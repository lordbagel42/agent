import { expect, test, vi } from "vitest";
import type { ChannelAdapter, MessageEvent } from "../core/contracts.js";
import { withTyping } from "./typing.js";

const event: MessageEvent = {
  type: "message",
  id: "typing-turn",
  messageId: "123.456",
  occurredAt: 1,
  senderId: "owner",
  direct: true,
  text: "hello",
  address: {
    channel: "slack",
    accountId: "T1",
    conversationId: "D1",
    threadId: "123.4",
  },
};

function channel(
  setTyping: NonNullable<ChannelAdapter["setTyping"]>,
): ChannelAdapter {
  return {
    channel: "slack",
    capabilities: { text: true, reactions: true, threads: true },
    async receive() {
      return { response: new Response(), events: [] };
    },
    async send() {
      throw new Error("Typing must never send a message");
    },
    setTyping,
  };
}

test("status cleanup waits for a late start and never repeats the model or overlaps updates", async () => {
  vi.useFakeTimers();
  try {
    const started = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<string>();
    const work = vi.fn(() => answer.promise);
    const updates: boolean[] = [];
    const adapter = channel(async (_event, active) => {
      updates.push(active);
      if (active) await started.promise;
    });
    const result = withTyping(
      adapter,
      event,
      new AbortController().signal,
      work,
    );
    expect(work).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(updates).toEqual([true]);
    answer.resolve("answer");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(updates).toEqual([true]);
    started.resolve();
    expect(await result).toBe("answer");
    expect(updates).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(updates).toEqual([true, false]);
    expect(work).toHaveBeenCalledTimes(1);

    const next = Promise.withResolvers<string>();
    const refresh = vi
      .fn<NonNullable<ChannelAdapter["setTyping"]>>()
      .mockResolvedValue();
    const ongoing = withTyping(
      channel(refresh),
      event,
      new AbortController().signal,
      () => next.promise,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh.mock.calls.map(([, active]) => active)).toEqual([
      true,
      true,
      true,
    ]);
    next.resolve("long answer");
    expect(await ongoing).toBe("long answer");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh.mock.calls.map(([, active]) => active)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test("indicator failure cannot replace or retry inference and clearing ignores its aborted signal", async () => {
  const controller = new AbortController();
  const typing = vi
    .fn<NonNullable<ChannelAdapter["setTyping"]>>()
    .mockRejectedValue(new Error("unavailable"));
  const work = vi.fn(async () => {
    controller.abort();
    throw new Error("original model failure");
  });
  await expect(
    withTyping(channel(typing), event, controller.signal, work),
  ).rejects.toThrow("original model failure");
  expect(work).toHaveBeenCalledTimes(1);
  expect(
    typing.mock.calls.map(([, active, signal]) => [active, signal]),
  ).toEqual([
    [true, controller.signal],
    [false, undefined],
  ]);
});
