import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RawAccess } from "rivetkit/db";
import { expect, it, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type { MessageEvent, OutboundMessage } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { DebugSitePublishError } from "../diagnostics/publisher.js";
import { EvidenceStore } from "../memory/store.js";
import { initialSessionDirectory } from "../sessions/state.js";
import { initializeDebugBodies } from "./debug-bodies.js";
import { conversationInputId } from "./inbox.js";
import { createJuneRegistry } from "./registry.js";
import {
  createDebugShareActor,
  type DebugSnapshot,
} from "./session-controls.js";

it("acknowledges DEBUG while its independent upload waits and shares website links only in owner DMs", async (t) => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const sent: OutboundMessage[] = [];
  const captured: DebugSnapshot[] = [];
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  t.onTestFinished(() => finish());
  const { client } = await setupTest(
    t,
    createJuneRegistry({
      owner,
      debugSite: {
        url: (id) => `https://debug.example.test/s/${id}`,
        publish: async (snapshot) => {
          captured.push(snapshot);
          await waiting;
        },
      },
      debugShare: {
        run: async () => {
          throw new Error("DEBUG must not investigate");
        },
      },
      model: {
        reply: async () => {
          throw new Error("DEBUG must not infer");
        },
      },
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, threads: true, reactions: true },
          receive: async () => ({ events: [], response: new Response() }),
          send: async (message) => {
            sent.push(message);
            return { status: "sent", messageId: "ack" };
          },
        },
      },
    }),
  );
  const event: MessageEvent = {
    type: "message",
    id: "standalone-debug",
    messageId: "1791141720.001",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    senderId: "U1",
    text: "DEBUG delayed reply",
    direct: true,
    sessionCommandEligible: true,
  };
  await client.conversation.getOrCreate(["private", owner.id]).receive(event);
  await vi.waitFor(
    () =>
      expect(
        sent.some(
          (item) =>
            item.address.conversationId === "D1" &&
            item.content.type === "text" &&
            item.content.text.includes("https://debug.example.test/s/"),
        ),
      ).toBe(true),
    { timeout: 10_000 },
  );
  await vi.waitFor(() => expect(captured).toHaveLength(1), { timeout: 10_000 });
  const id = captured[0]?.id as string;
  expect(await client.debugShare.get([id]).inspect()).toMatchObject({
    status: "saved",
    website: { status: "pending" },
  });
  finish();
  await vi.waitFor(
    async () =>
      expect(await client.debugShare.get([id]).inspect()).toMatchObject({
        website: { status: "saved" },
      }),
    { timeout: 10_000 },
  );
  const guest: MessageEvent = {
    ...event,
    id: "guest-debug",
    senderId: "U2",
    direct: false,
    address: { ...event.address, conversationId: "C1" },
    metadata: { channelType: "channel" },
  };
  const scope = routeEvent(guest, owner, true);
  if (!scope) throw new Error("missing guest scope");
  await client.conversation.getOrCreate(scope.key).receive(guest);
  await vi.waitFor(
    () =>
      expect(sent.some((item) => item.address.conversationId === "C1")).toBe(
        true,
      ),
    { timeout: 10_000 },
  );
  expect(
    sent
      .filter((item) => item.address.conversationId === "C1")
      .every(
        (item) =>
          item.content.type !== "text" ||
          !item.content.text.includes("debug.example.test"),
      ),
  ).toBe(true);
  await vi.waitFor(
    () =>
      expect(
        sent.some(
          (item) =>
            item.address.conversationId === "U1" &&
            item.content.type === "text" &&
            item.content.text.includes("https://debug.example.test/s/"),
        ),
      ).toBe(true),
    { timeout: 10_000 },
  );
  expect(
    await client.conversation.get(["private", owner.id]).debugShares(),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id,
        website: expect.objectContaining({ status: "saved" }),
      }),
    ]),
  );
});

