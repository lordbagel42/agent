import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, test } from "vitest";
import { createConnectionRoutes } from "../src/console/connections.js";
import type { ModelRequest } from "../src/core/contracts.js";
import { parseReply, replyJsonSchema } from "../src/models/provider.js";
import { buildModelRequest } from "../src/runtime/prompt.js";
import { McpConnections } from "../src/tools/connections.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "june-mcp-"));
  const calls: unknown[] = [];
  let description = "Look up a record";
  let onList = () => {};
  const store = new McpConnections(
    {
      directory,
      key: Buffer.alloc(32, 7),
      owner: "owner",
      origin: "https://june.example",
    },
    {
      fetch: async (_url, init) => {
        if (init?.method === "DELETE")
          return new Response(null, { status: 204 });
        const message = JSON.parse(String(init?.body));
        if (message.id === undefined)
          return new Response(null, { status: 202 });
        if (message.method === "tools/list") onList();
        if (message.method === "tools/call") calls.push(message.params);
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result:
            message.method === "initialize"
              ? {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "fixture", version: "1" },
                }
              : message.method === "tools/list"
                ? {
                    tools: [
                      {
                        name: "lookup",
                        description,
                        inputSchema: {
                          type: "object",
                          properties: { id: { type: "string" } },
                          required: ["id"],
                          additionalProperties: false,
                        },
                      },
                    ],
                  }
                : {
                    content: [
                      { type: "text", text: "private result private-token" },
                    ],
                  },
        });
      },
    },
  );
  cleanups.push(async () => {
    await store.close();
    await rm(directory, { recursive: true });
  });
  const id = store.add({
    name: "Fixture",
    url: "https://mcp.example/rpc",
    token: "private-token",
  });
  const connection = () => {
    const value = store.list()[0];
    assert(value);
    return value;
  };
  await store.discover(id, connection().revision);
  const request: ModelRequest = {
    system: "Answer",
    messages: [],
    workspaces: [],
    mcpAvailable: true,
  };
  const invoke = () =>
    store
      .wrap({
        reply: async (req) =>
          req.mcpAvailable
            ? {
                text: "",
                mcp: {
                  connection: id,
                  tool: "lookup",
                  argumentsJson: '{"id":"record-9"}',
                },
              }
            : { text: "answer" },
      })
      .reply(request);
  return {
    store,
    id,
    directory,
    calls,
    request,
    invoke,
    connection,
    change: () => {
      description = "Changed contract";
    },
    duringList: (fn: () => void) => {
      onList = fn;
    },
  };
}

test("discovery grants nothing, read results are transient and credentials stay encrypted", async () => {
  const f = await fixture();
  expect(f.connection().tools[0]?.permission).toBe("disabled");
  await f.invoke();
  expect(f.calls).toHaveLength(0);
  f.store.permit(f.id, f.connection().revision, "lookup", "read");
  f.request.latencyAvailable = true;
  let evidence = "";
  let synthesis: ModelRequest | undefined;
  await f.store
    .wrap({
      reply: async (request) => {
        if (request.mcpAvailable)
          return {
            text: "",
            mcp: {
              connection: f.id,
              tool: "lookup",
              argumentsJson: '{"id":"record-9"}',
            },
          };
        evidence = request.system;
        synthesis = request;
        return { text: "summarized answer" };
      },
    })
    .reply(f.request);
  expect(f.calls).toEqual([{ name: "lookup", arguments: { id: "record-9" } }]);
  assert(synthesis);
  expect(replyJsonSchema([], synthesis).properties).not.toHaveProperty(
    "latency",
  );
  expect(() =>
    parseReply('{"text":"","latency":"recent"}', [], synthesis),
  ).toThrow();
  expect(f.request.latencyAvailable).toBe(true);
  expect(evidence).toContain("private result [credential redacted]");
  expect(evidence).not.toContain("private-token");
  expect(JSON.stringify(f.store.list())).not.toContain("private-token");
  expect(
    (await readFile(join(f.directory, "connections.sqlite-wal"))).includes(
      Buffer.from("private-token"),
    ),
  ).toBe(false);
  f.change();
  await f.store.discover(f.id, f.connection().revision);
  expect(f.connection().tools[0]?.permission).toBe("disabled");
});

