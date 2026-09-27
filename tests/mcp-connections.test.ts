import { strict as assert } from "node:assert";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import { createSlackAdapter } from "../src/channels/slack.js";
import { createWhatsAppAdapter } from "../src/channels/whatsapp.js";
import { createConnectionRoutes } from "../src/console/connections.js";
import { createConsoleLoginLinks } from "../src/console/session.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelProvider,
  ModelRequest,
  OutboundMessage,
  Owner,
} from "../src/core/contracts.js";
import { PRIVATE_REFLECTION_REVIEW_PREFIX } from "../src/core/reflection-review.js";
import { RIVET_REPLY_PREFIX } from "../src/core/rivet.js";
import { routeEvent } from "../src/core/routing.js";
import { createHttpApp } from "../src/http/app.js";
import { slackSource } from "../src/imports/index.js";
import { EvidenceStore } from "../src/memory/store.js";
import { parseReply, replyJsonSchema } from "../src/models/provider.js";
import { createInspectionReader } from "../src/runtime/inspection.js";
import { buildModelRequest } from "../src/runtime/prompt.js";
import { createJuneRegistry } from "../src/runtime/registry.js";
import { McpConnections } from "../src/tools/connections.js";
import { createPuckConsoleOAuth } from "../src/tools/puck-oauth.js";
import { createSlackMcpOAuth } from "../src/tools/slack-mcp-oauth.js";
import { setupTest } from "./rivet.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  input: Parameters<McpConnections["add"]>[0] = {
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
  let structuredContent: Record<string, unknown> | undefined;
  let onList = () => {};
  let requests = 0;
  let callFailure: "transport" | "result" | undefined;
  let onCall = () => {};
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
          requests++;
          if (init?.method === "DELETE")
            return new Response(null, { status: 204 });
          const message = JSON.parse(String(init?.body));
          if (message.id === undefined)
            return new Response(null, { status: 202 });
          if (message.method === "tools/list") onList();
          if (message.method === "tools/call") {
            calls.push(message.params);
            onCall();
            if (callFailure === "transport")
              throw new Error("provider-secret private-token");
          }
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
                      ...(callFailure === "result" ? { isError: true } : {}),
                      content: [{ type: "text", text: resultText }],
                      structuredContent,
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
  const invoke = (target = id, canStartAction?: () => boolean) =>
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
      .reply(request, undefined, undefined, canStartAction);
  return {
    get store() {
      return store;
    },
    get requests() {
      return requests;
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
    duringCall: (fn: () => void) => {
      onCall = fn;
    },
    result: (text: string, structured?: Record<string, unknown>) => {
      resultText = text;
      structuredContent = structured;
    },
    fail: (mode: "transport" | "result") => {
      callFailure = mode;
    },
  };
}

test("enrollment inspection reveals no credentials or private configuration and grants nothing", async () => {
  const f = await fixture({
    name: "PRIVATE NAME",
    url: "https://private.example/secret-path",
    token: "private-token",
  });
  const before = f.connection();
  const requests = f.requests;
  const report = await createInspectionReader({
    audience: "owner",
    selections: {},
    mcp: f.store,
  })("mcp-enrollment");
  expect(report).toContain('"next":"owner_tool_consent_required"');
  expect(report).toContain("Browser consent/save progress is unknown");
  expect(report).toContain("do not prove current authorization");
  for (const secret of [
    "PRIVATE NAME",
    "private.example",
    "secret-path",
    "private-token",
    f.id,
    "Look up a record",
  ])
    expect(report).not.toContain(secret);
  expect(f.requests).toBe(requests);
  expect(f.calls).toEqual([]);
  expect(f.store.proposals()).toEqual([]);
  expect(f.connection()).toEqual(before);
});

test.each([
  ["missing", "unavailable", 0],
  ["disabled", "denied", 0],
  ["revoked", "denied", 0],
  ["malformed", "rejected", 0],
  ["schema", "failed", 0],
  ["preparation", "failed", 0],
  ["transport", "unknown", 1],
  ["result", "unknown", 1],
  ["synthesis", "failed", 1],
  ["revoked-result", "denied", 1],
] as const)(
  "MCP %s failure preserves uncertainty without leaking errors or repeating calls",
  async (scenario, outcome, calls) => {
    const f = await fixture();
    if (scenario !== "disabled")
      f.store.permit(f.id, f.connection().revision, "lookup", "read");
    if (scenario === "preparation")
      f.duringList(() => {
        throw new Error("provider-secret private-token");
      });
    if (scenario === "transport" || scenario === "result") {
      f.fail(scenario);
      f.result("provider-secret private-token");
    }
    const requests: ModelRequest[] = [];
    const answer = await f.store
      .wrap({
        async reply(request) {
          requests.push(request);
          if (requests.length === 1) {
            if (scenario === "revoked")
              f.store.disconnect(f.id, f.connection().revision);
            return {
              text: "",
              mcp: {
                connection: scenario === "missing" ? "missing" : f.id,
                tool: "lookup",
                argumentsJson:
                  scenario === "malformed"
                    ? "provider-secret private-token"
                    : scenario === "schema"
                      ? '{"id":42}'
                      : '{"id":"record-9"}',
              },
            };
          }
          if (scenario === "revoked-result") {
            f.store.disconnect(f.id, f.connection().revision);
            return { text: "withheld result" };
          }
          throw new Error("provider-secret private-token");
        },
      })
      .reply(f.request);
    expect(answer.text).toContain(`MCP request ${outcome}:`);
    expect(answer.text).toContain("won't repeat it automatically");
    expect(answer.text).toContain("does not establish that retrying is safe");
    expect(JSON.stringify({ answer, requests })).not.toMatch(
      /provider-secret|private-token|withheld result/,
    );
    expect(requests).toHaveLength(
      scenario === "synthesis" || scenario === "revoked-result" ? 2 : 1,
    );
    expect(f.calls).toHaveLength(calls);
    expect(f.store.proposals()).toEqual([]);
  },
);

test.each(["discovery", "dispatch"] as const)(
  "follow-up during MCP %s prevents new calls but retains already-started results",
  async (boundary) => {
    const f = await fixture();
    f.store.permit(f.id, f.connection().revision, "lookup", "read");
    let current = true;
    const supersede = () => {
      current = false;
    };
    if (boundary === "discovery") f.duringList(supersede);
    else f.duringCall(supersede);
    const answer = await f.invoke(f.id, () => current);
    expect(current).toBe(false);
    expect(f.calls).toHaveLength(boundary === "discovery" ? 0 : 1);
    if (boundary === "discovery")
      expect(answer.text).toContain("MCP request failed:");
    else expect(answer.text).toBe("answer");
    expect(f.store.proposals()).toEqual([]);
  },
);