it("revalidates tombstones and context provenance before uploading a fresh DEBUG when cleanup was interrupted", async (t) => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const audience = JSON.stringify(["private", "owner"]);
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const message = (id: string): MessageEvent => ({
    type: "message",
    id,
    messageId: id,
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    senderId: "U1",
    direct: true,
    text: id,
    sessionCommandEligible: true,
  });
  const source = (event: MessageEvent) => ({
    id: event.id,
    audiences: [audience],
    platform: "slack",
    account: "T1",
    conversation: "D1",
    author: "U1",
    observedAt: event.occurredAt,
    sourceUrl: "https://example.invalid/private",
    text: event.text,
  });
  const names = [
    "REMOVE_DIRECT",
    "REMOVE_DEPENDENT",
    "REMOVE_LEGACY",
    "REMOVE_PLATFORM",
    "REMOVE_UNKNOWN_CONTEXT",
    "REMOVE_FORGOTTEN",
    "KEEP_ELIGIBLE",
  ];
  const events = names.map(message);
  for (const event of events) store.appendSource(source(event));
  const ids = events.map((event) =>
    conversationInputId({ type: "event", event }),
  );
  const personality = createHash("sha256").update("{}").digest("hex");
  const references = events.map((event) => ({
    sourceIds: [event.id],
    contextSourceIds:
      event.id === "REMOVE_DEPENDENT"
        ? ["REMOVE_DIRECT"]
        : event.id === "REMOVE_PLATFORM"
          ? ["volatile-context:platform"]
          : event.id === "REMOVE_UNKNOWN_CONTEXT"
            ? ["unretained-context"]
            : [],
    personality,
    deletionTracked: true as const,
  }));
  const captured: DebugSnapshot[] = [];
  const registry = createJuneRegistry({
    owner,
    memory: { store, source },
    debugSite: {
      url: (id) => `https://debug.example/s/${id}`,
      publish: async (snapshot) => {
        captured.push(snapshot);
      },
    },
    model: {
      reply: async () => {
        throw new Error("No model for DEBUG");
      },
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: false, threads: false },
        receive: async () => ({ events: [], response: new Response() }),
        send: async () => ({ status: "sent", messageId: "ack" }),
      },
    },
  });
  const config = registry.config.use.conversation.config;
  const initial = "state" in config ? config.state : undefined;
  if (!initial || typeof initial !== "object")
    throw new Error("Missing fixture state");
  const sessionId = "b".repeat(64);
  Object.assign(initial, {
    // Persisted coordinator barrier, before the activity cleanup RPC completed.
    forgottenEvents: [ids[names.indexOf("REMOVE_FORGOTTEN")]],
    sessions: {
      directory: {
        ...initialSessionDirectory(["private", "owner"]),
        activeSessionId: sessionId,
      },
      turns: {},
    },
    events: Object.fromEntries(
      events.map((event, i) => [ids[i], { event, done: true }]),
    ),
    history: events.flatMap((event, i) => [
      {
        id: ids[i],
        role: "user",
        sourceId: event.id,
        content: event.text,
        context: references[i],
      },
      {
        id: `${ids[i]}:reply`,
        role: "assistant",
        content: `${event.text}_ANSWER`,
        context: references[i],
      },
    ]),
    memoryContexts: Object.fromEntries(
      ids
        .filter((_, i) => i !== 2)
        .map((id) => [id, references[ids.indexOf(id)]]),
    ),
    deliveries: Object.fromEntries(
      ids.map((id, i) => [
        `${id}:text`,
        {
          phase: "settled",
          attempts: 1,
          result: { status: "sent" },
          message: { content: { type: "text", text: `${names[i]}_DELIVERY` } },
        },
      ]),
    ),
  });
  const activityConfig = registry.config.use.activity.config;
  const activityState =
    "state" in activityConfig ? activityConfig.state : undefined;
  if (!activityState || typeof activityState !== "object")
    throw new Error("Missing activity state");
  const contexts = events.map((source, i) =>
    i === 2
      ? undefined
      : {
          source,
          reference: references[i],
          retentionExcluded: false,
          deletionRevision: 0,
          replyAddress: source.address,
        },
  );
  Object.assign(activityState, {
    binding: { sessionId, scopeKey: ["private", "owner"], openedAt: 0 },
    history: events.map((event, i) => ({
      eventId: ids[i],
      context: contexts[i],
      role: "user",
      content: event.text,
    })),
    turns: Object.fromEntries(
      events.map((event, i) => [
        ids[i],
        {
          acknowledged: true,
          assignment: {
            eventId: ids[i],
            sessionId,
            scopeKey: ["private", "owner"],
            receivedAt: 0,
            openedAt: 0,
            sequence: i + 1,
            kind: "message",
          },
          context: contexts[i],
          reply: { text: `${event.text}_ACTIVITY_ANSWER` },
        },
      ]),
    ),
  });
  // Commit the deletion, deliberately never call conversation.forget.
  store.deleteSource("REMOVE_DIRECT");
  const { client } = await setupTest(t, registry);
  await client.conversation
    .getOrCreate(["private", "owner"])
    .receive({ ...message("capture"), text: "DEBUG safe diagnostic" });
  await vi.waitFor(() => expect(captured).toHaveLength(1), { timeout: 10000 });
  const json = JSON.stringify(captured[0]?.data);
  expect(json).not.toContain("REMOVE_");
  expect(json).toContain("KEEP_ELIGIBLE_ANSWER");
  expect(json).toContain("KEEP_ELIGIBLE_DELIVERY");
  expect(json).toContain("KEEP_ELIGIBLE_ACTIVITY_ANSWER");
});

