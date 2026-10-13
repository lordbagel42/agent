import { createHash } from "node:crypto";
import type { ChannelEvent, MessageEvent } from "../core/contracts.js";
import type { WakeupContext } from "../wakeups/state.js";
import {
  type CompressedJson,
  readIngressReceipts,
} from "./conversation-storage.js";

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

/** Only optional, plain bot chatter can yield its inference to a later message
 * from that same bot/surface. Callers retain every original history record.
 * Human turns, addressed requests, attachments and already-started work never
 * enter this path. A bounded burst cannot swallow an entire conversation. */
export function newerBotChatter(
  event: MessageEvent,
  pending: readonly MessageEvent[],
): boolean {
  if (
    event.address.channel !== "slack" ||
    !event.address.threadId ||
    !event.senderId.startsWith("bot:") ||
    event.direct ||
    event.botMentioned ||
    event.questionAnswered ||
    event.metadata?.files?.length
  )
    return false;
  return pending.some(
    (next) =>
      next.id !== event.id &&
      next.senderId === event.senderId &&
      next.address.channel === event.address.channel &&
      next.address.accountId === event.address.accountId &&
      next.address.conversationId === event.address.conversationId &&
      next.address.threadId === event.address.threadId &&
      next.occurredAt > event.occurredAt &&
      next.occurredAt - event.occurredAt <= 30_000,
  );
}

export function wakeupInputId(runId: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["wakeup", runId]))
    .digest("hex");
}

export function conversationInputId(input: ConversationInput): string {
  if (input.type === "wakeup") return wakeupInputId(input.wakeup.runId);
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
  receiptsArchive?: CompressedJson;
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
  if (readIngressReceipts(state)[id]) return;
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
