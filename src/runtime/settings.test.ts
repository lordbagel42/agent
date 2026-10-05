import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { parseConfig } from "../config.js";
import type { MessageEvent } from "../core/contracts.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { SettingsStore } from "../settings/store.js";
import type { CapabilityContext } from "./capabilities.js";
import { runExecutionCapability } from "./execution-capabilities.js";
import {
  currentExecutionCapabilities,
  executionCapabilities,
} from "./execution-context.js";
import { buildModelRequest } from "./prompt.js";
import { createJuneRegistry, type Dependencies } from "./registry.js";

it("admits settings only as an exclusive granted execution action", () => {
  const directive = { text: "", settings: { action: "inspect" } };
  const granted = { agentRole: "execution" as const, settingsAvailable: true };
  expect(replyJsonSchema([], granted).properties).toHaveProperty("settings");
  // The raw schema must work for both Responses and Anthropic structured output;
  // bounds stay enforced by local parsing, not unsupported provider keywords.
  expect(
    JSON.stringify(replyJsonSchema([], granted).properties.settings),
  ).not.toMatch(
    /"(?:\$schema|oneOf|minimum|maximum|minItems|maxItems|pattern)":/,
  );
  expect(parseReply(JSON.stringify(directive), [], granted)).toEqual(directive);
  for (const capabilities of [
    {},
    { ...granted, settingsAvailable: false },
    { ...granted, agentRole: "interaction" as const },
    { ...granted, agentRole: "repository" as const },
  ]) {
    expect(replyJsonSchema([], capabilities).properties).not.toHaveProperty(
      "settings",
    );
    expect(() =>
      parseReply(JSON.stringify(directive), [], capabilities),
    ).toThrow();
  }
  for (const extra of [{ text: "Already applied" }, { javascript: "return 1" }])
    expect(() =>
      parseReply(JSON.stringify({ ...directive, ...extra }), [], {
        ...granted,
        javascriptAvailable: true,
      }),
    ).toThrow();
});