it.for([false, true])(
  "includes cached requests only while their deletion epoch is current (deleted=%s)",
  async (deleted, t) => {
    const store = new EvidenceStore(":memory:", randomBytes(32));
    t.onTestFinished(() => store.close());
    const captured: DebugSnapshot[] = [];
    const owner = {
      id: "owner",
      identities: [
        { channel: "slack" as const, accountId: "T1", senderId: "U1" },
      ],
    };
    const registry = createJuneRegistry({
      owner,
      memory: {
        store,
        source: () => {
          throw new Error("DEBUG does not ingest memory");
        },
      },
      debugSite: {
        url: (id) => `https://debug.example/s/${id}`,
        publish: async (snapshot) => {
          captured.push(snapshot);
        },
      },
      model: {
        reply: async () => {
          throw new Error("DEBUG does not infer");
        },
      },
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, reactions: false, threads: false },
          receive: async () => ({ events: [], response: new Response() }),
          send: async () => ({ status: "sent", messageId: "ack" }),
        },
      },
    });
    const config = registry.config.use.conversation.config;
    if (!("createVars" in config) || !config.createVars)
      throw new Error("Missing vars");
    const createVars = config.createVars;
    const request = { system: "CACHED_CONTEXT_BODY" };
    config.createVars = async (c, input) => ({
      ...(await createVars(c, input)),
      debugRequest: { value: request, deletionRevision: 0 },
    });
    if (deleted) store.deleteSource("context-without-an-event-receipt");
    const { client } = await setupTest(t, registry);
    await client.conversation.getOrCreate(["private", "owner"]).receive({
      type: "message",
      id: "capture",
      messageId: "1.0",
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      senderId: "U1",
      direct: true,
      text: "DEBUG cached request",
      sessionCommandEligible: true,
    });
    await vi.waitFor(() => expect(captured).toHaveLength(1), {
      timeout: 10000,
    });
    expect(
      (captured[0]?.data as { modelRequest?: unknown } | undefined)
        ?.modelRequest,
    ).toEqual(deleted ? undefined : request);
  },
);

it("fences duplicate wake timers inside the publication lane during an outage", async (t) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  t.onTestFinished(() => clock.mockRestore());
  const publish = vi.fn(async (_snapshot: DebugSnapshot): Promise<void> => {
    throw new DebugSitePublishError("transport", true);
  });
  const config = createDebugShareActor({
    debugSite: {
      url: (id) => `https://debug.example/s/${id}`,
      publish,
    },
  }).config;
  if (
    !("createVars" in config) ||
    !config.createVars ||
    !config.actions ||
    !config.onWake
  )
    throw new Error("Missing debug actor");
  const snapshot: DebugSnapshot = {
    id: "e782a1c4-9d2f-4ace-a1c0-5f3e9d7b1142",
    sessionId: "test",
    capturedAt: "2026-10-04T16:42:00Z",
    revision: "test",
    scope: ["private", "owner"],
    reason: "archive unavailable",
    snapshotOnly: true,
    data: {},
    exclusions: [],
  };
  const scheduled: { at: number; action: string; expected: number }[] = [];
  const work: Promise<unknown>[] = [];
  const sqlite = new DatabaseSync(":memory:");
  t.onTestFinished(() => sqlite.close());
  const db = {
    execute: async (sql: string, ...args: SQLInputValue[]) =>
      sqlite.prepare(sql).all(...args),
  } as RawAccess;
  await initializeDebugBodies(db);
  const c = {
    db,
    key: [snapshot.id],
    state: {},
    async saveState() {},
    keepAwake(promise: Promise<unknown>) {
      work.push(promise);
    },
    schedule: {
      async at(at: number, action: string, expected: number) {
        scheduled.push({ at, action, expected });
      },
    },
  } as unknown as Parameters<typeof config.actions.publishSite>[0];
  c.vars = await config.createVars(c, undefined);
  await config.actions.start(c, snapshot);
  for (const [now, retryAt] of [
    [1000, 16000],
    [16000, 46000],
  ] as const) {
    clock.mockReturnValue(now);
    // Durable schedulers can retain the old timer alongside wake repairs.
    await config.onWake(c);
    await config.onWake(c);
    const callbacks = scheduled.splice(0);
    expect(callbacks).toHaveLength(3);
    for (const callback of callbacks)
      config.actions.publishSite(c, callback.expected);
    await Promise.all(work.splice(0));
    expect(scheduled).toEqual([
      { at: retryAt, action: "publishSite", expected: retryAt },
    ]);
  }
  expect(publish).toHaveBeenCalledTimes(2);
  // A late callback from an already-consumed generation does not replace its successor.
  config.actions.publishSite(c, 1000);
  await Promise.all(work.splice(0));
  expect(scheduled).toHaveLength(1);
  clock.mockReturnValue(46000);
  publish.mockResolvedValueOnce(undefined);
  config.actions.publishSite(c, scheduled.shift()?.expected ?? 0);
  await Promise.all(work.splice(0));
  expect(publish).toHaveBeenCalledTimes(3);
  expect(publish.mock.calls.map(([value]) => value)).toEqual([
    snapshot,
    snapshot,
    snapshot,
  ]);
  expect(c.state.website).toMatchObject({ status: "saved", attempts: 3 });
  expect(scheduled).toEqual([]);
});
