import type { OutboundMessage, SendResult } from "../core/contracts.js";

export interface Delivery {
  message: OutboundMessage;
  /** Content is constructed only inside the send callback and never retained. */
  ephemeral?: true;
  phase: "ready" | "sending" | "settled";
  attempts: number;
  result?: SendResult;
  /** Host observation of this outcome; absent on historical receipts. */
  outcomeObservedAt?: number;
}

export async function deliver(
  delivery: Delivery,
  persist: () => Promise<void>,
  send: (message: OutboundMessage) => Promise<SendResult>,
  /** Synchronous dispatch gate, after the intent flush. A withheld send consumes
   * no transport attempt; retryable withholding stays ready for explicit retry. */
  check?: () => Extract<SendResult, { status: "rejected" }> | undefined,
): Promise<SendResult> {
  if (delivery.phase === "sending") {
    delivery.result = { status: "unknown", code: "interrupted_send" };
    delivery.outcomeObservedAt = Date.now();
  } else if (
    !delivery.result ||
    (delivery.result.status === "rejected" &&
      delivery.result.retryable &&
      delivery.attempts < 3)
  ) {
    delivery.phase = "sending";
    delivery.attempts++;
    await persist();
    try {
      const rejected = check?.();
      if (rejected) {
        delivery.attempts--;
        delivery.result = rejected;
        delivery.outcomeObservedAt = Date.now();
        delivery.phase = rejected.retryable ? "ready" : "settled";
        await persist();
        return delivery.result;
      }
      delivery.result = await send(delivery.message);
    } catch {
      delivery.result = { status: "unknown", code: "transport_error" };
    }
    delivery.outcomeObservedAt = Date.now();
  }
  delivery.phase = "settled";
  await persist();
  return delivery.result;
}
