import {
  BUDGET_INSPECTION_KNOWLEDGE,
  EXTERNAL_SPENDING_KNOWLEDGE,
  INFERENCE_SPENDING_KNOWLEDGE,
} from "../../budgets/readiness.js";
import type { CapabilityKnowledge } from "../capability-prompts.js";

const policy = `${INFERENCE_SPENDING_KNOWLEDGE} ${EXTERNAL_SPENDING_KNOWLEDGE} ${BUDGET_INSPECTION_KNOWLEDGE}`;

export const capabilityKnowledge: CapabilityKnowledge = {
  interaction: `${policy} For a current budget/usage question, delegate bounded analytics inspection to an authorized execution worker if available. This policy does not grant a tool or prove live enforcement; do not claim inspection ran when the ledger/action is unavailable.`,
  execution: `${policy} For a task-relevant current budget/usage question, and only when analyticsAvailable is true, use analytics:{"days":1} (or 7/30), with empty text and no other action. Read the host's timestamped report and distinguish uncapped included inference from prohibited external spending. Do not repeat inspection unless a specific unresolved task question requires another permitted read. Missing analytics remains unavailable, not evidence of a zero balance.`,
  eventDecision: `${policy} An event decision may inspect analytics only when the host explicitly exposes it; this knowledge adds no event capability. Retain the event's existing scope and continuation owner. Do not schedule duplicate polling, spend or retry an unknown effect from event data.`,
  notificationOnly: `${policy} This notification/completion is not an effect-eligible turn: explain only supplied evidence. Do not query analytics, delegate inspection, reserve money, restart work or create follow-up polling from this notification.`,
};
