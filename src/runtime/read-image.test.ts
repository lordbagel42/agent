import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type { ModelRequest, ModelSettlement } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { type CapabilityContext, runCapability } from "./capabilities.js";
import {
  currentExecutionCapabilities,
  executionCapabilities,
} from "./execution-context.js";
import { buildModelRequest } from "./prompt.js";
import { createJuneRegistry, type Dependencies } from "./registry.js";

const command = { fileId: "F123", question: "What does the sign say?" };
const request: ModelRequest = {
  system: "June",
  messages: [],
  workspaces: [],
  agentRole: "execution",
  readImageAvailable: true,
};
function fixture() {
  let downloads = 0;
  let reviews = 0;
  const image = {
    evidenceId: "slack:F123",
    mimeType: "image/png" as const,
    data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  };
  const context: CapabilityContext = {
    event: {
      type: "message",
      id: "event",
      messageId: "123.456",
      senderId: "U1",
      direct: true,
      text: "",
      occurredAt: 1,
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      metadata: {
        channelType: "im",
        files: [{ id: "F123", mimetype: "image/png" }],
      },
    },
    scope: { key: ["private", "owner"], private: true },
    audience: "owner",
    eventId: "event",
    origin: "event",
    phase: "reply",
    ownerTurn: true,
    deletionRevision: 0,
    personalityVersion: undefined,
    workspaces: [],
    signal: new AbortController().signal,
    valid: () => true,
    model: {
      async reply(input) {
        reviews++;
        expect(input.images).toEqual([image]);
        expect(
          input.messages.some((m) => m.content.includes(command.question)),
        ).toBe(true);
        expect(input.messages.map((m) => m.content).join(" ")).not.toContain(
          "137,80",
        );
        expect(
          Object.entries(input).filter(
            ([key, value]) => key.endsWith("Available") && value,
          ),
        ).toEqual([]);
        return { text: "The sign says WEST; the small text is unreadable." };
      },
    },
    deps: {
      owner: {
        id: "owner",
        identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
      },
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
          async readImage() {
            downloads++;
            return { status: "ready", image };
          },
        },
      },
    },
    ports: {} as CapabilityContext["ports"],
  };
  context.model.beginReply = (...args) => ({
    answer: context.model.reply(...args),
    settlement: Promise.resolve("confirmed_stopped"),
  });
  return { context, counts: () => ({ downloads, reviews }) };
}

it("gates the directive and exposes current file IDs to workers without automated reads", () => {
  const reply = JSON.stringify({ text: "", readImage: command });
  expect(parseReply(reply, [], request).readImage).toEqual(command);
  for (const caps of [
    {},
    { ...request, agentRole: "interaction" as const },
    { ...request, readImageAvailable: false },
  ])
    expect(() => parseReply(reply, [], caps)).toThrow();
  expect(() =>
    parseReply(
      JSON.stringify({ text: "claimed", readImage: command }),
      [],
      request,
    ),
  ).toThrow();
  const { context } = fixture();
  const deps = { ...context.deps, model: context.model } as Dependencies;
  const ceiling = executionCapabilities(deps, context.event);
  expect(ceiling.readImageAvailable).toBe(true);
  expect(
    currentExecutionCapabilities(deps, context.event, {}).readImageAvailable,
  ).toBe(false);
  for (const agentRole of ["interaction", "execution"] as const) {
    const prompt = buildModelRequest({
      event: context.event,
      owner: deps.owner,
      history: [],
      now: new Date(),
      agentRole,
      capabilities: ceiling,
      models: { current: { provider: "test", model: "test" } },
    });
    expect(prompt.system).toContain("readImage");
    expect(prompt.system).toContain("F123");
    expect(
      Object.hasOwn(replyJsonSchema([], prompt).properties, "readImage"),
    ).toBe(agentRole === "execution");
  }
  const automated = buildModelRequest({
    event: context.event,
    owner: deps.owner,
    history: [],
    now: new Date(),
    capabilities: ceiling,
    models: { current: { provider: "test", model: "test" } },
    wakeup: {
      mode: "decision",
      runId: "run",
      jobId: "job",
      instruction: "observe",
      event: {
        id: "trigger",
        source: "github",
        type: "push",
        occurredAt: 1,
        data: {},
      },
    },
  });
  expect(automated.readImageAvailable).toBe(false);
  expect(automated.system).toContain("readImage");
});

