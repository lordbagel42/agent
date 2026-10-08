import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it, vi } from "vitest";
import { createAgentMcp } from "../src/agent/mcp.js";
import { operatorRequest } from "../src/agent/operator.js";
import { AgentService } from "../src/agent/service.js";
import { routeEvent } from "../src/core/routing.js";
import { createHttpApp } from "../src/http/app.js";
import { parseReply, replyJsonSchema } from "../src/models/provider.js";
import {
  type CapabilityContext,
  runCapability,
} from "../src/runtime/capabilities.js";
import {
  currentExecutionCapabilities,
  executionCapabilities,
} from "../src/runtime/execution-context.js";
import { buildModelRequest } from "../src/runtime/prompt.js";
import type { Dependencies } from "../src/runtime/registry.js";
import { initializeTelemetry, withSpan } from "../src/telemetry/index.js";

it("admits task telemetry while preserving current grants, invalidation and HTTP/MCP authentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "june-otel-access-"));
  // This fixture must never export to an inherited live collector.
  const env = { ...process.env };
  for (const key of Object.keys(process.env))
    if (key.startsWith("OTEL_")) delete process.env[key];
  const telemetry = initializeTelemetry({
    path: join(directory, "otel.sqlite"),
  });
  const query = vi.spyOn(telemetry, "query");
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "team", senderId: "human" },
    ],
  };
  const token = randomBytes(32).toString("base64url");
  const operatorToken = randomBytes(32).toString("hex");
  const service = new AgentService({
    directory,
    key: randomBytes(32),
    ownerId: owner.id,
    clients: [{ id: "fixture", token, expiresAt: Date.now() + 60_000 }],
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
  const client = new Client({ name: "fixture", version: "1" });
  try {
    await withSpan("june.turn", {}, async () => {
      await withSpan(
        "june.model.call",
        { "gen_ai.usage.input_tokens": 37 },
        async () => {},
      );
    });
    const context: CapabilityContext = {
      event: {
        type: "message",
        id: "event",
        messageId: "message",
        senderId: "human",
        direct: true,
        text: "inspect telemetry",
        occurredAt: Date.now(),
        address: { channel: "slack", accountId: "team", conversationId: "dm" },
        metadata: { channelType: "im" },
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
      model: { reply: async () => ({ text: "" }) },
      deps: { owner, telemetry },
      ports: {} as CapabilityContext["ports"],
    };
    const deps: Dependencies = {
      owner,
      telemetry,
      channels: {},
      model: context.model,
    };
    const ceiling = executionCapabilities(deps, context.event);
    expect(ceiling.telemetryAvailable).toBe(true);
    expect(
      currentExecutionCapabilities(deps, context.event, {}).telemetryAvailable,
    ).toBe(false);
    const input = {
      event: context.event,
      owner,
      history: [],
      now: new Date(),
      models: { current: { provider: "fixture", model: "fixture" } },
      capabilities: ceiling,
    };
    const request = buildModelRequest({ ...input, agentRole: "execution" });
    expect(request.system).toContain("nextBefore");
    expect(replyJsonSchema([], request).properties).toHaveProperty("telemetry");
    const interaction = buildModelRequest({
      ...input,
      agentRole: "interaction",
    });
    expect(interaction.system).toContain("query_telemetry");
    expect(replyJsonSchema([], interaction).properties).not.toHaveProperty(
      "telemetry",
    );
    const unavailable = buildModelRequest({ ...input, capabilities: {} });
    expect(unavailable.system).toContain(
      "Automated turns without a telemetry grant cannot query it",
    );
    expect(unavailable.telemetryAvailable).toBe(false);
    const reply = parseReply(
      JSON.stringify({
        text: "",
        telemetry: {
          view: "traces",
          name: "june.model.call",
          limit: 1,
          traceId: null,
        },
      }),
      [],
      request,
    );
    const observation = JSON.parse(
      (await runCapability(reply, request, context)).text,
    );
    expect(observation.rows).toHaveLength(1);
    expect(observation.rows[0].attributes["gen_ai.usage.input_tokens"]).toBe(
      37,
    );
    expect(observation.rows[0].parentSpanId).toMatch(/^[a-f0-9]{16}$/);
    const traceId = observation.rows[0].traceId;
    query.mockClear();
    for (const event of [
      { ...context.event, senderId: "guest" },
      {
        ...context.event,
        direct: false,
        address: { ...context.event.address, conversationId: "C1" },
        metadata: { channelType: "channel" as const },
      },
      {
        ...context.event,
        senderId: "guest",
        direct: false,
        botMentioned: true,
        address: { ...context.event.address, conversationId: "C1" },
        metadata: { channelType: "channel" as const },
      },
    ]) {
      const scope = routeEvent(event, owner);
      if (!scope) throw new Error("Missing task scope");
      const taskRequest = buildModelRequest({
        ...input,
        event,
        agentRole: "execution",
        capabilities: executionCapabilities(deps, event),
      });
      expect(taskRequest.telemetryAvailable).toBe(true);
      const result = await runCapability(reply, taskRequest, {
        ...context,
        event,
        scope,
        audience: JSON.stringify(scope.key),
        ownerTurn: event.senderId === "human",
      });
      expect(JSON.parse(result.text).rows).toHaveLength(1);
    }
    expect(query).toHaveBeenCalledTimes(3);
    query.mockClear();
    for (const override of [
      { valid: () => false },
      { signal: AbortSignal.abort() },
      { phase: "synthesis" as const },
      { origin: "wakeup" as const },
    ]) {
      await runCapability(reply, request, { ...context, ...override });
    }
    await runCapability(
      reply,
      { ...request, telemetryAvailable: false },
      context,
    );
    expect(query).not.toHaveBeenCalled();
    expect(() => parseReply(JSON.stringify(reply), [], {})).toThrow();
    expect(() => parseReply(JSON.stringify(reply), [], interaction)).toThrow();

    const app = createHttpApp({
      channels: {},
      owner,
      operatorToken,
      telemetry,
      submit: async () => {},
      ready: async () => true,
      inspectConversation: async () => ({}),
      inspectJob: async () => null,
      resumeJob: async () => false,
    });
    for (const authorization of ["", "Bearer wrong"])
      expect(
        (
          await app.request("/operator/telemetry/query", {
            method: "POST",
            headers: { authorization },
            body: "{}",
          })
        ).status,
      ).toBe(401);
    expect(query).not.toHaveBeenCalled();
    const mcp = createAgentMcp({
      service,
      origin: "http://localhost",
      status: async () => ({}),
      operator: operatorRequest((request) => app.fetch(request), operatorToken),
    });
    expect(
      (await mcp(new Request("http://localhost/mcp", { method: "POST" })))
        .status,
    ).toBe(401);
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: (input, init) => mcp(new Request(input, init)),
      }),
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      "query_telemetry",
    );
    const read = async (before?: number) => {
      const result = await client.callTool({
        name: "query_telemetry",
        arguments: {
          view: "traces",
          traceId,
          limit: 1,
          ...(before ? { before } : {}),
        },
      });
      expect(result.isError).not.toBe(true);
      return (
        result.structuredContent as {
          result: {
            status: number;
            result: {
              rows: { spanId: string; parentSpanId?: string }[];
              nextBefore: number | null;
            };
          };
        }
      ).result;
    };
    const first = await read();
    expect(first.status).toBe(200);
    expect(first.result.nextBefore).not.toBeNull();
    const second = await read(first.result.nextBefore ?? undefined);
    expect(first.result.rows[0]?.parentSpanId).toBe(
      second.result.rows[0]?.spanId,
    );
    expect(second.result.nextBefore).toBeNull();
    expect(
      (
        await client.callTool({
          name: "query_telemetry",
          arguments: { limit: 101 },
        })
      ).isError,
    ).toBe(true);
    query.mockClear();
    service.revokeClient("fixture");
    await expect(read()).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await service.close();
    await telemetry.shutdown();
    for (const [key, value] of Object.entries(env))
      if (key.startsWith("OTEL_")) process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
});
