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
import { createSlackMcpOAuth } from "../src/tools/slack-mcp-oauth.js";

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
  f.request.analyticsAvailable = true;
  let evidence = "";
  let synthesis: ModelRequest | undefined;
  let modelStatusAvailable: boolean | undefined;
  f.request.modelStatusAvailable = true;
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
        modelStatusAvailable = request.modelStatusAvailable;
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
  expect(replyJsonSchema([], synthesis).properties).not.toHaveProperty(
    "analytics",
  );
  expect(() =>
    parseReply('{"text":"","analytics":{"days":7}}', [], synthesis),
  ).toThrow();
  expect(f.request.analyticsAvailable).toBe(true);
  expect(evidence).toContain("private result [credential redacted]");
  expect(modelStatusAvailable).toBe(false);
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
      capabilities: { mcpAvailable: true, executionAvailable: true },
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
          else {
            expect(input.releaseAvailable).toBe(false);
            expect(input.executionAvailable).toBe(false);
          }
          return {
            text: direct ? "Found record-9" : "No private tools",
            ...(direct
              ? {
                  execution: [
                    {
                      agent: "injected",
                      action: "run" as const,
                      task: "Do more",
                    },
                  ],
                }
              : {}),
          };
        },
      })
      .reply(request);
    expect(answer.text).toBe(direct ? "Found record-9" : "No private tools");
    expect(answer.execution).toBeUndefined();
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