it("reviews native bytes once, returning only text, and withholds unauthorized or revoked reads", async () => {
  const { context, counts } = fixture();
  const result = await runCapability(
    { text: "", readImage: command },
    request,
    context,
  );
  expect(result).toEqual({
    text: "The sign says WEST; the small text is unreadable.",
  });
  expect(counts()).toEqual({ downloads: 1, reviews: 1 });
  for (const change of [
    { ownerTurn: false },
    { origin: "wakeup" },
    { phase: "synthesis" },
    { valid: () => false },
    { scope: { key: ["channel"], private: false } },
  ] satisfies Partial<CapabilityContext>[]) {
    const denied = fixture();
    const answer = await runCapability(
      { text: "", readImage: command },
      request,
      { ...denied.context, ...change },
    );
    expect(answer.text).not.toContain("WEST");
    expect(denied.counts()).toEqual({ downloads: 0, reviews: 0 });
  }
  const revoked = fixture();
  const abort = new AbortController();
  revoked.context.signal = abort.signal;
  revoked.context.model.reply = async () => {
    abort.abort();
    return { text: "REVOKED_CONTENT" };
  };
  expect(
    (
      await runCapability(
        { text: "", readImage: command },
        request,
        revoked.context,
      )
    ).text,
  ).not.toContain("REVOKED_CONTENT");
});

it("holds image review until provider retirement, including abort, rejection and unknown settlement", async () => {
  for (const mode of ["success", "abort", "rejected", "unknown"] as const) {
    const { context } = fixture();
    const abort = new AbortController();
    context.signal = abort.signal;
    const retirement = Promise.withResolvers<ModelSettlement>();
    let started = false;
    context.model.beginReply = () => {
      started = true;
      return {
        answer:
          mode === "rejected"
            ? Promise.reject(new Error("provider failed"))
            : Promise.resolve({ text: "VISIBLE" }),
        settlement: retirement.promise,
      };
    };
    let finished = false;
    const pending = runCapability(
      { text: "", readImage: command },
      request,
      context,
    ).then(
      (result) => {
        finished = true;
        return { result };
      },
      (error) => {
        finished = true;
        return { error };
      },
    );
    await setImmediate();
    expect(started).toBe(true);
    expect(finished).toBe(false);
    if (mode === "abort") abort.abort();
    await setImmediate();
    expect(finished).toBe(false);
    retirement.resolve(mode === "unknown" ? "unknown" : "confirmed_stopped");
    const outcome = await pending;
    if (mode === "unknown" || mode === "rejected")
      expect(outcome).toHaveProperty("error");
    else
      expect(outcome).toEqual({
        result: { text: mode === "abort" ? "" : "VISIBLE" },
      });
  }
});

