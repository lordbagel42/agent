import { expect, test, vi } from "vitest";
import type { MessageEvent, ProviderTimingStage } from "../core/contracts.js";
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

test("private report separates answer readiness from late retirement without mixing calls or recreating traces", () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  try {
    const latency = createLatencyDiagnostics();
    const event: MessageEvent = {
      type: "message",
      id: "private-event",
      senderId: "private-sender",
      messageId: "1800000000.000000",
      occurredAt: 1800000000000,
      address: {
        channel: "slack",
        accountId: "private-account",
        conversationId: "private-conversation",
      },
      direct: true,
      text: "private-prompt",
    };
    const reportEvent = { ...event, id: "report-request" };
    const absent = latency.providerTiming(event, "fast");
    absent("submitted");
    expect(latency.snapshot().traces).toEqual([]);
    latency.begin(event);
    absent("retired");
    for (const [stage, at] of [
      ["context_started", 0],
      ["context_memory_ready", 1],
      ["context_platform_ready", 2],
      ["context_continuity_ready", 4],
      ["context_prompt_ready", 5],
      ["context_roster_ready", 8],
      ["context_ready", 9],
    ] as const) {
      clock.mockReturnValue(at);
      latency.mark(event, stage as LatencyStage);
    }
    const first = latency.providerTiming(event, "fast");
    clock.mockReturnValue(10);
    first("submitted");
    clock.mockReturnValue(100);
    first("terminal");
    clock.mockReturnValue(120);
    first("validated");
    latency.mark(event, "finished");
    latency.mark(event, "released");
    const second = latency.providerTiming(event, "deep");
    second("submitted");
    clock.mockReturnValue(150);
    second("retired");
    first("private-secret" as ProviderTimingStage);
    latency.begin(reportEvent);
    const pending = latency.report("recent", reportEvent, "revision");
    expect(pending).toContain("1 retained sample(s)");
    expect(pending).toContain(
      "Context preparation: memory 1.0ms; platform 1.0ms; continuity 2.0ms; prompt/typing preference 1.0ms; worker roster 3.0ms; host status 1.0ms.",
    );
    expect(pending).toContain("submitted→terminal 90.0ms; validation 20.0ms");
    expect(pending).toContain("answer-ready 120.0ms since arrival");
    expect(pending).toContain("submitted→answer-ready 110.0ms");
    expect(pending).toContain(
      "cleanup unobserved; missing stages: provider_retired",
    );
    clock.mockReturnValue(300);
    first("retired");
    expect(latency.report("recent", reportEvent)).toContain(
      "cleanup 180.0ms; missing stages: none",
    );
    expect(JSON.stringify(latency.snapshot())).not.toMatch(/private-/);
    expect(latency.report("recent", reportEvent)).not.toMatch(/private-/);
    for (let i = 0; i < 150; i++) first("retired");
    expect(latency.snapshot().traces[0]?.observations).toHaveLength(128);
    for (let i = 0; i < 150; i++) latency.begin({ ...event, id: `event-${i}` });
    latency.begin(event);
    first("retired");
    expect(latency.snapshot().traces.at(-1)?.observations).toEqual([
      { stage: "accepted", ms: 0 },
    ]);
    expect(latency.report("recent", reportEvent)).toContain(
      "missing stages: provider_submitted, provider_terminal, provider_validated, provider_retired",
    );
    expect(latency.report("recent", reportEvent)).toContain(
      "Context preparation: memory unobserved; platform unobserved; continuity unobserved; prompt/typing preference unobserved; worker roster unobserved; host status unobserved.",
    );
  } finally {
    clock.mockRestore();
  }
});
