import { describe, expect, it } from "vitest";
import type { MessageEvent } from "../core/contracts.js";
import { acceptEvent, applyAction, initialState, tick } from "./state.js";

const now = Date.parse("2026-09-27T16:00:00Z");
const source: MessageEvent = {
  type: "message",
  id: "request-1",
  messageId: "123.456",
  occurredAt: now,
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  direct: true,
  senderId: "U1",
  text: "DM me after the next successful deploy",
};
const watch = {
  action: "create" as const,
  name: "Next deploy",
  instruction: "Tell me the deployed revision",
  once: true,
  trigger: {
    kind: "event" as const,
    source: "deployment",
    type: "healthy",
    filters: [{ path: "branch", value: "main" }],
  },
};
const event = {
  id: "51",
  source: "deployment",
  type: "healthy",
  occurredAt: now + 1,
  data: { branch: "main", revision: "abc" },
};

describe("durable wakeup state", () => {
  it("bounds decision backlog without coalescing or remembering rejected events", () => {
    const state = initialState();
    applyAction(
      state,
      { ...watch, once: false },
      source,
      "decision:deployment",
      now,
      ["deployment"],
    );
    const job = state.jobs["decision:deployment"];
    if (!job) throw new Error("Missing fixture job");
    job.mode = "decision";
    for (let i = 0; i < 100; i++)
      acceptEvent(state, { ...event, id: String(i) }, now + 10);
    expect(Object.values(state.runs)).toHaveLength(100);
    expect(job.coalesced).toBe(0);
    const full = JSON.stringify(state);
    expect(() =>
      acceptEvent(state, { ...event, id: "overflow" }, now + 10),
    ).toThrow("event_decision_capacity");
    expect(JSON.stringify(state)).toBe(full);
    expect(acceptEvent(state, { ...event, id: "0" }, now + 10)).toEqual({
      accepted: true,
      duplicate: true,
    });
    const first = Object.values(state.runs)[0];
    if (first) first.status = "completed";
    expect(acceptEvent(state, { ...event, id: "overflow" }, now + 10)).toEqual({
      accepted: true,
      duplicate: false,
    });
    applyAction(state, watch, source, "explicit", now, ["deployment"]);
    acceptEvent(state, { ...event, id: "requested" }, now + 10);
    expect(
      Object.values(state.runs)
        .filter((run) => run.event.id === "requested")
        .map((run) => run.jobId),
    ).toEqual(["explicit"]);
    applyAction(
      state,
      { action: "cancel", id: job.id },
      source,
      "cancel",
      now,
      ["deployment"],
    );
    tick(state, now + 8 * 86400000);
    expect(state.jobs[job.id]?.status).toBe("cancelled");
  });

  it("matches exact source/type/filters only after registration and consumes one-shot once", () => {
    const state = initialState();
    applyAction(state, watch, source, "watch-1", now, ["deployment"]);
    for (const wrong of [
      { ...event, id: "old", occurredAt: now - 1 },
      { ...event, id: "other-source", source: "webhook.deploy" },
      { ...event, id: "failed", type: "failed" },
      { ...event, id: "branch", data: { branch: "feature" } },
    ])
      acceptEvent(state, wrong, now + 10);
    expect(Object.values(state.runs)).toHaveLength(0);
    acceptEvent(state, event, now + 10);
    // Persistence round trip, not an in-memory duplicate set.
    const restored = JSON.parse(JSON.stringify(state));
    acceptEvent(restored, event, now + 20);
    acceptEvent(restored, { ...event, id: "52" }, now + 20);
    expect(Object.values(restored.runs)).toHaveLength(1);
    expect(restored.jobs["watch-1"].status).toBe("completed");
    const waiting = initialState();
    applyAction(waiting, watch, source, "later", now, ["deployment"]);
    const muchLater = now + 8 * 86_400_000;
    acceptEvent(waiting, { ...event, occurredAt: muchLater }, muchLater);
    const run = Object.values(waiting.runs)[0];
    expect(run).toBeDefined();
    if (run) run.status = "completed";
    tick(waiting, muchLater + 1);
    expect(waiting.jobs.later?.status).toBe("completed");
    tick(waiting, muchLater + 8 * 86_400_000);
    expect(waiting.jobs.later).toBeUndefined();
  });

  it("coalesces overdue cron ticks, persists a strictly future Boise deadline, and does not run while paused", () => {
    const state = initialState();
    applyAction(
      state,
      {
        ...watch,
        once: false,
        trigger: {
          kind: "cron",
          expression: "15 9 * * *",
          timezone: "America/Boise",
        },
      },
      source,
      "cron-1",
      now,
      [],
    );
    expect(state.jobs["cron-1"]?.nextAt).toBe(
      Date.parse("2026-09-27T15:15:00Z") + 86_400_000,
    );
    const late = Date.parse("2026-09-30T18:00:00Z");
    tick(state, late);
    tick(state, late);
    expect(Object.values(state.runs)).toHaveLength(1);
    expect(state.jobs["cron-1"]?.nextAt).toBe(
      Date.parse("2026-10-01T15:15:00Z"),
    );
    applyAction(
      state,
      { action: "pause", id: "cron-1" },
      source,
      "pause",
      late,
      [],
    );
    expect(Object.values(state.runs)[0]?.status).toBe("cancelled");
    tick(state, Date.parse("2026-10-02T18:00:00Z"));
    expect(Object.values(state.runs)).toHaveLength(1);
  });

  it("fires an overdue one-time timer once after recovery and rejects invalid schedules and sources", () => {
    const state = initialState();
    applyAction(
      state,
      { ...watch, trigger: { kind: "at", at: "2026-09-27T16:01:00Z" } },
      source,
      "timer-1",
      now,
      [],
    );
    const restored = JSON.parse(JSON.stringify(state));
    tick(restored, now + 120_000);
    tick(restored, now + 180_000);
    expect(Object.values(restored.runs)).toHaveLength(1);
    expect(restored.jobs["timer-1"].status).toBe("completed");
    expect(() =>
      applyAction(state, watch, source, "bad-source", now, []),
    ).toThrow();
    for (const trigger of [
      { kind: "at", at: "2026-09-27T16:00:00" },
      { kind: "at", at: "2026-09-26T16:00:00Z" },
      { kind: "cron", expression: "* * * * * *", timezone: "UTC" },
      { kind: "cron", expression: "0 9 * * *", timezone: "not/a-zone" },
    ])
      expect(() =>
        applyAction(state, { ...watch, trigger }, source, "bad", now, []),
      ).toThrow();
  });

  it("bounds a busy repeating watch and does not revive it on duplicate create or resume after cancellation", () => {
    const state = initialState();
    applyAction(state, { ...watch, once: false }, source, "watch-1", now, [
      "deployment",
    ]);
    acceptEvent(state, event, now + 10);
    acceptEvent(state, { ...event, id: "52" }, now + 20);
    expect(Object.values(state.runs)).toHaveLength(1);
    expect(state.jobs["watch-1"]?.coalesced).toBe(1);
    applyAction(
      state,
      { action: "cancel", id: "watch-1" },
      source,
      "cancel",
      now + 30,
      [],
    );
    applyAction(state, watch, source, "watch-1", now + 40, ["deployment"]);
    expect(state.jobs["watch-1"]?.status).toBe("cancelled");
    expect(() =>
      applyAction(
        state,
        { action: "resume", id: "watch-1" },
        source,
        "resume",
        now + 40,
        [],
      ),
    ).toThrow();
    expect(() =>
      applyAction(
        state,
        { action: "pause", id: "watch-1" },
        source,
        "pause",
        now + 40,
        [],
      ),
    ).toThrow();
    const completed = initialState();
    applyAction(completed, watch, source, "once", now, ["deployment"]);
    acceptEvent(completed, event, now + 10);
    expect(() =>
      applyAction(
        completed,
        { action: "pause", id: "once" },
        source,
        "pause",
        now + 40,
        [],
      ),
    ).toThrow();
  });
});
