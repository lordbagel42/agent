import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { afterEach, expect, test } from "vitest";
import { createConnectionRoutes } from "../src/console/connections.js";
import { createConsoleLoginLinks } from "../src/console/session.js";
import type { ModelRequest } from "../src/core/contracts.js";
import { parseReply, replyJsonSchema } from "../src/models/provider.js";
import { buildModelRequest } from "../src/runtime/prompt.js";
import { McpConnections } from "../src/tools/connections.js";
import { createSlackMcpOAuth } from "../src/tools/slack-mcp-oauth.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  input = {
    name: "Fixture",
    url: "https://mcp.example/rpc",
    token: "private-token",
  },
  tools?: Tool[],
) {
  const directory = await mkdtemp(join(tmpdir(), "june-mcp-"));
  const calls: unknown[] = [];
  let description = "Look up a record";
  let resultText = "private result private-token";
  let onList = () => {};
  const open = () =>
    new McpConnections(
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
                      tools: tools ?? [
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
                      content: [{ type: "text", text: resultText }],
                    },
          });
        },
      },
    );
  let store = open();
  cleanups.push(async () => {
    await store.close();
    await rm(directory, { recursive: true });
  });
  const id = store.add(input);
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
  const invoke = (target = id) =>
    store
      .wrap({
        reply: async (req) =>
          req.mcpAvailable
            ? {
                text: "",
                mcp: {
                  connection: target,
                  tool: "lookup",
                  argumentsJson: '{"id":"record-9"}',
                },
              }
            : { text: "answer" },
      })
      .reply(request);
  return {
    get store() {
      return store;
    },
    restart: async () => {
      await store.close();
      store = open();
    },
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
    result: (text: string) => {
      resultText = text;
    },
  };
}

test("dashboard credentials from MCP results never reach the synthesis provider", async () => {
  const f = await fixture();
  const links = createConsoleLoginLinks("https://june.example");
  const link = links.issue();
  assert(link);
  const id = new URL(link.url).pathname.slice(1);
  f.result(
    `Open ${link.url} or https://june.example/console/session/link/${id}`,
  );
  f.store.permit(f.id, f.connection().revision, "lookup", "read");
  const requests: ModelRequest[] = [];
  const model = links.wrapModel({
    async reply(request) {
      requests.push(request);
      return request.mcpAvailable
        ? {
            text: "",
            mcp: {
              connection: f.id,
              tool: "lookup",
              argumentsJson: '{"id":"record-9"}',
            },
          }
        : { text: "A sign-in link was found; ask for a fresh one." };
    },
  });
  const answer = await f.store.wrap(model).reply(f.request);
  expect(answer.text).toContain("ask for a fresh one");
  expect(requests).toHaveLength(2);
  expect(requests[1]?.system).toContain("credential omitted");
  expect(JSON.stringify(requests)).not.toContain(id);
  expect(links.has(id)).toBe(true);
});

test("mixed recall directives cannot dispatch MCP calls, proposals or extra catalog rounds", async () => {
  const f = await fixture();
  f.request.recallAvailable = true;
  for (const permission of ["read", "approval"] as const) {
    f.store.permit(f.id, f.connection().revision, "lookup", permission);
    for (const directive of [
      {
        mcp: {
          connection: f.id,
          tool: "lookup",
          argumentsJson: '{"id":"record-9"}',
        },
      },
      { mcpCatalog: { connection: null, tool: null, offset: 0 } },
    ]) {
      for (const afterCatalog of [false, true]) {
        let calls = 0;
        const model = f.store.wrap({
          async reply() {
            calls++;
            if (afterCatalog && calls === 1)
              return {
                text: "",
                mcpCatalog: { connection: null, tool: null, offset: 0 },
              };
            return { text: "", recall: "heron", ...directive };
          },
        });
        await expect(model.reply(f.request)).rejects.toThrow();
        expect(calls).toBe(afterCatalog ? 2 : 1);
      }
    }
  }
  expect(f.calls).toEqual([]);
  expect(f.store.proposals()).toEqual([]);
});

