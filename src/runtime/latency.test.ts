import { expect, test } from "vitest";
import type { MessageEvent } from "../core/contracts.js";
import { createLatencyDiagnostics, type LatencyStage } from "./latency.js";

test("timing observations retain no content or identities, stay bounded, and never invent replay measurements", () => {
  const latency = createLatencyDiagnostics();
  const event: MessageEvent = {
    type: "message",
    id: "private-event",
    senderId: "private-sender",
    messageId: "1800000000.123456",
    occurredAt: 1800000000123,
    address: {
      channel: "slack",
      accountId: "private-account",
      conversationId: "private-conversation",
    },
    direct: true,
    text: "private-message",
    metadata: { senderName: "private-name" },
  };
  latency.mark(event, "fast_started");
  expect(latency.snapshot().traces).toEqual([]);
  latency.begin(event);
  const before = latency.snapshot().traces[0];
  latency.begin(event);
  latency.mark(event, "private-prompt" as LatencyStage);
  latency.delivered(
    event,
    "text",
    { status: "sent", messageId: "1800000001.000001" },
    false,
  );
  const snapshot = latency.snapshot();
  expect(snapshot.traces).toHaveLength(1);
  expect(snapshot.traces[0]?.id).toBe(before?.id);
  expect(snapshot.traces[0]?.receivedAt).toBe(before?.receivedAt);
  expect(snapshot.traces[0]?.deliveries[0]?.platformMs).toBe(876.545);
  expect(JSON.stringify(snapshot)).not.toMatch(/private-|1800000000\.123456/);
  snapshot.traces[0]?.observations.splice(0);
  for (let i = 0; i < 150; i++) latency.mark(event, "fast_started");
  expect(latency.snapshot().traces[0]?.observations).toHaveLength(128);
  for (let i = 0; i < 150; i++) latency.begin({ ...event, id: `event-${i}` });
  expect(latency.snapshot().traces).toHaveLength(128);
  expect(latency.snapshot().traces.some((t) => t.id === before?.id)).toBe(
    false,
  );
});
