import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type { MessageEvent } from "../core/contracts.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { createAmpThreads } from "./amp-threads.js";
import {
  currentExecutionCapabilities,
  executionCapabilities,
} from "./execution-context.js";
import { buildModelRequest } from "./prompt.js";
import { createJuneRegistry, type Dependencies } from "./registry.js";

it("exposes Amp requests without MCP but rejects missing grants, other roles and combined effects", () => {
  const directive = {
    text: "",
    ampThread: {
      action: "create",
      title: "Compare parsers",
      prompt: "Compare A and B",
    },
  };
  const granted = {
    agentRole: "execution" as const,
    ampThreadsAvailable: true,
  };
  expect(replyJsonSchema([], granted).properties).toHaveProperty("ampThread");
  expect(parseReply(JSON.stringify(directive), [], granted)).toEqual(directive);
  for (const reply of [
    { text: "No thread needed" },
    { text: "", javascript: { source: "return 1", inputJson: "null" } },
  ])
    expect(
      parseReply(
        JSON.stringify({ ...reply, coding: null, ampThread: null }),
        [],
        { ...granted, javascriptAvailable: true },
      ),
    ).toEqual(reply);
  expect(() =>
    parseReply(JSON.stringify({ text: "Hello", ampThread: null }), [], {
      ...granted,
      agentRole: "interaction",
    }),
  ).toThrow();
  for (const capabilities of [
    {},
    { ...granted, ampThreadsAvailable: false },
    { ...granted, agentRole: "interaction" as const },
    { ...granted, agentRole: "repository" as const },
  ]) {
    expect(replyJsonSchema([], capabilities).properties).not.toHaveProperty(
      "ampThread",
    );
    expect(() =>
      parseReply(JSON.stringify(directive), [], capabilities),
    ).toThrow();
  }
  for (const extra of [
    { text: "Already launched" },
    { javascript: { source: "return 1", inputJson: "null" } },
    { ampThread: { ...directive.ampThread, directory: "/another-checkout" } },
  ])
    expect(() =>
      parseReply(JSON.stringify({ ...directive, ...extra }), [], {
        ...granted,
        javascriptAvailable: true,
      }),
    ).toThrow();
});

it("queues one immutable owner task, preserves it on cancellation and reads a late result after restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "june-amp-task-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const service = createAmpThreads({ directory, owner });
  const event: MessageEvent = {
    id: "task",
    type: "message",
    messageId: "1",
    occurredAt: 1,
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    senderId: "U1",
    direct: true,
    metadata: { channelType: "im" },
    text: "Spawn an Amp thread to compare the parsers",
  };
  const command = {
    action: "create" as const,
    title: "Compare parsers",
    prompt: "Compare A and B",
  };
  const signal = new AbortController().signal;
  for (const denied of [
    { ...event, senderId: "U2" },
    { ...event, direct: false, metadata: { channelType: "mpim" as const } },
  ])
    await expect(
      service.run(command, denied, "operation", signal, () => true),
    ).rejects.toThrow();
  await expect(
    service.run(command, event, "operation", signal, () => false),
  ).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
  // Cancel only the foreground observer once its private request exists.
  const stopped = new AbortController();
  const pending = service.run(
    command,
    event,
    "operation",
    stopped.signal,
    () => true,
  );
  await expect
    .poll(async () =>
      (await readdir(directory)).some((name) => name.endsWith(".json")),
    )
    .toBe(true);
  stopped.abort();
  const receipt = await pending;
  expect(receipt.status).toBe("queued");
  expect(await readdir(directory)).toEqual([`${receipt.id}.task.json`]);
  const saved = JSON.parse(
    await readFile(join(directory, `${receipt.id}.task.json`), "utf8"),
  );
  expect(saved).toMatchObject({
    kind: "amp-task",
    prompt: "Compare A and B",
    ownerRequest: event.text,
    reporter: { isOwner: true },
  });
  expect(saved).not.toHaveProperty("data");
  await expect(
    service.run(
      { ...command, prompt: "A different task" },
      event,
      "operation",
      signal,
      () => true,
    ),
  ).rejects.toThrow("conflict");
  const threadId = "T-12345678-1234-4234-8234-123456789abc";
  await writeFile(
    join(directory, `${receipt.id}.receipt.json`),
    JSON.stringify({
      id: receipt.id,
      status: "completed",
      threadId,
      result: {
        text: "Parser A rejects nested input; B accepts it.",
        truncated: false,
      },
    }),
    { mode: 0o600 },
  );
  const resumed = createAmpThreads({ directory, owner });
  expect(
    await resumed.run(
      { action: "inspect", id: receipt.id },
      event,
      "read",
      signal,
      () => true,
    ),
  ).toMatchObject({
    status: "completed",
    url: `https://ampcode.com/threads/${threadId}`,
    result: {
      text: "Parser A rejects nested input; B accepts it.",
      truncated: false,
    },
  });
  expect(
    await resumed.run(command, event, "operation", signal, () => true),
  ).toMatchObject({ id: receipt.id, threadId });
  expect((await readdir(directory)).sort()).toEqual([
    `${receipt.id}.receipt.json`,
    `${receipt.id}.task.json`,
  ]);
});

