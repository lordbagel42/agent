import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { setupTest } from "../../tests/rivet.js";
import { AgentService } from "../agent/service.js";
import type {
  CompanionReply,
  MessageEvent,
  OutboundMessage,
} from "../core/contracts.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { createLifecycle } from "../runtime/lifecycle.js";
import { createJuneRegistry } from "../runtime/registry.js";
import { createWorkflowTools } from "./tools.js";

const owner = {
  id: "raygen",
  identities: [{ channel: "slack" as const, accountId: "T1", senderId: "U1" }],
};
const event = (id: string): MessageEvent => ({
  type: "message",
  id,
  messageId: `${id}.001`,
  occurredAt: Date.now(),
  senderId: "U1",
  direct: true,
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  text: id,
});
const command = (action: string, extra = {}) => ({
  action,
  name: null,
  source: null,
  dataJson: null,
  runId: null,
  offset: 0,
  ...extra,
});

it("exposes workflow commands only with the capability and forbids mixed directives", () => {
  const reply = {
    text: "",
    workflow: command("define", { name: "check", source: "return input + 1;" }),
  };
  expect(
    parseReply(JSON.stringify(reply), [], { workflowAvailable: true }),
  ).toEqual(reply);
  expect(
    replyJsonSchema([], { workflowAvailable: true }).properties,
  ).toHaveProperty("workflow");
  expect(() => parseReply(JSON.stringify(reply), [])).toThrow();
  expect(() =>
    parseReply(JSON.stringify({ ...reply, webSearch: "leak" }), [], {
      workflowAvailable: true,
      webSearchAvailable: true,
    }),
  ).toThrow();
});

it("isolates admitted workflow definitions, runs and receipts to the original task scope", async (t) => {
  const registry = createJuneRegistry({
    owner,
    channels: {},
    model: { reply: async () => ({ text: "" }) },
    workflows: { tools: {} },
  });
  const { client } = await setupTest(t, registry);
  const library = client.workflowLibrary.getOrCreate([owner.id]);
  const channel: MessageEvent = {
    ...event("channel"),
    senderId: "guest",
    direct: false,
    botMentioned: true,
    metadata: { channelType: "channel" },
    address: {
      channel: "slack",
      accountId: "T1",
      conversationId: "C1",
      threadId: "thread",
    },
  };
  const dm: MessageEvent = {
    ...event("dm"),
    senderId: "guest",
    metadata: { channelType: "im" },
    address: { channel: "slack", accountId: "T1", conversationId: "D2" },
  };
  const sources = [
    event("owner"),
    {
      ...event("other-dm"),
      address: { ...event("owner").address, conversationId: "D3" },
    },
    channel,
    dm,
    {
      ...channel,
      botMentioned: false,
      questionAnswered: true,
      address: { ...channel.address, conversationId: "C2" },
    },
  ];
  for (const [i, source] of sources.entries()) {
    const manage = (id: string, action: string, extra = {}) =>
      library.manage(source, id, command(action, extra));
    expect(JSON.parse(await manage("list", "list"))).toEqual({
      definitions: [],
      runs: [],
    });
    await expect(
      manage("inspect", "inspect", { name: "same-name" }),
    ).rejects.toThrow();
    await expect(
      manage(`missing-${i}`, "start", { name: "same-name" }),
    ).rejects.toThrow();
    const code = `await workflow.wait("hold"); return ${i};`;
    await manage(`define-${i}`, "define", { name: "same-name", source: code });
    const started = JSON.parse(
      await manage(`start-${i}`, "start", { name: "same-name" }),
    );
    expect(started.status).toBe("accepted");
    expect(
      JSON.parse(await manage(`start-${i}`, "start", { name: "same-name" }))
        .runId,
    ).toBe(started.runId);
    expect(
      JSON.parse(await manage("inspect", "inspect", { name: "same-name" }))
        .source,
    ).toBe(code);
    expect(
      JSON.parse(await manage("list", "list")).runs.map(
        (run: { runId: string }) => run.runId,
      ),
    ).toEqual([started.runId]);
    await manage("cancel", "cancel", { runId: started.runId });
    expect(
      JSON.parse(await manage("inspect", "inspect", { runId: started.runId }))
        .status,
    ).toBe("cancelled");
    const run = client.workflowRun.getOrCreate([owner.id, started.runId]);
    const presentation = await run.presentation(source);
    expect(presentation).toEqual({
      runId: started.runId,
      name: "same-name",
      revision: started.revision,
      status: "cancelled",
      operations: expect.any(Array),
    });
    // Existing artifact viewers use the status-only presentation behind the
    // artifact's public/PIN access controls, not the creator's live event.
    expect(await run.presentation()).toEqual(presentation);
    for (const other of [
      {
        ...source,
        senderId: "someone-else",
        metadata: source.metadata ?? { channelType: "im" as const },
      },
      {
        ...source,
        address: { ...source.address, conversationId: "elsewhere" },
      },
      { ...source, address: { ...source.address, threadId: "other-thread" } },
    ]) {
      expect(await run.presentation(other)).toBeNull();
      expect(
        JSON.parse(await library.manage(other, "list", command("list"))),
      ).toEqual({ definitions: [], runs: [] });
      for (const action of ["inspect", "signal", "cancel"])
        await expect(
          library.manage(
            other,
            action,
            command(action, { runId: started.runId }),
          ),
        ).rejects.toThrow();
      // A cached write receipt must not reveal another scope's run or definition.
      await expect(
        library.manage(
          other,
          `start-${i}`,
          command("start", { name: "same-name" }),
        ),
      ).rejects.toThrow();
      await expect(
        library.manage(
          other,
          `define-${i}`,
          command("define", { name: "same-name", source: code }),
        ),
      ).rejects.toThrow();
    }
    expect(
      await run.presentation({
        ...source,
        address: { ...source.address, accountId: "unconfigured" },
      }),
    ).toBeNull();
    if (source.senderId === "guest") {
      expect(
        await run.presentation({ ...source, metadata: undefined }),
      ).toBeNull();
      expect(
        await run.presentation({
          ...source,
          senderId: owner.identities[0]?.senderId ?? "U1",
        }),
      ).toBeNull();
    }
  }
  for (const invalid of [
    { ...channel, botMentioned: false },
    { ...dm, metadata: undefined },
    { ...dm, address: { ...dm.address, accountId: "unconfigured" } },
  ])
    await expect(
      library.manage(
        invalid,
        "invalid",
        command("start", { name: "bad", source: "return null;" }),
      ),
    ).rejects.toThrow();
});

