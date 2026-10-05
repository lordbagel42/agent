import { describe, expect, it } from "vitest";
import {
  filterRows,
  pageItems,
  projectSnapshot,
  timestamp,
} from "./projection.js";
import type { DebugSnapshot } from "./types.js";

const capture = (data: unknown): DebugSnapshot => ({
  id: "capture-1",
  sessionId: "session-1",
  capturedAt: "2026-10-04T12:00:00.000Z",
  revision: "revision-1",
  reason: "Reported symptom, not a diagnosis",
  scope: ["private", "owner"],
  exclusions: ["Logs not retained"],
  data,
});

describe("retained evidence projection", () => {
  it("projects matched timing stages with their elapsed time and exact payload paths", () => {
    const view = projectSnapshot(
      capture({
        timings: {
          coverage: "current-process",
          traces: [
            {
              inputId: "input-one",
              receivedAt: 1000,
              observations: [
                { stage: "context_ready", ms: 37 },
                { stage: "provider_terminal", ms: 1234.5 },
              ],
            },
            { inputId: "input-two", observations: [{ stage: "accepted" }] },
          ],
        },
      }),
    );
    expect(
      view.logs.map(({ path, time, status }) => ({ path, time, status })),
    ).toEqual([
      {
        path: "/data/timings/traces/0/observations/0",
        time: 1037,
        status: "+37.0 ms",
      },
      {
        path: "/data/timings/traces/0/observations/1",
        time: 2234.5,
        status: "+1234.5 ms",
      },
      {
        path: "/data/timings/traces/1/observations/0",
        time: null,
        status: "Elapsed unknown",
      },
    ]);
    expect(view.logs[1]?.payload).toEqual({
      stage: "provider_terminal",
      ms: 1234.5,
    });
  });

  it("supports flat historical captures without inventing dates or successful inference", () => {
    const delivery = {
      phase: "settled",
      message: { lastInboundAt: 1700000000000 },
      result: { status: "unknown", code: "interrupted_send" },
    };
    const view = projectSnapshot(
      capture({
        events: {
          "event/a~b": {
            event: { occurredAt: 1000, text: "hello" },
            done: true,
          },
        },
        history: [
          { id: "1700000000.000:reply", role: "assistant", content: "reply" },
        ],
        deliveries: { delivery },
        modelInvocations: { invocation: "settled" },
      }),
    );
    expect(view.timeline[0]).toMatchObject({
      path: "/data/events/event~1a~0b",
      time: 1000,
      status: "Workflow complete",
    });
    expect(view.deliveries[0]).toMatchObject({
      time: null,
      status: "unknown",
      payload: delivery,
    });
    expect(view.messages[0]?.time).toBeNull();
    expect(
      view.timeline.find((row) => row.kind === "Model marker"),
    ).toMatchObject({ time: null, status: "settled" });
    expect(view.modelRequest).toBeUndefined();
  });

  it("keeps coordinator and activity evidence distinct and links exact payloads", () => {
    const turn = {
      eventId: "same",
      receivedAt: 2000,
      inference: "confirmed_stopped",
      hold: "delivery",
      deliveries: [
        {
          phase: "settled",
          result: { status: "sent" },
          content: { type: "text", text: "hi" },
        },
      ],
    };
    const request = { system: "instructions", messages: [] };
    const view = projectSnapshot(
      capture({
        coordinator: {
          history: [{ id: "same", role: "user", content: "hi" }],
          modelRequest: request,
        },
        activity: {
          history: [{ eventId: "same", role: "user", content: "hi" }],
          turns: [turn],
        },
        activityCapturedAt: "2026-10-04T12:00:01.000Z",
      }),
    );
    expect(view.messages.map((row) => row.path)).toEqual([
      "/data/coordinator/history/0",
      "/data/activity/history/0",
    ]);
    expect(
      view.timeline.find((row) => row.kind === "Activity turn"),
    ).toMatchObject({
      path: "/data/activity/turns/0",
      time: 2000,
      timeLabel: "Input received",
      payload: turn,
    });
    expect(view.deliveries[0]).toMatchObject({
      path: "/data/activity/turns/0/deliveries/0",
      time: null,
    });
    expect(view.modelRequest).toEqual(request);
    expect(view.activityCapturedAt).toBe(1791115201000);
  });

  it("tolerates unavailable or unexpected historical sections without rewriting raw evidence", () => {
    const snapshot = capture({
      coordinator: { events: null, history: "unavailable" },
      activity: null,
    });
    const view = projectSnapshot(snapshot);
    expect(view.timeline).toEqual([]);
    expect(view.messages).toEqual([]);
    expect(view.activityAvailable).toBe(false);
    expect(snapshot.data).toEqual({
      coordinator: { events: null, history: "unavailable" },
      activity: null,
    });
  });

  it("orders the timeline newest first while keeping ties and untimed evidence in source order", () => {
    const snapshot = capture({
      coordinator: {
        events: {
          middle: { event: { occurredAt: 2000 } },
          oldest: { event: { occurredAt: 0 } },
          newest: { event: { occurredAt: 6000 } },
        },
        pending: { tied: { occurredAt: 2000 } },
        modelInvocations: { untimed: "settled" },
        history: [
          { role: "user", content: "First message" },
          { role: "assistant", content: "Second message" },
        ],
      },
      activity: { turns: [{ eventId: "turn", receivedAt: 5000 }] },
    });
    const original = structuredClone(snapshot);
    const view = projectSnapshot(snapshot);

    expect(view.timeline.map((row) => row.path)).toEqual([
      "/data/coordinator/events/newest",
      "/data/activity/turns/0",
      "/data/coordinator/events/middle",
      "/data/coordinator/pending/tied",
      "/data/coordinator/events/oldest",
      "/data/coordinator/modelInvocations/untimed",
      "/data/coordinator/history/0",
      "/data/coordinator/history/1",
    ]);
    expect(
      pageItems(filterRows(view.timeline, "/events/"), 1, 2).items.map(
        (row) => row.path,
      ),
    ).toEqual(["/data/coordinator/events/oldest"]);
    expect(view.messages.map((row) => row.title)).toEqual([
      "First message",
      "Second message",
    ]);
    expect(snapshot).toEqual(original);
  });

  it("searches complete retained payloads before pagination, including hostile text as plain data", () => {
    const view = projectSnapshot(
      capture({
        history: Array.from({ length: 83 }, (_, index) => ({
          role: "user",
          content: `${"long ".repeat(300)}${index === 82 ? "<script>needle</script>" : index}`,
        })),
      }),
    );
    const matches = filterRows(view.messages, "<script>needle");
    expect(matches.map((row) => row.path)).toEqual(["/data/history/82"]);
    expect(pageItems(view.messages, 2, 40).items).toHaveLength(3);
    expect(pageItems(view.messages, 9, 40)).toMatchObject({
      page: 2,
      pages: 3,
    });
    expect(pageItems([], 4, 40)).toMatchObject({
      page: 0,
      pages: 1,
      items: [],
    });
  });

  it("accepts explicit retained timestamps but not opaque IDs or timezone-ambiguous strings", () => {
    expect(timestamp(0)).toBe(0);
    expect(timestamp("2026-10-04T12:00:00.000Z")).toBe(1791115200000);
    for (const value of [
      null,
      undefined,
      "1700000000.001",
      "2026-10-04",
      "2026-10-04T12:00:00",
      Infinity,
      -1,
    ]) {
      expect(timestamp(value)).toBeNull();
    }
  });
});
