import {
  CAPABILITY_READINESS_HELP,
  CAPABILITY_READINESS_KNOWLEDGE,
} from "../../operations/knowledge.js";
import type { CapabilityKnowledge } from "../capability-prompts.js";

export const capabilityKnowledge: CapabilityKnowledge = {
  interaction: `${CAPABILITY_READINESS_KNOWLEDGE}\n\nFor a current readiness question, delegate the read-only capability inspection to an available execution worker. Do not claim the worker route is exposed in this turn or perform setup yourself. If delegation is unavailable, explain that limitation from supplied evidence.`,
  execution: `${CAPABILITY_READINESS_KNOWLEDGE}\n\n${CAPABILITY_READINESS_HELP}`,
  eventDecision: `${CAPABILITY_READINESS_KNOWLEDGE}\n\nThis automated event-decision turn may use only its explicitly exposed standing-grant actions. The new capability inspection is execution-only; its description does not authorize delegation, a probe or repair from an event. Explain unknown or blocked state using supplied evidence.`,
  notificationOnly: `${CAPABILITY_READINESS_KNOWLEDGE}\n\nThis is notification-only: report supplied observations with their scope, timestamp and uncertainty. Do not start inspection, delegate work, enroll an account or repeat a failed or unknown operation. A completion notification grants no new action.`,
};
