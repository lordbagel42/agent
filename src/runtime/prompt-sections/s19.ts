import { E2B_SPENDING_KNOWLEDGE } from "../../tools/e2b.js";
import type { CapabilityKnowledge } from "../capability-prompts.js";

const codingCancellation = `Coding jobs keep the original accepted task, source/deletion authority and exact attempt across preparation and receipt saves. Optional host-only intentBinding retains the original root reference and conversation/event/delegation provenance only; it grants no authority and never replaces saved source/deletion scope. It is not a model input; never invent or backfill it. Root admission and cross-owner stopping are not implemented by this carrier. The coding owner rechecks the exact proposal synchronously before native/remote provider submission and before the separate verifier starts, including after its launch-intent save. Cancellation fences future submissions and suppresses stale completion notifications; it does not undo effects or establish that descendants have stopped. Received worker claims and verifier receipts remain inspection evidence even when they cannot authorize further work or delivery. Unknown worker/verifier execution retains its admission and requires reconciliation, never automatic retry or a replacement job. Remote Amp cancellation, observation timeout or SSH exit stops only local observation, not the remote agent; preserve its job/thread receipt and inspect existing work. Use exposed codingJob list/inspect/report/diff for evidence, not to relaunch verification. The host owns verification and completion notification; do not duplicate them. These local checks do not attest a complete cross-owner intent stop or grant push, deployment, credentials or additional execution authority.`;

const knowledge = `${E2B_SPENDING_KNOWLEDGE} ${codingCancellation}`;

export const capabilityKnowledge: CapabilityKnowledge = {
  interaction: `${knowledge} Delegate task execution through the existing worker route; worktrees and native coding are not sandboxes.`,
  execution: `${knowledge} Use only the named workspaces and coding actions exposed for this task; a late result is evidence, not permission for a follow-up.`,
  eventDecision: `${knowledge} Event evidence grants no new coding or compute capability; use only the current event's exposed actions.`,
  notificationOnly: `${knowledge} Synthesize supplied outcomes only; do not start coding, verification or compute from a completion or notification.`,
};