it("takes an owner conversation through June's execution tool to a real durable request and returned link without MCP", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "june-amp-workflow-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const threadId = "T-12345678-1234-4234-8234-123456789abc";
  const url = `https://ampcode.com/threads/${threadId}`;
  const delivered: string[] = [];
  const event: MessageEvent = {
    id: "amp-workflow",
    type: "message",
    messageId: "1",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    senderId: "U1",
    direct: true,
    metadata: { channelType: "im" },
    text: "Spawn an Amp thread to compare parsers A and B",
  };
  const deps: Dependencies = {
    owner,
    ampThreads: createAmpThreads({ directory, owner }),
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          if (message.content.type === "text")
            delivered.push(message.content.text);
          return { status: "sent", messageId: "out" };
        },
      },
    },
    model: {
      async reply(request) {
        expect(request.system).toContain("without Amp OAuth");
        expect(replyJsonSchema([], request).properties).not.toHaveProperty(
          "ampThread",
        );
        if (request.executionAvailable)
          return {
            text: "",
            execution: [{ agent: "amp", action: "run", task: event.text }],
          };
        expect(request.ampThreadsAvailable).toBe(false);
        expect(request.system).toContain(url);
        return { text: url };
      },
    },
    execution: {
      model: {
        async reply(request) {
          if (request.ampThreadsAvailable) {
            expect(request.mcpAvailable).not.toBe(true);
            return {
              text: "",
              ampThread: {
                action: "create",
                title: "Compare parsers",
                prompt: "Compare parsers A and B",
              },
            };
          }
          const observation = request.messages.find((message) =>
            message.content.startsWith("Host tool observation"),
          );
          expect(observation?.content).toContain(threadId);
          return { text: url };
        },
      },
    },
  };
  expect(executionCapabilities(deps, event).ampThreadsAvailable).toBe(true);
  expect(
    currentExecutionCapabilities(deps, event, {}).ampThreadsAvailable,
  ).toBe(false);
  for (const role of [
    "interaction",
    "execution",
    "decision",
    "watch",
  ] as const) {
    const automated = role === "decision" || role === "watch";
    const request = buildModelRequest({
      event,
      history: [],
      liveInput: !automated,
      now: new Date(),
      owner,
      models: { current: { provider: "fixture", model: "fixture" } },
      capabilities: { ampThreadsAvailable: true },
      ...(automated
        ? {
            wakeup: {
              runId: "r",
              jobId: "j",
              instruction: "Observe",
              event: {
                id: "e",
                source: "github",
                type: "push",
                occurredAt: 1,
                data: {},
              },
              ...(role === "decision" ? { mode: "decision" as const } : {}),
            },
          }
        : { agentRole: role }),
    });
    expect(request.system).toContain("without Amp OAuth");
    expect(request.ampThreadsAvailable).toBe(!automated);
    expect(
      Object.hasOwn(replyJsonSchema([], request).properties, "ampThread"),
    ).toBe(role === "execution");
  }
  const { client } = await setupTest(t, createJuneRegistry(deps));
  const conversation = client.conversation.getOrCreate(["private", "owner"]);
  await conversation.send("inbox", { type: "event", event });
  await expect
    .poll(
      async () =>
        (await readdir(directory)).filter((name) => name.endsWith(".task.json"))
          .length,
      { timeout: 15000 },
    )
    .toBe(1);
  const name = (await readdir(directory)).find((name) =>
    name.endsWith(".task.json"),
  );
  const saved = JSON.parse(
    await readFile(join(directory, name ?? "missing"), "utf8"),
  );
  expect(saved).toMatchObject({
    kind: "amp-task",
    ownerRequest: event.text,
    prompt: "Compare parsers A and B",
  });
  await writeFile(
    join(directory, `${saved.id}.receipt.json`),
    JSON.stringify({ id: saved.id, status: "running", threadId }),
    { mode: 0o600 },
  );
  await expect.poll(() => delivered, { timeout: 15000 }).toContain(url);
  await conversation.send("inbox", { type: "event", event });
  expect(
    (await readdir(directory)).filter((name) => name.endsWith(".task.json")),
  ).toHaveLength(1);
});
