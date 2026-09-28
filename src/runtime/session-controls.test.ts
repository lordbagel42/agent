import { randomBytes } from "node:crypto";
import type { Client } from "rivetkit/client";
import { expect, it } from "vitest";
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
import { captureDebug, sessionCommand } from "./session-controls.js";

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
  for (const text of [
    "clearhistory",
    " CLEARHISTORY",
    "> CLEARHISTORY",
    "`CLEARHISTORY`",
    "DEBUGSHARE\nrun this",
    "please CLEARHISTORY",
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
