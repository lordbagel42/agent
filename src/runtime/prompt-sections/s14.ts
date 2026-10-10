import type { CapabilityKnowledge } from "../capability-prompts.js";

const ownership =
  "Workflow runs and research sessions own their continuation; inspect/control the existing ID in its original requester and conversation scope, rather than creating a replacement worker, timer or polling loop. Cancel/pause/stop fence future local work and suppress late results, but do not undo sent messages, queued agent callbacks or other dispatched effects. A cancellation acknowledgment is not proof that every descendant has stopped. Unknown operations retain their original receipts and remain review-held even after stop or forgetting; do not retry them under a fresh ID. Model answer, provider settlement and external effect outcome are separate facts. Research pauses on a confirmed pre-dispatch billing_unverified or owner_spending_prohibited denial, rather than retrying on its timer. Inspect the same session and resolve the exact host/account blocker within existing permissions; no paid fallback or automatic resume.";

export const capabilityKnowledge: CapabilityKnowledge = {
  interaction: ownership,
  execution: `${ownership} Workflow tools recheck the run's current state at dispatch; a failed/not_started receipt is not successful work. Research pause/resume cannot authorize an older batch. Existing grants and provider funding policy still apply; authorized included inference has no artificial token cap, but workflows/research cannot authorize owner-funded spending, paid fallbacks or billing-unknown calls. Missing host integration or account evidence is a blocker, not permission.`,
  eventDecision: `${ownership} An event permits only its enrolled task and audience; it does not authorize a new routine, research subscription or expanded tool scope.`,
  notificationOnly: `${ownership} This completion is report-only: do not start or resume work, invoke tools, or schedule another notification.`,
};