it("notifies the admitted original channel or DM and preserves unknown-send receipts", async () => {
  const sent: OutboundMessage[] = [];
  const tools = createWorkflowTools({
    owner,
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        receive: async () => ({ response: new Response(), events: [] }),
        send: async (message) => {
          sent.push(message);
          return { status: "unknown", code: "connection_lost" };
        },
      },
    },
    model: { reply: async () => ({ text: "" }) },
  });
  for (const channelType of ["channel", "im"] as const) {
    const source: MessageEvent = {
      ...event("notify"),
      senderId: "guest",
      direct: channelType === "im",
      botMentioned: channelType === "channel",
      metadata: { channelType },
    };
    const context = {
      source,
      operationId: channelType,
      signal: new AbortController().signal,
    };
    await expect(
      tools.notify?.execute({ text: "Progress" }, context),
    ).rejects.toThrow("workflow_send_unknown");
    expect(sent.at(-1)).toMatchObject({
      id: `workflow:${channelType}`,
      address: source.address,
    });
    await expect(
      tools.notify?.execute(
        { text: "Progress" },
        { ...context, source: { ...source, metadata: undefined } },
      ),
    ).rejects.toThrow("workflow_denied");
    await expect(
      tools.notify?.execute(
        { text: "Progress" },
        { ...context, signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow();
  }
  expect(sent).toHaveLength(2);
});

it("admits workflow callbacks from channels and DMs while fencing revoked agent identities", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-callback-"));
  const agents = new AgentService({
    directory,
    key: randomBytes(32),
    ownerId: owner.id,
    clients: [
      {
        id: "agent",
        token: randomBytes(32).toString("base64url"),
        expiresAt: Date.now() + 60_000,
      },
    ],
    destinations: [],
    submit: async () => {},
    snapshot: async () => ({
      history: [],
      events: {},
      deliveries: {},
      jobs: {},
      lastInbound: {},
    }),
  });
  t.onTestFinished(async () => {
    await agents.close();
    await rm(directory, { recursive: true, force: true });
  });
  const tools = createWorkflowTools({
    owner: {
      ...owner,
      identities: [
        ...owner.identities,
        { channel: "agent", accountId: owner.id, senderId: "agent" },
      ],
    },
    agents,
    channels: {},
    model: { reply: async () => ({ text: "" }) },
  });
  const context = {
    operationId: "callbacks",
    signal: new AbortController().signal,
  };
  for (const channelType of ["channel", "im"] as const) {
    const source: MessageEvent = {
      ...event("callback"),
      senderId: "guest",
      direct: channelType === "im",
      botMentioned: channelType === "channel",
      metadata: { channelType },
    };
    expect(
      await tools.agent_webhook?.execute(
        { action: "list" },
        { ...context, source },
      ),
    ).toEqual([]);
    await expect(
      tools.agent_webhook?.execute(
        { action: "list" },
        { ...context, source: { ...source, metadata: undefined } },
      ),
    ).rejects.toThrow("workflow_denied");
  }
  const source: MessageEvent = {
    ...event("agent"),
    senderId: "agent",
    address: {
      channel: "agent",
      accountId: owner.id,
      conversationId: "thread",
    },
  };
  expect(
    await tools.agent_webhook?.execute(
      { action: "list" },
      { ...context, source },
    ),
  ).toEqual([]);
  agents.revokeClient("agent");
  await expect(
    tools.agent_webhook?.execute({ action: "list" }, { ...context, source }),
  ).rejects.toThrow("workflow_denied");
});

