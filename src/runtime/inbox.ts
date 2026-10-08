import { createHash } from "node:crypto";
import type { ChannelEvent, MessageEvent } from "../core/contracts.js";
import type { WakeupContext } from "../wakeups/state.js";

/** Host ingress. Identity is independent of the activity actor or reply surface. */
export type ConversationInput =
  | { type: "event"; event: ChannelEvent }
  | { type: "wakeup"; source: MessageEvent; wakeup: WakeupContext }
  | { type: "forget_request"; source: MessageEvent; token: string }
  | {
      type: "execution_result";
      agentId: string;
      requestId: string;
      source: MessageEvent;
      replyAddress?: MessageEvent["address"];
    }
  | {
      type: "job_result";
      jobId: string;
      attempt: number;
      source: MessageEvent;
      text: string;
    };

export function conversationInputId(input: ConversationInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        input.type === "event"
          ? [
              input.event.address.channel,
              input.event.address.accountId,
              input.event.id,
            ]
          : input.type === "execution_result"
            ? ["execution", input.agentId, input.requestId]
            : input.type === "forget_request"
              ? ["forget", input.token]
              : input.type === "wakeup"
                ? ["wakeup", input.wakeup.runId]
                : ["job", input.jobId, input.attempt],
      ),
    )
    .digest("hex");
}

/** Prospective receipt only. Its presence does not certify effect settlement or
 * reconstruct a legacy queue entry's first receipt time. Keep after forgetting. */
export interface ConversationIngress {
  receivedThrough: number;
  sequence: number;
  receipts: Record<
    string,
    {
      sequence: number;
      receivedAt: number;
      kind: "message" | "notification";
      /** Absent old receipts remain legacy, never retroactively reassigned. */
      lane?: "legacy" | "session";
    }
  >;
}

/** Called in the scope's serialized admission, before its first durable save. */
export function recordConversationIngress(
  state: ConversationIngress,
  input: ConversationInput,
  firstReceivedAt: number,
  lane: "legacy" | "session" = "legacy",
): void {
  const id = conversationInputId(input);
  if (state.receipts[id]) return;
  if (!Number.isSafeInteger(firstReceivedAt) || firstReceivedAt < 0)
    throw new Error("Invalid host receipt time");
  state.receivedThrough = Math.max(firstReceivedAt, state.receivedThrough);
  state.receipts[id] = {
    sequence: ++state.sequence,
    receivedAt: state.receivedThrough,
    lane,
    kind:
      input.type === "event" && input.event.type === "message"
        ? "message"
        : "notification",
  };
}
