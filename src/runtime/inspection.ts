import { isDeepStrictEqual } from "node:util";
import type { CompanionReply } from "../core/contracts.js";
import type { HistoryImports } from "../imports/index.js";
import { MEMORY_CORRECTION_HELP } from "../memory/correction.js";
import type { CuratedPersonalityStore } from "../memory/curated.js";
import type { EvidenceStore, ImportCoverage } from "../memory/store.js";
import type { ReflectionRuntimeState } from "./reflection.js";

/** Host-bound audience and selections, never model-supplied scope or query.
 * Reports contain metadata only, so retained receipts cannot resurrect evidence.
 * No mutating service methods or remote history fetches are called here.
 */
export function createInspectionReader(deps: {
  audience: string;
  memory?: { store: EvidenceStore; personality?: CuratedPersonalityStore };
  imports?: HistoryImports;
  selections: Record<string, ImportCoverage>;
  nativeCoding?: () => Promise<string>;
  reflection?: () => Promise<
    Pick<
      ReflectionRuntimeState,
      "reflection" | "liveActive" | "invocations"
    > & {
      candidateIds: string[];
    }
  >;
}): (target: NonNullable<CompanionReply["inspection"]>) => Promise<string> {
  return async (target) => {
    const heading = `${target} metadata snapshot at ${new Date().toISOString()}. Read-only; not recall or proof of complete coverage.`;
    switch (target) {
      case "native-coding":
        return deps.nativeCoding
          ? deps.nativeCoding()
          : `${heading}\nNative coding preflight is unavailable; readiness cannot be inferred.`;
      case "retention":
        // Wiring only: even apparently read-only store/actor getters can
        // decrypt evidence or prune state. Do not enumerate retained data.
        return [
          heading,
          "Retained-copy category inventory, not a census of files or messages. Basis: current runtime wiring and implementation behavior only; no storage or provider scan.",
          `Ledger: ${deps.memory ? "configured" : "not configured in this runtime"}. Source deletion removes affected sources and dependent claims/proposals from the active evidence ledger and retains tombstones. Per-source deletion status is unknown here; no source was checked. Encryption and SQLite secure deletion are not proof of physical erasure across copies.`,
          "Rivet journals: runtime persistence can retain historical conversation, workflow and delivery payloads. Clearing current actor state does not purge old journals. The optional evidence-ledger encryption does not encrypt Rivet data. Retained contents and copy counts are unknown.",
          `Snapshots: curated encrypted snapshot storage is ${deps.memory?.personality ? "configured" : "not configured in this runtime"}. Logical deletion filters evidence-derived projections, not old encrypted revisions. Git rollback is not erasure. Historical curated copies and filesystem snapshots may remain; their inventory is unknown.`,
          "Backups: existence, locations, ages, retention deadlines and purge status are unknown; no backup inventory was supplied or scanned. An older ledger must not serve traffic until later tombstones are replayed. Retain tombstones through the backup retention window; physical purge and retention policy require operator verification.",
          "Delivered messages: platform and recipient copies may remain after local history or delivery text is cleared. Logical forgetting does not retract already delivered messages or already submitted model requests. Platform, recipient and provider retention is unknown; no remote lookup or deletion was attempted.",
          "Physical erasure is unverified for every category. Logical deletion means removal from active use, not proof that all bytes or external copies are gone. Unknown does not mean absent; an unconfigured subsystem does not prove older copies are absent. This report contains no content, IDs, paths or keys, performs no deletion, and certifies no individual deletion request.",
        ].join("\n");
      case "memory": {
        if (!deps.memory) return `${heading}\nMemory is unavailable.`;
        const capacity = deps.memory.store.capacity(deps.audience);
        const proposals = deps.memory.store.proposals(deps.audience);
        const counts = { pending: 0, accepted: 0, rejected: 0 };
        for (const proposal of proposals) counts[proposal.status]++;
        return `${heading}\nAuthorized memory capacity: ${JSON.stringify(capacity)}. Counts include only retained sources and stored claims visible to this host-bound audience, not pending/rejected proposals. serializedBytes measures UTF-8 JSON of {sources,claims}, including record metadata and the empty container; it excludes other audiences' records, proposals, imports, tombstones, curated history, encryption and database overhead. This is not total ledger/disk size or model context usage. Null limits mean no audience-specific quota, not unlimited capacity; remaining capacity is unknown. Imports separately enforce ledger-wide source/claim/full-snapshot byte ceilings.\nProposal counts: ${JSON.stringify(counts)}. Curated revision count: ${deps.memory.personality?.ownerHistory().revisions.length ?? "unavailable"}. No evidence, proposal text, or personality values returned.\n${MEMORY_CORRECTION_HELP}`;
      }
      case "imports": {
        const imports = deps.imports;
        if (!imports) return `${heading}\nImports are unavailable.`;
        const selections = Object.entries(deps.selections).filter(
          ([, coverage]) => coverage.audiences.includes(deps.audience),
        );
        const rows = selections.slice(0, 10).map(([id, coverage]) => {
          const {
            running,
            progress,
            notBefore,
            cooldownReason,
            coolingDown,
            budget,
          } = imports.status(id);
          if (progress && !isDeepStrictEqual(progress.coverage, coverage))
            throw new Error("Import coverage changed");
          return {
            selection: id.slice(0, 80),
            conversations: coverage.conversations.length,
            from: coverage.from,
            to: coverage.to,
            running,
            started: progress !== undefined,
            pages: progress?.pages ?? 0,
            complete: progress?.complete ?? false,
            notBefore,
            cooldownReason,
            coolingDown,
            gapCount: progress?.gaps.length ?? 0,
            budgetRejected: budget.lastRejection,
          };
        });
        return `${heading}\nConfigured selections: ${selections.length}; showing ${rows.length}. ${JSON.stringify(rows)}\nnotBefore is the persisted account cooldown deadline (epoch milliseconds); cooldownReason is rate_limit, provider_backoff, pacing, unknown for legacy deadlines, or null. coolingDown is only the time gate at this snapshot, not provider readiness. Wait until notBefore; no polling or automatic retry. Resuming requires explicit operator confirmation, even after expiry or restart.\nBudget rejections are last observed this process, cleared when a page advances its page count or the service is recreated; cooldown-only updates do not clear them. Null is not proof a page will fit. A rejection means the whole page exceeded a ledger-wide source, claim, or full-snapshot UTF-8 byte budget; no page evidence or progress committed. Reduce the import or ask the operator to review capacity. Complete means the selected window was exhausted, not complete account history. Gap contents, cursors, provider errors, credentials and message bodies are omitted. No import was started or cancelled.`;
      }
      case "reflection": {
        if (!deps.reflection) return `${heading}\nReflection is unavailable.`;
        const status = await deps.reflection();
        const counts = {
          pending: 0,
          running: 0,
          cancelling: 0,
          cancelled: 0,
          stopped: 0,
        };
        for (const request of status.reflection.requests)
          if (request.scope === deps.audience) counts[request.status]++;
        const invocations = { started: 0, settled: 0, uncertain: 0 };
        for (const state of Object.values(status.invocations))
          invocations[state]++;
        return `${heading}\nScoped request counts: ${JSON.stringify(counts)}. Invocation counts: ${JSON.stringify(invocations)}. Live turns: ${status.liveActive}. Candidate count: ${status.candidateIds.length}. Candidates are provisional, not approved messages; a live turn may invalidate them. No evidence IDs, rationale, candidate contents, enqueue or approval action returned.`;
      }
    }
  };
}