it("teaches every prompt path pending activation without granting automated changes", () => {
  for (const role of ["interaction", "execution", "automated"] as const) {
    const request = buildModelRequest({
      event: {
        id: "settings",
        type: "message",
        messageId: "1",
        occurredAt: 1,
        address: { channel: "slack", accountId: "T1", conversationId: "D1" },
        senderId: "U1",
        direct: true,
        metadata: { channelType: "im" },
        text: "Inspect settings",
      },
      history: [],
      liveInput: true,
      now: new Date(1000),
      models: { current: { provider: "fixture", model: "fixture" } },
      owner: {
        id: "owner",
        identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
      },
      agentRole: role === "execution" ? "execution" : "interaction",
      capabilities: { settingsAvailable: true },
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
    expect(request.system.includes("Settings operating knowledge")).toBe(true);
    expect(request.system.includes("pending next authorized activation")).toBe(
      true,
    );
    expect(
      Object.hasOwn(replyJsonSchema([], request).properties, "settings"),
    ).toBe(role === "execution");
  }
});

it("lets June inspect then save and reset through a real delegated worker without hot reload", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "june-settings-worker-"));
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const base = parseConfig({
    setupMode: true,
    owner: { id: "owner", identities: [] },
    model: {
      protocol: "openai",
      model: "fixture",
      apiKeyEnv: "UNUSED",
      timeoutMs: 21000,
    },
  });
  const settings = new SettingsStore({
    path: join(directory, "settings.sqlite"),
    base,
  });
  t.onTestFinished(async () => {
    settings.close();
    await rm(directory, { recursive: true, force: true });
  });
  let action: "update" | "reset" = "update";
  let inspected = false;
  const reports: string[] = [];
  const deps: Dependencies = {
    owner,
    settings,
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
        return request.executionAvailable
          ? {
              text: "",
              execution: [
                {
                  agent: "preferences",
                  action: "run",
                  task: "Inspect and save the requested preference",
                },
              ],
            }
          : { text: "Settings receipt recorded." };
      },
    },
    execution: {
      model: {
        async reply(request) {
          if (!request.settingsAvailable)
            return { text: "Settings action sequence finished." };
          const receipt = request.messages.findLast(
            (message) =>
              message.content.startsWith("Host tool observation") &&
              message.content.includes('"status":"inspected"'),
          );
          if (!inspected) {
            inspected = true;
            return { text: "", settings: { action: "inspect" } };
          }
          expect(receipt).toBeDefined();
          return {
            text: "",
            settings:
              action === "update"
                ? {
                    action,
                    expectedVersion: 0,
                    changes: [{ key: "model.timeoutMs", value: 35000 }],
                  }
                : { action, expectedVersion: 1, keys: ["model.timeoutMs"] },
          };
        },
      },
    },
  };
  const event: MessageEvent = {
    id: "settings-update",
    type: "message",
    messageId: "1",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    senderId: "U1",
    direct: true,
    metadata: { channelType: "im" },
    text: "Save my model timeout preference",
  };
  expect(executionCapabilities(deps, event).settingsAvailable).toBe(true);
  expect(currentExecutionCapabilities(deps, event, {}).settingsAvailable).toBe(
    false,
  );
  for (const other of [
    { ...event, senderId: "guest" },
    { ...event, direct: false, metadata: { channelType: "mpim" as const } },
    { ...event, direct: false, metadata: { channelType: "channel" as const } },
  ])
    expect(executionCapabilities(deps, other).settingsAvailable).not.toBe(true);
  const { client } = await setupTest(t, createJuneRegistry(deps));
  const context: CapabilityContext = {
    event,
    eventId: event.id,
    scope: { key: ["private", "owner"], private: true },
    audience: "owner",
    origin: "event",
    phase: "reply",
    ownerTurn: true,
    deletionRevision: 0,
    personalityVersion: undefined,
    workspaces: [],
    signal: new AbortController().signal,
    valid: () => true,
    model: deps.model,
    deps,
    ports: {} as CapabilityContext["ports"], // No other capability may run here.
  };
  const input = {
    system: "",
    messages: [],
    workspaces: [],
    agentRole: "execution" as const,
    settingsAvailable: true,
  };
  const update = {
    text: "",
    settings: {
      action: "update" as const,
      expectedVersion: 0,
      changes: [{ key: "model.timeoutMs" as const, value: 99000 }],
    },
  };
  // Even a forged valid directive/grant must not bypass host provenance or drain.
  for (const change of [
    { event: { ...event, senderId: "guest" } },
    {
      event: {
        ...event,
        direct: false,
        metadata: { channelType: "mpim" as const },
      },
    },
    {
      event: {
        ...event,
        direct: false,
        metadata: { channelType: "channel" as const },
      },
    },
    { origin: "wakeup" as const },
    { origin: "execution_result" as const },
    { phase: "synthesis" as const },
    { ownerTurn: false },
    { valid: () => false },
    { signal: AbortSignal.abort() },
    { canStartAction: () => false },
  ]) {
    await expect(
      runExecutionCapability(
        update,
        input,
        { ...context, ...change },
        deps,
        client as Parameters<typeof runExecutionCapability>[4],
        [],
        async () => {
          throw new Error("Unexpected private delivery");
        },
      ),
    ).rejects.toThrow();
    expect(settings.run({ action: "inspect" }).version).toBe(0);
  }
  const conversation = client.conversation.getOrCreate(["private", "owner"]);
  await conversation.send("inbox", { type: "event", event });
  await expect
    .poll(() => settings.run({ action: "inspect" }).version, { timeout: 15000 })
    .toBe(1);
  await expect
    .poll(() => reports.includes("Settings receipt recorded."), {
      timeout: 15000,
    })
    .toBe(true);
  expect(settings.effective.model.timeoutMs).toBe(21000);
  expect(settings.run({ action: "inspect" }).pendingActivation).toEqual([
    "model.timeoutMs",
  ]);
  action = "reset";
  inspected = false;
  await conversation.send("inbox", {
    type: "event",
    event: {
      ...event,
      id: "settings-reset",
      messageId: "2",
      text: "Reset my model timeout preference",
    },
  });
  await expect
    .poll(() => settings.run({ action: "inspect" }).version, { timeout: 15000 })
    .toBe(2);
  await expect
    .poll(
      () =>
        reports.filter((report) => report === "Settings receipt recorded.")
          .length,
      { timeout: 15000 },
    )
    .toBe(2);
  expect(settings.run({ action: "inspect" }).pendingActivation).toEqual([]);
});
