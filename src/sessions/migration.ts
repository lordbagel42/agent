import { createHash } from "node:crypto";
import type { Delivery } from "../runtime/delivery.js";

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
}

export interface LegacyDrainState {
  legacyCoverage?: LegacyCoverage;
  migration?: SessionMigration;
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
      if (!ids.includes(id) && state.ingress?.receipts[id]?.lane !== "session")
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
