import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type { MessageEvent } from "../core/contracts.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { AMP_THREAD_HELP, createAmpThreads } from "./amp-threads.js";
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
    { ...event, text: "## ignored" },
    {
      ...event,
      address: { ...event.address, channel: "whatsapp" as const },
    },
    {
      ...event,
      senderId: "U2",
      direct: false,
      metadata: { channelType: "channel" as const },
    },
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
    scopeKey: ["private", "owner"],
    address: event.address,
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

const taskOwner = {
  id: "owner",
  identities: [
    { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    { channel: "slack" as const, accountId: "T2", senderId: "U1" },
  ],
};
const taskEvent: MessageEvent = {
  id: "task",
  type: "message",
  messageId: "123.4",
  occurredAt: 1,
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  senderId: "U1",
  direct: true,
  metadata: { channelType: "im" },
  text: "Spawn an Amp thread to compare the parsers",
};
const taskCommand = {
  action: "create" as const,
  title: "Compare parsers",
  prompt: "Compare A and B",
};

async function queueTask(
  directory: string,
  service: ReturnType<typeof createAmpThreads>,
  event: MessageEvent,
) {
  const count = async () =>
    (await readdir(directory)).filter((name) => name.endsWith(".task.json"))
      .length;
  const before = await count();
  const stopped = new AbortController();
  const pending = service.run(
    taskCommand,
    event,
    "operation",
    stopped.signal,
    () => true,
  );
  try {
    await Promise.race([pending, expect.poll(count).toBe(before + 1)]);
  } finally {
    stopped.abort();
  }
  return pending;
}

it.for([
  { channelType: "im", conversationId: "D2", senderId: "U2" },
  { channelType: "channel", conversationId: "C1", senderId: "U2" },
  { channelType: "mpim", conversationId: "G1", senderId: "U2" },
  { channelType: "group", conversationId: "G2", senderId: "U2" },
  { channelType: "channel", conversationId: "C1", senderId: "bot:B1" },
] as const)(
  "binds a guest $channelType task by $senderId to its sender and exact source",
  async (surface, t) => {
    const directory = await mkdtemp(join(tmpdir(), "june-amp-guest-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const service = createAmpThreads({ directory, owner: taskOwner });
    const event: MessageEvent = {
      ...taskEvent,
      senderId: surface.senderId,
      direct: surface.channelType === "im",
      botMentioned: true,
      metadata: { channelType: surface.channelType },
      address: {
        ...taskEvent.address,
        conversationId: surface.conversationId,
        threadId: "123.4",
      },
    };
    const receipt = await queueTask(directory, service, event);
    const saved = JSON.parse(
      await readFile(join(directory, `${receipt.id}.task.json`), "utf8"),
    );
    expect(saved).toMatchObject({
      ownerRequest: event.text,
      scopeKey: [
        "guest",
        "slack",
        "T1",
        surface.conversationId,
        "123.4",
        surface.senderId,
      ],
      address: event.address,
      reporter: {
        channel: "slack",
        accountId: "T1",
        senderId: surface.senderId,
        isOwner: false,
      },
    });
    await writeFile(
      join(directory, `${receipt.id}.receipt.json`),
      JSON.stringify({
        id: receipt.id,
        status: "completed",
        threadId: "T-12345678-1234-4234-8234-123456789abc",
        result: { text: "Private task result", truncated: false },
      }),
      { mode: 0o600 },
    );
    const resumed = createAmpThreads({ directory, owner: taskOwner });
    const signal = new AbortController().signal;
    const inspect = { action: "inspect" as const, id: receipt.id };
    expect(
      await resumed.run(
        inspect,
        { ...event, id: "follow-up" },
        "read",
        signal,
        () => true,
      ),
    ).toMatchObject({
      status: "completed",
      url: "https://ampcode.com/threads/T-12345678-1234-4234-8234-123456789abc",
      result: { text: "Private task result", truncated: false },
    });
    for (const denied of [
      { ...event, senderId: "U3" },
      { ...event, senderId: "U1" },
      { ...event, address: { ...event.address, accountId: "T2" } },
      { ...event, address: { ...event.address, conversationId: "C9" } },
      { ...event, address: { ...event.address, threadId: "456.7" } },
      { ...event, address: { ...event.address, threadId: undefined } },
    ])
      await expect(
        resumed.run(inspect, denied, "read", signal, () => true),
      ).rejects.toThrow("scope");
    expect(
      await resumed.run(taskCommand, event, "operation", signal, () => true),
    ).toMatchObject({ id: receipt.id, status: "completed" });
    expect((await readdir(directory)).sort()).toEqual([
      `${receipt.id}.receipt.json`,
      `${receipt.id}.task.json`,
    ]);
  },
);

it("separates identical operation/event IDs across source scopes, including merged owner DMs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "june-amp-scopes-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const service = createAmpThreads({ directory, owner: taskOwner });
  const events: MessageEvent[] = [
    taskEvent,
    { ...taskEvent, address: { ...taskEvent.address, conversationId: "D2" } },
    { ...taskEvent, address: { ...taskEvent.address, threadId: "123.4" } },
    { ...taskEvent, address: { ...taskEvent.address, accountId: "T2" } },
    { ...taskEvent, senderId: "U2" },
  ];
  const ids = [];
  const signal = new AbortController().signal;
  for (const event of events) {
    const receipt = await queueTask(directory, service, event);
    ids.push(receipt.id);
    await writeFile(
      join(directory, `${receipt.id}.receipt.json`),
      JSON.stringify({ id: receipt.id, status: "unknown" }),
      { mode: 0o600 },
    );
    expect(
      await service.run(taskCommand, event, "operation", signal, () => true),
    ).toMatchObject({ id: receipt.id, status: "unknown" });
    for (const other of events.filter((candidate) => candidate !== event))
      await expect(
        service.run(
          { action: "inspect", id: receipt.id },
          other,
          "read",
          signal,
          () => true,
        ),
      ).rejects.toThrow("scope");
  }
  expect(new Set(ids).size).toBe(events.length);
  expect((await readdir(directory)).length).toBe(events.length * 2);
});

it("retains legacy owner receipts only in the private owner scope and never republishes them", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "june-amp-legacy-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const service = createAmpThreads({ directory, owner: taskOwner });
  // UUID from the legacy owner/event/operation hash, before source binding.
  const id = "5f07ce8d-80e2-517f-a847-54a3850f5db1";
  const legacy = {
    kind: "amp-task",
    id,
    title: taskCommand.title,
    prompt: taskCommand.prompt,
    ownerRequest: taskEvent.text,
    reporter: {
      channel: "slack",
      accountId: "T1",
      senderId: "U1",
      isOwner: true,
    },
  };
  const path = join(directory, `${id}.task.json`);
  const bytes = JSON.stringify(legacy);
  await writeFile(path, bytes, { mode: 0o600 });
  await writeFile(
    join(directory, `${id}.receipt.json`),
    JSON.stringify({ id, status: "unknown" }),
    { mode: 0o600 },
  );
  const signal = new AbortController().signal;
  const inspect = { action: "inspect" as const, id };
  expect(
    await service.run(inspect, taskEvent, "read", signal, () => true),
  ).toMatchObject({ id, status: "unknown" });
  for (const denied of [
    { ...taskEvent, senderId: "U2" },
    {
      ...taskEvent,
      direct: false,
      metadata: { channelType: "channel" as const },
    },
    { ...taskEvent, direct: false, metadata: { channelType: "mpim" as const } },
  ])
    await expect(
      service.run(inspect, denied, "read", signal, () => true),
    ).rejects.toThrow("scope");
  expect(
    await service.run(taskCommand, taskEvent, "operation", signal, () => true),
  ).toMatchObject({ id, status: "unknown" });
  await expect(
    service.run(
      { ...taskCommand, prompt: "Changed task" },
      taskEvent,
      "operation",
      signal,
      () => true,
    ),
  ).rejects.toThrow("conflict");
  expect(await readFile(path, "utf8")).toBe(bytes);
  expect((await readdir(directory)).sort()).toEqual([
    `${id}.receipt.json`,
    `${id}.task.json`,
  ]);
  // Partial new provenance must never fall back to legacy owner authority.
  for (const changed of [
    { ...legacy, address: taskEvent.address },
    { ...legacy, scopeKey: ["private", "owner"] },
    { ...legacy, address: null, scopeKey: null },
    { ...legacy, reporter: { ...legacy.reporter, isOwner: false } },
    { ...legacy, reporter: { ...legacy.reporter, senderId: "U2" } },
  ]) {
    await writeFile(path, JSON.stringify(changed), { mode: 0o600 });
    await expect(
      service.run(inspect, taskEvent, "read", signal, () => true),
    ).rejects.toThrow("scope");
  }
});

it("takes a guest channel conversation through June's execution tool to a real durable request and returned link without MCP", async (t) => {
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
    messageId: "123.4",
    occurredAt: Date.now(),
    address: {
      channel: "slack",
      accountId: "T1",
      conversationId: "C1",
      threadId: "123.4",
    },
    senderId: "U2",
    direct: false,
    botMentioned: true,
    metadata: { channelType: "channel" },
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
        expect(request.system).toContain(AMP_THREAD_HELP);
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
          expect(request.system).toContain(AMP_THREAD_HELP);
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
    expect(request.system).toContain(AMP_THREAD_HELP);
    expect(request.ampThreadsAvailable).toBe(!automated);
    expect(
      Object.hasOwn(replyJsonSchema([], request).properties, "ampThread"),
    ).toBe(role === "execution");
  }
  const { client } = await setupTest(t, createJuneRegistry(deps));
  const scopeKey = ["guest", "slack", "T1", "C1", "123.4", "U2"];
  const conversation = client.conversation.getOrCreate(scopeKey);
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
    scopeKey,
    address: event.address,
    reporter: { senderId: "U2", isOwner: false },
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
