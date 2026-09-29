import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { createAgentMcp } from "../src/agent/mcp.js";
import { operatorRequest } from "../src/agent/operator.js";
import { AgentService } from "../src/agent/service.js";
import type { WebhookRegistration } from "../src/agent/webhooks.js";
import type { MessageEvent, ModelRequest } from "../src/core/contracts.js";
import { createHttpApp } from "../src/http/app.js";
import { parseReply } from "../src/models/provider.js";
import {
  type ConversationState,
  createJuneRegistry,
} from "../src/runtime/registry.js";
import { setupTest } from "./rivet.js";

const state = (): ConversationState => ({
  history: [{ id: "human", role: "user", content: "owner private context" }],
  events: {},
  deliveries: {},
  jobs: {},
  lastInbound: {},
});

async function connect(
  handler: (request: Request) => Promise<Response>,
  token: string,
) {
  const client = new Client({ name: "fixture", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: (input, init) => handler(new Request(input, init)),
    }),
  );
  return client;
}

it("authenticates every MCP request, exposes owner context, and preserves idempotency and operator confirmations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "june-mcp-"));
  const token = randomBytes(32).toString("base64url");
  const key = randomBytes(32);
  const submitted: MessageEvent[] = [];
  let failSubmission = true;
  const serviceOptions = {
    directory,
    key,
    ownerId: "owner",
    clients: [{ id: "amp", token, expiresAt: Date.now() + 60000 }],
    destinations: [],
    submit: async (event: MessageEvent) => {
      submitted.push(event);
      if (failSubmission) throw new Error("ambiguous queue acknowledgement");
    },
    snapshot: async () => state(),
  };
  let service = new AgentService(serviceOptions);
  const operatorToken = randomBytes(32).toString("hex");
  let resumes = 0;
  const app = createHttpApp({
    channels: { agent: service.adapter },
    owner: { id: "owner", identities: [] },
    operatorToken,
    submit: async () => {},
    ready: async () => true,
    inspectConversation: async () => state(),
    inspectJob: async () => null,
    resumeJob: async () => {
      resumes++;
      return true;
    },
  });
  const handler = () =>
    createAgentMcp({
      service,
      origin: "http://localhost",
      status: async () => ({ ready: true }),
      operator: operatorRequest((request) => app.fetch(request), operatorToken),
    });
  let mcp = handler();
  const client = await connect((request) => mcp(request), token);
  t.onTestFinished(async () => {
    await client.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
    "send_webhook",
  );
  const read = await client.callTool({ name: "read_messages", arguments: {} });
  expect(JSON.stringify(read)).toContain("owner private context");
  expect(JSON.stringify(read)).not.toContain(token);
  const request = {
    idempotencyKey: randomUUID(),
    conversationId: "thread",
    text: "exact private request",
  };
  expect(
    (await client.callTool({ name: "send_message", arguments: request }))
      .isError,
  ).toBe(true);
  await service.close();
  failSubmission = false;
  service = new AgentService(serviceOptions);
  mcp = handler();
  const accepted = await client.callTool({
    name: "send_message",
    arguments: request,
  });
  expect(accepted.isError).not.toBe(true);
  expect(submitted).toHaveLength(2);
  expect(submitted[0]).toEqual(submitted[1]); // Same durable event after uncertain queue acknowledgement.
  await client.callTool({ name: "send_message", arguments: request });
  expect(submitted).toHaveLength(2);
  expect(
    (
      await client.callTool({
        name: "send_message",
        arguments: { ...request, text: "changed" },
      })
    ).isError,
  ).toBe(true);
  const jobId = "a".repeat(64);
  const denied = await client.callTool({
    name: "operator_request",
    arguments: { operation: "resume_job", id: jobId },
  });
  expect(JSON.stringify(denied)).toContain("confirm_previous_worker_stopped");
  expect(resumes).toBe(0);
  const resumed = await client.callTool({
    name: "operator_request",
    arguments: {
      operation: "resume_job",
      id: jobId,
      idempotencyKey: randomUUID(),
      body: { confirmedStopped: true },
    },
  });
  expect(JSON.stringify(resumed)).toContain('"queued":true');
  expect(resumes).toBe(1);
  expect(
    (
      await client.callTool({
        name: "operator_request",
        arguments: { operation: "job", id: "../../health" },
      })
    ).isError,
  ).toBe(true);
  expect(
    (await app.request("/webhooks/agent", { method: "POST" })).status,
  ).toBe(404);
  for (const headers of [
    {},
    { authorization: `Bearer ${operatorToken}` },
    { authorization: `Bearer ${token}`, origin: "https://evil.example" },
    { authorization: `Bearer ${token}`, host: "evil.example" },
  ] as Record<string, string>[]) {
    const result = await mcp(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers,
        body: "{}",
      }),
    );
    expect([401, 403]).toContain(result.status);
  }
  const large = await mcp(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: " ".repeat(128 * 1024 + 1),
    }),
  );
  expect(large.status).toBe(413);
  expect(JSON.stringify(service.readAudit())).not.toContain(
    "exact private request",
  );
  await client.callTool({
    name: "revoke_client",
    arguments: { id: "amp", confirmed: true },
  });
  expect(service.authenticate(`Bearer ${token}`)).toBeUndefined();
  await service.close();
  service = new AgentService(serviceOptions);
  expect(service.authenticate(`Bearer ${token}`)).toBeUndefined();
});

