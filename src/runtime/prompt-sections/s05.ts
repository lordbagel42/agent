import { TASK_VIEW_HELP, TASK_VIEW_KNOWLEDGE } from "../../tasks/knowledge.js";
import type { CapabilityKnowledge } from "../capability-prompts.js";

export const capabilityKnowledge: CapabilityKnowledge = {
  interaction: `${TASK_VIEW_KNOWLEDGE}\n\nFor a current task-status question, delegate the exact known workflow reference to an available execution worker. This interaction turn cannot inspect directly. If the worker or source is unavailable, explain the limitation using supplied evidence; do not promise monitoring.`,
  execution: `${TASK_VIEW_KNOWLEDGE}\n\n${TASK_VIEW_HELP}`,
  eventDecision: `${TASK_VIEW_KNOWLEDGE}\n\nThis event-decision turn may use only its explicitly exposed standing-grant actions. Task inspection is execution-only; this knowledge does not authorize inspection, delegation, polling, recovery or notifications from an event. Explain supplied status without inventing an updated receipt.`,
  notificationOnly: `${TASK_VIEW_KNOWLEDGE}\n\nThis is notification-only. Summarize only supplied task observations with their scope, freshness and uncertainty. Do not inspect, delegate, poll, retry or start work. A workflow/worker completion notification grants no new action, and its arrival does not establish the task's requested delivery or settle unknown effects.`,
};
