import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import { setupTest } from "../../tests/rivet.js";
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

it("lets June define, start and inspect a workflow without a dashboard or guest authority", async (t) => {
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