it("shares June's owner history and emits each registered reply/action once across duplicate admissions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "june-agent-runtime-"));
  const token = randomBytes(32).toString("base64url");
  const captured: Array<{ body: Buffer; headers: Record<string, string> }> = [];
  const requests: ModelRequest[] = [];
  let service: AgentService;
  let hook: WebhookRegistration & { signingKey?: string };
  const registry = createJuneRegistry({
    owner: {
      id: "owner",
      identities: [
        { channel: "agent", accountId: "owner", senderId: "amp" },
        { channel: "slack", accountId: "T1", senderId: "U1" },
      ],
    },
    channels: {
      agent: {
        channel: "agent",
        capabilities: { text: true, reactions: false, threads: false },
        receive: async () => ({ response: new Response(), events: [] }),
        send: (message) => service.adapter.send(message),
      },
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        receive: async () => ({ response: new Response(), events: [] }),
        send: async () => ({ status: "sent", messageId: "human-reply" }),
      },
    },
    agentActive: (id) => service.clientActive(id),
    webhooks: {
      targets: (conversationId) => service.targets("message", conversationId),
      send: async (id, text, idempotencyKey) =>
        service.webhooks.enqueue("amp", {
          webhookId: id,
          idempotencyKey,
          type: "message",
          payload: { text },
        }),
    },
    model: {
      reply: async (request) => {
        requests.push(request);
        if (!request.agentConversation) return { text: "Remembered." };
        return parseReply(
          JSON.stringify({
            text: `exact reply\n${"x".repeat(4000)}`,
            coding: null,
            reaction: null,
            webhook: { id: hook.id, text: "June initiated this callback" },
          }),
          request.workspaces,
          request.searchAvailable,
          request.webhookIds,
          request.agentConversation,
        );
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "owner"]);
  service = new AgentService(
    {
      directory,
      key: randomBytes(32),
      ownerId: "owner",
      clients: [{ id: "amp", token, expiresAt: Date.now() + 60000 }],
      destinations: [
        { origin: "https://receiver.example", pathPrefix: "/callback" },
      ],
      submit: async (event) => {
        await june.send("inbox", { type: "event", event });
      },
      snapshot: () => june.snapshot(),
    },
    async (request) => {
      request.beforeDispatch();
      captured.push({ body: request.body, headers: request.headers });
      return 202;
    },
  );
  t.onTestFinished(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  await june.send("inbox", {
    type: "event",
    event: {
      id: "human",
      messageId: "human",
      type: "message",
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      senderId: "U1",
      direct: true,
      text: "The shared secret fixture is cedar.",
    },
  });
  await expect.poll(async () => (await june.snapshot()).history.length).toBe(2);
  hook = service.webhooks.register("amp", {
    idempotencyKey: randomUUID(),
    name: "receiver",
    url: "https://receiver.example/callback",
    events: ["reply", "message"],
    conversationId: "thread",
    expiresAt: Date.now() + 60000,
  });
  const input = {
    idempotencyKey: randomUUID(),
    conversationId: "thread",
    text: "What did the human say? Notify the receiver.",
  };
  const admission = await service.sendMessage("amp", input);
  await expect
    .poll(async () => (await service.getMessage(admission.id))?.status)
    .toBe("completed");
  expect(requests).toHaveLength(2);
  expect(
    requests[1]?.messages.some((message) => message.content.includes("cedar")),
  ).toBe(true);
  expect(requests[1]?.system).not.toContain("Use a native reaction alone");
  await service.webhooks.drain();
  expect(captured).toHaveLength(2);
  const bodies = captured.map(({ body }) => JSON.parse(body.toString()));
  expect(bodies.map((body) => body.type).sort()).toEqual(["message", "reply"]);
  expect(bodies.find((body) => body.type === "reply").payload.text).toBe(
    `exact reply\n${"x".repeat(4000)}`,
  );
  for (const capturedRequest of captured) {
    const signature = createHmac(
      "sha256",
      Buffer.from(hook.signingKey ?? "", "base64url"),
    )
      .update(`${capturedRequest.headers["X-June-Timestamp"]}.`)
      .update(capturedRequest.body)
      .digest("hex");
    expect(capturedRequest.headers["X-June-Signature"]).toBe(`v1=${signature}`);
  }
  service.webhooks.register("amp", {
    idempotencyKey: randomUUID(),
    name: "another correlation",
    url: "https://receiver.example/callback",
    events: ["reply"],
    conversationId: "other",
    expiresAt: Date.now() + 60000,
  });
  expect(await service.getMessage(admission.id)).toHaveProperty(
    "callbacks.length",
    2,
  );
  expect(() =>
    parseReply(
      JSON.stringify({
        text: "",
        webhook: { id: randomUUID(), text: "not allowed" },
      }),
      [],
      false,
      [hook.id],
      true,
    ),
  ).toThrow("invalid_response");
  expect(await service.sendMessage("amp", input)).toEqual(admission);
  await service.webhooks.drain();
  expect(captured).toHaveLength(2);
  expect(requests).toHaveLength(2);
  service.webhooks.revoke(hook.id);
  const blocked = service.webhooks.enqueue("amp", {
    webhookId: hook.id,
    idempotencyKey: "after-revoke",
    type: "message",
    payload: { text: "must not send" },
  });
  await service.webhooks.drain();
  expect(service.webhooks.delivery(blocked.id)?.status).toBe("rejected");
  expect(captured).toHaveLength(2);
});