test("Add commands stay consumed across permission changes, disconnection and restart", async () => {
  const f = await fixture();
  const base = "/console/connections";
  const app = () =>
    new Hono().route(
      base,
      createConnectionRoutes(
        {
          origin: "https://june.example",
          csrfSecret: "a".repeat(32),
          authenticate: async () => "owner",
        },
        { store: f.store },
      ),
    );
  const page = await (await app().request(base)).text();
  const proof = page.match(
    /action="\/console\/connections\/add"[^>]*><input type="hidden" name="proof" value="([^"]+)"/,
  )?.[1];
  assert(proof);
  const body = {
    proof,
    name: "Replay fixture",
    url: "https://mcp.example/rpc",
    token: "private-token",
  };
  const post = (values = body) =>
    app().request(`${base}/add`, {
      method: "POST",
      headers: {
        origin: "https://june.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(values),
    });
  const first = await post();
  expect(first.status).toBe(303);
  const id = first.headers.get("location")?.split("/").at(-1);
  assert(id);
  const connection = () => {
    const value = f.store.list().find((value) => value.id === id);
    assert(value);
    return value;
  };
  const initial = connection();
  expect((await post()).status).toBe(303);
  expect(connection()).toEqual(initial);
  await f.store.discover(id, connection().revision);
  f.store.permit(id, connection().revision, "lookup", "read");
  const permitted = connection();
  await f.restart();
  expect(
    (
      await post({
        ...body,
        url: "https://other.example/rpc",
        token: "replacement",
      })
    ).status,
  ).toBe(303);
  expect(connection()).toEqual(permitted);
  await f.invoke(id);
  expect(f.calls).toHaveLength(1);
  f.store.permit(id, connection().revision, "lookup", "approval");
  await f.invoke(id);
  const proposal = f.store.proposals()[0];
  assert(proposal);
  f.store.permit(id, connection().revision, "lookup", "disabled");
  const disabled = connection();
  await post();
  expect(connection()).toEqual(disabled);
  await expect(f.store.confirm(proposal.id)).rejects.toThrow(
    "proposal_expired",
  );
  await f.invoke(id);
  expect(f.calls).toHaveLength(1);
  f.store.disconnect(id, connection().revision);
  const generation = f.store.generation(id);
  await post();
  await f.restart();
  expect((await post()).status).toBe(303);
  expect(f.store.list().some((value) => value.id === id)).toBe(false);
  expect(f.store.generation(id)).toBe(generation);
  await f.invoke(id);
  expect(f.calls).toHaveLength(1);

  // A fresh command can intentionally add the same server again.
  expect(f.store.add({ name: body.name, url: body.url })).not.toBe(id);
  // Slack's verified OAuth reconnect remains an explicit replacement.
  f.store.connectSlack({ accessToken: "old-token" });
  const oldRevision = f.store.generation("slack");
  await f.store.discover("slack", oldRevision);
  f.store.permit("slack", f.store.generation("slack"), "lookup", "read");
  f.store.connectSlack({ accessToken: "new-token" });
  expect(f.store.generation("slack")).not.toBe(oldRevision);
  expect(f.store.list().find((value) => value.id === "slack")).toMatchObject({
    tools: [],
    authenticated: true,
    status: "not_tested",
  });
  f.store.disconnect("slack", f.store.generation("slack"));
  f.store.connectSlack({ accessToken: "reconnected-token" });
  expect(f.store.list().some((value) => value.id === "slack")).toBe(true);
});

