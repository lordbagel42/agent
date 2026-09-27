import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CompanionReply } from "../core/contracts.js";
import type { BitwardenCredentialResolver } from "../credentials/bitwarden.js";
import type { HistoryImports } from "../imports/index.js";
import { MEMORY_CORRECTION_HELP } from "../memory/correction.js";
import type { CuratedPersonalityStore } from "../memory/curated.js";
import type { EvidenceStore, ImportCoverage } from "../memory/store.js";
import type { ReflectionRuntimeState } from "./reflection.js";

/** Project existing recovery receipts only; absence is not an outcome. */
export function inspectInterruptedInference(
  events: Record<
    string,
    {
      event: { occurredAt: number };
      inference?: {
        status: "unknown";
        code: "interrupted_inference";
        invocation: string;
      };
    }
  >,
  forgottenEvents: readonly string[] = [],
): string {
  const forgotten = new Set(forgottenEvents);
  const receipts = Object.entries(events)
    .flatMap(([id, { event, inference }]) =>
      inference && !forgotten.has(id)
        ? [{ inference, occurredAt: event.occurredAt }]
        : [],
    )
    .sort((a, b) => b.occurredAt - a.occurredAt);
  const rows = receipts.slice(0, 10).map(({ inference, occurredAt }) => ({
    id: createHash("sha256").update(inference.invocation).digest("hex"),
    inboundOccurredAt: occurredAt,
    status: inference.status,
    code: inference.code,
  }));
  return `Interrupted inference snapshot at ${new Date().toISOString()}. Read-only; this owner-private conversation only. Recorded recovery receipts: ${receipts.length}; showing latest ${rows.length} by inbound event time. ${JSON.stringify(rows)}\nIDs are opaque receipt fingerprints, not provider request IDs. inboundOccurredAt is the inbound event time (epoch milliseconds), not an inference or interruption timestamp; those times were not recorded. Legacy or uninterrupted events may have no receipt; absence does not prove success or intentional silence. Outcomes remain unknown, not intentional silence; actions may have occurred. Inspect recorded delivery/tool receipts before any new action. No retry, reconciliation, reclassification or release of held work was performed. No message bodies or raw invocation keys returned.`;
}

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
  capabilities?: () => string;
  credentials?: Pick<BitwardenCredentialResolver, "inspect">;
  reflection?: () => Promise<
    Pick<
      ReflectionRuntimeState,
      "reflection" | "liveActive" | "invocations"
    > & {
      candidateIds: string[];
      activeTurnIds: string[];
    }
  >;
}): (
  target: Exclude<NonNullable<CompanionReply["inspection"]>, "inference">,
) => Promise<string> {
  return async (target) => {
    const heading = `${target} metadata snapshot at ${new Date().toISOString()}. Read-only; not recall or proof of complete coverage.`;
    switch (target) {
      case "capabilities":
        return `${heading}\n${deps.capabilities?.() ?? "Generic capabilities are disabled; no generic capability routes or tools are mounted. Opaque action links are also disabled. Inspection grants nothing and does not enable them."}`;
      case "credentials": {
        const caution =
          "Vault authentication and item availability: unverified. No session or vault read was attempted. Configuration is not authorization or proof of usable credentials. No account aliases, origins, vault IDs, paths, credential values, tokens or item bodies returned.";
        if (!deps.credentials)
          return `${heading}\nCredential resolver: absent. No bindings are available to inspect. ${caution}`;
        const metadata = deps.credentials.inspect();
        return `${heading}\nCredential resolver: configured. Configured bindings: ${metadata.configuredBindings}; showing ${metadata.bindings.length}. Bindings are numbered in configuration order: ${JSON.stringify(metadata.bindings)}\n${caution}`;
      }
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
        if (!deps.memory)
          return `${heading}\nMemory is disabled or unavailable. Counts, size and operation history are unknown, not zero.`;
        const { store, personality } = deps.memory;
        let snapshot: string;
        try {
          const capacity = store.capacity(deps.audience);
          const proposals = store.proposals(deps.audience);
          const counts = { pending: 0, accepted: 0, rejected: 0 };
          for (const proposal of proposals) counts[proposal.status]++;
          snapshot = `Scoped source/claim projection: ${capacity.sources === 0 && capacity.claims === 0 ? "empty" : "nonempty"}. Authorized memory capacity: ${JSON.stringify(capacity)}. Counts cover this audience's retained sources/stored claims, not pending/rejected proposals. serializedBytes is UTF-8 JSON of {sources,claims}, with record metadata and the empty container; excludes other audiences, proposals, imports, tombstones, curated history, encryption and database overhead. This is not total ledger/disk size or model context usage. Null limits mean no audience-specific quota, not unlimited capacity; remaining capacity is unknown. Imports separately enforce ledger-wide source/claim/full-snapshot byte ceilings.\nProposal counts: ${JSON.stringify(counts)}.`;
        } catch {
          snapshot =
            "Ledger snapshot failed; current counts and size are unknown. No cached or zero values substituted.";
        }
        let revisions: number | "unavailable" = "unavailable";
        try {
          revisions =
            personality?.ownerHistory().revisions.length ?? "unavailable";
        } catch {
          // A separate curated-store failure must not conceal ledger status.
        }
        return `${heading}\n${snapshot}\nLedger operations: ${JSON.stringify(store.operationStatus())}. Ledger-wide, this opening only; earlier history unknown. Times: epoch ms. Read success means authenticated snapshot read; transaction success means COMMIT completed (including initial creation, excluding pre-transaction validation). Open is not a health check; read success does not prove writability.\nCurated revision count: ${revisions}. No evidence, proposal text, keys, error details or personality values returned.\n${MEMORY_CORRECTION_HELP}`;
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
            lastConflict,
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
            lastConflict,
          };
        });
        const reconciliation = rows.some(
          (row) => row.lastConflict === "immutable_source",
        )
          ? "\nImmutable-source conflict: a page reused a source ID with changed fields. Rejected page: stored evidence and cursor unchanged. Saved evidence is not proof of current content. Please arrange explicit reconciliation through the authenticated operator before retrying. I cannot overwrite evidence, skip conflicts, invent replacement IDs, or authorize reconciliation. This is operator review, not a queued or completed repair."
          : "";
        return `${heading}\nConfigured selections: ${selections.length}; showing ${rows.length}. ${JSON.stringify(rows)}\nnotBefore: persisted account cooldown deadline (epoch ms). cooldownReason: rate_limit, provider_backoff, pacing, unknown (legacy), or null. coolingDown is a time gate, not provider readiness. Wait until notBefore; no polling or automatic retry. Explicit operator confirmation is needed to resume, even after expiry/restart.\nbudgetRejected and lastConflict are last observed this process; page-count advancement or restart clears them, but cooldown-only updates do not. Null proves neither capacity nor absence of conflicts. Budget rejection: whole page exceeds ledger-wide source/claim/full-snapshot UTF-8 byte ceilings; no page evidence or progress committed. Reduce import or request operator capacity review. Complete means selected window exhausted, not complete account history. Gap contents, cursors, provider errors, credentials and message bodies are omitted. No import was started or cancelled.${reconciliation}`;
      }
      case "reflection": {
        if (!deps.reflection) return `${heading}\nReflection is unavailable.`;
        const status = await deps.reflection();
        const requests = status.reflection.requests.filter(
          (request) => request.scope === deps.audience,
        );
        const counts = {
          pending: 0,
          running: 0,
          cancelling: 0,
          cancelled: 0,
          stopped: 0,
        };
        for (const request of requests) counts[request.status]++;
        const invocations = { started: 0, settled: 0, uncertain: 0 };
        const requestIds = new Set(requests.map((request) => request.id));
        for (const [key, state] of Object.entries(status.invocations))
          if (requestIds.has(JSON.parse(key)[0])) invocations[state]++;
        // Request/turn IDs can embed scope and evidence IDs. Only expose bounded
        // fingerprints; the authenticated operator retrieves the exact IDs.
        const reference = (id: string) =>
          createHash("sha256").update(id).digest("hex");
        const held = requests.filter(
          (request) =>
            request.status === "running" || request.status === "cancelling",
        );
        const rows = held.slice(0, 5).map((request) => ({
          reference: reference(request.id),
          status: request.status,
          attempt: request.attempts,
          invocation:
            status.invocations[
              JSON.stringify([request.id, request.attempts])
            ] ?? "not_recorded",
        }));
        const turns = status.activeTurnIds.slice(0, 5).map(reference);
        return `${heading}\nScoped request counts: ${JSON.stringify(counts)}. Scoped invocation counts: ${JSON.stringify(invocations)}. Owner-wide live turns: ${status.liveActive}. Owner-wide candidate count: ${status.candidateIds.length}. Candidates are provisional, not approved messages; a live turn may invalidate them. No evidence IDs, rationale or candidate contents returned.
Held scoped requests: ${held.length}; showing ${rows.length}. ${JSON.stringify(rows)}
Owner-wide live turn references: ${status.activeTurnIds.length}; showing ${turns.length}. ${JSON.stringify(turns)}
An uncertain invocation was interrupted; its outcome is unknown, not success or confirmed failure. Running/started may still be active; cancelling is not stopped. Live occupancy may include this inspection turn and does not by itself prove interruption. Unidentified legacy live holds may also remain. Cancellation, timeout, restart, elapsed time or a model assertion cannot prove provider settlement. Do not retry unknown work or release its capacity automatically.
Reconciliation is operator-only: use the existing owner bearer authentication on the private GET /operator/reflection endpoint. References are SHA-256 of the exact UTF-8 request id or activeTurnIds entry; match locally, never paste raw IDs or credentials into chat. Inspect the old worker/provider and confirm it actually stopped. If stoppage cannot be verified, leave the hold and outcome unknown. Only after that confirmation, POST /operator/reflection/reconcile with {"id":"<exact request id>","confirmedStopped":true,"live":false}, or {"id":"<exact active turn id>","confirmedStopped":true,"live":true} for live occupancy. Never substitute a reference for an id or guess an id for a legacy hold. Require reconciled:true and read status again before reporting the hold released. Reconciliation is not successful reflection, candidate approval or permission to retry; dedupe remains. This inspection changed nothing and cannot reconcile, cancel, enqueue or send.`;
      }
    }
  };
}
