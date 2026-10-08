import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type { MessageEvent } from "../core/contracts.js";
import { createHttpApp } from "../http/app.js";
import { parseReply } from "../models/provider.js";
import { executionCapabilities } from "../runtime/execution-context.js";
import { createInspectionReader } from "../runtime/inspection.js";
import { createJuneRegistry, type Dependencies } from "../runtime/registry.js";
import { createBoxLiteProvider } from "./boxlite.js";
import { EnvironmentService } from "./service.js";

it("reads only metadata and hides rootfs paths in all retained policy generations", async () => {
  const forbidden = async (): Promise<never> => {
    throw new Error("Inspection attempted a lifecycle operation");
  };
  const provider = createBoxLiteProvider(
    {
      get: forbidden,
      create: forbidden,
      remove: forbidden,
      shutdown: forbidden,
      async listInfo() {
        return [
          "rootfs:/private/image",
          "rootfs:./private/image",
          "registry.example/browser:v1",
        ].map((image, index) => ({
          id: `box-${index}`,
          name: `june-${"a".repeat(32)}-${"b".repeat(16)}`,
          image,
          cpus: 2,
          memoryMib: 2048,
          createdAt: "2026-10-05T00:00:00Z",
          state: { status: "stopped", running: false, exitCode: 0 },
          autoStop: 0,
          autoDelete: 0,
          autoResume: false,
          healthStatus: { state: "None" as const, failures: 0 },
          network: null,
        }));
      },
    },
    { image: "registry.example/new-policy:v2", allowedHosts: [] },
    {
      binding: "fixture",
      retain: forbidden,
      retained: forbidden,
      confirmRemoved: forbidden,
      witness: forbidden,
      close: forbidden,
    },
  );
  const result = await provider.inspect?.();
  expect(result?.map((box) => box.image)).toEqual([
    "Managed browser image",
    "Managed browser image",
    "registry.example/browser:v1",
  ]);
  expect(JSON.stringify(result)).not.toContain("private/image");
});

it("inspects leases and uncertain cleanup without retaining commands, output or worker keys", async () => {
  const service = new EnvironmentService({
    name: "boxlite",
    binding: "private-storage-binding",
    persistence: "worker",
    async connect() {
      return {
        async exec(_command, output) {
          output("stdout", "private-output");
          return 7;
        },
        async stop() {
          throw new Error("private-host-path");
        },
      };
    },
    async inspect() {
      return [];
    },
    async destroy() {},
    async close() {},
  });
  await service.run(
    "private-worker-key",
    { action: "exec", command: "private-command" },
    new AbortController().signal,
  );
  expect((await service.inspect()).leases[0]?.state).toBe("active");
  await expect(service.release("private-worker-key")).rejects.toThrow();
  const snapshot = await service.inspect();
  expect(snapshot.leases[0]?.state).toBe("needs_review");
  expect(snapshot.activity.map((entry) => entry.kind)).toEqual([
    "cleanup_unknown",
    "command_failed",
    "opening",
  ]);
  expect(snapshot.activity[1]?.exitCode).toBe(7);
  for (const secret of [
    "private-worker-key",
    "private-storage-binding",
    "private-command",
    "private-output",
    "private-host-path",
  ])
    expect(JSON.stringify(snapshot)).not.toContain(secret);
});

it("gives the dashboard credential only snapshot reads, never operator authority", async () => {
  const operatorToken = "fixture-operator-token-longer-than-32-characters";
  const readToken = createHmac("sha256", operatorToken)
    .update("june:sandboxes:read:v1")
    .digest("base64url");
  const app = createHttpApp({
    operatorToken,
    owner: { id: "owner", identities: [] },
    channels: {},
    async sandboxes() {
      return { status: "disabled" };
    },
    async submit() {},
    async ready() {
      return true;
    },
    async inspectConversation() {
      return { private: true };
    },
    async inspectJob() {},
    async resumeJob() {
      return false;
    },
  });
  expect((await app.request("/sandboxes/snapshot")).status).toBe(401);
  const headers = { authorization: `Bearer ${readToken}` };
  const response = await app.request("/sandboxes/snapshot", { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "disabled" });
  expect(
    (await app.request("/operator/conversation", { headers })).status,
  ).toBe(401);
  expect(
    (await app.request("/sandboxes/snapshot", { method: "POST", headers }))
      .status,
  ).not.toBe(200);
});

it("makes the same sandbox observations available to authorized June workers", async () => {
  const directive = { text: "", inspection: "sandboxes" };
  expect(
    parseReply(JSON.stringify(directive), [], {
      agentRole: "execution",
      inspectionAvailable: true,
    }),
  ).toEqual(directive);
  expect(() =>
    parseReply(JSON.stringify(directive), [], {
      agentRole: "execution",
      inspectionAvailable: false,
    }),
  ).toThrow();
  const inspect = createInspectionReader({
    audience: "owner",
    selections: {},
    sandboxes: async () => ({
      status: "disabled",
      observedAt: "2026-10-05T12:00:00Z",
    }),
  });
  expect(await inspect("sandboxes")).toContain('"status":"disabled"');
});

it("dispatches sandbox inspection through a worker and also grants it to admitted guest and shared tasks", async (t) => {
  let reads = 0;
  let observed = false;
  const deps: Dependencies = {
    owner: {
      id: "owner",
      identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
    },
    channels: {},
    inspection: createInspectionReader({
      audience: "owner",
      selections: {},
      sandboxes: async () => {
        reads++;
        return { status: "disabled" };
      },
    }),
    model: {
      async reply(request) {
        return request.executionAvailable
          ? {
              text: "",
              execution: [
                {
                  agent: "observer",
                  action: "run",
                  task: "Inspect sandbox metadata",
                },
              ],
            }
          : { text: "Inspection finished" };
      },
    },
    execution: {
      model: {
        async reply(request) {
          expect(request.inspectionAvailable).toBe(true);
          const result = request.messages.find((message) =>
            message.content.startsWith("Host tool observation"),
          );
          if (!result) return { text: "", inspection: "sandboxes" };
          expect(result.content).toContain('"status":"disabled"');
          observed = true;
          return { text: "The provider is disabled in this process." };
        },
      },
    },
  };
  const event: MessageEvent = {
    id: "sandbox-inspection",
    type: "message",
    messageId: "1",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    senderId: "U1",
    direct: true,
    metadata: { channelType: "im" },
    text: "Inspect sandbox metadata",
  };
  expect(executionCapabilities(deps, event).inspectionAvailable).toBe(true);
  expect(
    executionCapabilities(deps, { ...event, senderId: "guest" })
      .inspectionAvailable,
  ).toBe(true);
  expect(
    executionCapabilities(deps, {
      ...event,
      direct: false,
      metadata: { channelType: "channel" },
      address: { ...event.address, conversationId: "C1" },
    }).inspectionAvailable,
  ).toBe(true);
  expect(
    executionCapabilities({ ...deps, inspection: undefined }, event)
      .inspectionAvailable,
  ).toBe(false);
  const { client } = await setupTest(t, createJuneRegistry(deps));
  await client.conversation
    .getOrCreate(["private", "owner"])
    .send("inbox", { type: "event", event });
  await expect.poll(() => observed, { timeout: 15000 }).toBe(true);
  expect(reads).toBe(1);
});