it("journals authored code, pins revisions, waits for signals, runs parallel steps and cancels", async (t) => {
  const calls: number[] = [];
  const registry = createJuneRegistry({
    owner,
    channels: {},
    model: {
      async reply() {
        return { text: "" };
      },
    },
    workflows: {
      tools: {
        multiply: {
          description: "Multiply by three",
          schema: z.object({ value: z.number() }),
          async execute(args) {
            const n = (args as { value: number }).value;
            calls.push(n);
            return n * 3;
          },
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const library = client.workflowLibrary.getOrCreate([owner.id]);
  const manage = (id: string, action: string, extra = {}) =>
    library.manage(event(id), id, command(action, extra));
  const source = `const first = await workflow.step("first", "multiply", {value:input});
    const signal = await workflow.wait("answer");
    const rest = await workflow.parallel("rest", [
      {name:"left", tool:"multiply", args:{value:signal.value}},
      {name:"right", tool:"multiply", args:{value:5}}
    ]);
    await workflow.sleep("brief", 25);
    return first + rest.left + rest.right;`;
  await manage("define", "define", { name: "demo", source });
  const started = JSON.parse(
    await manage("start", "start", { name: "demo", dataJson: "7" }),
  );
  const run = client.workflowRun.getOrCreate([owner.id, started.runId]);
  await expect
    .poll(async () => (await run.inspect()).status, { timeout: 15000 })
    .toBe("waiting");
  expect(calls).toEqual([7]);
  expect(
    JSON.parse(await manage("start", "start", { name: "demo", dataJson: "7" }))
      .runId,
  ).toBe(started.runId);
  await manage("edit", "define", { name: "demo", source: "return 999;" });
  await manage("signal", "signal", {
    runId: started.runId,
    dataJson: '{"value":11}',
  });
  await expect
    .poll(async () => (await run.inspect()).status, { timeout: 15000 })
    .toBe("completed");
  expect(await run.inspect()).toMatchObject({ result: 69 });
  expect(calls.sort((a, b) => a - b)).toEqual([5, 7, 11]);
  await manage("waiting", "define", {
    name: "hold",
    source: 'await workflow.sleep("hold", 86400000); return 99;',
  });
  const held = JSON.parse(await manage("hold", "start", { name: "hold" }));
  const holding = client.workflowRun.getOrCreate([owner.id, held.runId]);
  await expect
    .poll(async () => (await holding.inspect()).status)
    .toBe("waiting");
  await manage("cancel", "cancel", { runId: held.runId });
  await expect
    .poll(async () => (await holding.inspect()).status)
    .toBe("cancelled");
  await expect(
    library.manage(
      { ...event("guest"), senderId: "U2" },
      "guest",
      command("start", { name: "demo" }),
    ),
  ).rejects.toThrow();
}, 60_000);

it("lets June define, start and inspect a workflow without a dashboard", async (t) => {
  const sent: OutboundMessage[] = [];
  const turns: boolean[] = [];
  const registry = createJuneRegistry({
    owner,
    workflows: { tools: {} },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(message);
          return { status: "sent", messageId: `out-${sent.length}` };
        },
      },
    },
    model: {
      async reply(request): Promise<CompanionReply> {
        turns.push(request.workflowAvailable === true);
        const text = JSON.parse(request.messages.at(-1)?.content ?? "{}").text;
        return {
          text: "",
          workflow: command(
            text === "define" ? "define" : "start",
            text === "define"
              ? { name: "hello", source: "return input * 7;" }
              : { name: "hello", dataJson: "13" },
          ),
        } as CompanionReply;
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", owner.id]);
  for (const id of ["define", "start"]) {
    const before = sent.length;
    await june.send("inbox", { type: "event", event: event(id) });
    await expect.poll(() => sent.length, { timeout: 15000 }).toBe(before + 1);
  }
  expect(turns).toEqual([true, true]);
  const content = sent.at(-1)?.content;
  const started = JSON.parse(content?.type === "text" ? content.text : "{}");
  const run = client.workflowRun.getOrCreate([owner.id, started.runId]);
  await expect
    .poll(async () => (await run.inspect()).result, { timeout: 15000 })
    .toBe(91);
}, 45_000);

it("runs the shipped catalog through June's single-turn start with source", async (t) => {
  const sent: OutboundMessage[] = [];
  const channels = {
    slack: {
      channel: "slack" as const,
      capabilities: {
        text: true as const,
        reactions: true as const,
        threads: true,
      },
      async receive() {
        return { response: new Response(), events: [] };
      },
      async send(message: OutboundMessage) {
        sent.push(message);
        return { status: "sent" as const, messageId: `out-${sent.length}` };
      },
    },
  };
  const source =
    'const answer = await workflow.step("think", "model", {prompt:"Compute thirteen times seven"}); await workflow.step("tell", "notify", {text:answer}); return answer;';
  const registry = createJuneRegistry({
    owner,
    channels,
    workflows: {
      tools: createWorkflowTools({
        owner,
        channels,
        model: {
          async reply(request) {
            expect(request.workspaces).toEqual([]);
            expect(request.mcpAvailable).not.toBe(true);
            expect(request.workflowAvailable).not.toBe(true);
            return { text: "91" };
          },
        },
      }),
    },
    model: {
      async reply(request) {
        expect(request.system).toContain('"notify"');
        return {
          text: "",
          workflow: command("start", { name: "one-turn", source }),
        } as CompanionReply;
      },
    },
  });
  const { client } = await setupTest(t, registry);
  await client.conversation
    .getOrCreate(["private", owner.id])
    .send("inbox", { type: "event", event: event("do-it") });
  await expect
    .poll(
      () =>
        sent.find((m) => m.content.type === "text" && m.content.text === "91"),
      { timeout: 15000 },
    )
    .toBeDefined();
  const delivered = sent.find(
    (m) => m.content.type === "text" && m.content.text === "91",
  );
  expect(delivered?.address).toEqual(event("do-it").address);
}, 30_000);

it("stops uncertain effects, rejects duplicate names, and suppresses late results after revocation", async (t) => {
  const calls: string[] = [];
  const pending = Promise.withResolvers<null>();
  const lifecycle = createLifecycle();
  const registry = createJuneRegistry({
    owner,
    lifecycle,
    channels: {},
    model: {
      async reply() {
        return { text: "" };
      },
    },
    workflows: {
      tools: {
        effect: {
          description: "Fixture",
          schema: z.strictObject({ mode: z.string() }),
          async execute(args) {
            const mode = (args as { mode: string }).mode;
            calls.push(mode);
            if (mode === "unknown") throw new Error("lost response");
            if (mode === "late") return pending.promise;
            return null;
          },
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const library = client.workflowLibrary.getOrCreate([owner.id]);
  const start = async (name: string, source: string) => {
    const report = JSON.parse(
      await library.manage(
        event(name),
        name,
        command("start", { name, source }),
      ),
    );
    return client.workflowRun.getOrCreate([owner.id, report.runId]);
  };
  const unknown = await start(
    "unknown",
    'try { await workflow.step("one","effect",{mode:"unknown"}); } catch {} await workflow.step("two","effect",{mode:"forbidden"});',
  );
  await expect
    .poll(async () => (await unknown.inspect()).status, { timeout: 10000 })
    .toBe("needs_review");
  const duplicate = await start(
    "duplicate",
    'await workflow.step("same","effect",{mode:"once"}); await workflow.step("same","effect",{mode:"once"});',
  );
  await expect
    .poll(async () => (await duplicate.inspect()).status, { timeout: 10000 })
    .toBe("failed");
  const invalid = await start(
    "invalid",
    'await workflow.step("invalid","missing",{});',
  );
  await expect
    .poll(async () => (await invalid.inspect()).status, { timeout: 10000 })
    .toBe("failed");
  const late = await start(
    "late",
    'await workflow.step("slow","effect",{mode:"late"}); await workflow.step("next","effect",{mode:"forbidden"}); return "private";',
  );
  await expect
    .poll(() => calls.includes("late"), { timeout: 10000 })
    .toBe(true);
  await library.invalidate();
  pending.resolve(null);
  await expect
    .poll(async () => await late.inspect())
    .toEqual({ status: "revoked" });
  expect(await late.presentation(event("late"))).toBeNull();
  expect(await late.presentation()).toBeNull();
  await expect.poll(() => lifecycle.active).toBe(0);
  expect(lifecycle.ready).toBe(true);
  expect(await lifecycle.drain()).toBe(true);
  lifecycle.resume();
  const release = lifecycle.tryEnter();
  expect(release).toBeDefined();
  release?.();
  expect(calls).toEqual(["unknown", "once", "late"]);
}, 45_000);

it("retries revision-bound forgetting without erasing newer runs, definitions or receipts", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const registry = createJuneRegistry({
    owner,
    channels: {},
    model: {
      async reply() {
        return { text: "" };
      },
    },
    memory: { store, source: () => undefined },
    workflows: { tools: {} },
  });
  const { client } = await setupTest(t, registry);
  const library = client.workflowLibrary.getOrCreate([owner.id]);
  const manage = (id: string, action: string, extra = {}) =>
    library.manage(
      event(id),
      id,
      command(action, extra),
      store.deletionRevision(),
    );
  await manage("old", "start", {
    name: "kept",
    source: 'await workflow.wait("hold");',
  });
  store.deleteSource("forgotten-source");
  const cutoff = store.deletionRevision();
  expect(cutoff).toBe(1);
  const started = JSON.parse(
    await manage("new", "start", {
      name: "kept",
      source: "return 17;",
    }),
  );
  const run = client.workflowRun.getOrCreate([owner.id, started.runId]);
  await expect
    .poll(async () => (await run.inspect()).result, { timeout: 15000 })
    .toBe(17);
  const saved = await manage("saved", "define", {
    name: "kept",
    source: "return 29;",
  });
  await manage("edited", "define", { name: "kept", source: "return 31;" });
  for (let retry = 0; retry < 2; retry++) {
    await library.invalidate(cutoff);
    // If cleanup discarded this receipt, replay would overwrite the newer edit.
    expect(
      await manage("saved", "define", { name: "kept", source: "return 29;" }),
    ).toBe(saved);
    expect(
      JSON.parse(await manage("inspect", "inspect", { name: "kept" })).source,
    ).toBe("return 31;");
    expect((await run.inspect()).result).toBe(17);
    expect(
      JSON.parse(await manage("list", "list")).runs.map(
        (r: { runId: string }) => r.runId,
      ),
    ).toEqual([started.runId]);
  }
}, 30_000);
