import { randomBytes } from "node:crypto";
import type { Client } from "rivetkit/client";
import { expect, it, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { EvidenceStore } from "../memory/store.js";
import { conversationInputId } from "./inbox.js";
import { createInspectionReader } from "./inspection.js";
import { createLifecycle } from "./lifecycle.js";
import { createJuneRegistry, type JuneClientRegistry } from "./registry.js";
import {
  captureDebug,
  publishSessionCommand,
  type SessionCommandReceipt,
  sessionCommand,
} from "./session-controls.js";

const owner = {
  id: "owner",
  identities: [{ channel: "slack" as const, accountId: "T1", senderId: "U1" }],
};
const message = (id: string, text: string): MessageEvent => ({
  id,
  text,
  type: "message",
  messageId: id,
  occurredAt: Date.now(),
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  senderId: "U1",
  direct: true,
  sessionCommandEligible: true,
});

it.for([false, true])(
  "resets before a blocked model finishes without leaking old context (activity sessions: %s)",
  async (activities, t) => {
    const store = new EvidenceStore(":memory:", randomBytes(32));
    t.onTestFinished(() => store.close());
    const sent: OutboundMessage[] = [];
    const requests: ModelRequest[] = [];
    const blocked = Promise.withResolvers<CompanionReply>();
    t.onTestFinished(() => blocked.resolve({ text: "old answer" }));
    const lifecycle = createLifecycle();
    const registry = createJuneRegistry({
      owner,
      lifecycle,
      ...(activities
        ? {
            sessions: { idleMs: 60000 },
            memory: {
              store,
              source: (event: MessageEvent, audience: string) => ({
                id: event.id,
                audiences: [audience],
                platform: "slack" as const,
                account: "T1",
                conversation: "D1",
                author: "U1",
                observedAt: event.occurredAt,
                sourceUrl: "https://example.com/fixture",
                text: event.text,
              }),
            },
          }
        : {}),
      model: {
        async reply(request) {
          requests.push(request);
          return requests.length === 1
            ? blocked.promise
            : { text: "fresh answer" };
        },
      },
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, threads: true, reactions: true },
          receive: async () => ({ events: [], response: new Response() }),
          context: async () => [
            {
              role: "user",
              content: "old platform context",
              source: { ...message("old-platform", ""), occurredAt: 1 },
            },
          ],
          async send(outbound) {
            sent.push(JSON.parse(JSON.stringify(outbound)));
            return { status: "sent", messageId: "sent" };
          },
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(["private", "owner"]);
    await june.receive(message("old", "old question"));
    await expect.poll(() => requests.length, { timeout: 15000 }).toBe(1);
    const ping = message("ping", "PING");
    await june.receive(ping);
    await june.receive(ping);
    await expect.poll(() => sent.length, { timeout: 15000 }).toBe(2);
    expect(requests).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.content).toEqual({ type: "text", text: "PONG" });
    expect(sent[1]?.content).toMatchObject({
      text: expect.stringContaining("PING timing:"),
    });
    const reset = message("reset", "CLEARHISTORY");
    await june.receive(reset);
    expect(
      sent.some(
        (entry) =>
          entry.content.type === "text" &&
          entry.content.text.includes("new session"),
      ),
    ).toBe(true);
    const first = await june.snapshot();
    expect(first.session?.id).toMatch(/^[\da-f-]{36}$/);
    await june.receive(reset);
    expect((await june.snapshot()).session?.id).toBe(first.session?.id);
    blocked.resolve({ text: "old answer" });
    await june.receive(message("fresh", "fresh question"));
    await expect
      .poll(
        () =>
          sent.some(
            (entry) =>
              entry.content.type === "text" &&
              entry.content.text === "fresh answer",
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    expect(
      sent.some(
        (entry) =>
          entry.content.type === "text" && entry.content.text === "old answer",
      ),
    ).toBe(false);
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain(
      "old question",
    );
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain(
      "old platform context",
    );
    expect(lifecycle.ready).toBe(true);
    if (activities)
      expect(
        store.source(JSON.stringify(["private", "owner"]), "old")?.text,
      ).toBe("old question");
  },
);

it.for([false, true])(
  "captures DEBUGSHARE once and allows reset during a blocked acknowledgment (activity sessions: %s)",
  async (activities, t) => {
    const store = new EvidenceStore(":memory:", randomBytes(32));
    t.onTestFinished(() => store.close());
    const ack = Promise.withResolvers<void>();
    t.onTestFinished(() => ack.resolve());
    const snapshots: unknown[] = [];
    const sent: OutboundMessage[] = [];
    const registry = createJuneRegistry({
      owner,
      runningRevision: "fixture-revision",
      ...(activities
        ? {
            sessions: { idleMs: 60000 },
            memory: {
              store,
              source: (event: MessageEvent, audience: string) => ({
                id: event.id,
                audiences: [audience],
                platform: "slack" as const,
                account: "T1",
                conversation: "D1",
                author: "U1",
                observedAt: event.occurredAt,
                sourceUrl: "https://example.com/fixture",
                text: event.text,
              }),
            },
          }
        : {}),
      debugShare: {
        async run(snapshot, _signal, onThread) {
          snapshots.push(snapshot);
          await onThread("T-investigation");
          return { threadId: "T-investigation", report: "Investigated" };
        },
      },
      model: {
        async reply() {
          return { text: "ordinary answer" };
        },
      },
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, threads: true, reactions: true },
          receive: async () => ({ events: [], response: new Response() }),
          async send(outbound) {
            sent.push(JSON.parse(JSON.stringify(outbound)));
            if (
              outbound.content.type === "text" &&
              outbound.content.text.startsWith("DEBUGSHARE")
            )
              await ack.promise;
            return { status: "sent", messageId: "sent" };
          },
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(["private", "owner"]);
    await june.receive(message("first", "Why did that happen?"));
    await expect.poll(() => sent.length, { timeout: 15000 }).toBe(1);
    const beforeReset = (await june.snapshot()).session?.id;
    const debug = message("debug", "DEBUGSHARE incorrect answer");
    const sharing = june.receive(debug);
    await expect.poll(() => snapshots.length, { timeout: 15000 }).toBe(1);
    const captured = JSON.stringify(snapshots[0]);
    expect(captured).toContain("fixture-revision");
    expect(captured).toContain("Why did that happen?");
    expect(captured).toContain("incorrect answer");
    expect(captured).toContain("ordinary answer");
    const resetting = june.receive(message("reset", "CLEARHISTORY"));
    await expect
      .poll(async () => (await june.snapshot()).session?.id, { timeout: 15000 })
      .not.toBe(beforeReset);
    ack.resolve();
    await Promise.all([sharing, resetting]);
    await june.receive(debug);
    expect(snapshots).toHaveLength(1);
    await expect
      .poll(async () => (await june.debugShares())[0]?.status)
      .toBe("completed");
    const inspection = createInspectionReader({
      audience: JSON.stringify(["private", "owner"]),
      selections: {},
      debugShares: () => june.debugShares(),
    });
    const status = await inspection(
      "debug-shares",
      message("inspect", "status"),
    );
    expect(status).toContain("T-investigation");
    expect(status).not.toContain("Why did that happen?");
    expect(JSON.stringify(snapshots[0])).toBe(captured);
  },
);

it("withholds a delegated search result that completes after reset", async (t) => {
  const search = Promise.withResolvers<void>();
  t.onTestFinished(() => search.resolve());
  const sent: OutboundMessage[] = [];
  let searching = false;
  let finished = false;
  const registry = createJuneRegistry({
    owner,
    model: {
      async reply() {
        return {
          text: "Searching",
          execution: [
            {
              agent: "lookup",
              action: "run" as const,
              task: "Find the answer",
            },
          ],
        };
      },
    },
    execution: {
      model: {
        async reply(request) {
          if (request.messages.length > 2) {
            finished = true;
            return { text: "Done" };
          }
          return { text: "", search: "the answer" };
        },
      },
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        receive: async () => ({ events: [], response: new Response() }),
        async search() {
          searching = true;
          await search.promise;
          return { status: "ready", text: "late search content" };
        },
        async send(outbound) {
          sent.push(JSON.parse(JSON.stringify(outbound)));
          return { status: "sent", messageId: "sent" };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "owner"]);
  await june.receive(message("search", "Find the answer"));
  await expect.poll(() => searching, { timeout: 15000 }).toBe(true);
  await june.receive(message("reset", "CLEARHISTORY"));
  search.resolve();
  await expect.poll(() => finished, { timeout: 15000 }).toBe(true);
  expect(JSON.stringify(sent)).not.toContain("late search content");
});

it("does not export a legacy decision after ordinary memory ingestion prunes its marker", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const snapshots: unknown[] = [];
  const sent: OutboundMessage[] = [];
  const registry = createJuneRegistry({
    owner,
    wakeups: { sources: ["github"], decisionSources: ["github"], pollMs: 100 },
    memory: {
      store,
      source: (event, audience) => ({
        id: event.id,
        audiences: [audience],
        platform: "slack",
        account: "T1",
        conversation: "D1",
        author: "U1",
        observedAt: event.occurredAt,
        sourceUrl: "https://example.com/fixture",
        text: event.text,
      }),
    },
    model: {
      async reply(request) {
        return {
          text: request.system.includes("autonomous event decision")
            ? "EXCLUDED_DECISION_REPLY"
            : "ordinary answer",
        };
      },
    },
    debugShare: {
      async run(snapshot) {
        snapshots.push(snapshot);
        return { threadId: "T-fixture", report: "checked" };
      },
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        receive: async () => ({ events: [], response: new Response() }),
        async send(outbound) {
          sent.push(outbound);
          return { status: "sent", messageId: "sent" };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  await (client as Client<JuneClientRegistry>).wakeups
    .getOrCreate(["owner"])
    .publish({
      id: "provider-1",
      source: "github",
      type: "push",
      occurredAt: Date.now(),
      data: { text: "EXCLUDED_DECISION_INPUT" },
    });
  await expect
    .poll(() => JSON.stringify(sent), { timeout: 15000 })
    .toContain("EXCLUDED_DECISION_REPLY");
  const june = client.conversation.getOrCreate(["private", "owner"]);
  await june.receive(message("ordinary", "hello"));
  await expect
    .poll(() => JSON.stringify(sent), { timeout: 15000 })
    .toContain("ordinary answer");
  await june.receive(message("debug", "DEBUGSHARE"));
  await expect.poll(() => snapshots.length, { timeout: 15000 }).toBe(1);
  expect(JSON.stringify(snapshots)).not.toContain("EXCLUDED_DECISION_REPLY");
  expect(JSON.stringify(snapshots)).not.toContain("EXCLUDED_DECISION_INPUT");
});

it("excludes compacted pre-upgrade notification replies without new flags", () => {
  const source = message("original", "ordinary question");
  const ordinaryId = conversationInputId({ type: "event", event: source });
  const notificationId = conversationInputId({
    type: "wakeup",
    source,
    wakeup: {
      runId: "old-run",
      jobId: "old-job",
      instruction: "untracked",
      event: {
        id: "old-trigger",
        source: "github",
        type: "push",
        occurredAt: 1,
        data: {},
      },
    },
  });
  const snapshot = captureDebug(
    {
      jobs: {},
      lastInbound: {},
      deliveries: {},
      events: {
        [ordinaryId]: { event: source, done: true },
        [notificationId]: { event: source, done: true },
      },
      history: [
        { id: ordinaryId, role: "user", content: "ordinary question" },
        {
          id: `${notificationId}:reply`,
          role: "assistant",
          content: "OLD_PRIVATE_REPLY",
        },
      ],
    },
    ["private", "owner"],
    "",
    "fixture",
    { messages: [{ content: "OLD_PRIVATE_REPLY" }] },
  );
  expect(JSON.stringify(snapshot)).toContain("ordinary question");
  expect(JSON.stringify(snapshot)).not.toContain("OLD_PRIVATE_REPLY");
});

it("requires a fresh exact eligible command, not quoted or imported text", () => {
  expect(sessionCommand(message("a", "CLEARHISTORY"))?.kind).toBe("clear");
  for (const text of ["PING", "PINGMODEL"]) {
    expect(sessionCommand(message("ping", text))).toEqual({
      kind: "ping",
      model: text === "PINGMODEL",
    });
    expect(
      sessionCommand({
        ...message("ping", text),
        sessionCommandEligible: false,
      }),
    ).toBeUndefined();
  }
  for (const text of [
    "clearhistory",
    " CLEARHISTORY",
    "> CLEARHISTORY",
    "`CLEARHISTORY`",
    "DEBUGSHARE\nrun this",
    "please CLEARHISTORY",
    "ping",
    " PING",
    "`PINGMODEL`",
    "> PING",
    "PING\n",
    "PINGMODEL please",
  ]) {
    expect(sessionCommand(message("b", text))).toBeUndefined();
  }
  expect(
    sessionCommand({
      ...message("c", "DEBUGSHARE"),
      sessionCommandEligible: undefined,
    }),
  ).toBeUndefined();
});

it("persists probe intent and both sends without repeating uncertain external effects", async () => {
  let now = 1000;
  let calls = 0;
  const sent: OutboundMessage[] = [];
  const deps = {
    owner,
    model: {
      beginReply(request: ModelRequest) {
        calls++;
        expect(request.messages).toEqual([{ role: "user", content: "PING" }]);
        expect(request.workspaces).toEqual([]);
        return {
          answer: Promise.resolve({
            text: "ignored model text",
            search: "never run",
          }),
          settlement: Promise.resolve("confirmed_stopped" as const),
        };
      },
      async reply() {
        throw new Error("use invocation handle");
      },
    },
    channels: {
      slack: {
        channel: "slack" as const,
        capabilities: { text: true, threads: true, reactions: true } as const,
        receive: async () => ({ events: [], response: new Response() }),
        async send(outbound: OutboundMessage) {
          sent.push(structuredClone(outbound));
          now = 1700;
          return { status: "sent" as const, messageId: "sent" };
        },
      },
    },
  };
  const receipt: SessionCommandReceipt = {
    ping: { receivedAt: 1200, messageAt: 925.25, model: "ready" },
    delivery: {
      phase: "ready",
      attempts: 0,
      message: {
        id: "pong",
        address: message("ping", "PINGMODEL").address,
        lastInboundAt: 900,
        content: { type: "text", text: "PONG" },
      },
    },
  };
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const persist = async () => {
      if (calls === 0) expect(receipt.ping?.model).toBe("started");
    };
    const publish = async () => {
      throw new Error("not a debug snapshot");
    };
    const run = () =>
      publishSessionCommand(
        receipt,
        deps,
        persist,
        publish,
        new AbortController().signal,
      );
    await run();
    await run();
    expect(calls).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.content).toEqual({ type: "text", text: "PONG" });
    expect(sent[1]?.content).toMatchObject({
      text: expect.stringContaining("500 ms from verified ingress"),
    });
    expect(sent[1]?.content).toMatchObject({
      text: expect.stringContaining("775 ms from Slack message timestamp"),
    });
    expect(sent[1]?.id).not.toBe(sent[0]?.id);
    // Simulate a crash after provider intent and during the first send.
    receipt.ping = { receivedAt: 1200, model: "started" };
    receipt.delivery.phase = "sending";
    delete receipt.delivery.result;
    await run();
    expect(receipt.ping.model).toBe("unknown");
    expect(receipt.delivery).toMatchObject({ result: { status: "unknown" } });
    expect(calls).toBe(1);
    expect(sent).toHaveLength(2);
  } finally {
    clock.mockRestore();
  }
});

it("admits probes independently, deduplicates pending inference, and holds drain through sends and retirement", async (t) => {
  const answer = Promise.withResolvers<CompanionReply>();
  const retirement = Promise.withResolvers<"confirmed_stopped">();
  const sending = Promise.withResolvers<void>();
  t.onTestFinished(() => {
    answer.resolve({ text: "PONG" });
    retirement.resolve("confirmed_stopped");
    sending.resolve();
  });
  let calls = 0;
  const sent: OutboundMessage[] = [];
  const lifecycle = createLifecycle();
  const registry = createJuneRegistry({
    owner,
    lifecycle,
    model: {
      beginReply() {
        calls++;
        return { answer: answer.promise, settlement: retirement.promise };
      },
      async reply() {
        throw new Error("use invocation handle");
      },
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        receive: async () => ({ events: [], response: new Response() }),
        async send(outbound) {
          sent.push(JSON.parse(JSON.stringify(outbound)));
          if (
            outbound.content.type === "text" &&
            outbound.content.text.startsWith("PINGMODEL timing") &&
            sent.length === 4
          ) {
            await sending.promise;
            return {
              status: "rejected",
              retryable: true,
              code: "rate_limited",
            };
          }
          return { status: "sent", messageId: "sent" };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "owner"]);
  const probe = {
    ...message("probe", "PINGMODEL"),
    messageId: "1800000000.812919",
  };
  await june.receive(probe);
  await expect.poll(() => calls).toBe(1);
  await june.receive(probe);
  await june.receive(message("ping", "PING"));
  await expect.poll(() => sent.length).toBe(2);
  expect(calls).toBe(1);
  expect(sent[0]?.content).toEqual({ type: "text", text: "PONG" });
  expect(
    (await june.snapshot()).sessionCommands?.[
      conversationInputId({ type: "event", event: probe })
    ]?.ping?.messageAt,
  ).toBe(1800000000812.919);
  answer.resolve({ text: "not forwarded" });
  await expect.poll(() => sent.length).toBe(4);
  expect(sent[2]?.content).toEqual({ type: "text", text: "PONG" });
  expect(await lifecycle.drain(20)).toBe(false);
  sending.resolve();
  expect(await lifecycle.drain(20)).toBe(false);
  retirement.resolve("confirmed_stopped");
  await expect.poll(() => lifecycle.active).toBe(0);
  expect(await lifecycle.drain(100)).toBe(true);
  lifecycle.resume();
  await june.receive(probe);
  await expect.poll(() => sent.length).toBe(5);
  expect(calls).toBe(1);
  expect(sent[4]?.id).toBe(sent[3]?.id);
  expect(
    sent.filter(
      (item) => item.content.type === "text" && item.content.text === "PONG",
    ),
  ).toHaveLength(2);
});