test("approval review identifies only the matching destination and preserves consent checks", async () => {
  const f = await fixture();
  f.store.add(
    {
      name: 'Research <img src=x onerror="alert(1)">',
      url: "https://mcp.example/research/rpc",
      token: "private-token",
    },
    f.id,
  );
  await f.store.discover(f.id, f.connection().revision);
  f.store.permit(f.id, f.connection().revision, "lookup", "approval");
  await f.invoke();
  const app = new Hono().route(
    "/console/connections",
    createConnectionRoutes(
      {
        origin: "https://june.example",
        csrfSecret: "a".repeat(32),
        authenticate: async () => "owner",
      },
      { store: f.store },
    ),
  );
  const path = () =>
    `/console/connections/approvals/${f.store.proposals()[0]?.id}`;
  const review = await (await app.request(path())).text();
  expect(review).toContain("Research &lt;img");
  expect(review).not.toContain("<img");
  expect(review).toContain("https://mcp.example/research/rpc");
  expect(review).toContain("record-9");
  expect(review).not.toContain("private-token");
  expect(f.calls).toHaveLength(0);
  const proof = (body: string) =>
    body.match(/name="proof" value="([^"]+)"/)?.[1] ?? "";
  const post = (body: Record<string, string>) =>
    app.request(path(), {
      method: "POST",
      headers: {
        origin: "https://june.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
    });
  expect((await post({ proof: proof(review) })).status).toBe(403);
  expect(f.calls).toHaveLength(0);
  expect((await post({ proof: proof(review), confirmed: "yes" })).status).toBe(
    303,
  );
  expect(f.calls).toEqual([{ name: "lookup", arguments: { id: "record-9" } }]);
  expect(await (await app.request(path())).text()).toContain("succeeded");
  await f.invoke();
  const staleProof = proof(await (await app.request(path())).text());
  f.store.add({ name: "Replacement", url: "https://other.example/mcp" }, f.id);
  const stale = await (await app.request(path())).text();
  expect(stale).toContain("connection has changed or been removed");
  expect(stale).not.toContain("https://other.example/mcp");
  expect(stale).not.toContain('name="proof"');
  expect((await post({ proof: staleProof, confirmed: "yes" })).status).toBe(
    503,
  );
  expect(f.calls).toHaveLength(1);
  f.store.disconnect(f.id, f.connection().revision);
  expect(await (await app.request(path())).text()).toContain(
    "connection has changed or been removed",
  );
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

test("Slack OAuth resumes pending setup and reports saved authorization without enabling tools", async () => {
  const f = await fixture();
  f.store.disconnect(f.id, f.connection().revision);
  const base = "/console/connections";
  const origin = "https://june.example";
  let rejectExchange = false;
  const slack = createSlackMcpOAuth(
    {
      clientId: "fixture",
      clientSecret: "fixture-secret",
      redirectUrl: `${origin}${base}/slack/callback`,
      teamId: "T1",
      userId: "U1",
      scopes: ["search:read"],
      generation: () => f.store.generation("slack"),
      saveAuthorization: async (value) => {
        f.store.connectSlack(value);
      },
    },
    {
      fetch: async (url) =>
        Response.json(
          rejectExchange
            ? { ok: false, error: "invalid_code" }
            : String(url).endsWith("auth.test")
              ? { ok: true, user_id: "U1", team_id: "T1" }
              : {
                  ok: true,
                  token_type: "user",
                  access_token: "fixture-slack-token",
                  authed_user: { id: "U1", scope: "search:read" },
                  team: { id: "T1" },
                },
        ),
    },
  );
  const app = new Hono().route(
    base,
    createConnectionRoutes(
      {
        origin,
        csrfSecret: "x".repeat(32),
        authenticate: async (request) =>
          request.headers.get("authorization") === "Bearer owner"
            ? "owner"
            : undefined,
      },
      { store: f.store, slack },
    ),
  );
  let cookie = "";
  const get = (path: string) =>
    app.request(`${base}${path}`, {
      headers: { authorization: "Bearer owner", cookie },
    });
  const proof = (body: string) =>
    body.match(/name="proof" value="([^"]+)"/)?.[1] ?? "";
  const post = (
    path: string,
    body: Record<string, string>,
    requestOrigin = origin,
  ) =>
    app.request(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer owner",
        cookie,
        origin: requestOrigin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
    });
  const start = async () => {
    const page = await get("");
    const begin = await post("/slack/connect", {
      proof: proof(await page.text()),
    });
    const target = new URL(
      (await begin.text())
        .match(/href="(https:\/\/slack.com[^"]+)"/)?.[1]
        ?.replaceAll("&amp;", "&") ?? "",
    );
    const callback = await app.request(
      `${base}/slack/callback?state=${target.searchParams.get("state")}&code=fixture-code`,
    );
    cookie = callback.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(callback.status).toBe(200);
    expect(cookie).toContain("__Host-june-slack-return=");
  };
  await start();
  expect(f.store.list()).toHaveLength(0);
  const pending = await (await get("")).text();
  expect(pending).toContain(`href="${base}/slack/finish"`);
  expect(pending).not.toContain(`action="${base}/slack/connect"`);
  const confirmation = {
    proof: proof(await (await get("/slack/finish")).text()),
    confirmed: "yes",
  };
  expect(
    (await post("/slack/finish", confirmation, "https://elsewhere.example"))
      .status,
  ).toBe(403);
  expect(
    (await post("/slack/finish", { proof: confirmation.proof })).status,
  ).toBe(403);
  expect(f.store.list()).toHaveLength(0);
  expect((await post("/slack/finish", confirmation)).status).toBe(303);
  expect(f.store.list()).toMatchObject([
    { id: "slack", authenticated: true, status: "not_tested", tools: [] },
  ]);
  expect((await post("/slack/finish", confirmation)).status).toBe(403);
  const saved = await (await get("")).text();
  expect(saved).toContain("Authorization saved");
  expect(saved).toContain(`href="${base}/slack"`);
  expect(saved).not.toContain("Connect Slack →");
  expect(saved).not.toContain("fixture-slack-token");
  expect(await (await get("/slack")).text()).toContain("Authorization saved");

  // Reconnecting must not claim success or erase an existing credential on failure.
  await start();
  rejectExchange = true;
  const failed = await post("/slack/finish", {
    proof: proof(await (await get("/slack/finish")).text()),
    confirmed: "yes",
  });
  expect(failed.status).toBe(400);
  const failurePage = await failed.text();
  expect(failurePage).toContain("Slack connection not confirmed");
  expect(failurePage).not.toContain("invalid_code");
  expect(f.store.list()).toMatchObject([{ id: "slack", authenticated: true }]);
  f.store.connectSlack({
    accessToken: "fixture-expired",
    expiresAt: Date.now() - 1,
  });
  for (const path of ["", "/slack"]) {
    const expired = await (await get(path)).text();
    expect(expired).toContain("Authorization expired");
    expect(expired).not.toContain("Authorization saved");
  }
  const denied = await app.request(
    `${base}/slack/callback?state=fixture&error=access_denied`,
  );
  expect(denied.status).toBe(400);
  expect(denied.headers.get("set-cookie")).toBeNull();
  expect(await denied.text()).not.toContain(`${base}/slack/finish`);
});