test("discovery grants nothing, read results are transient and credentials stay encrypted", async () => {
  const f = await fixture();
  expect(f.connection().tools[0]?.permission).toBe("disabled");
  await f.invoke();
  expect(f.calls).toHaveLength(0);
  f.store.permit(f.id, f.connection().revision, "lookup", "read");
  f.request.latencyAvailable = true;
  f.request.analyticsAvailable = true;
  f.request.inspectionAvailable = true;
  f.request.codingJobsAvailable = true;
  f.request.recallAvailable = true;
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
  expect(replyJsonSchema([], synthesis).properties).not.toHaveProperty(
    "inspection",
  );
  expect(() =>
    parseReply('{"text":"","inspection":"memory"}', [], synthesis),
  ).toThrow();
  expect(f.request.inspectionAvailable).toBe(true);
  expect(replyJsonSchema([], synthesis).properties).not.toHaveProperty(
    "codingJob",
  );
  expect(() =>
    parseReply(
      '{"text":"","codingJob":{"action":"list","id":null}}',
      [],
      synthesis,
    ),
  ).toThrow();
  expect(f.request.codingJobsAvailable).toBe(true);
  expect(replyJsonSchema([], synthesis).properties).not.toHaveProperty(
    "recall",
  );
  expect(() =>
    parseReply('{"text":"","recall":"private"}', [], synthesis),
  ).toThrow();
  expect(f.request.recallAvailable).toBe(true);
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

test("June discovers and calls beyond the first catalog page without granting disabled tools", async () => {
  const tools: Tool[] = Array.from({ length: 43 }, (_, index) => ({
    name: `lookup_${index}`,
    description: `Record lookup ${index}`,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", const: `record-${index}` } },
      required: ["id"],
      additionalProperties: false,
      // A large early contract must not hide any later tools.
      ...(index === 0 ? { description: "x".repeat(45_000) } : {}),
    },
  }));
  const f = await fixture(undefined, tools);
  for (const tool of tools.slice(0, 42))
    f.store.permit(f.id, f.connection().revision, tool.name, "read");
  const query = (tool: string | null, offset = 0) => ({
    text: "",
    mcpCatalog: { connection: f.id, tool, offset },
  });
  const call = (tool: string, id: string) => ({
    text: "",
    mcp: { connection: f.id, tool, argumentsJson: JSON.stringify({ id }) },
  });
  let phase = 0;
  const answer = await f.store
    .wrap({
      reply: async (request) => {
        const respond = (value: unknown) =>
          parseReply(JSON.stringify(value), [], request);
        if (!request.mcpAvailable) return respond({ text: "Found record-41" });
        expect(replyJsonSchema([], request).properties).toHaveProperty(
          "mcpCatalog",
        );
        const lines = request.system.split("\n");
        if (phase++ === 0) {
          const initial = JSON.parse(
            lines
              .find((line) => line.startsWith("Owner-approved MCP tools"))
              ?.split(": ")
              .slice(1)
              .join(": ") ?? "",
          );
          expect(initial.tools).toHaveLength(40);
          expect(initial.nextOffset).toBe(40);
          expect(
            initial.tools.map((tool: { name: string }) => tool.name),
          ).not.toContain("lookup_41");
          expect(request.system.length).toBeLessThan(40_000);
          return respond(query(null, initial.nextOffset));
        }
        const result = JSON.parse(lines.at(-1) ?? "").result;
        expect(JSON.stringify(result).length).toBeLessThan(40_000);
        if (phase === 2) {
          expect(
            result.tools.map((tool: { name: string }) => tool.name),
          ).toEqual(["lookup_40", "lookup_41"]);
          expect(result.nextOffset).toBeNull();
          return respond(query("lookup_41"));
        }
        expect(JSON.parse(result.contractJson).inputSchema).toEqual(
          tools[41]?.inputSchema,
        );
        expect(result.nextOffset).toBeNull();
        return respond(call("lookup_41", "record-41"));
      },
    })
    .reply(f.request);
  expect(answer.text).toBe("Found record-41");
  expect(f.calls).toEqual([
    { name: "lookup_41", arguments: { id: "record-41" } },
  ]);

  // Exact calls do not require prior discovery, but disabled names remain denied.
  for (const index of [40, 42]) {
    await f.store
      .wrap({
        reply: async (request) =>
          request.mcpAvailable
            ? call(`lookup_${index}`, `record-${index}`)
            : { text: "done" },
      })
      .reply(f.request);
  }
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1]).toEqual({
    name: "lookup_40",
    arguments: { id: "record-40" },
  });

  // Schema chunks are retained for stateless providers and have a finite turn budget.
  let rounds = 0;
  await f.store
    .wrap({
      reply: async (request) => {
        const lines = request.system.split("\n");
        if (rounds++ === 0) return query("lookup_42");
        const last = JSON.parse(lines.at(-1) ?? "");
        if (rounds === 2) {
          expect(last.result).toEqual({ error: "tool_not_enabled" });
          return query("lookup_0");
        }
        const chunks = lines
          .filter((line) => line.startsWith('{"query":'))
          .map((line) => JSON.parse(line))
          .filter((item) => item.query.tool === "lookup_0");
        for (const chunk of chunks)
          expect(JSON.stringify(chunk).length).toBeLessThan(40_000);
        expect(
          chunks.map((chunk) => chunk.result.contractJson).join("").length,
        ).toBe((rounds - 2) * 6000);
        return query("lookup_0", last.result.nextOffset);
      },
    })
    .reply(f.request)
    .then((result) => expect(result.text).toContain("lookup limit"));
  expect(rounds).toBe(9);
  expect(f.calls).toHaveLength(2);
});

test("catalog discovery obeys the MCP capability and action exclusivity contract", () => {
  const catalog = { connection: "fixture", tool: "lookup", offset: 0 };
  expect(
    replyJsonSchema([], { mcpAvailable: true }).properties.mcpCatalog
      ?.properties.offset,
  ).not.toHaveProperty("minimum");
  expect(() =>
    parseReply(JSON.stringify({ text: "", mcpCatalog: catalog }), [], {}),
  ).toThrow();
  for (const extra of [
    { text: "also talk" },
    { mcp: { connection: "fixture", tool: "lookup", argumentsJson: "{}" } },
    { analytics: { days: 7 } },
    { modelStatus: true },
  ])
    expect(() =>
      parseReply(
        JSON.stringify({ text: "", mcpCatalog: catalog, ...extra }),
        [],
        {
          mcpAvailable: true,
          analyticsAvailable: true,
          modelStatusAvailable: true,
        },
      ),
    ).toThrow();
  for (const invalid of [
    { ...catalog, offset: -1 },
    { ...catalog, offset: 0.5 },
    { ...catalog, connection: null },
  ])
    expect(() =>
      parseReply(JSON.stringify({ text: "", mcpCatalog: invalid }), [], {
        mcpAvailable: true,
      }),
    ).toThrow();
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
  const f = await fixture({
    name: 'Research <img src=x onerror="alert(1)">',
    url: "https://mcp.example/research/rpc",
    token: "private-token",
  });
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
  f.store.permit(f.id, f.connection().revision, "lookup", "disabled");
  f.store.add({ name: "Other server", url: "https://other.example/mcp" });
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
