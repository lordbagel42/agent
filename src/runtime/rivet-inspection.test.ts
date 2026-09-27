import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "rivetkit/client";
import { expect, it } from "vitest";
import { freeEnginePort, stopTestEngine } from "../../tests/rivet.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { RIVET_REPLY_PREFIX, type RivetRequest } from "../core/rivet.js";
import { routeEvent } from "../core/routing.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { createJuneRegistry, type JuneRegistry } from "./registry.js";
import {
  answerRivetInspection,
  createRivetReader,
} from "./rivet-inspection.js";

const request: RivetRequest = {
  target: "state",
  actorId: "actor-1",
  name: null,
  table: null,
  cursor: null,
  pointer: "",
  offset: 0,
  page: 0,
  format: "raw",
};

it("makes Rivet reads opt-in and rejects mutations, mixed directives and unbounded requests", () => {
  const reply = { text: "", rivet: request };
  expect(
    parseReply(JSON.stringify(reply), [], { rivetAvailable: true }),
  ).toEqual(reply);
  expect(
    replyJsonSchema([], { rivetAvailable: true }).properties,
  ).toHaveProperty("rivet");
  expect(replyJsonSchema([]).properties).not.toHaveProperty("rivet");
  expect(() => parseReply(JSON.stringify(reply), [])).toThrow();
  for (const rivet of [
    { ...request, target: "action" },
    { ...request, target: "database/execute", sql: "DELETE FROM x" },
    { ...request, actorId: "../other" },
    { ...request, page: -1 },
    { ...request, offset: 1e20 },
    { ...request, endpoint: "https://elsewhere.example" },
  ])
    expect(() =>
      parseReply(JSON.stringify({ text: "", rivet }), [], {
        rivetAvailable: true,
      }),
    ).toThrow();
  expect(() =>
    parseReply(
      JSON.stringify({
        ...reply,
        social: {
          kind: "post",
          conversationId: "C1",
          threadId: null,
          text: "leak",
        },
      }),
      [],
      { rivetAvailable: true, socialAvailable: true },
    ),
  ).toThrow();
});

const owner = {
  id: "owner",
  identities: [{ channel: "slack" as const, accountId: "T1", senderId: "U1" }],
};
const event: MessageEvent = {
  id: "inspect",
  type: "message",
  messageId: "100.1",
  occurredAt: Date.now(),
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  senderId: "U1",
  direct: true,
  metadata: { channelType: "im" },
  text: "Inspect retained state",
};

