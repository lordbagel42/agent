import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type { MessageEvent } from "../core/contracts.js";
import { EnvironmentService } from "../environments/service.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import {
  currentExecutionCapabilities,
  executionCapabilities,
} from "./execution-context.js";
import { buildModelRequest } from "./prompt.js";
import { createJuneRegistry, type Dependencies } from "./registry.js";

it("allows environment commands only for granted execution workers and as an exclusive action", () => {
  const directive = {
    text: "",
    environment: { action: "exec", command: "printf 'workspace ready'" },
  };
  const granted = {
    agentRole: "execution" as const,
    environmentAvailable: true,
  };
  expect(replyJsonSchema([], granted).properties).toHaveProperty("environment");
  expect(parseReply(JSON.stringify(directive), [], granted)).toEqual(directive);
  for (const capabilities of [
    {},
    { ...granted, environmentAvailable: false },
    { ...granted, agentRole: "interaction" as const },
    { ...granted, agentRole: "repository" as const },
  ]) {
    expect(replyJsonSchema([], capabilities).properties).not.toHaveProperty(
      "environment",
    );
    expect(() =>
      parseReply(JSON.stringify(directive), [], capabilities),
    ).toThrow();
  }
  for (const extra of [
    { text: "I already ran it" },
    { javascript: "return 1" },
    { environment: { ...directive.environment, owner: "another-agent" } },
  ])
    expect(() =>
      parseReply(JSON.stringify({ ...directive, ...extra }), [], {
        ...granted,
        javascriptAvailable: true,
      }),
    ).toThrow();
});

it("delegates two private workers into separate reusable command environments and tears them down before completion", async (t) => {
  const opened: string[] = [];
  const stopped: string[] = [];
  const destroyed: string[] = [];
  const reports: string[] = [];
  const environments = new EnvironmentService({
    name: "fixture",
    binding: "fixture:original",
    persistence: "worker",
    async connect(owner) {
      opened.push(owner);
      let stored = "empty";
      return {
        async exec(command, output) {
          if (command.startsWith("write ")) stored = command.slice(6);
          else if (command !== "read")
            throw new Error("Unexpected fixture command");
          output("stdout", stored);
          return 0;
        },
        async stop() {
          stopped.push(owner);
        },
      };
    },
    async destroy(owner) {
      destroyed.push(owner);
    },
    async close() {},
  });
  const deps: Dependencies = {
    owner: {
      id: "owner",
      identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
    },
    environments,
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          if (message.content.type === "text")
            reports.push(message.content.text);
          return { status: "sent", messageId: "out" };
        },
      },
    },
    model: {
      async reply(request) {
        expect(request.system).toContain("BoxLite");
        expect(replyJsonSchema([], request).properties).not.toHaveProperty(
          "environment",
        );
        return request.executionAvailable
          ? {
              text: "",
              execution: [
                { agent: "alpha", action: "run", task: "alpha" },
                { agent: "beta", action: "run", task: "beta" },
              ],
            }
          : { text: "Both workers reported their isolated results." };
      },
    },
    execution: {
      model: {
        async reply(request) {
          expect(request.system).toContain("agent-browser");
          const task = request.messages[0]?.content;
          const observations = request.messages.filter((message) =>
            message.content.startsWith("Host tool observation"),
          );
          if (observations.length < 2) {
            expect(request.environmentAvailable).toBe(true);
            return {
              text: "",
              environment: {
                action: "exec",
                command: observations.length ? "read" : `write ${task}`,
              },
            };
          }
          expect(observations.at(-1)?.content).toContain(`"stdout":"${task}"`);
          return { text: `${task} verified its own value` };
        },
      },
    },
  };
  const event: MessageEvent = {
    id: "environment-test",
    type: "message",
    messageId: "1",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    senderId: "U1",
    direct: true,
    metadata: { channelType: "im" },
    text: "Use two workers for isolated command work",
  };
  expect(executionCapabilities(deps, event).environmentAvailable).toBe(true);
  expect(
    currentExecutionCapabilities(deps, event, {}).environmentAvailable,
  ).toBe(false);
  expect(
    executionCapabilities(deps, { ...event, senderId: "guest" })
      .environmentAvailable,
  ).toBe(true);
  expect(
    executionCapabilities(deps, {
      ...event,
      direct: false,
      metadata: { channelType: "channel" },
      address: { ...event.address, conversationId: "C1" },
    }).environmentAvailable,
  ).toBe(true);
  expect(
    executionCapabilities({ ...deps, environments: undefined }, event)
      .environmentAvailable,
  ).toBe(false);
  const { client } = await setupTest(t, createJuneRegistry(deps));
  const conversation = client.conversation.getOrCreate(["private", "owner"]);
  await conversation.send("inbox", { type: "event", event });
  await expect.poll(() => stopped.length, { timeout: 15000 }).toBe(2);
  expect(new Set(opened).size).toBe(2);
  expect(stopped.sort()).toEqual(opened.sort());
  expect(environments.isSettled()).toBe(true);
  await expect
    .poll(() => reports.some((text) => text.includes("Both workers")), {
      timeout: 15000,
    })
    .toBe(true);
  const worker = client.execution.getOrCreate(JSON.parse(opened[0] ?? "[]"));
  await worker.cancel("forget-fixture");
  deps.environments = undefined;
  await expect(worker.cancel("forget-fixture", true)).rejects.toThrow();
  expect(destroyed).toEqual([]);
  deps.environments = new EnvironmentService({
    name: "replacement",
    binding: "fixture:different-home",
    persistence: "worker",
    async connect() {
      throw new Error("No new work requested");
    },
    async destroy(owner) {
      destroyed.push(owner);
    },
    async close() {},
  });
  await expect(worker.cancel("forget-fixture", true)).rejects.toThrow();
  expect(destroyed).toEqual([]);
  deps.environments = environments;
  await worker.cancel("forget-fixture", true);
  await worker.cancel("forget-fixture", true);
  expect(destroyed).toEqual([opened[0]]);
  expect((await worker.summary()).status).toBe("revoked");
});

it.for(["interaction", "execution", "automated"] as const)(
  "includes browser-environment knowledge in the final %s prompt without expanding tool grants",
  (role) => {
    const event: MessageEvent = {
      id: "knowledge",
      type: "message",
      messageId: "1",
      occurredAt: 1,
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      senderId: "U1",
      direct: true,
      metadata: { channelType: "im" },
      text: "Check a local page",
    };
    const request = buildModelRequest({
      event,
      history: [],
      liveInput: true,
      now: new Date(1000),
      models: { current: { provider: "fixture", model: "fixture" } },
      owner: {
        id: "owner",
        identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
      },
      agentRole: role === "execution" ? "execution" : "interaction",
      capabilities: { environmentAvailable: true },
      ...(role === "automated"
        ? {
            wakeup: {
              runId: "run",
              jobId: "job",
              instruction: "Report status",
              event: {
                id: "trigger",
                source: "github",
                type: "push",
                occurredAt: 1,
                data: {},
              },
            },
          }
        : {}),
    });
    expect(request.system).toContain("BoxLite");
    expect(request.system).toContain("agent-browser");
    expect(request.system).toContain('inspection:"sandboxes"');
    expect(request.system).toContain("sandboxes.raygen.dev");
    expect(request.environmentAvailable).toBe(role !== "automated");
    expect(
      Object.hasOwn(replyJsonSchema([], request).properties, "environment"),
    ).toBe(role === "execution");
    if (role !== "automated")
      expect(request.system).not.toContain(
        "Browser work is unavailable in this turn",
      );
  },
);