test("June can use enabled tools privately but channels receive no MCP catalog or authority", async () => {
  const f = await fixture();
  f.store.permit(f.id, f.connection().revision, "lookup", "read");
  for (const direct of [false, true]) {
    const request = buildModelRequest({
      event: {
        type: "message",
        id: "request",
        messageId: "1.2",
        occurredAt: Date.now(),
        address: {
          channel: "slack",
          accountId: "T1",
          conversationId: direct ? "D1" : "C1",
        },
        senderId: "U1",
        text: "Look up record-9",
        direct,
        metadata: { channelType: direct ? "im" : "channel" },
      },
      history: [],
      now: new Date(),
      owner: {
        id: "owner",
        identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
      },
      models: { current: { provider: "fixture", model: "fixture" } },
      capabilities: { mcpAvailable: true },
    });
    expect(request.mcpAvailable).toBe(direct);
    const answer = await f.store
      .wrap({
        reply: async (input) => {
          if (input.mcpAvailable)
            return {
              text: "",
              mcp: {
                connection: f.id,
                tool: "lookup",
                argumentsJson: '{"id":"record-9"}',
              },
            };
          if (!direct)
            expect(input.system).not.toContain("Owner-approved MCP tools");
          else expect(input.releaseAvailable).toBe(false);
          return { text: direct ? "Found record-9" : "No private tools" };
        },
      })
      .reply(request);
    expect(answer.text).toBe(direct ? "Found record-9" : "No private tools");
    expect(f.calls).toHaveLength(direct ? 1 : 0);
  }
});

test("mutation approval executes exactly once, including concurrent confirmation", async () => {
  const f = await fixture();
  f.store.permit(f.id, f.connection().revision, "lookup", "approval");
  await f.invoke();
  expect(f.calls).toHaveLength(0);
  const proposal = f.store.proposals()[0];
  assert(proposal);
  await Promise.all([
    f.store.confirm(proposal.id),
    f.store.confirm(proposal.id),
  ]);
  expect(f.calls).toHaveLength(1);
  expect(f.store.proposals()[0]?.status).toBe("succeeded");
  await f.store.confirm(proposal.id);
  expect(f.calls).toHaveLength(1);
});

test("disconnect during discovery prevents an already-approved mutation from dispatching", async () => {
  const f = await fixture();
  f.store.permit(f.id, f.connection().revision, "lookup", "approval");
  await f.invoke();
  f.duringList(() => f.store.disconnect(f.id, f.connection().revision));
  const proposal = f.store.proposals()[0];
  assert(proposal);
  expect(await f.store.confirm(proposal.id)).toBe("unknown");
  expect(f.calls).toHaveLength(0);
});

test("private routes reject unauthenticated and cross-site writes", async () => {
  const f = await fixture();
  const app = new Hono().route(
    "/console/connections",
    createConnectionRoutes(
      {
        origin: "https://june.example",
        csrfSecret: "a".repeat(32),
        authenticate: async (request) =>
          request.headers.get("authorization") === "Bearer owner"
            ? "owner"
            : undefined,
      },
      { store: f.store },
    ),
  );
  expect((await app.request("/console/connections")).status).toBe(401);
  const path = `/console/connections/${f.id}/disconnect`;
  expect(
    (
      await app.request(path, {
        method: "POST",
        headers: {
          authorization: "Bearer owner",
          origin: "https://evil.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "confirmed=yes",
      })
    ).status,
  ).toBe(403);
  expect(f.store.list()).toHaveLength(1);
  expect(() =>
    parseReply(
      '{"text":"","mcp":{"connection":"x","tool":"lookup","argumentsJson":"{}"}}',
      [],
      { mcpAvailable: false },
    ),
  ).toThrow();
});
