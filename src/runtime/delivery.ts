import type { OutboundMessage, SendResult } from "../core/contracts.js";

export interface Delivery {
  message: OutboundMessage;
  /** Content is constructed only inside the send callback and never retained. */
  ephemeral?: true;
  phase: "ready" | "sending" | "settled";
  attempts: number;
  result?: SendResult;
}

export async function deliver(
  delivery: Delivery,
  persist: () => Promise<void>,
  send: (message: OutboundMessage) => Promise<SendResult>,
): Promise<SendResult> {
  if (delivery.phase === "sending") {
    delivery.result = { status: "unknown", code: "interrupted_send" };
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
      delivery.result = await send(delivery.message);
    } catch {
      delivery.result = { status: "unknown", code: "transport_error" };
    }
  }
  delivery.phase = "settled";
  await persist();
  return delivery.result;
}