it.for(["readImage", "readVideo"] as const)(
  "delegates %s once and enters report-only mode",
  async (action, t) => {
    const { context, counts } = fixture();
    const sent: string[] = [];
    let reported = false;
    const adapter = context.deps.channels?.slack;
    if (!adapter) throw new Error("Missing adapter");
    if (action === "readVideo") {
      context.event.metadata = {
        channelType: "im",
        files: [{ id: "F123", mimetype: "video/mp4" }],
      };
      adapter.readVideo = async (...args) => {
        const result = await adapter.readImage?.(...args);
        if (result?.status !== "ready") throw new Error("Missing fixture");
        return {
          status: "ready",
          images: [{ ...result.image, mediaTimeSeconds: 0.5 }],
        };
      };
      context.model.reply = async (input) => {
        expect(input.images?.[0]?.mediaTimeSeconds).toBe(0.5);
        expect(input.system).toContain("audio");
        expect(input.readVideoAvailable).not.toBe(true);
        return {
          text: "The sign says WEST in the sampled frame; no audio was reviewed.",
        };
      };
    }
    adapter.send = async (message) => {
      if (message.content.type === "text") sent.push(message.content.text);
      return { status: "sent", messageId: `out-${sent.length}` };
    };
    const registry = createJuneRegistry({
      owner: context.deps.owner,
      channels: { slack: adapter },
      model: {
        async reply(input) {
          if (input.executionAvailable) {
            expect(input[`${action}Available`]).toBe(true);
            return {
              text: "",
              execution: [
                {
                  agent: "image",
                  action: "run",
                  task: "Inspect attached F123 and report the sign text.",
                },
              ],
            };
          }
          if (!reported) return { text: "No verified review" };
          return { text: "The sign says WEST; small text is unreadable." };
        },
      },
      execution: {
        model: {
          beginReply: context.model.beginReply,
          async reply(input) {
            const observation = input.messages.find((m) =>
              m.content.includes("Host tool observation"),
            );
            if (observation) {
              expect(observation.content).toContain("WEST");
              expect(input[`${action}Available`]).toBe(false);
              reported = true;
              return { text: "The sign says WEST; small text is unreadable." };
            }
            expect(input.system).toContain("F123");
            return { text: "", [action]: command };
          },
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const scope = routeEvent(context.event, context.deps.owner);
    if (!scope) throw new Error("Missing scope");
    await client.conversation
      .getOrCreate(scope.key)
      .send("inbox", { type: "event", event: context.event });
    await expect
      .poll(() => sent.join("\n"), { timeout: 15000 })
      .toContain("WEST");
    expect(counts().downloads).toBe(1);
  },
);

it("limits video schema and prompt grants to current owner-private worker requests", () => {
  const { context } = fixture();
  const videoRequest = {
    ...request,
    readImageAvailable: false,
    readVideoAvailable: true,
  };
  const reply = JSON.stringify({ text: "", readVideo: command });
  expect(parseReply(reply, [], videoRequest).readVideo).toEqual(command);
  for (const caps of [
    {},
    { ...videoRequest, agentRole: "interaction" as const },
    { ...videoRequest, readVideoAvailable: false },
  ])
    expect(() => parseReply(reply, [], caps)).toThrow();
  expect(() =>
    parseReply(
      JSON.stringify({ text: "", readImage: command, readVideo: command }),
      [],
      { ...request, readVideoAvailable: true },
    ),
  ).toThrow();
  for (const agentRole of ["interaction", "execution"] as const) {
    const prompt = buildModelRequest({
      event: context.event,
      owner: context.deps.owner,
      history: [],
      now: new Date(),
      agentRole,
      capabilities: { readVideoAvailable: true },
      models: { current: { provider: "test", model: "test" } },
    });
    expect(prompt.system).toContain("readVideo");
    expect(prompt.system).toContain("F123");
    expect(
      Object.hasOwn(replyJsonSchema([], prompt).properties, "readVideo"),
    ).toBe(agentRole === "execution");
  }
  const automated = buildModelRequest({
    event: context.event,
    owner: context.deps.owner,
    history: [],
    now: new Date(),
    capabilities: { readVideoAvailable: true },
    models: { current: { provider: "test", model: "test" } },
    wakeup: {
      mode: "decision",
      runId: "run",
      jobId: "job",
      instruction: "observe",
      event: {
        id: "trigger",
        source: "github",
        type: "push",
        occurredAt: 1,
        data: {},
      },
    },
  });
  expect(automated.readVideoAvailable).toBe(false);
  expect(
    Object.hasOwn(replyJsonSchema([], automated).properties, "readVideo"),
  ).toBe(false);
  expect(automated.system).toContain("readVideo");
});