test("pending memory cannot accompany MCP side effects from custom providers or catalog rounds", async () => {
  const f = await fixture();
  for (const permission of ["read", "approval"] as const) {
    f.store.permit(f.id, f.connection().revision, "lookup", permission);
    for (const catalogFirst of [false, true]) {
      let calls = 0;
      await expect(
        f.store
          .wrap({
            async reply() {
              if (catalogFirst && calls++ === 0)
                return {
                  text: "",
                  mcpCatalog: { connection: null, tool: null, offset: 0 },
                };
              return {
                text: "",
                pendingMemory: true,
                mcp: {
                  connection: f.id,
                  tool: "lookup",
                  argumentsJson: '{"id":"record-9"}',
                },
              };
            },
          })
          .reply({ ...f.request, pendingMemoryAvailable: true }),
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
      expect(f.store.proposals()).toEqual([]);
    }
  }
});

test.each([
  { kind: "literal", text: `${RIVET_REPLY_PREFIX}\nPRIVATE_INSPECTION_COPY` },
  {
    kind: "JSON escaped",
    text: '{"text":"[Private Rivet inspection \\u2014 not retained]\\nPRIVATE_INSPECTION_COPY"}',
  },
  {
    kind: "after truncation",
    text: `PRIVATE_INSPECTION_COPY${"x".repeat(13000)}${RIVET_REPLY_PREFIX}`,
  },
  {
    kind: "structured content",
    text: "PRIVATE_INSPECTION_COPY",
    structured: { text: RIVET_REPLY_PREFIX },
  },
  {
    kind: "reflection",
    text: `${PRIVATE_REFLECTION_REVIEW_PREFIX}PRIVATE_INSPECTION_COPY`,
  },
  {
    kind: "JSON escaped reflection",
    text: '{"text":"June private reflection review \\u2014 owner only\\nPRIVATE_INSPECTION_COPY"}',
  },
  {
    kind: "reflection after truncation",
    text: `PRIVATE_INSPECTION_COPY${"x".repeat(13000)}${PRIVATE_REFLECTION_REVIEW_PREFIX}`,
  },
  {
    kind: "structured reflection",
    text: "PRIVATE_INSPECTION_COPY",
    structured: { text: PRIVATE_REFLECTION_REVIEW_PREFIX },
  },
  {
    kind: "structured reflection key",
    text: "PRIVATE_INSPECTION_COPY",
    structured: { [PRIVATE_REFLECTION_REVIEW_PREFIX]: "copy" },
  },
  {
    kind: "JSON escaped reflection key",
    text: '{"June private reflection review \\u2014 owner only\\n":"PRIVATE_INSPECTION_COPY"}',
  },
])(
  "MCP cannot reimport a $kind private review reply into normal synthesis",
  async ({ text, structured }) => {
    const f = await fixture();
    f.store.permit(f.id, f.connection().revision, "lookup", "read");
    f.result(text, structured);
    let calls = 0;
    const result = await f.store
      .wrap({
        async reply() {
          calls++;
          return {
            text: "",
            mcp: {
              connection: f.id,
              tool: "lookup",
              argumentsJson: '{"id":"record-9"}',
            },
          };
        },
      })
      .reply(f.request);
    expect(calls).toBe(1);
    expect(result.text).toContain("inspect Rivet again");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_INSPECTION_COPY");
  },
);

test("MCP reflection copies cannot reach June's synthesis request or durable history", async (t) => {
  const f = await fixture();
  const hypothesis = "DISTINCTIVE PRIVATE REFLECTION COPY";
  f.store.permit(f.id, f.connection().revision, "lookup", "read");
  f.result(PRIVATE_REFLECTION_REVIEW_PREFIX + hypothesis);
  const prompts: ModelRequest[] = [];
  const sent: string[] = [];
  const registry = createJuneRegistry({
    owner: {
      id: "owner",
      identities: [{ channel: "slack", accountId: "T1", senderId: "UOWNER" }],
    },
    mcpAvailable: true,
    model: f.store.wrap({
      async reply(request) {
        prompts.push(request);
        if (prompts.length > 1) return { text: hypothesis };
        return {
          text: "",
          mcp: {
            connection: f.id,
            tool: "lookup",
            argumentsJson: '{"id":"record-9"}',
          },
        };
      },
    }),
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        receive: async () => ({ response: new Response(), events: [] }),
        async send(message) {
          if (message.content.type === "text") sent.push(message.content.text);
          return { status: "sent", messageId: "out" };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "owner"]);
  await june.send("inbox", {
    type: "event",
    event: {
      id: "review-copy",
      type: "message",
      messageId: "100.000001",
      occurredAt: Date.now(),
      senderId: "UOWNER",
      direct: true,
      metadata: { channelType: "im" },
      text: "Look up the earlier reply",
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    },
  });
  await expect
    .poll(
      async () =>
        Object.values((await june.snapshot()).events).some(
          (record) => record.done,
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  expect
    .soft(
      prompts.some((request) => JSON.stringify(request).includes(hypothesis)),
    )
    .toBe(false);
  expect
    .soft(JSON.stringify((await june.snapshot()).history).includes(hypothesis))
    .toBe(false);
  expect.soft(sent.some((text) => text.includes(hypothesis))).toBe(false);
  expect(prompts).toHaveLength(1);
  expect(f.calls).toHaveLength(1);
  expect(sent[0]).toContain("won't retain or forward");
});

test("connection inventory omits private config and credentials without network or permission changes", async () => {
  const f = await fixture();
  const ref = f.store.inventory().connections[0]?.ref;
  expect(ref).toMatch(/^mcp-[a-f0-9]{24}$/);
  expect(f.store.inventory()).toMatchObject({
    state: "configured",
    liveAvailability: "not_checked",
    connections: [
      {
        lastDiscovery: "succeeded",
        credential: "saved",
        tools: { disabled: 1, read: 0, approval: 0 },
      },
    ],
  });
  await f.restart();
  expect(f.store.inventory().connections[0]?.ref).toBe(ref);
  f.store.permit(f.id, f.connection().revision, "lookup", "approval");
  expect(f.store.inventory().connections[0]?.tools).toEqual({
    disabled: 0,
    read: 0,
    approval: 1,
  });
  f.store.permit(f.id, f.connection().revision, "lookup", "read");
  expect(f.store.inventory().connections[0]?.tools).toEqual({
    disabled: 0,
    read: 1,
    approval: 0,
  });
  f.duringList(() => {
    throw new Error("SECRET failure");
  });
  await f.store.discover(f.id, f.connection().revision);
  expect(f.store.inventory().connections[0]?.lastDiscovery).toBe("failed");
  f.store.disconnect(f.id, f.connection().revision);
  expect(f.store.inventory()).toEqual({
    state: "disconnected",
    configuredConnections: 0,
    connections: [],
    truncated: false,
    liveAvailability: "not_checked",
  });
  f.store.connectSlack({ accessToken: "SECRET-token", expiresAt: 0 });
  for (let i = 0; i < 19; i++)
    f.store.add(
      {
        name: "SECRET-name",
        url: `https://private.example/${"p".repeat(1800)}`,
        token: i === 0 ? "SECRET-token" : undefined,
      },
      `SECRET-id-${i}`,
    );
  const before = f.store.list();
  const requests = f.requests;
  const inventory = f.store.inventory();
  expect(inventory.configuredConnections).toBe(20);
  expect(inventory.connections).toHaveLength(20);
  expect(inventory.connections[0]).toMatchObject({
    kind: "slack",
    credential: "expired",
    lastDiscovery: "not_tested",
  });
  expect(inventory.connections[1]?.credential).toBe("saved");
  expect(inventory.connections[2]?.credential).toBe("absent");
  expect(new Set(inventory.connections.map(({ ref }) => ref)).size).toBe(20);
  const report = await createInspectionReader({
    audience: '["private","owner"]',
    selections: {},
    mcp: f.store,
  })("mcp-connections");
  expect(report).toContain('"state":"configured"');
  expect(report).toContain("not live health");
  expect(report.length).toBeLessThan(6000);
  const prompts: ModelRequest[] = [];
  const wrapped = f.store.wrap({
    async reply(request) {
      prompts.push(request);
      return { text: "" };
    },
  });
  await wrapped.reply(f.request);
  await wrapped.reply({ ...f.request, mcpAvailable: false });
  expect(prompts[0]?.system).toContain('"configuredConnections":20');
  expect(prompts[1]?.system).not.toContain("connection inventory");
  for (const text of [report, prompts[0]?.system ?? ""])
    for (const secret of ["SECRET", "private.example", "private-token", f.id])
      expect(text).not.toContain(secret);
  expect(f.requests).toBe(requests);
  expect(f.calls).toHaveLength(0);
  expect(f.store.list()).toEqual(before);
  expect(f.store.proposals()).toEqual([]);
});

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

test("mixed host recall/browser/preview directives cannot dispatch MCP calls, proposals or extra catalog rounds", async () => {
  const f = await fixture();
  f.request.recallAvailable = true;
  f.request.browserProposalAvailable = true;
  f.request.personalityPreviewAvailable = true;
  f.request.forgetPreviewAvailable = true;
  f.request.personalityEvaluateAvailable = true;
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
      for (const hostDirective of [
        { recall: "heron" },
        { browserProposal: { operation: "fill-note" } },
        {
          personalityPreview: {
            expectedVersion: 0,
            style: {
              tone: "dry",
              verbosity: "concise",
              humor: "none",
              curiosity: "eager",
            },
          },
        },
        { forgetPreview: { sourceId: "s1" } },
        {
          personalityEvaluate: {
            candidateId: "candidate",
            heldOutSourceIds: ["held-out"] as string[],
          },
        },
      ] as const)
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
              return { text: "", ...hostDirective, ...directive };
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
  f.request.appsAvailable = true;
  f.request.jevObservationAvailable = true;
  f.request.codingJobsAvailable = true;
  f.request.recallAvailable = true;
  f.request.reflectionRequestAvailable = true;
  f.request.reflectionReviewAvailable = true;
  f.request.reflectionMemoryAvailable = true;
  f.request.reflectionPersonalitySuggestionAvailable = true;
  f.request.skillEvaluationRequestAvailable = true;
  f.request.personalityPreviewAvailable = true;
  f.request.forgetPreviewAvailable = true;
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
  expect(replyJsonSchema([], synthesis).properties).not.toHaveProperty("apps");
  expect(f.request.appsAvailable).toBe(true);
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
    "jevObservation",
  );
  expect(() =>
    parseReply('{"text":"","jevObservation":true}', [], synthesis),
  ).toThrow();
  expect(f.request.jevObservationAvailable).toBe(true);
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
  expect(replyJsonSchema([], synthesis).properties).not.toHaveProperty(
    "reflectionRequest",
  );
  expect(() =>
    parseReply(
      '{"text":"","reflectionRequest":{"evidenceIds":["a"],"mode":"idle"}}',
      [],
      synthesis,
    ),
  ).toThrow();
  expect(f.request.reflectionRequestAvailable).toBe(true);
  expect(synthesis.reflectionReviewAvailable).toBe(false);
  expect(replyJsonSchema([], synthesis).properties).not.toHaveProperty(
    "reflectionReview",
  );
  expect(() =>
    parseReply(
      '{"text":"","reflectionReview":{"action":"list"}}',
      [],
      synthesis,
    ),
  ).toThrow();
  expect(f.request.reflectionReviewAvailable).toBe(true);
  expect(synthesis.reflectionMemoryAvailable).toBe(false);
  expect(replyJsonSchema([], synthesis).properties).not.toHaveProperty(
    "reflectionMemory",
  );
  expect(() =>
    parseReply(
      JSON.stringify({
        text: "",
        reflectionMemory: { id: "a".repeat(64), subjectSourceId: "original" },
      }),
      [],
      synthesis,
    ),
  ).toThrow();
  expect(f.request.reflectionMemoryAvailable).toBe(true);
  expect(synthesis.reflectionPersonalitySuggestionAvailable).toBe(false);
  expect(replyJsonSchema([], synthesis).properties).not.toHaveProperty(
    "reflectionPersonalitySuggestion",
  );
  expect(f.request.reflectionPersonalitySuggestionAvailable).toBe(true);
  expect(synthesis.skillEvaluationRequestAvailable).toBe(false);
  expect(replyJsonSchema([], synthesis).properties).not.toHaveProperty(
    "skillEvaluationRequest",
  );
  expect(() =>
    parseReply(
      JSON.stringify({
        text: "",
        skillEvaluationRequest: {
          candidateId: "a".repeat(64),
          heldOutEvidenceIds: ["held-a", "held-b"],
        },
      }),
      [],
      synthesis,
    ),
  ).toThrow();
  expect(f.request.skillEvaluationRequestAvailable).toBe(true);
  expect(synthesis.personalityPreviewAvailable).toBe(false);
  expect(replyJsonSchema([], synthesis).properties).not.toHaveProperty(
    "personalityPreview",
  );
  expect(() =>
    parseReply(
      '{"text":"","personalityPreview":{"expectedVersion":0,"style":{"tone":"dry","verbosity":"concise","humor":"none","curiosity":"eager"}}}',
      [],
      synthesis,
    ),
  ).toThrow();
  expect(f.request.personalityPreviewAvailable).toBe(true);
  expect(replyJsonSchema([], synthesis).properties).not.toHaveProperty(
    "forgetPreview",
  );
  expect(() =>
    parseReply('{"text":"","forgetPreview":{"sourceId":"s1"}}', [], synthesis),
  ).toThrow();
  expect(f.request.forgetPreviewAvailable).toBe(true);
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

test("permission inspection explains owner trust without network, grants or reclassification", async () => {
  const expiresAt = Date.now() + 60_000;
  const f = await fixture(
    {
      name: "Fixture",
      url: "https://mcp.example/rpc",
      token: "private-token",
      expiresAt,
    },
    [
      {
        name: "lookup",
        description: "private-description",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
    ],
  );
  const inspect = async (connection = f.id, tool = "lookup") => {
    const before = {
      connections: f.store.list(),
      proposals: f.store.proposals(),
      requests: f.requests,
    };
    const answer = await f.store
      .wrap({
        reply: async (request) => {
          expect(replyJsonSchema([], request).properties).toHaveProperty(
            "mcpPermission",
          );
          if (f.connection().tools[0]?.permission === "disabled")
            expect(replyJsonSchema([], request).properties).not.toHaveProperty(
              "mcp",
            );
          return parseReply(
            JSON.stringify({ text: "", mcpPermission: { connection, tool } }),
            [],
            request,
          );
        },
      })
      .reply(f.request);
    expect(f.requests).toBe(before.requests);
    expect(f.calls).toHaveLength(0);
    expect(f.store.list()).toEqual(before.connections);
    expect(f.store.proposals()).toEqual(before.proposals);
    for (const secret of [
      "private-token",
      "private-description",
      "https://mcp.example/rpc",
      "inputSchema",
    ])
      expect(answer.text).not.toContain(secret);
    expect(answer.text.length).toBeLessThan(3500);
    return answer.text;
  };
  // A server hint must not override the default disabled permission.
  expect(await inspect()).toContain(
    "Disabled: June cannot call or propose this tool",
  );
  for (const permission of ["read", "approval"] as const) {
    f.store.permit(f.id, f.connection().revision, "lookup", permission);
    const answer = await inspect();
    const snapshot = JSON.parse(answer.split("\n\n")[1] ?? "");
    expect(snapshot).toMatchObject({
      connection: f.id,
      revision: f.connection().revision,
      tool: "lookup",
      permission,
      serverReadOnlyHint: true,
    });
    expect(snapshot.contractDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(answer).toContain(
      permission === "read"
        ? "owner's trust classification, not independent proof"
        : "Separate authenticated owner confirmation",
    );
    expect(answer).toContain("does not sandbox its internal behavior");
  }
  expect(await inspect(f.id, "LOOKUP")).toContain("No saved MCP tool matches");
  expect(await inspect("other-connection")).toContain(
    "No saved MCP connection matches",
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(expiresAt);
  try {
    const answer = await inspect();
    expect(answer).toContain('"authorization":"expired"');
    expect(answer).toContain(
      "currently blocks use regardless of this permission",
    );
  } finally {
    clock.mockRestore();
  }
  // Read the current permission after the model selects, not the prompt snapshot.
  const answer = await f.store
    .wrap({
      reply: async () => {
        f.store.permit(f.id, f.connection().revision, "lookup", "disabled");
        return {
          text: "",
          mcpPermission: { connection: f.id, tool: "lookup" },
        };
      },
    })
    .reply(f.request);
  expect(answer.text).toContain('"permission":"disabled"');
  expect(f.calls).toHaveLength(0);
});

test("permission status is a separate bounded exclusive capability, not tool authority", () => {
  const mcpPermission = { connection: "fixture", tool: "lookup" };
  const capabilities = { mcpPermissionAvailable: true };
  expect(replyJsonSchema([], capabilities).properties).not.toHaveProperty(
    "mcp",
  );
  expect(
    parseReply(JSON.stringify({ text: "", mcpPermission }), [], capabilities)
      .mcpPermission,
  ).toEqual(mcpPermission);
  expect(() =>
    parseReply(JSON.stringify({ text: "", mcpPermission }), [], {
      mcpAvailable: true,
    }),
  ).toThrow();
  for (const extra of [
    { text: "also talk" },
    { mcp: { ...mcpPermission, argumentsJson: "{}" } },
    { mcpCatalog: { ...mcpPermission, offset: 0 } },
    { mcpPermission: { ...mcpPermission, permission: "read" } },
    { mcpPermission: { ...mcpPermission, tool: "x".repeat(257) } },
    { mcpPermission: { ...mcpPermission, connection: null } },
  ])
    expect(() =>
      parseReply(JSON.stringify({ text: "", mcpPermission, ...extra }), [], {
        ...capabilities,
        mcpAvailable: true,
      }),
    ).toThrow();
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
          expect(input.mcpPermissionAvailable).toBe(false);
          expect(() =>
            parseReply(
              JSON.stringify({
                text: "",
                mcpPermission: { connection: f.id, tool: "lookup" },
              }),
              [],
              input,
            ),
          ).toThrow();
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

test("per-connection cached catalog inspection neither probes availability nor grants authority", async () => {
  const f = await fixture();
  f.store.permit(f.id, f.connection().revision, "lookup", "read");
  const other = f.store.add({
    name: "Other",
    url: "https://other.example/private-endpoint",
  });
  await f.store.discover(other, f.store.generation(other));
  f.store.permit(other, f.store.generation(other), "lookup", "approval");
  f.duringList(() => {
    throw new Error("fixture server offline");
  });
  const before = f.store.list();
  const requests = f.requests;
  const queries = [
    { connection: other, tool: null, offset: 0 },
    { connection: other, tool: "lookup", offset: 0 },
    { connection: f.id, tool: "lookup", offset: 0 },
    { connection: "absent", tool: null, offset: 0 },
  ];
  let round = 0;
  const answer = await f.store
    .wrap({
      reply: async (request) => {
        expect(request.system).toContain(
          "not the complete authorized catalog or a live availability check",
        );
        expect(request.system).not.toContain("private-endpoint");
        expect(request.system).not.toContain("private-token");
        const lines = request.system.split("\n");
        const result =
          round === 0
            ? JSON.parse(
                lines
                  .find((line) => line.startsWith("Owner-approved MCP tools"))
                  ?.split(": ")
                  .slice(1)
                  .join(": ") ?? "",
              )
            : JSON.parse(lines.at(-1) ?? "").result;
        expect(result).toMatchObject({
          source: "cached_snapshot",
          liveAvailability: "not_checked",
          nextOffset: null,
        });
        if (round === 0) expect(result.tools).toHaveLength(2);
        if (round === 1)
          expect(result.tools).toEqual([
            expect.objectContaining({
              connection: other,
              name: "lookup",
              permission: "approval",
            }),
          ]);
        if (round === 2 || round === 3)
          expect(JSON.parse(result.contractJson)).toMatchObject({
            connection: round === 2 ? other : f.id,
            name: "lookup",
            permission: round === 2 ? "approval" : "read",
            inputSchema: { required: ["id"] },
          });
        if (round === 4) expect(result.tools).toEqual([]);
        const query = queries[round++];
        return parseReply(
          JSON.stringify(
            query
              ? { text: "", mcpCatalog: query }
              : { text: "Cached tools inspected; availability not checked." },
          ),
          [],
          request,
        );
      },
    })
    .reply(f.request);
  expect(answer.text).toContain("availability not checked");
  expect(round).toBe(5);
  expect(f.requests).toBe(requests);
  expect(f.calls).toEqual([]);
  expect(f.store.proposals()).toEqual([]);
  expect(f.store.list()).toEqual(before);
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
          expect(last.result).toEqual({
            source: "cached_snapshot",
            liveAvailability: "not_checked",
            error: "tool_not_enabled",
          });
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

test("revocation invalidates June's pending request without affecting another connection's grant", async () => {
  const f = await fixture();
  f.store.permit(f.id, f.store.generation(f.id), "lookup", "approval");
  const other = f.store.add({
    name: "Other connection",
    url: "https://other.example/mcp",
  });
  await f.store.discover(other, f.store.generation(other));
  f.store.permit(other, f.store.generation(other), "lookup", "approval");
  await f.invoke();
  await f.invoke(other);
  const revoked = f.store.proposals().find((item) => item.connection === f.id);
  const current = f.store.proposals().find((item) => item.connection === other);
  assert(revoked && current);
  expect(f.calls).toHaveLength(0);

  // Revoke A while B's exact grant is already admitted and discovering tools.
  f.duringList(() => {
    f.duringList(() => {});
    f.store.permit(f.id, f.store.generation(f.id), "lookup", "disabled");
  });
  expect(await f.store.confirm(current.id)).toBe("succeeded");
  await expect(f.store.confirm(revoked.id)).rejects.toThrow("proposal_expired");
  expect((await f.invoke()).text).toContain("MCP request denied:");
  expect(f.calls).toHaveLength(1);

  // Re-enabling and reopening cannot revive an old confirmation.
  f.store.permit(f.id, f.store.generation(f.id), "lookup", "approval");
  await f.restart();
  await expect(f.store.confirm(revoked.id)).rejects.toThrow("proposal_expired");
  expect(await f.store.confirm(current.id)).toBe("succeeded");
  expect(f.calls).toHaveLength(1);
  expect(
    f.store.proposals().find((item) => item.id === revoked.id)?.status,
  ).toBe("invalidated");
  await f.store
    .wrap({
      reply: async (request) => {
        expect(request.system).toContain(
          JSON.stringify({
            id: revoked.id,
            tool: "lookup",
            status: "invalidated",
          }),
        );
        expect(request.system).not.toContain("record-9");
        return {
          text: "The previous request is no longer available for approval.",
        };
      },
    })
    .reply(f.request);

  await f.invoke();
  const fresh = f.store.proposals()[0];
  assert(fresh && fresh.id !== revoked.id);
  expect(await f.store.confirm(fresh.id)).toBe("succeeded");
  f.store.permit(f.id, f.store.generation(f.id), "lookup", "disabled");
  expect(f.store.proposals().find((item) => item.id === fresh.id)?.status).toBe(
    "succeeded",
  );
  expect(f.calls).toHaveLength(2);
});

test("owner cancellation persists ungranted proposals and rejects stale approval and replay", async () => {
  const f = await fixture();
  f.store.permit(f.id, f.connection().revision, "lookup", "approval");
  await f.invoke();
  const proposal = f.store.proposals()[0];
  assert(proposal);
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
  const path = `/console/connections/approvals/${proposal.id}`;
  const review = await (await app.request(path)).text();
  const proof = review.match(/name="proof" value="([^"]+)"/)?.[1];
  assert(proof);
  expect(() => f.store.cancel("guest", proposal.id)).toThrow(
    "capability_denied",
  );
  expect(f.store.proposals()[0]).toEqual(proposal);
  const cancelled = f.store.cancel("owner", proposal.id);
  expect(cancelled).toContain("Nothing ran");
  expect(f.store.proposals()[0]).toMatchObject({ status: "cancelled" });
  expect(f.store.proposals()[0]?.grant).toBeUndefined();
  const cancelledAt = f.store.proposals()[0]?.cancelledAt;
  expect(cancelledAt).toBeTypeOf("number");
  expect(
    (
      await app.request(path, {
        method: "POST",
        headers: {
          origin: "https://june.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ proof, confirmed: "yes" }),
      })
    ).status,
  ).toBe(403);
  await expect(f.store.confirm(proposal.id)).rejects.toThrow(
    "proposal_cancelled",
  );
  await f.restart();
  expect(f.store.cancel("owner", proposal.id)).toBe(cancelled);
  expect(f.store.proposals()[0]?.cancelledAt).toBe(cancelledAt);
  await expect(f.store.confirm(proposal.id)).rejects.toThrow(
    "proposal_cancelled",
  );
  expect(f.calls).toHaveLength(0);
  // Cancellation is exact-proposal scoped, not a connection-wide revocation.
  await f.invoke();
  const other = f.store.proposals()[0];
  assert(other);
  expect(await f.store.confirm(other.id)).toBe("succeeded");
  expect(f.calls).toHaveLength(1);
});

test.each(["credential lookup", "discovery"])(
  "cancellation during %s suppresses granted MCP dispatch without replay",
  async (phase) => {
    const f = await fixture();
    f.store.permit(f.id, f.connection().revision, "lookup", "approval");
    await f.invoke();
    const proposal = f.store.proposals()[0];
    assert(proposal);
    let cancelled = "";
    if (phase === "discovery")
      f.duringList(() => {
        cancelled = f.store.cancel("owner", proposal.id);
      });
    const pending = f.store.confirm(proposal.id);
    if (phase === "credential lookup")
      cancelled = f.store.cancel("owner", proposal.id);
    expect(await pending).toBe("unknown");
    expect(cancelled).toContain("outcome: unknown");
    expect(f.store.proposals()[0]?.grant).toBeTypeOf("string");
    expect(f.store.proposals()[0]?.cancelledAt).toBeTypeOf("number");
    expect(f.calls).toHaveLength(0);
    await f.restart();
    expect(f.store.cancel("owner", proposal.id)).toContain("outcome: unknown");
    await expect(f.store.confirm(proposal.id)).rejects.toThrow(
      "proposal_cancelled",
    );
    expect(f.calls).toHaveLength(0);
  },
);

test.each(["succeeded", "unknown"])(
  "cancellation after dispatch preserves the %s outcome and never repeats the effect",
  async (outcome) => {
    const f = await fixture();
    f.store.permit(f.id, f.connection().revision, "lookup", "approval");
    await f.invoke();
    const proposal = f.store.proposals()[0];
    assert(proposal);
    let cancelled = "";
    f.duringCall(() => {
      cancelled = f.store.cancel("owner", proposal.id);
      if (outcome === "unknown") throw new Error("lost response");
    });
    expect(await f.store.confirm(proposal.id)).toBe(outcome);
    expect(cancelled).toContain("outcome: unknown");
    expect(cancelled).toContain("does not confirm an external effect stopped");
    expect(f.calls).toHaveLength(1);
    await f.restart();
    expect(f.store.cancel("owner", proposal.id)).toContain(
      `outcome: ${outcome}`,
    );
    expect(f.store.proposals()[0]?.status).toBe(outcome);
    await expect(f.store.confirm(proposal.id)).rejects.toThrow(
      "proposal_cancelled",
    );
    expect(f.calls).toHaveLength(1);
  },
);

test("proposal inspection is content-free and never repeats approved or unknown effects", async () => {
  const f = await fixture();
  f.store.permit(f.id, f.connection().revision, "lookup", "approval");
  await f.invoke();
  const proposal = f.store.proposals()[0];
  assert(proposal);
  const inspect = async (id: string) => {
    const before = f.requests;
    let modelCalls = 0;
    const answer = await f.store
      .wrap({
        async reply(request) {
          modelCalls++;
          expect(request.system).toContain("mcpProposal");
          return parseReply(
            JSON.stringify({
              text: "",
              mcpProposal: { action: "inspect", id },
            }),
            [],
            request,
          );
        },
      })
      .reply(f.request);
    expect(modelCalls).toBe(1);
    expect(f.requests).toBe(before);
    expect(answer.text.length).toBeLessThan(1000);
    for (const omitted of [
      "record-9",
      "private-token",
      "private result",
      "lookup",
      "mcp.example",
    ])
      expect(answer.text).not.toContain(omitted);
    const [metadata] = answer.text.split("\n");
    assert(metadata);
    return JSON.parse(metadata.replace("Recorded MCP proposal metadata: ", ""));
  };
  expect(await inspect(proposal.id)).toMatchObject({
    id: proposal.id,
    status: "awaiting_approval",
    grantId: null,
    receipt: null,
  });
  expect(await inspect(randomUUID())).toEqual({ status: "not_found" });
  expect(f.calls).toHaveLength(0);
  await f.store.confirm(proposal.id);
  expect(await inspect(proposal.id)).toMatchObject({
    status: "succeeded",
    receipt: { status: "succeeded" },
  });
  f.result("private result: remote rejection private-token");
  f.fail("result");
  await f.invoke();
  const uncertain = f.store.proposals()[0];
  assert(uncertain);
  expect(await f.store.confirm(uncertain.id)).toBe("unknown");
  expect(await inspect(uncertain.id)).toMatchObject({
    status: "unknown",
    receipt: { status: "unknown" },
  });
  f.store.cancel("owner", uncertain.id);
  expect(await inspect(uncertain.id)).toMatchObject({
    status: "unknown",
    cancelledAt: expect.any(Number),
    receipt: { status: "unknown" },
  });
  await f.invoke();
  const cancelled = f.store.proposals()[0];
  assert(cancelled);
  f.store.cancel("owner", cancelled.id);
  expect(await inspect(cancelled.id)).toMatchObject({
    status: "cancelled",
    cancelledAt: expect.any(Number),
    grantId: null,
    receipt: null,
  });
  // Exact lookup must not depend on the 50-entry dashboard listing window.
  for (let n = 0; n < 51; n++) await f.invoke();
  expect(f.store.proposals().some(({ id }) => id === proposal.id)).toBe(false);
  const unconsumed = f.store.proposals()[0];
  assert(unconsumed);
  f.store.disconnect(f.id, f.connection().revision);
  await f.restart();
  expect(await inspect(proposal.id)).toMatchObject({ status: "succeeded" });
  expect(await inspect(uncertain.id)).toMatchObject({ status: "unknown" });
  expect(await inspect(unconsumed.id)).toMatchObject({
    status: "invalidated",
    grantId: null,
    receipt: null,
  });
  expect(f.calls).toHaveLength(2);

  const directive = {
    text: "",
    mcpProposal: { action: "inspect", id: proposal.id },
  };
  for (const capabilities of [
    {},
    { mcpAvailable: true },
    { mcpProposalAvailable: true },
    { mcpPermissionAvailable: true },
  ]) {
    const schema = replyJsonSchema([], capabilities);
    expect(schema.required.toSorted()).toEqual(
      Object.keys(schema.properties).toSorted(),
    );
    expect("mcpProposal" in schema.properties).toBe(
      capabilities.mcpProposalAvailable === true,
    );
  }
  for (const [reply, capabilities] of [
    [directive, {}],
    [directive, { mcpAvailable: true }],
    [{ ...directive, text: "claimed success" }, { mcpProposalAvailable: true }],
    [
      {
        ...directive,
        mcp: { connection: f.id, tool: "lookup", argumentsJson: "{}" },
      },
      { mcpAvailable: true, mcpProposalAvailable: true },
    ],
    [
      { ...directive, mcpProposal: { action: "approve", id: proposal.id } },
      { mcpProposalAvailable: true },
    ],
    [
      { ...directive, mcpProposal: { action: "inspect", id: "not-an-id" } },
      { mcpProposalAvailable: true },
    ],
  ] as const)
    expect(() => parseReply(JSON.stringify(reply), [], capabilities)).toThrow();
});

test("June privately inspects receipts and forgetting suppresses an in-flight inspection", async (t) => {
  const f = await fixture();
  f.store.permit(f.id, f.connection().revision, "lookup", "approval");
  await f.invoke();
  const proposal = f.store.proposals()[0];
  assert(proposal);
  const directive: CompanionReply = {
    text: "",
    mcpProposal: { action: "inspect", id: proposal.id },
  };
  const store = new EvidenceStore(":memory:", Buffer.alloc(32, 9));
  const pending = Promise.withResolvers<CompanionReply>();
  t.onTestFinished(() => {
    pending.resolve({ text: "" });
    store.close();
  });
  const requests: ModelRequest[] = [];
  const sent: OutboundMessage[] = [];
  const source = (event: MessageEvent, audience: string) =>
    slackSource({
      workspace: "T1",
      channel: event.address.conversationId,
      ts: event.messageId,
      author: event.senderId,
      text: event.text,
      workspaceUrl: "https://fixture.slack.com/",
      audiences: [audience],
    });
  const registry = createJuneRegistry({
    owner: {
      id: "owner",
      identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
    },
    memory: { store, source },
    mcpAvailable: true,
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(message);
          return { status: "sent", messageId: String(sent.length) };
        },
      },
    },
    model: f.store.wrap({
      async reply(request) {
        requests.push(request);
        return requests.length === 1 ? directive : pending.promise;
      },
    }),
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "owner"]);
  const event: MessageEvent = {
    type: "message",
    id: "inspect-first",
    messageId: "100.000001",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    direct: true,
    senderId: "U1",
    text: `Inspect proposal ${proposal.id}`,
  };
  const done = async () =>
    Object.values((await june.snapshot()).events).filter((e) => e.done).length;
  await june.send("inbox", { type: "event", event });
  await expect.poll(done).toBe(1);
  expect(requests[0]?.mcpAvailable).toBe(true);
  expect(sent[0]?.content).toMatchObject({
    type: "text",
    text: expect.stringContaining('"status":"awaiting_approval"'),
  });
  const forgotten = {
    ...event,
    id: "inspect-forgotten",
    messageId: "100.000002",
  };
  await june.send("inbox", { type: "event", event: forgotten });
  await expect.poll(() => requests.length).toBe(2);
  const sourceId = source(forgotten, JSON.stringify(["private", "owner"])).id;
  store.deleteSource(sourceId);
  await june.forget(sourceId);
  pending.resolve(directive);
  await expect.poll(done).toBe(2);
  expect(sent).toHaveLength(1);
  expect((await june.snapshot()).history).toEqual([]);
  expect(f.calls).toHaveLength(0);

  // The same known UUID cannot reveal metadata outside an owner-private turn.
  for (const [direct, senderId] of [
    [false, "U1"],
    [true, "U2"],
  ] as const) {
    const request = buildModelRequest({
      event: {
        ...event,
        direct,
        senderId,
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
    expect(request.mcpAvailable).toBe(false);
    await f.store
      .wrap({
        async reply(input) {
          expect(input.system).not.toContain("Recorded MCP proposal");
          expect(input.system).not.toContain(proposal.id);
          expect(() =>
            parseReply(JSON.stringify(directive), [], input),
          ).toThrow();
          return { text: "No private tools" };
        },
      })
      .reply(request);
  }
});

test.each(["succeeded", "failed"])(
  "reconciles only the exact unknown proposal as %s without retrying",
  async (outcome) => {
    const f = await fixture();
    f.store.permit(f.id, f.connection().revision, "lookup", "approval");
    await f.invoke();
    const proposal = f.store.proposals()[0];
    assert(proposal);
    const confirmation = { confirmedStopped: true, outcome };
    expect(() => f.store.reconcile("owner", proposal.id, confirmation)).toThrow(
      "proposal_not_started",
    );
    f.duringCall(() => {
      throw new Error("ambiguous fixture transport");
    });
    const execution = f.store.confirm(proposal.id);
    expect(() => f.store.reconcile("owner", proposal.id, confirmation)).toThrow(
      "capability_denied",
    );
    expect(await execution).toBe("unknown");
    expect(f.calls).toHaveLength(1);
    await f.invoke();
    const other = f.store.proposals()[0];
    assert(other && other.id !== proposal.id);
    f.store.disconnect(f.id, f.connection().revision);
    await f.restart();
    expect(() => f.store.reconcile("guest", proposal.id, confirmation)).toThrow(
      "capability_denied",
    );
    expect(() =>
      f.store.reconcile("owner", proposal.id.slice(0, 8), confirmation),
    ).toThrow("proposal_unavailable");
    for (const input of [
      { outcome },
      { confirmedStopped: false, outcome },
      { confirmedStopped: true },
      { confirmedStopped: true, outcome: "unknown" },
    ])
      expect(() => f.store.reconcile("owner", proposal.id, input)).toThrow(
        "capability_denied",
      );
    expect(f.store.proposals().find((p) => p.id === proposal.id)?.status).toBe(
      "unknown",
    );
    expect(f.store.reconcile("owner", proposal.id, confirmation).status).toBe(
      outcome,
    );
    expect(f.store.proposals().find((p) => p.id === other.id)?.status).toBe(
      "invalidated",
    );
    expect(() => f.store.reconcile("owner", proposal.id, confirmation)).toThrow(
      "capability_denied",
    );
    await f.restart();
    expect(await f.store.confirm(proposal.id)).toBe(outcome);
    expect(f.calls).toHaveLength(1);
  },
);

test("June accepts MCP commands only from exact current owner-private confirmations, never model assertions", async (t) => {
  const f = await fixture();
  f.store.permit(f.id, f.connection().revision, "lookup", "approval");
  await f.invoke();
  const proposal = f.store.proposals()[0];
  assert(proposal);
  f.duringCall(() => {
    throw new Error("ambiguous fixture transport");
  });
  expect(await f.store.confirm(proposal.id)).toBe("unknown");
  const command = `!mcp-reconcile ${proposal.id} confirmed-stopped verified-failed`;
  const owner: Owner = {
    id: "owner",
    identities: [{ channel: "slack", accountId: "T1", senderId: "UOWNER" }],
  };
  const sent: OutboundMessage[] = [];
  const requests: ModelRequest[] = [];
  const registry = createJuneRegistry({
    owner,
    mcpAvailable: true,
    mcpCommands: f.store,
    model: f.store.wrap({
      reply: async (request) => {
        requests.push(request);
        return { text: command };
      },
    }),
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        receive: async () => ({ response: new Response(), events: [] }),
        send: async (message) => {
          sent.push(JSON.parse(JSON.stringify(message)));
          return { status: "sent", messageId: `out-${sent.length}` };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const ingress = createSlackAdapter({
    signingSecret: "fixture",
    botToken: "fixture",
    teamId: "T1",
    botUserId: "UBOT",
    ownerUserIds: ["UOWNER"],
    fetch: async () => Response.json({ ok: false }),
  });
  let number = 0;
  const send = async (
    text: string,
    overrides: Partial<MessageEvent> = {},
    blockType?: string,
  ) => {
    number++;
    let event: MessageEvent = {
      type: "message",
      id: `input-${number}`,
      messageId: `100.${number}`,
      occurredAt: Date.now(),
      senderId: "UOWNER",
      direct: true,
      botMentioned: true,
      mcpCommandEligible: true,
      metadata: { channelType: "im" },
      text,
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      ...overrides,
    };
    if (blockType) {
      const body = JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event_id: event.id,
        event_time: Math.floor(event.occurredAt / 1000),
        event: {
          type: "message",
          channel_type: "im",
          channel: "D1",
          user: "UOWNER",
          ts: event.messageId,
          text,
          blocks: [
            {
              type: "rich_text",
              elements: [
                { type: blockType, elements: [{ type: "text", text }] },
              ],
            },
          ],
        },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", "fixture")
        .update(`v0:${timestamp}:${body}`)
        .digest("hex");
      const normalized = await ingress.receive(
        new Request("https://june.example/webhooks/slack", {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": `v0=${signature}`,
          },
        }),
      );
      assert(normalized.events[0]?.type === "message");
      event = normalized.events[0];
      expect(event.mcpCommandEligible).toBe(blockType === "rich_text_section");
    }
    const scope = routeEvent(event, owner);
    assert(scope);
    const conversation = client.conversation.getOrCreate(scope.key);
    await conversation.send("inbox", { type: "event", event });
    await expect
      .poll(
        async () =>
          Object.values((await conversation.snapshot()).events).some(
            (entry) => entry.event.id === event.id && entry.done,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
  };
  const status = () =>
    f.store.proposals().find((p) => p.id === proposal.id)?.status;
  await send("What happened to that operation?");
  expect(requests[0]?.system).toContain("independently checking");
  expect(requests[0]?.system).toContain("!mcp-reconcile");
  expect(status()).toBe("unknown"); // The model returned the exact command.
  await send(command, { senderId: "UGUEST" });
  await send(command, { direct: false, metadata: { channelType: "channel" } });
  await send(`Quoted command: ${command}`);
  expect(status()).toBe("unknown");
  const modelCalls = requests.length;
  for (const block of ["rich_text_quote", "rich_text_preformatted"])
    await send(command, {}, block);
  await send(command, { mcpCommandEligible: undefined });
  for (const invalid of [
    `!mcp-reconcile ${proposal.id} confirmed-stopped`,
    `!mcp-reconcile ${proposal.id} confirmed-stopped verified-unknown`,
    `!mcp-reconcile ${proposal.id} verified-failed`,
    `${command} extra`,
  ])
    await send(invalid);
  expect(status()).toBe("unknown");
  expect(requests).toHaveLength(modelCalls);
  await send(command, {}, "rich_text_section");
  expect(status()).toBe("failed");
  expect(sent.at(-1)?.content).toEqual({
    type: "text",
    text: `MCP proposal ${proposal.id} reconciled as failed from your independent verification. No tool was run and no retry was authorized.`,
  });
  await send(command);
  expect(status()).toBe("failed");
  expect(requests).toHaveLength(modelCalls);
  expect(f.calls).toHaveLength(1);
  await f.invoke();
  const pending = f.store.proposals()[0];
  assert(pending && pending.id !== proposal.id);
  await send(`!mcp-cancel ${pending.id}`, { senderId: "UGUEST" });
  for (const block of ["rich_text_quote", "rich_text_preformatted"])
    await send(`!mcp-cancel ${pending.id}`, {}, block);
  expect(f.store.proposals()[0]).toEqual(pending);
  await send(`!mcp-cancel ${pending.id}`, {}, "rich_text_section");
  const cancelled = f.store.proposals()[0];
  expect(cancelled?.status).toBe("cancelled");
  await send(`!mcp-cancel ${pending.id}`);
  expect(f.store.proposals()[0]).toEqual(cancelled);
  await expect(f.store.confirm(pending.id)).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
});

test("WhatsApp MCP attestations reject forwarded and legacy commands before inference", async (t) => {
  const f = await fixture();
  f.store.permit(f.id, f.connection().revision, "lookup", "approval");
  await f.invoke();
  const unknown = f.store.proposals()[0];
  assert(unknown);
  f.duringCall(() => {
    throw new Error("ambiguous fixture transport");
  });
  expect(await f.store.confirm(unknown.id)).toBe("unknown");
  await f.invoke();
  const pending = f.store.proposals()[0];
  assert(pending && pending.id !== unknown.id);
  let modelCalls = 0;
  const registry = createJuneRegistry({
    owner: {
      id: "owner",
      identities: [
        { channel: "whatsapp", accountId: "phone", senderId: "15551234567" },
      ],
    },
    mcpCommands: f.store,
    model: {
      async reply() {
        modelCalls++;
        return { text: "unexpected" };
      },
    },
    channels: {
      whatsapp: {
        channel: "whatsapp",
        capabilities: { text: true, threads: false, reactions: true },
        receive: async () => ({ response: new Response(), events: [] }),
        send: async () => ({ status: "sent", messageId: "out" }),
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "owner"]);
  const ingress = createWhatsAppAdapter({
    appSecret: "fixture",
    verifyToken: "fixture",
    accessToken: "fixture",
    phoneNumberId: "phone",
    apiVersion: "v23.0",
  });
  let sequence = 0;
  const send = async (
    text: string,
    forwarding?: "forwarded" | "frequently_forwarded" | "legacy",
  ) => {
    const id = `wa-${++sequence}`;
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone" },
                messages: [
                  {
                    id,
                    from: "15551234567",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: text },
                    ...(forwarding && forwarding !== "legacy"
                      ? { context: { [forwarding]: true } }
                      : {}),
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const received = await ingress.receive(
      new Request("https://june.example/webhooks/whatsapp", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": `sha256=${createHmac("sha256", "fixture").update(body).digest("hex")}`,
        },
      }),
    );
    assert(received.events[0]?.type === "message");
    const event = received.events[0];
    if (forwarding === "legacy") delete event.mcpCommandEligible;
    await june.send("inbox", { type: "event", event });
    await expect
      .poll(
        async () =>
          Object.values((await june.snapshot()).events).some(
            (entry) => entry.event.id === id && entry.done,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
  };
  const commands = [
    `!mcp-reconcile ${unknown.id} confirmed-stopped verified-succeeded`,
    `!mcp-cancel ${pending.id}`,
  ];
  const before = f.store.proposals();
  for (const command of commands) {
    for (const forwarding of [
      "forwarded",
      "frequently_forwarded",
      "legacy",
    ] as const) {
      await send(command, forwarding);
      expect(f.store.proposals()).toEqual(before);
      expect(modelCalls).toBe(0);
    }
  }
  for (const command of commands) {
    await send(command);
    await send(command);
  }
  expect(f.store.proposals().find((p) => p.id === unknown.id)?.status).toBe(
    "succeeded",
  );
  expect(f.store.proposals().find((p) => p.id === pending.id)?.status).toBe(
    "cancelled",
  );
  await expect(f.store.confirm(pending.id)).rejects.toThrow(
    "proposal_cancelled",
  );
  expect(modelCalls).toBe(0);
  expect(f.calls).toHaveLength(1);
});

test.for(["read", "approval", "catalog", "discovery", "result", "synthesis"])(
  "forgetting suppresses stale MCP %s work through June and provider wrappers",
  async (phase, t) => {
    const f = await fixture();
    const memory = new EvidenceStore(":memory:", randomBytes(32));
    const scope = ["private", "owner"];
    const audience = JSON.stringify(scope);
    memory.appendSource({
      id: "A",
      text: "violet synthetic secret",
      audiences: [audience],
      platform: "slack",
      account: "T1",
      conversation: "D1",
      author: "UOWNER",
      observedAt: 100,
      sourceUrl: "https://fixture.slack.com/archives/D1/p100",
    });
    t.onTestFinished(() => memory.close());
    f.store.permit(
      f.id,
      f.connection().revision,
      "lookup",
      phase === "approval" ? "approval" : "read",
    );
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    t.onTestFinished(() => released.resolve());
    let modelCalls = 0;
    const sent: string[] = [];
    const provider: ModelProvider = {
      async reply(request, _signal, isCurrent) {
        modelCalls++;
        // The live host predicate is out-of-band, not a non-cloneable request field.
        expect(structuredClone(request).system).toContain(
          "violet synthetic secret",
        );
        expect(isCurrent?.()).toBe(true);
        if (phase === "catalog" && modelCalls === 1)
          return {
            text: "",
            mcpCatalog: { connection: null, tool: null, offset: 0 },
          };
        const pause =
          phase === "read" ||
          phase === "approval" ||
          phase === "catalog" ||
          (phase === "synthesis" && modelCalls === 2);
        if (pause) {
          started.resolve();
          await released.promise;
        }
        if (modelCalls > 1 && phase !== "catalog")
          return { text: "stale violet answer" };
        return {
          text: "",
          mcp: {
            connection: f.id,
            tool: "lookup",
            argumentsJson: '{"id":"record-9"}',
          },
        };
      },
    };
    if (phase === "discovery") f.duringList(() => memory.deleteSource("A"));
    if (phase === "result") f.duringCall(() => memory.deleteSource("A"));
    const links = createConsoleLoginLinks("https://june.example");
    const wrapped =
      phase === "approval" || phase === "catalog"
        ? links.wrapModel(f.store.wrap(provider))
        : f.store.wrap(links.wrapModel(provider));
    const registry = createJuneRegistry({
      owner: {
        id: "owner",
        identities: [{ channel: "slack", accountId: "T1", senderId: "UOWNER" }],
      },
      mcpAvailable: true,
      model: wrapped,
      memory: {
        store: memory,
        source: (event, scope) =>
          slackSource({
            workspace: "T1",
            channel: "D1",
            ts: event.messageId,
            author: event.senderId,
            text: event.text,
            workspaceUrl: "https://fixture.slack.com/",
            audiences: [scope],
          }),
      },
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, threads: true, reactions: true },
          receive: async () => ({ response: new Response(), events: [] }),
          send: async (message) => {
            if (message.content.type === "text")
              sent.push(message.content.text);
            return { status: "sent", messageId: "out" };
          },
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(scope);
    await june.send("inbox", {
      type: "event",
      event: {
        id: "violet",
        type: "message",
        messageId: "100.000001",
        occurredAt: Date.now(),
        senderId: "UOWNER",
        direct: true,
        text: "violet",
        address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      },
    });
    if (phase !== "discovery" && phase !== "result") {
      await started.promise;
      memory.deleteSource("A");
      await june.forget("A");
      released.resolve();
    }
    await expect
      .poll(
        async () =>
          Object.values((await june.snapshot()).events).some(
            (entry) => entry.event.id === "violet" && entry.done,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    expect(modelCalls).toBe(
      phase === "catalog" || phase === "synthesis" ? 2 : 1,
    );
    expect(f.calls).toHaveLength(
      phase === "result" || phase === "synthesis" ? 1 : 0,
    );
    expect(f.store.proposals()).toEqual([]);
    expect(sent).toEqual([]);
    expect(JSON.stringify((await june.snapshot()).history)).not.toContain(
      "stale violet answer",
    );
  },
);

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
  expect(stale).toContain("invalidated");
  expect(stale).toContain("connection has changed or been removed");
  expect(stale).not.toContain("https://other.example/mcp");
  expect(stale).not.toContain('name="proof"');
  expect((await post({ proof: staleProof, confirmed: "yes" })).status).toBe(
    403,
  );
  expect(f.calls).toHaveLength(1);
  f.store.disconnect(f.id, f.connection().revision);
  expect(await (await app.request(path())).text()).toContain(
    "connection has changed or been removed",
  );
});

test.each(["disconnect", "revoke"])(
  "%s during discovery prevents an already-approved mutation from dispatching",
  async (change) => {
    const f = await fixture();
    f.store.permit(f.id, f.connection().revision, "lookup", "approval");
    await f.invoke();
    f.duringList(() => {
      if (change === "disconnect") {
        f.store.disconnect(f.id, f.connection().revision);
      } else {
        f.store.permit(f.id, f.connection().revision, "lookup", "disabled");
        f.store.permit(f.id, f.connection().revision, "lookup", "approval");
      }
    });
    const proposal = f.store.proposals()[0];
    assert(proposal);
    expect(await f.store.confirm(proposal.id)).toBe("unknown");
    await f.restart();
    expect(f.store.proposals()[0]?.status).toBe("unknown");
    expect(await f.store.confirm(proposal.id)).toBe("unknown");
    expect(f.calls).toHaveLength(0);
  },
);

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

test("Amp consent saves once behind owner confirmation; June needs tool consent and reconnect revokes it", async () => {
  const f = await fixture();
  f.store.disconnect(f.id, f.connection().revision);
  const origin = "https://june.example";
  const base = "/console/connections";
  const issuer = "https://auth.ampcode.com";
  const keys = await generateKeyPair("RS256");
  const publicKey = await exportJWK(keys.publicKey);
  let nonce = "";
  let exchanges = 0;
  const amp = createPuckConsoleOAuth(
    {
      origin,
      generation: () => f.store.generation("amp"),
      saveAuthorization: async (value) => {
        f.store.connectAmp(value);
      },
    },
    {
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("oauth-protected-resource/mcp"))
          return Response.json({
            resource: "https://ampcode.com/mcp",
            authorization_servers: [issuer],
          });
        if (url.endsWith("oauth-authorization-server"))
          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}/oauth2/authorize`,
            token_endpoint: `${issuer}/oauth2/token`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            client_id_metadata_document_supported: true,
          });
        if (url === `${issuer}/oauth2/jwks`)
          return Response.json({
            keys: [{ ...publicKey, kid: "fixture", alg: "RS256" }],
          });
        expect(url).toBe(`${issuer}/oauth2/token`);
        exchanges++;
        return Response.json({
          access_token: "private-token",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: await new SignJWT({ nonce })
            .setProtectedHeader({ alg: "RS256", kid: "fixture" })
            .setIssuer(issuer)
            .setAudience(`${origin}${base}/amp/client.json`)
            .setSubject("fixture-amp-owner")
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(keys.privateKey),
        });
      },
    },
  );
  const ownerToken = "owner-fixture-token".repeat(2);
  const app = createHttpApp({
    owner: { id: "owner", identities: [] },
    channels: {},
    operatorToken: ownerToken,
    submit: async () => {},
    ready: async () => true,
    inspectConversation: async () => ({}),
    inspectJob: async () => undefined,
    resumeJob: async () => false,
    console: {
      origin,
      inspect: async () => ({ observedAt: "fixture", sections: {} }),
      connections: { store: f.store, amp },
    },
  });
  let cookie = "";
  const get = (path: string) =>
    app.request(`${base}${path}`, {
      headers: { authorization: `Bearer ${ownerToken}`, cookie },
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
        authorization: `Bearer ${ownerToken}`,
        cookie,
        origin: requestOrigin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
    });
  const metadata = await app.request(`${base}/amp/client.json`);
  expect(metadata.status).toBe(200);
  expect(await metadata.json()).toEqual({
    client_id: `${origin}${base}/amp/client.json`,
    client_name: "June",
    redirect_uris: [`${origin}${base}/amp/callback`],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "openid",
  });
  expect((await app.request(base)).status).toBe(401);
  expect((await app.request(`${base}/amp/finish`)).status).toBe(401);
  expect(
    (await app.request(`${base}/amp/connect`, { method: "POST" })).status,
  ).toBe(401);
  const beginProof = proof(await (await get("")).text());
  expect(
    (await post("/amp/connect", { proof: beginProof }, "https://evil.example"))
      .status,
  ).toBe(403);
  const begin = await post("/amp/connect", { proof: beginProof });
  const target = new URL(
    (await begin.text())
      .match(/href="(https:\/\/auth.ampcode.com[^"]+)"/)?.[1]
      ?.replaceAll("&amp;", "&") ?? "",
  );
  nonce = target.searchParams.get("nonce") ?? "";
  const callback = await app.request(
    `${base}/amp/callback?state=${target.searchParams.get("state")}&code=fixture-code`,
  );
  cookie = callback.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).toContain("__Host-june-amp-return=");
  expect(exchanges).toBe(0);
  expect(f.store.list()).toHaveLength(0);
  expect(await (await get("")).text()).toContain("Resume Amp setup");
  const confirmation = {
    proof: proof(await (await get("/amp/finish")).text()),
    confirmed: "yes",
  };
  expect(
    (await post("/amp/finish", confirmation, "https://evil.example")).status,
  ).toBe(403);
  expect(
    (await post("/amp/finish", { proof: confirmation.proof })).status,
  ).toBe(403);
  expect(exchanges).toBe(0);
  expect((await post("/amp/finish", confirmation)).status).toBe(303);
  expect((await post("/amp/finish", confirmation)).status).toBe(403);
  expect(exchanges).toBe(1);
  expect(f.store.list()).toMatchObject([
    {
      id: "amp",
      url: "https://ampcode.com/mcp",
      account: "fixture-amp-owner",
      authenticated: true,
      tools: [],
      status: "not_tested",
    },
  ]);
  const saved = await (await get("/amp")).text();
  expect(saved).toContain("Authorization saved");
  expect(saved).toContain("fixture-amp-owner");
  expect(saved).not.toContain("private-token");
  await f.restart();
  expect(
    (await readFile(join(f.directory, "connections.sqlite"))).includes(
      Buffer.from("private-token"),
    ),
  ).toBe(false);
  await f.store.discover("amp", f.connection().revision);
  const call: CompanionReply = {
    text: "",
    mcp: {
      connection: "amp",
      tool: "lookup",
      argumentsJson: '{"id":"record-9"}',
    },
  };
  expect(
    (await f.store.wrap({ reply: async () => call }).reply(f.request)).text,
  ).toContain("denied");
  expect(f.calls).toEqual([]);
  f.store.permit("amp", f.connection().revision, "lookup", "read");
  const requests: ModelRequest[] = [];
  const answer = await f.store
    .wrap({
      reply: async (request) => {
        requests.push(request);
        return request.mcpAvailable
          ? call
          : { text: "Fixture result received" };
      },
    })
    .reply(f.request);
  expect(answer.text).toBe("Fixture result received");
  expect(requests).toHaveLength(2);
  expect(requests[0]?.system).toContain('"connection":"amp"');
  expect(requests[1]?.system).toContain("private result");
  expect(JSON.stringify(requests)).not.toContain("private-token");
  expect(requests[1]).toMatchObject({
    mcpAvailable: false,
    reflectionMemoryAvailable: false,
    usageStage: "synthesis",
  });
  expect(f.calls).toEqual([{ name: "lookup", arguments: { id: "record-9" } }]);
  f.store.permit("amp", f.connection().revision, "lookup", "approval");
  expect((await f.invoke("amp")).text).toContain("Nothing has run");
  expect(f.calls).toHaveLength(1);
  const proposal = f.store.proposals()[0];
  assert(proposal);
  f.store.connectAmp({
    accessToken: "replacement-token",
    expiresAt: Date.now() + 3600_000,
    account: "other-amp-owner",
  });
  expect(f.connection().tools).toEqual([]);
  expect(f.store.proposals()[0]?.status).toBe("invalidated");
  await expect(f.store.confirm(proposal.id)).rejects.toThrow(
    "proposal_expired",
  );
  expect(f.calls).toHaveLength(1);
});
