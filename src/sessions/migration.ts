import { createHash } from "node:crypto";
import type { ChannelEvent } from "../core/contracts.js";
import type { EvidenceStore } from "../memory/store.js";
import type { Delivery } from "../runtime/delivery.js";
import type { ConversationIngress } from "../runtime/inbox.js";
import { isReceiptOnlyArchive, type SessionArchiveInput } from "./archive.js";
import { produceSessionArchiveTurn } from "./producer.js";

/** Creation-only lineage, never backfilled from empty state or old journals. */
export interface LegacyCoverage {
  version: 1;
  scope: string;
  turns: Record<string, { finished?: true; untrackedEffect?: true }>;
}

/** The scope coordinator owns this record. It must save the frozen boundary
 * before publishing the barrier; no ordinary admission may enter legacy after it.
 * This is separate from the activity directory, which owns session assignments.
 */
export interface SessionMigration {
  scope: string;
  epoch: string;
  barrier: string;
  phase: "draining" | "sessions";
  legacyInputs: string[];
  barrierObserved?: true;
  archivedInputs: string[];
  /** Immutable projection survives a ledger-write/catalog-ACK gap. */
  archivePending?: { input: SessionArchiveInput; deletionRevision: number };
}

export interface LegacyDrainState {
  legacyCoverage?: LegacyCoverage;
  migration?: SessionMigration;
  /** Lane ownership only, including direct queue inputs; not effect coverage. */
  legacyAdmissions?: string[];
  events: Record<string, { done: boolean }>;
  pendingInputs?: Record<string, unknown>;
  pendingNotifications?: Record<string, unknown>;
  ingress?: { receipts: Record<string, { lane?: "legacy" | "session" }> };
  modelInvocations?: Record<string, "started" | "settled" | "uncertain">;
  webInvocations?: Record<string, "started" | "settled" | "uncertain">;
  deliveries: Record<string, Delivery>;
}

const inputIds = (state: LegacyDrainState) =>
  [
    ...new Set([
      ...Object.keys(state.events),
      ...Object.keys(state.pendingInputs ?? {}),
      ...Object.keys(state.pendingNotifications ?? {}),
      ...Object.keys(state.ingress?.receipts ?? {}),
      ...Object.keys(state.legacyCoverage?.turns ?? {}),
      ...(state.legacyAdmissions ?? []),
    ]),
  ].sort();

/** Run inside the receive serializer. Repeated preparation reuses the exact
 * boundary; it never sweeps newly waiting session inputs into the legacy lane.
 */
export function beginSessionMigration(
  state: LegacyDrainState,
  scopeKey: readonly string[],
  epoch: string,
): SessionMigration {
  if (state.migration) return state.migration;
  if (!/^[a-f0-9]{64}$/.test(epoch)) throw new Error("Invalid migration epoch");
  state.migration = {
    scope: JSON.stringify(scopeKey),
    epoch,
    barrier: createHash("sha256")
      .update(JSON.stringify([scopeKey, epoch, "legacy-barrier"]))
      .digest("hex"),
    phase: "draining",
    legacyInputs: inputIds(state),
    archivedInputs: [],
  };
  return state.migration;
}

/** Called only by the legacy consumer on the exact durable queue barrier. */
export function observeLegacyBarrier(
  state: LegacyDrainState,
  epoch: string,
  barrier: string,
): void {
  const migration = state.migration;
  if (!migration || migration.epoch !== epoch || migration.barrier !== barrier)
    throw new Error("Unrecognized legacy barrier");
  migration.barrierObserved = true;
}

/** Archive only the frozen, finished inventory, in original admission order.
 * Legacy turns lack a durable retention classification. Preserve attributed
 * receipts, but omit their payloads rather than copying credentials, previews or
 * control text. Missing host receipt times cannot be reconstructed from age.
 * This is archival coverage only; inspectLegacyDrain still checks every effect.
 */
