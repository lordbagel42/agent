import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "rivetkit/client";
import { expect, it, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { slackSource } from "../imports/index.js";
import { EvidenceStore, type Source } from "../memory/store.js";
import { parseReply } from "../models/provider.js";
import { ConversationContinuity } from "./continuity.js";
import { executionKey } from "./execution.js";
import type { ExecutionContext } from "./execution-context.js";
import { createLatencyDiagnostics } from "./latency.js";
import { createLifecycle } from "./lifecycle.js";
import { createJuneRegistry, type JuneClientRegistry } from "./registry.js";
import { executionDispatchText } from "./scope-catalog.js";

const notification = vi.hoisted(() => ({
  before: undefined as undefined | (() => Promise<void>),
}));
const summaryRead = vi.hoisted(() => ({
  after: undefined as undefined | (() => Promise<void>),
  evidenceId: undefined as string | undefined,
}));
// Pause a real worker save, not a replacement workflow or production test hook.
const persistence = vi.hoisted(() => ({
  afterSave: undefined as undefined | (() => Promise<void>),
  legacy: false as boolean | "queued" | "running",
}));
vi.mock("rivetkit", async (importOriginal) => {
  const real = await importOriginal<typeof import("rivetkit")>();
  return {
    ...real,
    actor: (config: Parameters<typeof real.actor>[0]) => {
      if (typeof config.actions?.notify === "function") {
        const notify = config.actions.notify;
        return real.actor({
          ...config,
          actions: {
            ...config.actions,
            notify: async (...args: Parameters<typeof notify>) => {
              await notification.before?.();
              return notify(...args);
            },
          },
        });
      }
      if (
        !("state" in config) ||
        !config.state ||
        typeof config.state !== "object" ||
        !("cancellations" in config.state)
      )
        return real.actor(config);
      const createVars =
        "createVars" in config && typeof config.createVars === "function"
          ? (config.createVars as (
              context: unknown,
            ) => object | Promise<object>)
          : undefined;
      const summary = config.actions?.summary;
      return real.actor({
        ...config,
        actions: {
          ...config.actions,
          ...(typeof summary === "function"
            ? {
                summary: async (...args: Parameters<typeof summary>) => {
                  // A dependency known only to this worker, not conversation history.
                  if (summaryRead.evidenceId) {
                    const state = args[0].state as { evidenceIds: string[] };
                    state.evidenceIds.push(summaryRead.evidenceId);
                  }
                  const result = await summary(...args);
                  await summaryRead.after?.();
                  return result;
                },
              }
            : {}),
        },
        createVars: async (c) => ({
          ...(await createVars?.(c)),
          persist: async () => {
            if (persistence.legacy) {
              const state = c.state as {
                requests: Record<
                  string,
                  { id: string; status: string; deletionTracked?: true }
                >;
                activeRequest?: string;
              };
              for (const request of Object.values(state.requests)) {
                delete request.deletionTracked;
                if (typeof persistence.legacy === "string") {
                  request.status = persistence.legacy;
                  if (persistence.legacy === "running")
                    state.activeRequest = request.id;
                }
              }
              persistence.legacy = false;
            }
            await c.saveState({ immediate: true });
            await persistence.afterSave?.();
          },
        }),
      });
    },
  };
});
const owner = {
  id: "raygen",
  identities: [{ channel: "slack" as const, accountId: "T1", senderId: "U1" }],
};
const event = (id: string, text: string): MessageEvent => ({
  id,
  type: "message",
  messageId: `${id}.000001`,
  occurredAt: Date.now(),
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  senderId: "U1",
  direct: true,
  text,
});

it("keeps a slow execution notification owned until its real RPC settles", async (t) => {
  const lifecycle = createLifecycle();
  const arrived = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let notifications = 0;
  let executions = 0;
  const sent: string[] = [];
  notification.before = async () => {
    notifications++;
    arrived.resolve();
    await gate.promise;
  };
  t.onTestFinished(() => {
    notification.before = undefined;
    gate.resolve();
  });
  const registry = createJuneRegistry({
    owner,
    lifecycle,
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        receive: async () => ({ response: new Response(), events: [] }),
        send: async (message) => {
          if (message.content.type === "text") sent.push(message.content.text);
          return { status: "sent", messageId: "result" };
        },
      },
    },
    model: {
      reply: async (request): Promise<CompanionReply> =>
        request.system.includes("Execution completion")
          ? { text: "Execution result received." }
          : {
              text: "",
              execution: [
                { agent: "slow", action: "run", task: "Do one task" },
              ],
            },
    },
    execution: {
      model: {
        reply: async () => {
          executions++;
          return { text: "Completed once." };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const conversation = client.conversation.getOrCreate(["private", owner.id]);
  await conversation.send("inbox", {
    type: "event",
    event: event("slow", "Do one task"),
  });
  await arrived.promise;
  // Exercise the real engine's default 30-second deadline, not a fake step.
  await delay(31_000);
  expect(lifecycle.ready).toBe(true);
  expect(lifecycle.active).toBeGreaterThan(0);
  expect(await lifecycle.drain(20)).toBe(false);
  expect(sent).toEqual([]);
  gate.resolve();
  await expect
    .poll(() => sent, { timeout: 15000 })
    .toEqual(["Execution result received."]);
  await expect.poll(() => lifecycle.active, { timeout: 15000 }).toBe(0);
  expect(await lifecycle.drain()).toBe(true);
  lifecycle.resume();
  expect(notifications).toBe(1);
  expect(executions).toBe(1);
}, 60_000);

it.for(["ready", "failed", "revoked"])(
  "overlaps owner context and roster reads without abandoning a pending summary (%s)",
  async (outcome, t) => {
    const store = new EvidenceStore(":memory:", randomBytes(32));
    const continuity = new ConversationContinuity({
      file: ":memory:",
      key: randomBytes(32),
      owner,
      idleMs: 1000,
      now: () => 1000,
      revision: () => store.deletionRevision(),
      filter: async () => ({ excerpts: [] }),
    });
    const lifecycle = createLifecycle();
    const latency = createLatencyDiagnostics();
    const contextEntered = Promise.withResolvers<void>();
    const contextGate = Promise.withResolvers<void>();
    const summaryGate = Promise.withResolvers<void>();
    let reads = 0;
    const turns: ModelRequest[] = [];
    t.onTestFinished(() => {
      summaryRead.after = undefined;
      summaryRead.evidenceId = undefined;
      contextGate.resolve();
      summaryGate.resolve();
      continuity.close();
      store.close();
    });
    const registry = createJuneRegistry({
      owner,
      continuity,
      lifecycle,
      latency,
      memory: { store, source: () => undefined },
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, reactions: true, threads: true },
          receive: async () => ({ response: new Response(), events: [] }),
          send: async () => ({ status: "sent", messageId: "out" }),
          context: async (input) => {
            if (input.id === "overlap") {
              contextEntered.resolve();
              await contextGate.promise;
            }
            return [];
          },
        },
      },
      model: {
        reply: async (request): Promise<CompanionReply> => {
          turns.push(request);
          if (turns.length !== 1) return { text: "Noted." };
          return {
            text: "",
            execution: [
              { agent: "trains", action: "run", task: "Compare trains" },
              { agent: "boats", action: "run", task: "Compare boats" },
            ],
          };
        },
      },
      execution: { model: { reply: async () => ({ text: "Fixture report" }) } },
    });
    const { client } = await setupTest(t, registry);
    const conversation = client.conversation.getOrCreate(["private", owner.id]);
    await conversation.send("inbox", {
      type: "event",
      event: event("setup", "Compare trains and boats"),
    });
    await expect.poll(() => turns.length, { timeout: 15000 }).toBe(3);
    await expect.poll(() => lifecycle.active, { timeout: 15000 }).toBe(0);
    summaryRead.after = async () => {
      reads++;
      if (outcome === "failed" && reads === 1)
        throw new Error("fixture summary failure");
      await summaryGate.promise;
    };
    const input = event("overlap", "How do they compare?");
    const dependency = (await continuity.project(input, { kind: "owner" }))
      .dependency;
    if (outcome === "revoked") {
      summaryRead.evidenceId = dependency;
      expect(JSON.stringify(await conversation.snapshot())).not.toContain(
        summaryRead.evidenceId,
      );
    }
    latency.begin(input);
    try {
      await conversation.send("inbox", { type: "event", event: input });
      await contextEntered.promise;
      // Serial collection cannot reach either summary while context is blocked.
      await expect.poll(() => reads, { timeout: 1500 }).toBe(2);
      if (outcome === "revoked") {
        continuity.clear();
        expect(continuity.valid(dependency)).toBe(false);
        expect(store.deletionRevision()).toBe(0);
      }
      contextGate.resolve();
      await expect
        .poll(() =>
          latency
            .snapshot()
            .traces[0]?.observations.some(
              ({ stage }) => stage === "context_platform_ready",
            ),
        )
        .toBe(true);
      expect(turns).toHaveLength(3);
      expect(await lifecycle.drain(100)).toBe(false);
      expect(lifecycle.active).toBeGreaterThan(0);
      summaryGate.resolve();
      await expect.poll(() => lifecycle.active, { timeout: 15000 }).toBe(0);
      expect(turns).toHaveLength(outcome === "ready" ? 4 : 3);
      if (outcome === "ready") {
        expect(turns[3]?.system).toContain('"name":"trains"');
        expect(turns[3]?.system).toContain('"name":"boats"');
        expect(turns[3]?.system).toContain('"report":"Fixture report"');
      }
      expect(reads).toBe(2);
      expect(lifecycle.ready).toBe(true);
    } finally {
      summaryRead.after = undefined;
      contextGate.resolve();
      summaryGate.resolve();
      await expect.poll(() => lifecycle.active, { timeout: 15000 }).toBe(0);
    }
  },
);

it("revokes continuity-derived worker output on restriction but not on idle expiry", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  let now = 1000;
  const continuity = new ConversationContinuity({
    file: ":memory:",
    key: randomBytes(32),
    owner,
    idleMs: 1000,
    now: () => now,
    revision: () => store.deletionRevision(),
    filter: async () => ({ excerpts: [] }),
  });
  t.onTestFinished(() => {
    continuity.close();
    store.close();
  });
  const input = event("1", "Ordinary context");
  continuity.receive(input);
  const projection = await continuity.project(input, { kind: "owner" });
  const resume = Promise.withResolvers<CompanionReply>();
  let workerPrompt = "";
  let started = false;
  const registry = createJuneRegistry({
    owner,
    continuity,
    memory: { store, source: () => undefined },
    channels: {},
    model: { reply: async () => ({ text: "" }) },
    execution: {
      model: {
        reply: async (request) => {
          workerPrompt = request.system;
          started = true;
          return resume.promise;
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const worker = client.execution.getOrCreate(
    executionKey(["private", owner.id], "continuity"),
  );
  expect(
    await worker.submit({
      id: `${"a".repeat(64)}:work`,
      source: input,
      task: "Continue topic",
      web: false,
      workspaces: [],
      evidenceIds: [projection.dependency],
      deletionTracked: true,
    }),
  ).toBe(true);
  await expect.poll(() => started).toBe(true);
  now = 2000;
  expect((await worker.summary()).status).not.toBe("revoked");
  continuity.receive(event("2", "don't share this"));
  resume.resolve({ text: "Must be suppressed" });
  await expect
    .poll(async () => (await worker.summary()).status)
    .toBe("revoked");
  expect((await worker.summary()).report).not.toContain("Must be suppressed");
  expect(workerPrompt).toContain("Do not rerun the task");
});

it.each([
  { outcomes: ["research: queued"], expected: 1, text: "", want: "" },
  {
    outcomes: ["research: queued"],
    expected: 1,
    text: "I'll compare them.",
    want: "I'll compare them.",
  },
  {
    outcomes: ["research: queued", "sources: unavailable"],
    expected: 2,
    text: "Both started.",
    want: "1 requested task was accepted.\nsources: I couldn't start that task.",
  },
  {
    outcomes: ["research: cancellation requested"],
    expected: 1,
    text: "Stopped.",
    want: "Cancellation requested. This does not confirm that in-flight work stopped.",
  },
  {
    outcomes: ["research: not found"],
    expected: 1,
    text: "Stopped.",
    want: "I couldn't find that task to cancel. Nothing is confirmed stopped.",
  },
  {
    outcomes: ["old: cancellation requested", "replacement: queued"],
    expected: 2,
    text: "Stopped that and started the replacement.",
    want: "1 requested task was accepted.\nCancellation requested. This does not confirm that in-flight work stopped.",
  },
  {
    outcomes: ["sources: roster full; reuse an existing worker"],
    expected: 1,
    text: "Started.",
    want: "This conversation has reached its task limit; I couldn't start that work.",
  },
  {
    outcomes: [
      "sources: forgetting cleanup pending; retry after cleanup or use another worker name",
    ],
    expected: 1,
    text: "Started.",
    want: "I couldn't start that task while earlier context is being cleared.",
  },
  {
    outcomes: [
      "research: queued",
      "sources: busy; four tasks are already pending",
    ],
    expected: 2,
    text: "Both started.",
    want: "1 requested task was accepted.\nsources: Four tasks are already pending, so I couldn't start that work.",
  },
  {
    outcomes: ["research: queued"],
    expected: 2,
    text: "Both started.",
    want: "",
  },
])(
  "keeps dispatch receipts internal without hiding failures: $outcomes",
  ({ outcomes, expected, text, want }) => {
    expect(executionDispatchText(outcomes, expected, text)).toBe(want);
  },
);

it("accepts bounded execution only when granted and excludes every other directive", () => {
  const reply = {
    text: "On it.",
    execution: [{ agent: "trains", action: "run", task: "Compare trains" }],
  };
  expect(
    parseReply(JSON.stringify(reply), [], { executionAvailable: true }),
  ).toEqual(reply);
  expect(() => parseReply(JSON.stringify(reply), [])).toThrow();
  for (const other of [
    { social: { kind: "outreach", userId: "U2", text: "hi" } },
    { release: { action: "inspect", revision: null } },
    { mcp: { connection: "slack", tool: "search", argumentsJson: "{}" } },
    { webSearch: "trains" },
  ])
    expect(() =>
      parseReply(JSON.stringify({ ...reply, ...other }), [], {
        executionAvailable: true,
        socialAvailable: true,
        releaseAvailable: true,
        mcpAvailable: true,
        webSearchAvailable: true,
      }),
    ).toThrow();
  expect(() =>
    parseReply(
      JSON.stringify({
        ...reply,
        execution: [...reply.execution, ...reply.execution],
      }),
      [],
      { executionAvailable: true },
    ),
  ).toThrow();
});

it("keeps chat responsive, bounds background work, reuses history and exposes status/cancellation to June", async (t) => {
  const sent: OutboundMessage[] = [];
  const work: ModelRequest[] = [];
  const turns: ModelRequest[] = [];
  const modelStatus = vi.fn(() => "Model diagnostics, not a worker report");
  const gate = Promise.withResolvers<void>();
  t.onTestFinished(() => gate.resolve());
  const registry = createJuneRegistry({
    owner,
    modelStatus,
    mcpAvailable: true,
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(m) {
          sent.push(JSON.parse(JSON.stringify(m)));
          return { status: "sent", messageId: `out-${sent.length}` };
        },
      },
    },
    execution: {
      model: {
        async reply(request) {
          work.push(structuredClone(request));
          const text = request.messages.at(-1)?.content;
          if (text === "trains-first" || text === "hotels-first")
            await gate.promise;
          if (text === "trains-first") {
            return { text: "Train evidence: 17:42" };
          }
          if (text === "hotels-first") return { text: "Hotel evidence: $137" };
          return {
            text: request.messages.some((m) => m.content.includes("17:42"))
              ? "Still 17:42"
              : "LOST HISTORY",
          };
        },
      },
    },
    model: {
      async reply(request): Promise<CompanionReply> {
        turns.push(structuredClone(request));
        if (request.system.includes("Execution completion"))
          return {
            text: request.system.includes('"task":"hotels-first"')
              ? "June: $137"
              : "June: 17:42",
          };
        const text = JSON.parse(request.messages.at(-1)?.content ?? "{}").text;
        if (text === "plan")
          return {
            text: "Working on both.",
            interrupt: false,
            execution: [
              { agent: "constructor", action: "run", task: "trains-first" },
              { agent: "hotels", action: "run", task: "hotels-first" },
            ],
          };
        if (text === "followup")
          return {
            text: "Checking.",
            replyInThread: false,
            execution: [
              {
                agent: "constructor",
                action: "run",
                task: "What departure did you find?",
              },
            ],
          };
        if (text === "cancel")
          return {
            text: "",
            execution: [{ agent: "constructor", action: "cancel", task: "" }],
          };
        return { text: "Still chatting." };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "raygen"]);
  const texts = () =>
    sent.flatMap((m) => (m.content.type === "text" ? [m.content.text] : []));
  const send = (id: string, text: string) =>
    june.send("inbox", { type: "event", event: event(id, text) });
  await send("1", "plan");
  await expect.poll(() => work.length, { timeout: 15000 }).toBe(2);
  await send("2", "hi");
  await expect.poll(texts, { timeout: 15000 }).toContain("Still chatting.");
  expect(work).toHaveLength(2);
  const statusTurn = turns.find((r) =>
    r.messages.at(-1)?.content.includes('"text":"hi"'),
  );
  expect(statusTurn?.system.match(/"status":"running"/g)).toHaveLength(2);
  expect(statusTurn?.agentRole).toBe("interaction");
  expect(texts()).not.toContain("Hotel evidence: $137");
  gate.resolve();
  await expect.poll(texts, { timeout: 15000 }).toContain("June: $137");
  await expect.poll(texts, { timeout: 15000 }).toContain("June: 17:42");
  for (const request of work) {
    expect(request.system).toContain('"version":0,"style":{"tone":"warm"');
    expect(request.system).toContain("not her conversational persona");
  }
  expect(
    sent.find(
      (m) => m.content.type === "text" && m.content.text === "June: 17:42",
    )?.address.threadId,
  ).toBe("1.000001");
  expect(
    await client.personality.getOrCreate([owner.id]).command({
      ...event("revise", ""),
      metadata: { channelType: "im" },
      personalityCommandEligible: true,
      text: '!personality revise {"expectedVersion":0,"changes":{"tone":"dry","verbosity":"expansive"},"explanation":"PRIVATE revision reason","publish":true}',
    }),
  ).toContain("Saved global personality revision 1");
  await send("3", "followup");
  await expect.poll(() => work.length, { timeout: 15000 }).toBe(3);
  expect(work[2]?.system).toContain(
    '"version":1,"style":{"tone":"dry","verbosity":"expansive"',
  );
  expect(work[2]?.system).toContain("concise evidence-based reporting");
  expect(work[2]?.system).toContain("not worker instructions");
  expect(work[2]?.system).toContain("Return only the requested JSON");
  expect(work[2]?.system).toContain(
    "June will request separate owner approval",
  );
  expect(work[2]?.system).toContain(
    "Do not send ordinary conversational replies",
  );
  expect(work[2]?.agentRole).toBe("execution");
  expect(work[2]?.workspaces).toEqual([]);
  expect(JSON.stringify(work)).not.toContain("PRIVATE revision reason");
  expect(work[2]?.messages.some((m) => m.content.includes("17:42"))).toBe(true);
  expect(work[2]?.messages.some((m) => m.content.includes("$137"))).toBe(false);
  await expect
    .poll(() => texts().filter((text) => text === "June: 17:42").length, {
      timeout: 15000,
    })
    .toBe(2);
  expect(
    sent.findLast(
      (m) => m.content.type === "text" && m.content.text === "June: 17:42",
    )?.address.threadId,
  ).toBeUndefined();
  await send("3", "followup");
  await send("4", "cancel");
  await expect
    .poll(texts, { timeout: 15000 })
    .toContain(
      "Cancellation requested. This does not confirm that in-flight work stopped.",
    );
  expect(texts()).not.toContain("constructor: cancellation requested");
  expect(work).toHaveLength(3);
  expect(
    turns.find((r) => r.messages.at(-1)?.content.includes('"text":"cancel"'))
      ?.system,
  ).toContain("Execution roster");
  expect(
    turns
      .filter((r) => r.system.includes("Execution completion"))
      .every(
        (r) =>
          r.agentRole === "interaction" &&
          r.system.includes(
            "Treat completed authorized execution as June's own work",
          ) &&
          !r.executionAvailable &&
          !r.modelStatusAvailable &&
          !r.releaseAvailable &&
          !r.socialAvailable &&
          !r.mcpAvailable &&
          !r.replyPlacementAvailable &&
          r.workspaces.length === 0,
      ),
  ).toBe(true);
  expect(modelStatus).not.toHaveBeenCalled();
  // Guests never gain paid worker dispatch just because routing now accepts them.
  const guest = {
    ...event("5", "hi"),
    senderId: "U2",
    metadata: { channelType: "im" as const },
  };
  await client.conversation
    .getOrCreate(["guest", "slack", "T1", "D1", "", "U2"])
    .send("inbox", { type: "event", event: guest });
  await expect
    .poll(
      () =>
        turns.some((r) =>
          r.messages.at(-1)?.content.includes('"senderId":"U2"'),
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  expect(turns.at(-1)?.executionAvailable).toBe(false);
  expect(
    await client.execution
      .getOrCreate(
        executionKey(["guest", "slack", "T1", "D1", "", "U2"], "guest"),
      )
      .submit({
        id: `${"a".repeat(64)}:guest`,
        source: guest,
        task: "work",
        workspaces: [],
        web: true,
        evidenceIds: [],
      }),
  ).toBe(false);
});

it.for(["sent", "unknown", "rejected"] as const)(
  "keeps login dispatch quiet and settles a %s delivery without duplicate replies",
  async (status, t) => {
    const sent: OutboundMessage[] = [];
    const issue = vi.fn(() => ({
      url: "https://example.org/private-login",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }));
    const workerReply = vi.fn(
      async (): Promise<CompanionReply> =>
        workerReply.mock.calls.length === 1
          ? { text: "", dashboardLogin: true }
          : { text: "Login delivery was not confirmed." },
    );
    const modelReply = vi.fn(
      async (request: ModelRequest): Promise<CompanionReply> =>
        request.system.includes("Execution completion")
          ? { text: "Login delivery was not confirmed." }
          : {
              text: "",
              execution: [
                { agent: "login", action: "run", task: "Send a login link" },
              ],
            },
    );
    const registry = createJuneRegistry({
      owner,
      dashboardLogin: { issue, redact: (text) => text },
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, reactions: true, threads: true },
          async receive() {
            return { response: new Response(), events: [] };
          },
          async send(message) {
            sent.push(JSON.parse(JSON.stringify(message)));
            return status === "sent"
              ? { status, messageId: "login-sent" }
              : { status, code: "fixture", retryable: false };
          },
        },
      },
      model: { reply: modelReply },
      execution: { model: { reply: workerReply } },
    });
    const { client } = await setupTest(t, registry);
    const conversation = client.conversation.getOrCreate(["private", "raygen"]);
    await conversation.send("inbox", {
      type: "event",
      event: event("login", "Send a login link"),
    });
    await expect
      .poll(async () => (await conversation.snapshot()).agents?.login, {
        timeout: 15000,
      })
      .toBeTruthy();
    const agentId = (await conversation.snapshot()).agents?.login;
    if (!agentId) throw new Error("Missing login worker");
    const worker = client.execution.getOrCreate(
      executionKey(["private", "raygen"], agentId),
    );
    await expect
      .poll(async () => (await worker.summary()).status, { timeout: 15000 })
      .toBe("completed");
    await expect
      .poll(
        async () => {
          const events = Object.values((await conversation.snapshot()).events);
          return events.length >= 2 && events.every((entry) => entry.done);
        },
        { timeout: 15000 },
      )
      .toBe(true);
    expect(issue).toHaveBeenCalledTimes(1);
    expect(workerReply).toHaveBeenCalledTimes(status === "sent" ? 1 : 2);
    expect(modelReply).toHaveBeenCalledTimes(status === "sent" ? 1 : 2);
    const texts = sent.map((message) =>
      message.content.type === "text" ? message.content.text : "",
    );
    expect(texts).not.toContain("login: queued");
    expect(texts.filter((text) => text.includes("private-login"))).toHaveLength(
      1,
    );
    if (status === "sent")
      expect(texts).toEqual([
        "Here's your sign-in link: https://example.org/private-login\nIt expires in 10 minutes.",
      ]);
  },
);

it("bounds research and stops ambiguous or unsent searches without automatic retries", async (t) => {
  let calls = 0;
  let searches = 0;
  let mode: "ready" | "possibly_sent" | "not_sent" = "ready";
  const prompts: string[] = [];
  let revise: () => Promise<void>;
  const registry = createJuneRegistry({
    owner,
    channels: {},
    model: {
      async reply() {
        return { text: "" };
      },
    },
    execution: {
      model: {
        async reply(request) {
          calls++;
          prompts.push(request.system);
          return request.webSearchAvailable
            ? { text: "", webSearch: "public timetable" }
            : {
                text: request.messages.some((m) => m.content.includes("17:42"))
                  ? "17:42 https://example.org/times"
                  : "missing",
              };
        },
      },
    },
    webSearch: {
      available: true,
      description: "fixture",
      async search() {
        searches++;
        if (searches === 1) await revise();
        return mode === "ready"
          ? {
              status: "ready",
              results: [
                {
                  title: "Schedule",
                  url: "https://example.org/times",
                  snippet: "17:42",
                },
              ],
            }
          : { status: "error", code: "timeout", requestState: mode };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  revise = async () => {
    expect(
      await client.personality.getOrCreate([owner.id]).command({
        ...event("mid-search-revision", ""),
        metadata: { channelType: "im" },
        personalityCommandEligible: true,
        text: '!personality revise {"expectedVersion":0,"changes":{"tone":"playful"},"explanation":"PRIVATE search reason","publish":true}',
      }),
    ).toContain("Saved global personality revision 1");
  };
  const worker = client.execution.getOrCreate(
    executionKey(["private", "raygen"], "research"),
  );
  const input = {
    id: `${"a".repeat(64)}:research`,
    source: event("10", "research"),
    task: "look up trains",
    workspaces: [],
    web: true,
    evidenceIds: [],
  };
  expect(
    await client.execution
      .getOrCreate(executionKey(["slack", "T1", "C1", ""], "research"))
      .submit(input),
  ).toBe(false);
  await worker.submit(input);
  await expect
    .poll(async () => (await worker.result(input.id))?.status, {
      timeout: 15000,
    })
    .toBe("completed");
  expect((await worker.result(input.id))?.report).toBe(
    "17:42 https://example.org/times",
  );
  expect(searches).toBe(5);
  expect(calls).toBe(6);
  for (const prompt of prompts)
    expect(prompt).toContain('"version":0,"style":{"tone":"warm"');
  for (const [prefix, failure, status] of [
    ["b", "possibly_sent", "needs_review"],
    ["c", "not_sent", "failed"],
  ] as const) {
    mode = failure;
    const id = `${prefix.repeat(64)}:research`;
    await worker.submit({ ...input, id });
    await expect
      .poll(async () => (await worker.result(id))?.status, { timeout: 15000 })
      .toBe(status);
    await worker.submit({ ...input, id });
  }
  expect(searches).toBe(7);
  expect(calls).toBe(8);
  for (const prompt of prompts.slice(6))
    expect(prompt).toContain('"version":1,"style":{"tone":"playful"');
  expect(prompts.join("\n")).not.toContain("PRIVATE search reason");
});

it.for([false, true])(
  "cancellation wins during the final history save (revoke=%s)",
  async (revoke, t) => {
    const saved = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let active = 0;
    t.onTestFinished(() => {
      persistence.afterSave = undefined;
      resume.resolve();
    });
    const registry = createJuneRegistry({
      owner,
      channels: {},
      model: {
        async reply() {
          return { text: "" };
        },
      },
      lifecycle: {
        async enter() {
          active++;
          return () => {
            active--;
          };
        },
        fail() {},
      },
      execution: {
        model: {
          async reply() {
            persistence.afterSave = async () => {
              persistence.afterSave = undefined;
              saved.resolve();
              await resume.promise;
            };
            return { text: "late confirmed report" };
          },
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const worker = client.execution.getOrCreate(
      executionKey(["private", "raygen"], "late"),
    );
    const id = `${"a".repeat(64)}:late`;
    await worker.submit({
      id,
      source: event("20", "work"),
      task: "work",
      workspaces: [],
      web: false,
      evidenceIds: [],
    });
    await saved.promise;
    await worker.cancel("stop-during-save", revoke);
    expect((await worker.summary()).pending).toBe(1);
    resume.resolve();
    await expect
      .poll(async () => (await worker.summary()).pending, { timeout: 15000 })
      .toBe(0);
    if (revoke) {
      expect(await worker.result(id)).toBeNull();
      expect((await worker.summary()).report).toBe("");
    } else {
      expect((await worker.result(id))?.status).toBe("cancelled");
      expect((await worker.result(id))?.report).not.toContain("late confirmed");
    }
    await expect.poll(() => active, { timeout: 15000 }).toBe(0);
  },
);

it.for([false, true])(
  "retains background admission until provider and save settle (save fails=%s)",
  async (failSave, t) => {
    const settle = Promise.withResolvers<void>();
    const started = Promise.withResolvers<AbortSignal>();
    const saving = Promise.withResolvers<void>();
    const saveSettled = Promise.withResolvers<void>();
    const occupied = Promise.withResolvers<void>();
    const reserve = Promise.withResolvers<void>();
    let calls = 0;
    t.onTestFinished(() => {
      persistence.afterSave = undefined;
      settle.resolve();
      saveSettled.resolve();
      reserve.resolve();
    });
    const registry = createJuneRegistry({
      owner,
      channels: {},
      model: {
        async reply() {
          return { text: "" };
        },
      },
      execution: {
        model: {
          async reply(_request, signal) {
            if (!signal) throw new Error("Execution signal missing");
            if (_request.messages.at(-1)?.content === "occupy") {
              occupied.resolve();
              await reserve.promise;
              return { text: "" };
            }
            calls++;
            if (calls === 1) {
              started.resolve(signal);
              await settle.promise;
            }
            return { text: "settled" };
          },
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const first = client.execution.getOrCreate(
      executionKey(["private", "raygen"], "first"),
    );
    const second = client.execution.getOrCreate(
      executionKey(["private", "raygen"], "second"),
    );
    const input = {
      id: `${"a".repeat(64)}:first`,
      source: event("held", "work"),
      task: "work",
      workspaces: [],
      web: false,
      evidenceIds: [],
    };
    await client.execution
      .getOrCreate(executionKey(["private", "raygen"], "reserve"))
      .submit({ ...input, id: `${"c".repeat(64)}:reserve`, task: "occupy" });
    await occupied.promise;
    await first.submit(input);
    const signal = await started.promise;
    await first.cancel("cancel-held");
    expect(signal.aborted).toBe(true);
    expect((await first.summary()).pending).toBe(1);
    await second.submit({
      ...input,
      id: `${"b".repeat(64)}:second`,
      source: event("next", "work"),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await second.summary()).status).toBe("queued");
    expect(calls).toBe(1);
    persistence.afterSave = async () => {
      persistence.afterSave = undefined;
      saving.resolve();
      await saveSettled.promise;
      if (failSave) throw new Error("fixture final save failure");
    };
    settle.resolve();
    await saving.promise;
    expect((await second.summary()).status).toBe("queued");
    expect(calls).toBe(1);
    saveSettled.resolve();
    await expect.poll(() => calls, { timeout: 15000 }).toBe(2);
    expect((await first.result(input.id))?.status).toBe("cancelled");
    await expect
      .poll(async () => (await second.summary()).status)
      .toBe("completed");
    await expect
      .poll(
        async () => {
          const state = await client.conversation
            .getOrCreate(["private", "raygen"])
            .snapshot();
          return Object.values(state.events).filter(
            (entry) => entry.done && entry.event.id === "next",
          ).length;
        },
        { timeout: 15000 },
      )
      .toBe(1);
    expect(calls).toBe(2);
  },
);

it.for([true, false])(
  "carries historical context ancestry and blocks tombstoned worker reuse (private=%s)",
  async (direct, t) => {
    const store = new EvidenceStore(":memory:", randomBytes(32));
    t.onTestFinished(() => store.close());
    const scope = direct ? ["private", "raygen"] : ["slack", "T1", "C1", ""];
    const input = (id: string, text: string) => ({
      ...event(id, text),
      direct,
      address: {
        ...event(id, text).address,
        conversationId: direct ? "D1" : "C1",
      },
    });
    const source = (e: MessageEvent, audience: string) =>
      slackSource({
        workspace: "T1",
        channel: e.address.conversationId,
        ts: e.messageId,
        author: e.senderId,
        text: e.text,
        workspaceUrl: "https://fixture.slack.com/",
        audiences: [audience],
      });
    const background = input("1", "Violet train preference");
    store.appendSource(
      source(
        event("99", "PRIVATE owner evidence"),
        JSON.stringify(["private", owner.id]),
      ),
    );
    let calls = 0;
    const turns: ModelRequest[] = [];
    const work: ModelRequest[] = [];
    const registry = createJuneRegistry({
      owner,
      memory: { store, source },
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, reactions: true, threads: true },
          async receive() {
            return { response: new Response(), events: [] };
          },
          async send() {
            return { status: "sent", messageId: "out" };
          },
          async context(e) {
            if (e.id !== "2") return [];
            const { type: _type, text, ...provenance } = background;
            return [{ role: "user", content: text, source: provenance }];
          },
        },
      },
      model: {
        async reply(request): Promise<CompanionReply> {
          turns.push(structuredClone(request));
          if (request.system.includes("Execution completion"))
            return { text: "Worker found violet." };
          return JSON.parse(request.messages.at(-1)?.content ?? "{}").text ===
            "remember"
            ? { text: "Violet preference noted." }
            : {
                text: "",
                execution: [
                  {
                    agent: "trains",
                    action: "run",
                    task: "Analyze the violet preference",
                  },
                ],
              };
        },
      },
      execution: {
        model: {
          async reply(request) {
            calls++;
            work.push(structuredClone(request));
            return { text: "Violet result" };
          },
        },
      },
    });
    const { client } = await setupTest(t, registry);
    expect(
      await client.personality.getOrCreate([owner.id]).command({
        ...event("public-style", ""),
        metadata: { channelType: "im" },
        personalityCommandEligible: true,
        text: '!personality revise {"expectedVersion":0,"changes":{"tone":"direct"},"explanation":"PRIVATE personality evidence","publish":true}',
      }),
    ).toContain("Saved global personality revision 1");
    const june = client.conversation.getOrCreate(scope);
    const done = async () =>
      Object.values((await june.snapshot()).events).every((e) => e.done);
    await june.send("inbox", { type: "event", event: input("2", "remember") });
    await expect.poll(() => turns.length, { timeout: 15000 }).toBe(1);
    await expect.poll(done, { timeout: 15000 }).toBe(true);
    await june.send("inbox", { type: "event", event: input("3", "analyze") });
    await expect.poll(() => turns.length, { timeout: 15000 }).toBe(3);
    await expect.poll(done, { timeout: 15000 }).toBe(true);
    expect(work[0]?.system).toContain('"version":1,"style":{"tone":"direct"');
    expect(JSON.stringify(work)).not.toContain("PRIVATE");
    expect(work[0]?.workspaces).toEqual([]);
    const id = (await june.snapshot()).agents?.trains;
    if (!id) throw new Error("Worker was not registered");
    const worker = client.execution.getOrCreate(executionKey(scope, id));
    const evidenceId = source(background, JSON.stringify(scope)).id;
    expect((await worker.summary()).evidenceIds).toContain(evidenceId);
    store.deleteSource(evidenceId); // No conversation.forget: exercise transitive revocation.
    expect((await worker.summary()).status).toBe("revoked");
    expect((await worker.summary()).report).toBe("");
    expect(
      await worker.submit({
        id: `${"b".repeat(64)}:trains`,
        source: input("4", "followup"),
        task: "repeat",
        workspaces: [],
        web: false,
        evidenceIds: [],
      }),
    ).toBe(false);
    expect(calls).toBe(1);
  },
);

it("does not orphan work admitted while forgetting older workers", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  const paused = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const work = Promise.withResolvers<CompanionReply>();
  let calls = 0;
  t.onTestFinished(() => {
    persistence.afterSave = undefined;
    resume.resolve();
    work.resolve({ text: "done" });
    store.close();
  });
  const registry = createJuneRegistry({
    owner,
    channels: {},
    memory: { store, source: () => undefined },
    model: {
      async reply(request): Promise<CompanionReply> {
        if (request.system.includes("Execution completion"))
          return { text: "" };
        const name = JSON.parse(request.messages.at(-1)?.content ?? "{}").text;
        return {
          text: "",
          execution: [{ agent: name, action: "run", task: name }],
        };
      },
    },
    execution: {
      model: {
        async reply(request) {
          calls++;
          return request.messages.at(-1)?.content === "fresh"
            ? work.promise
            : { text: "old result" };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "raygen"]);
  await june.send("inbox", { type: "event", event: event("30", "old") });
  await expect.poll(() => calls, { timeout: 15000 }).toBe(1);
  await expect
    .poll(
      async () =>
        Object.values((await june.snapshot()).events).filter((e) => e.done)
          .length,
      { timeout: 15000 },
    )
    .toBe(2);
  store.deleteSource("old-evidence");
  persistence.afterSave = async () => {
    persistence.afterSave = undefined;
    paused.resolve();
    await resume.promise;
  };
  const forgetting = june.forget("old-evidence");
  await paused.promise;
  // The frozen identity cannot accept fresh tasks that a cleanup retry would
  // subsequently revoke. Other worker names remain usable during cleanup.
  await june.send("inbox", { type: "event", event: event("reuse-old", "old") });
  await expect
    .poll(
      async () =>
        (await june.snapshot()).history.some((entry) =>
          entry.content.includes("cleanup pending"),
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  expect(calls).toBe(1);
  await june.send("inbox", { type: "event", event: event("31", "fresh") });
  await expect.poll(() => calls, { timeout: 15000 }).toBe(2);
  resume.resolve();
  await forgetting;
  const id = (await june.snapshot()).agents?.fresh;
  if (!id) throw new Error("Newly admitted worker was orphaned");
  expect((await june.snapshot()).agents?.old).toBeUndefined();
  const worker = client.execution.getOrCreate(
    executionKey(["private", "raygen"], id),
  );
  expect((await worker.summary()).pending).toBe(1);
  await june.forget("old-evidence");
  expect((await june.snapshot()).agents?.fresh).toBe(id);
  expect((await worker.summary()).pending).toBe(1);
  work.resolve({ text: "fresh result" });
  await expect
    .poll(async () => (await worker.summary()).status, { timeout: 15000 })
    .toBe("completed");
});

it.for(["relation", "grounding"] as const)(
  "blocks saved reports and pending delivery after %s-only deletion and ledger reopen",
  async (dependency, t) => {
    const root = await mkdtemp(join(tmpdir(), "june-execution-privacy-"));
    const key = randomBytes(32);
    const path = join(root, "memory.db");
    let store = new EvidenceStore(path, key);
    t.onTestFinished(async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const scope = ["private", "raygen"];
    const audience = JSON.stringify(scope);
    const source = (id: string, text: string): Source => ({
      id,
      text,
      audiences: [audience],
      platform: "slack",
      account: "T1",
      conversation: "D1",
      author: "U1",
      observedAt: 100,
      sourceUrl: "https://fixture.invalid/source",
    });
    store.appendSource(source("A", "anchor"));
    store.appendSource(source("B", "unrelated original"));
    store.appendClaim({
      id: "parent-A",
      entity: "owner",
      text: "anchor claim",
      audiences: [audience],
      kind: "evidence",
      dependsOn: ["A"],
      contradicts: [],
      supersedes: [],
    });
    store.appendClaim({
      id: "C",
      entity: "owner",
      text: "violet synthetic context",
      audiences: [audience],
      kind: "evidence",
      dependsOn: ["B"],
      contradicts: dependency === "relation" ? ["parent-A"] : [],
      supersedes: [],
      ...(dependency === "grounding"
        ? {
            grounding: {
              subjectSourceId: "B",
              text: "violet synthetic context",
              category: "claim" as const,
              citations: [{ sourceId: "A", quote: "anchor" }],
              confidence: 0.5,
              validFrom: null,
              validTo: null,
              contradicts: [],
              supersedes: [],
            },
          }
        : {}),
    });
    // Relation ancestry is deletion-only; original grounding citations remain
    // evidence under the store's independent provenance contract.
    expect(store.independentEvidence("C", audience)).toEqual(
      dependency === "relation" ? ["B"] : ["A", "B"],
    );
    const memory = {
      store,
      source: (e: MessageEvent, audience: string) =>
        slackSource({
          workspace: "T1",
          channel: e.address.conversationId,
          ts: e.messageId,
          author: e.senderId,
          text: e.text,
          workspaceUrl: "https://fixture.slack.com/",
          audiences: [audience],
        }),
    };
    const requests: ModelRequest[] = [];
    const sent: OutboundMessage[] = [];
    const run = vi.fn(async () => ({ text: "synthetic-retired-report" }));
    const registry = createJuneRegistry({
      owner,
      memory,
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, reactions: true, threads: true },
          async receive() {
            return { response: new Response(), events: [] };
          },
          async send(message) {
            sent.push(JSON.parse(JSON.stringify(message)));
            return message.content.type === "text" &&
              message.content.text === "synthetic-retired-report"
              ? {
                  status: "rejected",
                  code: "rate_limited",
                  retryable: true,
                  retryAfterMs: 3000,
                }
              : { status: "sent", messageId: "out" };
          },
        },
      },
      model: {
        async reply(request): Promise<CompanionReply> {
          requests.push(structuredClone(request));
          if (request.system.includes("Execution completion"))
            return { text: "synthetic-retired-report" };
          if (
            JSON.parse(request.messages.at(-1)?.content ?? "{}").text ===
            "violet"
          ) {
            expect(request.system).toContain("violet synthetic context");
            return {
              text: "",
              execution: [
                { agent: "privacy", action: "run", task: "Analyze violet" },
              ],
            };
          }
          return { text: "fresh answer" };
        },
      },
      execution: { model: { reply: run } },
    });
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(scope);
    await june.send("inbox", { type: "event", event: event("2", "violet") });
    const completionSends = () =>
      sent.filter(
        (m) =>
          m.content.type === "text" &&
          m.content.text === "synthetic-retired-report",
      );
    await expect
      .poll(() => completionSends().length, { timeout: 15000 })
      .toBe(1);
    const id = (await june.snapshot()).agents?.privacy;
    if (!id) throw new Error("No worker");
    const worker = client.execution.getOrCreate(executionKey(scope, id));
    expect((await worker.summary()).evidenceIds).toEqual(
      expect.arrayContaining(["B", "C"]),
    );
    expect(await june.executionJobs(id)).toEqual([]);
    store.close();
    store = new EvidenceStore(path, key);
    memory.store = store;
    expect(await june.executionJobs(id)).toEqual([]);
    store.deleteSource("A"); // Crash window: never call conversation.forget.
    store.close();
    store = new EvidenceStore(path, key);
    memory.store = store;
    expect(store.isDeleted("C")).toBe(true);
    expect(await worker.summary()).toMatchObject({
      status: "revoked",
      report: "",
    });
    expect(await worker.result(id)).toBeNull();
    expect(
      await worker.submit({
        id: `${"b".repeat(64)}:privacy`,
        source: event("4", "fresh followup"),
        task: "repeat",
        workspaces: [],
        web: false,
        evidenceIds: [],
        deletionTracked: true,
      }),
    ).toBe(false);
    await june.send("inbox", {
      type: "event",
      event: event("3", "fresh unrelated input"),
    });
    await expect
      .poll(
        async () =>
          Object.values((await june.snapshot()).events).some(
            (e) => e.event.id === "3" && e.done,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    expect(JSON.stringify(requests.at(-1))).not.toContain(
      "synthetic-retired-report",
    );
    expect(JSON.stringify(requests.at(-1))).not.toContain(
      "violet synthetic context",
    );
    expect(completionSends()).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    const delivery = Object.values((await june.snapshot()).deliveries).find(
      (d) => d.message.id === completionSends()[0]?.id,
    );
    expect(delivery?.result).toMatchObject({
      status: "rejected",
      code: "memory_invalidated",
    });
    expect(delivery?.message.content).toEqual({ type: "text", text: "" });
  },
);

it.for(["completed", "queued", "running", "save-gap"] as const)(
  "retires legacy %s occupancy without reviving history",
  async (status, t) => {
    t.onTestFinished(() => {
      persistence.legacy = false;
      persistence.afterSave = undefined;
    });
    const run = vi.fn(async () => ({ text: "legacy private report" }));
    const registry = createJuneRegistry({
      owner,
      channels: {},
      model: {
        async reply() {
          return { text: "" };
        },
      },
      execution: { model: { reply: run } },
    });
    const { client } = await setupTest(t, registry);
    const worker = client.execution.getOrCreate(
      executionKey(["private", "raygen"], "legacy"),
    );
    const request = {
      id: `${"a".repeat(64)}:legacy`,
      source: event("20", "work"),
      task: "work",
      workspaces: [],
      web: false,
      evidenceIds: [],
    };
    if (status !== "completed")
      persistence.legacy = status === "save-gap" ? "queued" : status;
    if (status === "save-gap") {
      persistence.afterSave = async () => {
        persistence.afterSave = undefined;
        throw new Error("Interrupted before queue send");
      };
      await expect(worker.submit(request)).rejects.toThrow();
    } else expect(await worker.submit(request)).toBe(true);
    if (status === "completed") {
      await expect
        .poll(async () => (await worker.summary()).status, { timeout: 15000 })
        .toBe("completed");
      expect((await worker.result(request.id))?.report).toBe(
        "legacy private report",
      );
      // Write the pre-upgrade shape through a real save, not a new empty worker.
      persistence.legacy = true;
      await worker.cancel("legacy-save");
    }
    await expect
      .poll(async () => (await worker.summary()).pending, { timeout: 15000 })
      .toBe(0);
    expect(await worker.result(request.id)).toBeNull();
    expect(
      await worker.submit({
        ...request,
        id: `${"b".repeat(64)}:legacy`,
        deletionTracked: true,
      }),
    ).toBe(false);
    expect(await worker.summary()).toMatchObject({
      status: "revoked",
      report: "",
    });
    expect(run).toHaveBeenCalledTimes(status === "completed" ? 1 : 0);
    const fresh = client.execution.getOrCreate(
      executionKey(["private", "raygen"], "fresh"),
    );
    expect(
      await fresh.submit({
        ...request,
        source: event("21", "fresh"),
        deletionTracked: true,
      }),
    ).toBe(true);
    await expect
      .poll(async () => (await fresh.summary()).status, { timeout: 15000 })
      .toBe("completed");
    expect(run).toHaveBeenCalledTimes(status === "completed" ? 2 : 1);
    // A terminal worker still owes its asynchronous conversation notification.
    const june = client.conversation.getOrCreate(["private", "raygen"]);
    await expect
      .poll(
        async () =>
          Object.values((await june.snapshot()).events).some(
            (e) => e.event.id === "21" && e.done,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
  },
);

it("keeps delegated wakeup origins and inspected ancestry separate from operation IDs and rejects stale worker history", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const scope = ["private", owner.id];
  const audience = JSON.stringify(scope);
  const source = (e: MessageEvent, scope: string) =>
    slackSource({
      workspace: "T1",
      channel: "D1",
      ts: e.messageId,
      author: "U1",
      text: e.text,
      workspaceUrl: "https://fixture.slack.com/",
      audiences: [scope],
    });
  const original = event("501", "Private reminder instruction");
  const unrelated = source(event("502", "Another private exchange"), audience);
  store.appendSource(source(original, audience));
  store.appendSource(unrelated);
  const create = {
    action: "create" as const,
    name: "Private reminder",
    instruction: "Remember the private instruction",
    once: true,
    trigger: {
      kind: "at" as const,
      at: new Date(Date.now() + 86_400_000).toISOString(),
    },
  };
  let calls = 0;
  const registry = createJuneRegistry({
    owner,
    channels: {},
    memory: { store, source },
    wakeups: { sources: [], pollMs: 1000 },
    model: { reply: async () => ({ text: "" }) },
    execution: {
      model: {
        async reply(request): Promise<CompanionReply> {
          calls++;
          const last = request.messages.at(-1)?.content ?? "";
          if (last === "create") return { text: "", wakeup: create };
          if (last === "inspect")
            return { text: "", wakeup: { action: "list" } };
          if (last.includes('"jobs":'))
            return { text: "", wakeup: { action: "inspect", id: "existing" } };
          if (last.includes('"recentRuns":'))
            return { text: "", wakeup: { action: "pause", id: "existing" } };
          return { text: "Confirmed reminder result" };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const wakeups = (client as Client<JuneClientRegistry>).wakeups.getOrCreate([
    owner.id,
  ]);
  await wakeups.manage(create, original, "existing", [
    source(original, audience).id,
  ]);
  const context: ExecutionContext = {
    version: 1,
    scopeKey: scope,
    audience,
    conversationKey: scope,
    originEventId: "a".repeat(64),
    deletionRevision: 0,
    sourceIds: [],
    contextSourceIds: [],
    personality: createHash("sha256").update("{}").digest("hex"),
    capabilities: { wakeupAvailable: true },
  };
  const input = {
    id: `${context.originEventId}:creator`,
    source: event("503", "create"),
    task: "create",
    context,
    web: false,
    workspaces: [],
    evidenceIds: [],
    deletionTracked: true as const,
  };
  const creator = client.execution.getOrCreate(executionKey(scope, "creator"));
  expect(await creator.submit(input)).toBe(true);
  await expect
    .poll(async () => (await creator.summary()).status, { timeout: 15000 })
    .toBe("completed");
  const created = Object.values((await wakeups.snapshot()).jobs).find(
    (job) => job.id !== "existing",
  );
  expect(created?.originEventId).toBe(context.originEventId);
  expect(created?.id).not.toBe(context.originEventId);
  await wakeups.forget([context.originEventId]);
  expect((await wakeups.snapshot()).jobs[created?.id ?? ""]?.instruction).toBe(
    "",
  );
  expect((await wakeups.snapshot()).jobs.existing?.status).toBe("active");

  const inspector = client.execution.getOrCreate(
    executionKey(scope, "inspector"),
  );
  const inspected = {
    ...input,
    id: `${"b".repeat(64)}:inspector`,
    task: "inspect",
    source: event("504", "inspect"),
    context: { ...context, originEventId: "b".repeat(64) },
  };
  expect(await inspector.submit(inspected)).toBe(true);
  await expect
    .poll(async () => (await inspector.summary()).status, { timeout: 15000 })
    .toBe("completed");
  expect((await wakeups.snapshot()).jobs.existing?.status).toBe("paused");
  expect((await inspector.summary()).evidenceIds).toContain(
    source(original, audience).id,
  );
  expect(calls).toBe(6); // create/report; list/inspect/pause/report

  // Even deletion outside the explicit ancestry invalidates reports/history.
  // Updating a later request's revision must not rehabilitate old tool text.
  expect((await inspector.summary()).evidenceIds).not.toContain(unrelated.id);
  store.deleteSource(unrelated.id);
  expect((await inspector.summary()).status).toBe("revoked");
  expect((await inspector.summary()).report).toBe("");
  expect(await inspector.result(inspected.id)).toBeNull();
  expect(
    await inspector.submit({
      ...inspected,
      id: `${"c".repeat(64)}:inspector`,
      context: { ...context, deletionRevision: store.deletionRevision() },
    }),
  ).toBe(false);
  expect(calls).toBe(6);
});
