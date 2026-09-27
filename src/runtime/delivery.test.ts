import { describe, expect, it, vi } from "vitest";
import type { OutboundMessage } from "../core/contracts.js";
import { type Delivery, deliver } from "./delivery.js";

const message: OutboundMessage = {
  id: "operation-1",
  lastInboundAt: 1000,
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  content: { type: "text", text: "Hello" },
};

describe("outbox crash boundary", () => {
  it("timestamps observations, not no-op replay or already settled legacy receipts", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const delivery: Delivery = { message, phase: "ready", attempts: 0 };
      const persist = vi.fn(async () => {});
      const send = vi.fn(async () => ({
        status: "sent" as const,
        messageId: "receipt",
      }));
      await deliver(delivery, persist, send);
      expect(delivery.outcomeObservedAt).toBe(1000);
      clock.mockReturnValue(2000);
      await deliver(delivery, persist, send);
      expect(delivery.outcomeObservedAt).toBe(1000);
      delete delivery.outcomeObservedAt;
      await deliver(delivery, persist, send);
      expect(delivery.outcomeObservedAt).toBeUndefined();
      expect(send).toHaveBeenCalledTimes(1);
      const interrupted: Delivery = { message, phase: "sending", attempts: 1 };
      await deliver(interrupted, persist, send);
      expect(interrupted.outcomeObservedAt).toBe(2000);
      expect(interrupted.result?.status).toBe("unknown");
      const withheld: Delivery = { message, phase: "ready", attempts: 0 };
      await deliver(withheld, persist, send, () => ({
        status: "rejected",
        retryable: true,
        code: "blocked",
      }));
      expect(withheld.outcomeObservedAt).toBe(2000);
      expect(withheld.attempts).toBe(0);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("persists sending intent before sending and the receipt before returning", async () => {
    const delivery: Delivery = { message, phase: "ready", attempts: 0 };
    const order: string[] = [];
    const result = await deliver(
      delivery,
      async () => {
        order.push(delivery.phase);
      },
      async () => {
        order.push("send");
        return { status: "sent", messageId: "platform-1" };
      },
    );
    expect(order).toEqual(["sending", "send", "settled"]);
    expect(result).toEqual({ status: "sent", messageId: "platform-1" });
    expect(delivery.attempts).toBe(1);
  });

  it("does not resend after acceptance followed by a failed receipt flush", async () => {
    const delivery: Delivery = { message, phase: "ready", attempts: 0 };
    let stored = structuredClone(delivery);
    let sends = 0;
    const send = async () => {
      sends++;
      return { status: "sent" as const, messageId: "platform-1" };
    };
    await expect(
      deliver(
        delivery,
        async () => {
          if (delivery.phase === "settled") throw new Error("simulated crash");
          stored = structuredClone(delivery);
        },
        send,
      ),
    ).rejects.toThrow("simulated crash");
    const recovered = await deliver(stored, async () => {}, send);
    expect(recovered).toEqual({ status: "unknown", code: "interrupted_send" });
    expect(sends).toBe(1);
  });

  it("allows only known retryable rejections to be attempted again", async () => {
    const delivery: Delivery = { message, phase: "ready", attempts: 0 };
    let sends = 0;
    const send = async () => {
      sends++;
      return sends === 1
        ? { status: "rejected" as const, code: "rate_limited", retryable: true }
        : { status: "sent" as const, messageId: "platform-2" };
    };
    await deliver(delivery, async () => {}, send);
    await deliver(delivery, async () => {}, send);
    await deliver(delivery, async () => {}, send);
    expect(sends).toBe(2);
    expect(delivery.result).toEqual({
      status: "sent",
      messageId: "platform-2",
    });
  });

  it("rechecks after each intent flush without spending attempts on withheld sends", async () => {
    const delivery: Delivery = { message, phase: "ready", attempts: 0 };
    let blocked = false;
    let blockDuringFlush = true;
    let sends = 0;
    let stored = structuredClone(delivery);
    const persist = async () => {
      stored = structuredClone(delivery);
      if (delivery.phase === "sending" && blockDuringFlush) blocked = true;
    };
    const send = async () => {
      sends++;
      return { status: "sent" as const, messageId: "platform-3" };
    };
    const check = () =>
      blocked
        ? { status: "rejected" as const, code: "quiet_hours", retryable: true }
        : undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      blocked = false;
      expect(await deliver(delivery, persist, send, check)).toEqual({
        status: "rejected",
        code: "quiet_hours",
        retryable: true,
      });
      expect(stored.phase).toBe("ready");
      expect(stored.attempts).toBe(0);
    }
    expect(sends).toBe(0);
    blockDuringFlush = false;
    blocked = false;
    expect(await deliver(delivery, persist, send, check)).toEqual({
      status: "sent",
      messageId: "platform-3",
    });
    await deliver(delivery, persist, send, check);
    expect(sends).toBe(1);
    expect(delivery.attempts).toBe(1);
  });
});