it("reads a real actor through June only in the owner DM without retaining or redisclosing results", async (t) => {
  const sent: OutboundMessage[] = [];
  const prompts: ModelRequest[] = [];
  const paths: string[] = [];
  let action: CompanionReply = { text: "" };
  let synthesisAttack = false;
  const registry = createJuneRegistry({
    owner,
    model: {
      async reply(prompt) {
        prompts.push(prompt);
        if (prompt.usageStage === "synthesis") {
          expect(prompt.workspaces).toEqual([]);
          expect(prompt.mcpAvailable).not.toBe(true);
          expect(prompt.socialAvailable).not.toBe(true);
          expect(prompt.executionAvailable).not.toBe(true);
          expect(prompt.workflowAvailable).not.toBe(true);
          expect(prompt.system).toContain("PRIVATE_FIXTURE");
          return synthesisAttack
            ? {
                text: "",
                social: {
                  kind: "post",
                  conversationId: "C1",
                  threadId: null,
                  text: "PRIVATE_FIXTURE",
                },
              }
            : { text: "PRIVATE_FIXTURE is retained in that conversation." };
        }
        expect(prompt.system).not.toContain("PRIVATE_FIXTURE");
        expect(JSON.stringify(prompt.messages)).not.toContain(
          RIVET_REPLY_PREFIX,
        );
        return action;
      },
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async context() {
          return [
            {
              role: "assistant",
              content: `${RIVET_REPLY_PREFIX}\nPRIVATE_FIXTURE`,
            },
          ];
        },
        async send(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          return { status: "sent", messageId: `out${sent.length}` };
        },
      },
    },
    rivet: async (...args) => read(...args),
  });
  // rivetkit/test bypasses stored inspector auth with a fixed token. Use the
  // normal runtime here so the actual KV credential path is exercised too.
  const directory = await mkdtemp(join(tmpdir(), "june-inspector-"));
  const previousStorage = process.env.RIVETKIT_STORAGE_PATH;
  process.env.RIVETKIT_STORAGE_PATH = directory;
  const port = await freeEnginePort();
  Object.assign(registry.config, {
    namespace: "default",
    token: "default",
    engineHost: "127.0.0.1",
    enginePort: port,
    startEngine: true,
    startServices: false,
    noWelcome: true,
    shutdown: { disableSignalHandlers: true },
    envoy: { poolName: "default" },
    test: { enabled: false },
  });
  t.onTestFinished(async () => {
    await client.dispose();
    await registry.shutdown();
    await stopTestEngine(directory, port);
    await rm(directory, { recursive: true, force: true });
    if (previousStorage === undefined) delete process.env.RIVETKIT_STORAGE_PATH;
    else process.env.RIVETKIT_STORAGE_PATH = previousStorage;
  });
  registry.start();
  await expect
    .poll(async () => (await registry.routes.health()).ok, { timeout: 10000 })
    .toBe(true);
  const runtime = registry.parseConfig();
  const client = createClient<JuneRegistry>({
    endpoint: runtime.endpoint,
    namespace: runtime.namespace,
    token: runtime.token,
    poolName: runtime.envoy.poolName,
  });
  const read = createRivetReader({
    owner,
    connection: () => ({
      endpoint: runtime.endpoint as string,
      namespace: runtime.namespace,
      token: runtime.token,
      pool: runtime.envoy.poolName,
    }),
    fetch: async (input, init) => {
      expect(init?.method).toBe("GET");
      paths.push(new URL(String(input)).pathname);
      const response = await fetch(input, init);
      expect(
        response.ok,
        `${new URL(String(input)).pathname}: ${response.status} ${response.ok ? "" : await response.clone().text()}`,
      ).toBe(true);
      return response;
    },
  });
  const other = client.conversation.getOrCreate([
    "guest",
    "slack",
    "T1",
    "D2",
    "",
    "U2",
  ]);
  // A guest's retained conversation is readable by the owner, never vice versa.
  const guest = {
    ...event,
    id: "private-fixture",
    messageId: "99.1",
    senderId: "U2",
    address: { ...event.address, conversationId: "D2" },
    text: "PRIVATE_FIXTURE",
  };
  await other.send("inbox", { type: "event", event: guest });
  await expect
    .poll(
      async () =>
        Object.values((await other.snapshot()).events).find(
          ({ event }) => event.id === guest.id,
        )?.done,
      {
        timeout: 5000,
      },
    )
    .toBe(true);
  const listed = JSON.parse(
    JSON.parse(
      await read(
        event,
        { ...request, target: "actors", actorId: null, name: "conversation" },
        new AbortController().signal,
      ),
    ).jsonFragment,
  );
  const actorId: string = listed.actors.find((a: { key: string }) =>
    a.key.includes("D2"),
  ).actor_id;
  expect(
    await read(
      event,
      { ...request, actorId, pointer: "/state/history" },
      new AbortController().signal,
    ),
  ).toContain("PRIVATE_FIXTURE");
  action = {
    text: "",
    rivet: { ...request, actorId, pointer: "/state/history", format: "answer" },
  };
  const send = async (extra: Partial<MessageEvent> = {}) => {
    const inbound = {
      ...event,
      id: `e${prompts.length}`,
      messageId: `${prompts.length}.1`,
      ...extra,
    };
    const scope = routeEvent(inbound, owner);
    if (!scope) throw new Error("fixture not admitted");
    const actor = client.conversation.getOrCreate(scope.key);
    await actor.send("inbox", { type: "event", event: inbound });
    await expect
      .poll(
        async () =>
          Object.values((await actor.snapshot()).events).find(
            ({ event }) => event.id === inbound.id,
          )?.done,
        {
          timeout: 5000,
        },
      )
      .toBe(true);
    return { actor, inbound };
  };
  const { actor, inbound } = await send();
  expect(sent.at(-1)?.address).toEqual(event.address);
  expect(sent.at(-1)?.content).toMatchObject({
    type: "text",
    plainText: true,
    text: `${RIVET_REPLY_PREFIX}\nPRIVATE_FIXTURE is retained in that conversation.`,
  });
  expect(JSON.stringify(await actor.snapshot())).not.toContain(
    "PRIVATE_FIXTURE",
  );
  const count = sent.length;
  await actor.send("inbox", { type: "event", event: inbound });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(sent).toHaveLength(count);
  for (const extra of [
    { senderId: "U3" },
    { metadata: { channelType: "mpim" as const } },
    { metadata: undefined },
    {
      direct: false,
      address: { ...event.address, conversationId: "C1" },
      metadata: { channelType: "channel" as const },
    },
  ]) {
    const before = paths.length;
    await send(extra);
    expect(prompts.at(-1)?.rivetAvailable).toBe(false);
    expect(paths).toHaveLength(before);
    expect(JSON.stringify(sent.slice(count))).not.toContain("PRIVATE_FIXTURE");
  }
  synthesisAttack = true;
  await send();
  expect(sent.at(-1)?.content).toMatchObject({
    text: expect.stringContaining("couldn't complete"),
  });
  expect(
    sent.every(
      (m) =>
        m.address.conversationId !== "C1" ||
        !JSON.stringify(m).includes("PRIVATE_FIXTURE"),
    ),
  ).toBe(true);
  // Exercise every pinned inspector GET, and ensure DB internals cannot reveal KV credentials.
  for (const target of [
    "state",
    "summary",
    "connections",
    "rpcs",
    "queue",
    "workflow-history",
    "database-schema",
    "actor",
    "runners",
  ] as const) {
    const result = JSON.parse(
      await read(
        event,
        { ...request, target, actorId },
        new AbortController().signal,
      ),
    );
    expect(result.target).toBe(target);
    expect(result.jsonFragment).toBeTruthy();
  }
  await expect(
    read(
      event,
      { ...request, target: "database-rows", actorId, table: "_rivet_kv" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("table_not_allowed");
  const before = paths.length;
  for (const denied of [
    { ...event, senderId: "U2" },
    { ...event, address: { ...event.address, accountId: "T2" } },
    { ...event, metadata: undefined },
  ])
    await expect(
      read(denied, request, new AbortController().signal),
    ).rejects.toThrow("owner_dm_required");
  expect(paths).toHaveLength(before);
});

it("redacts before JSON pointer selection and never follows redirects or inspects a foreign pool", async () => {
  const paths: string[] = [];
  let pool = "june";
  const read = createRivetReader({
    owner,
    connection: () => ({
      endpoint: "https://engine.example/prefix/",
      namespace: "june-ns",
      token: "management-secret",
      pool: "june",
    }),
    secrets: ["live-secret-value"],
    fetch: async (input, init) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      expect(init?.redirect).toBe("error");
      expect(url.searchParams.get("namespace")).toBe("june-ns");
      if (url.pathname.endsWith("/actors"))
        return Response.json({
          actors: [
            {
              actor_id: "actor-1",
              name: "conversation",
              runner_name_selector: pool,
            },
          ],
        });
      if (url.pathname.includes("/kv/"))
        return Response.json({
          value: Buffer.from("inspector-secret").toString("base64"),
        });
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer inspector-secret",
      );
      expect(new Headers(init?.headers).get("X-Rivet-Token")).toBe(
        "management-secret",
      );
      return Response.json({
        state: {
          authToken: "different-secret",
          text: "a live-secret-value b",
          public: "🙂".repeat(2450),
        },
      });
    },
  });
  const signal = new AbortController().signal;
  const page = JSON.parse(
    await read(event, { ...request, pointer: "/state/authToken" }, signal),
  );
  expect(JSON.parse(page.jsonFragment)).toBe("[REDACTED]");
  expect(
    await read(event, { ...request, pointer: "/state/text" }, signal),
  ).not.toContain("live-secret-value");
  const first = JSON.parse(
    await read(event, { ...request, pointer: "/state/public" }, signal),
  );
  const second = JSON.parse(
    await read(
      event,
      { ...request, pointer: "/state/public", page: 1 },
      signal,
    ),
  );
  expect(first.nextPage).toBe(1);
  expect(second.nextPage).toBeNull();
  expect(JSON.parse(first.jsonFragment + second.jsonFragment)).toBe(
    "🙂".repeat(2450),
  );
  pool = "other";
  const before = paths.length;
  await expect(read(event, request, signal)).rejects.toThrow(
    "actor_out_of_scope",
  );
  expect(paths.slice(before)).toEqual(["/prefix/actors"]);
  let valid = true;
  let modelCalls = 0;
  await expect(
    answerRivetInspection({
      event,
      first: { ...request, format: "answer" },
      signal,
      valid: () => valid,
      read: async () => {
        valid = false;
        return "private";
      },
      model: {
        async reply() {
          modelCalls++;
          return { text: "leak" };
        },
      },
    }),
  ).rejects.toThrow("inspection_invalidated");
  expect(modelCalls).toBe(0);
});