export async function archiveLegacyInputs(
  state: LegacyDrainState & {
    events: Record<string, { event: ChannelEvent; done: boolean }>;
    ingress?: ConversationIngress;
  },
  scopeKey: readonly string[],
  store: Pick<EvidenceStore, "archiveSessionTurn" | "deletionRevision">,
  persist: () => Promise<void>,
): Promise<void> {
  const migration = state.migration;
  if (
    migration?.phase !== "draining" ||
    migration.scope !== JSON.stringify(scopeKey)
  )
    return;
  const receipts = state.ingress?.receipts;
  if (
    migration.legacyInputs.some((id) => {
      const receipt = receipts?.[id];
      return (
        !receipt ||
        receipt.lane === "session" ||
        !Number.isSafeInteger(receipt.receivedAt) ||
        receipt.receivedAt < 0
      );
    })
  )
    return;
  const ordered = [...migration.legacyInputs].sort(
    (a, b) => (receipts?.[a]?.sequence ?? 0) - (receipts?.[b]?.sequence ?? 0),
  );
  const first = ordered[0];
  if (!first || !receipts?.[first]) return;
  const openedAt = receipts[first].receivedAt;
  const sessionId = createHash("sha256")
    .update(JSON.stringify([scopeKey, migration.epoch, "legacy-archive"]))
    .digest("hex");
  for (const [index, id] of ordered.entries()) {
    if (migration.archivedInputs.includes(id)) continue;
    const receipt = receipts[id];
    const record = state.events[id];
    if (
      !receipt ||
      !record?.done ||
      !state.legacyCoverage?.turns[id]?.finished ||
      Object.hasOwn(state.pendingInputs ?? {}, id) ||
      Object.hasOwn(state.pendingNotifications ?? {}, id)
    )
      return;
    const deliveries = Object.entries(state.deliveries)
      .filter(([key]) => key.startsWith(`${id}:`))
      .map(([, delivery]) => ({ delivery }));
    if (
      deliveries.some(
        ({ delivery }) =>
          delivery.phase !== "settled" ||
          !delivery.result ||
          (delivery.result.status === "rejected" && delivery.result.retryable),
      )
    )
      return;
    if (!migration.archivePending) {
      const input = produceSessionArchiveTurn(
        {
          sessionId,
          audience: migration.scope,
          openedAt,
          eventId: id,
          sequence: index + 1,
          receivedAt: receipt.receivedAt,
          ...(receipt.kind === "message" && record.event.type === "message"
            ? { inbound: { event: record.event } }
            : {}),
          deliveries,
          retentionExcluded: true,
        },
        // No legacy payload has a complete retained-context certificate here.
        {
          source: () => undefined,
          isDeleted: () => true,
          contextAvailable: () => false,
        },
      );
      input.turn.data.incomplete = true;
      migration.archivePending = {
        input,
        deletionRevision: store.deletionRevision(),
      };
      await persist();
    }
    if (migration.archivePending.input.turn.eventId !== id)
      throw new Error("Legacy archive assignment conflict");
    const pending = migration.archivePending;
    const revision = store.deletionRevision();
    if (pending.deletionRevision !== revision) {
      if (!isReceiptOnlyArchive(pending.input))
        throw new Error("Cannot renew a retained legacy archive projection");
      // Only this dependency-free, omitted-content receipt can cross deletion.
      // Do not regenerate its times or outcomes, or relax the ledger's fence.
      // No await may separate this check from the synchronous ledger write.
      pending.deletionRevision = revision;
    }
    store.archiveSessionTurn(pending.input, pending.deletionRevision);
    migration.archivedInputs.push(id);
    delete migration.archivePending;
    await persist();
  }
}

/** Read-only, content-free reasons. Not an operator reconciliation API.
 * Existing invocation markers have no provider settlement contract: even
 * `settled` can mean a local HTTP timeout or a hot answer before retirement.
 * They stay held, regardless of age, event.done or released reflection capacity.
 */
export function inspectLegacyDrain(
  state: LegacyDrainState,
  scopeKey: readonly string[],
) {
  const migration = state.migration;
  const coverage = state.legacyCoverage;
  const scope = JSON.stringify(scopeKey);
  const counts = {
    scopeMismatch: migration && migration.scope !== scope ? 1 : 0,
    missingCoverage:
      coverage?.version === 1 && coverage.scope === scope ? 0 : 1,
    unfrozenLegacyInputs: 0,
    untrackedTurnEffects: 0,
    unfinishedInputs: 0,
    unarchivedInputs: 0,
    modelSettlementUnproven: Object.keys(state.modelInvocations ?? {}).length,
    webSettlementUnproven: Object.keys(state.webInvocations ?? {}).length,
    unresolvedDeliveries: 0,
  };
  // With a frozen boundary, new session admissions are deliberately excluded.
  // Without one this is prospective inspection, never permission to migrate.
  const ids = migration?.legacyInputs ?? inputIds(state);
  if (migration)
    for (const id of inputIds(state))
      if (
        !ids.includes(id) &&
        (state.ingress?.receipts[id]?.lane !== "session" ||
          state.legacyAdmissions?.includes(id) ||
          Object.hasOwn(coverage?.turns ?? {}, id))
      )
        counts.unfrozenLegacyInputs++;
  for (const id of ids) {
    const turn = coverage?.turns[id];
    if (!turn) counts.missingCoverage++;
    if (turn?.untrackedEffect) counts.untrackedTurnEffects++;
    if (
      !turn?.finished ||
      state.events[id]?.done === false ||
      Object.hasOwn(state.pendingInputs ?? {}, id) ||
      Object.hasOwn(state.pendingNotifications ?? {}, id)
    )
      counts.unfinishedInputs++;
    if (!migration?.archivedInputs.includes(id)) counts.unarchivedInputs++;
  }
  for (const delivery of Object.values(state.deliveries)) {
    const result = delivery.result;
    if (
      delivery.phase !== "settled" ||
      !result ||
      result.status === "unknown" ||
      (result.status === "rejected" && result.retryable) ||
      (result.status === "sent" && !result.messageId) ||
      delivery.outcomeObservedAt === undefined
    )
      counts.unresolvedDeliveries++;
  }
  const reasons = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([reason]) => reason);
  if (!migration?.barrierObserved) reasons.unshift("barrierNotObserved");
  return {
    phase: migration?.phase ?? ("legacy" as const),
    legacyInputs: ids.length,
    counts,
    reasons,
    ready: !!migration && reasons.length === 0,
  };
}

/** Last check immediately before persisting the lane switch. No reconciliation,
 * state clearing, effect replay or archive write happens in this transition.
 */
export function finishSessionMigration(
  state: LegacyDrainState,
  scopeKey: readonly string[],
): void {
  if (!state.migration || !inspectLegacyDrain(state, scopeKey).ready)
    throw new Error("Legacy conversation is not provably drained");
  state.migration.phase = "sessions";
}
