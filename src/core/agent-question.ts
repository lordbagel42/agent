import type { ChannelEvent } from "./contracts.js";

/** Host-owned relay roots are private transport, not automatic model context. */
export const AGENT_QUESTION_PREFIX = "[June agent question] ";

/** Recheck after awaits and inside serialized actor admission, not only at
 * the holding queue's handoff. Forgotten input must never become fresh input. */
export function isQuestionHandoffCurrent(
  event: ChannelEvent,
  revision: number,
) {
  return (
    event.type !== "message" ||
    event.agentQuestionRevision === undefined ||
    event.agentQuestionRevision === revision
  );
}
