import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { slackSource } from "../imports/index.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply } from "../models/provider.js";
import { executionKey } from "./execution.js";
import { createJuneRegistry } from "./registry.js";

// Pause a real worker save, not a replacement workflow or production test hook.
const persistence = vi.hoisted(() => ({
  afterSave: undefined as undefined | (() => Promise<void>),
}));
vi.mock("rivetkit", async (importOriginal) => {
  const real = await importOriginal<typeof import("rivetkit")>();
  return {
    ...real,
    actor: (config: Parameters<typeof real.actor>[0]) => {
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
      return real.actor({
        ...config,
        createVars: async (c) => ({
          ...(await createVars?.(c)),
          persist: async () => {
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
  const gate = Promise.withResolvers<void>();
  t.onTestFinished(() => gate.resolve());
  const registry = createJuneRegistry({
    owner,
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
            replyInThread: true,
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
  await expect.poll(() => work.length, { timeout: 15000 }).toBe(1);
  await send("2", "hi");
  await expect.poll(texts, { timeout: 15000 }).toContain("Still chatting.");
  expect(work).toHaveLength(1);
  const statusTurn = turns.find((r) =>
    r.messages.at(-1)?.content.includes('"text":"hi"'),
  );
  expect(statusTurn?.system).toContain('"status":"running"');
  expect(statusTurn?.system).toContain('"status":"queued"');
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
  expect(work[2]?.system).toContain("You cannot send messages");
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
    .toContain("constructor: cancellation requested");
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
          !r.executionAvailable &&
          !r.releaseAvailable &&
          !r.socialAvailable &&
          !r.mcpAvailable &&
          !r.replyPlacementAvailable &&
          r.workspaces.length === 0,
      ),
  ).toBe(true);
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
    let calls = 0;
    t.onTestFinished(() => {
      persistence.afterSave = undefined;
      settle.resolve();
      saveSettled.resolve();
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
  work.resolve({ text: "fresh result" });
  await expect
    .poll(async () => (await worker.summary()).status, { timeout: 15000 })
    .toBe("completed");
});
