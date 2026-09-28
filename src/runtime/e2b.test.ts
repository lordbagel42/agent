import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type { MessageEvent, OutboundMessage } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import {
  currentExecutionCapabilities,
  executionCapabilities,
} from "./execution-context.js";
import { createJuneRegistry, type Dependencies } from "./registry.js";

const directive = {
  text: "",
  e2b: { language: "python" as const, code: "print(7 * 9)" },
};

it("exposes E2B only as an available exclusive execution action", () => {
  const capabilities = { e2bAvailable: true };
  expect(replyJsonSchema([], capabilities).properties).toHaveProperty("e2b");
  expect(parseReply(JSON.stringify(directive), [], capabilities)).toEqual(
    directive,
  );
  for (const flags of [
    {},
    { e2bAvailable: false },
    { ...capabilities, agentRole: "interaction" as const },
  ]) {
    expect(replyJsonSchema([], flags).properties).not.toHaveProperty("e2b");
    expect(() => parseReply(JSON.stringify(directive), [], flags)).toThrow();
  }
  for (const extra of [
    { text: "already ran" },
    { webSearch: "query" },
    { reaction: "eyes" },
  ])
    expect(() =>
      parseReply(JSON.stringify({ ...directive, ...extra }), [], {
        ...capabilities,
        webSearchAvailable: true,
      }),
    ).toThrow();
});

it("dispatches owner-private E2B once and rejects forged shared, guest and synthesis actions", async (t) => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const sent: OutboundMessage[] = [];
  let calls = 0;
  let search = false;
  const deps: Dependencies = {
    owner,
    e2b: {
      available: true,
      async run() {
        calls++;
        return {
          status: "ok",
          stdout: ["63\n"],
          stderr: [],
          results: [],
          cleanup: "confirmed",
        };
      },
    },
    webSearch: {
      available: true,
      description: "fixture",
      async search() {
        return { status: "ready", results: [] };
      },
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(message);
          return { status: "sent", messageId: "out" };
        },
      },
    },
    model: {
      async reply(request) {
        if (request.e2bAvailable) expect(request.system).toContain("cheaper");
        return search && request.webSearchAvailable
          ? { text: "", webSearch: "public query" }
          : directive;
      },
    },
  };
  const { client } = await setupTest(t, createJuneRegistry(deps));
  const base: MessageEvent = {
    id: "e2b",
    type: "message",
    messageId: "1",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    direct: true,
    senderId: "U1",
    metadata: { channelType: "im" },
    text: "Run Python in E2B",
  };
  const deliver = async (event: MessageEvent) => {
    const scope = routeEvent(event, owner);
    if (!scope) throw new Error("Invalid fixture");
    const actor = client.conversation.getOrCreate(scope.key);
    await actor.send("inbox", {
      type: "event",
      event: { ...event, messageId: event.id },
    });
    await expect
      .poll(
        async () =>
          Object.values((await actor.snapshot()).events).find(
            (record) => record.event.id === event.id,
          )?.done,
      )
      .toBe(true);
    return actor;
  };
  const actor = await deliver(base);
  expect(calls).toBe(1);
  expect(JSON.stringify(sent[0])).toContain("63");
  await actor.send("inbox", {
    type: "event",
    event: { ...base, messageId: base.id },
  });
  await deliver({
    ...base,
    id: "public",
    direct: false,
    address: { ...base.address, conversationId: "C1" },
    metadata: { channelType: "channel" },
  });
  await deliver({ ...base, id: "guest", senderId: "U2" });
  search = true;
  await deliver({ ...base, id: "synthesis" });
  expect(calls).toBe(1);
  expect(executionCapabilities(deps, base).e2bAvailable).toBe(true);
  expect(currentExecutionCapabilities(deps, base, {}).e2bAvailable).toBe(false);
  expect(
    currentExecutionCapabilities({ ...deps, e2b: undefined }, base, {
      e2bAvailable: true,
    }).e2bAvailable,
  ).not.toBe(true);
});

it("lets June delegate E2B and synthesize a host result without giving the worker a second action", async (t) => {
  let runs = 0;
  let workerTurns = 0;
  const delivered: string[] = [];
  const registry = createJuneRegistry({
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
        async send(message) {
          if (message.content.type === "text")
            delivered.push(message.content.text);
          return { status: "sent", messageId: "out" };
        },
      },
    },
    model: {
      async reply(request) {
        expect(replyJsonSchema([], request).properties).not.toHaveProperty(
          "e2b",
        );
        return request.executionAvailable
          ? {
              text: "",
              execution: [
                {
                  agent: "compute",
                  action: "run",
                  task: "Run the requested Python calculation in E2B",
                },
              ],
            }
          : { text: "Python returned 63; sandbox cleanup was confirmed." };
      },
    },
    execution: {
      model: {
        async reply(request) {
          workerTurns++;
          if (workerTurns === 1) {
            expect(request.e2bAvailable).toBe(true);
            return parseReply(JSON.stringify(directive), [], request);
          }
          expect(request.e2bAvailable).not.toBe(true);
          expect(
            request.messages.some((message) =>
              message.content.includes("63\\n"),
            ),
          ).toBe(true);
          return { text: "Python returned 63; sandbox cleanup was confirmed." };
        },
      },
    },
    e2b: {
      available: true,
      async run() {
        runs++;
        return {
          status: "ok",
          stdout: ["63\n"],
          stderr: [],
          results: [],
          cleanup: "confirmed",
        };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const actor = client.conversation.getOrCreate(["private", "owner"]);
  await actor.send("inbox", {
    type: "event",
    event: {
      id: "delegated-e2b",
      type: "message",
      messageId: "1",
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      senderId: "U1",
      direct: true,
      metadata: { channelType: "im" },
      text: "Use Python in E2B to multiply 7 by 9",
    },
  });
  await expect
    .poll(() => delivered.some((text) => text.includes("Python returned 63")), {
      timeout: 15000,
    })
    .toBe(true);
  expect(runs).toBe(1);
  expect(workerTurns).toBe(2);
});
