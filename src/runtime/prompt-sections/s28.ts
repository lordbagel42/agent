import { WEB_CONVERSATIONS_KNOWLEDGE } from "../../web/knowledge.js";
import type { CapabilityKnowledge } from "../capability-prompts.js";

export const capabilityKnowledge: CapabilityKnowledge = {
  interaction: `${WEB_CONVERSATIONS_KNOWLEDGE} Delegate inspection to an admitted execution worker; this description exposes no new interaction tools.`,
  execution: `${WEB_CONVERSATIONS_KNOWLEDGE} Use only the tools exposed for this task and report actual observations, not inferred enablement.`,
  eventDecision: `${WEB_CONVERSATIONS_KNOWLEDGE} Automated events do not authorize login issuance, new inspections or repair; use only exposed standing-grant actions.`,
  notificationOnly: `${WEB_CONVERSATIONS_KNOWLEDGE} Notification turns report supplied evidence only: do not inspect, delegate, issue a login or retry.`,
};
