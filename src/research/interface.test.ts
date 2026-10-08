import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import type { MessageEvent, ModelRequest } from "../core/contracts.js";
import { EvidenceStore } from "../memory/store.js";
import {
  createModelProvider,
  parseReply,
  replyJsonSchema,
} from "../models/provider.js";
import {
  currentExecutionCapabilities,
  executionCapabilities,
} from "../runtime/execution-context.js";
import {
  type ConversationInput,
  conversationInputId,
} from "../runtime/inbox.js";
import { defaultGlobalPersonality } from "../runtime/personality.js";
import { buildModelRequest, type PromptInput } from "../runtime/prompt.js";
import type { Dependencies } from "../runtime/registry.js";
import { createSessionCatalog, type SessionHost } from "../sessions/catalog.js";

const start = {
  action: "start",
  id: null,
  goal: "Find public museum opening hours with official source URLs.",
  connections: ["public-search"],
  intervalMinutes: null,
  dailyBatches: null,
  offset: 0,
};
const capabilities = { researchAvailable: true };
const event: MessageEvent = {
  type: "message",
  id: "event",
  messageId: "1800000000.000001",
  senderId: "U1",
  direct: true,
  text: "Keep researching public museum opening hours.",
  occurredAt: 1800000000000,
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  metadata: { channelType: "im" },
};
const model = { reply: async () => ({ text: "" }) };
const deps: Dependencies = {
  owner: {
    id: "owner",
    identities: [
      { channel: "slack", accountId: "T1", senderId: "U1" },
      { channel: "whatsapp", accountId: "phone", senderId: "U1" },
    ],
  },
  channels: {},
  model,
  research: { model },
};
const input: PromptInput = {
  event,
  owner: deps.owner,
  history: [],
  now: new Date(event.occurredAt),
  models: { current: { provider: "test", model: "test" } },
  capabilities,
};

it("validates strict research scope, identity and bounded limits without silently editing a session", () => {
  const parse = (research: unknown) =>
    parseReply(JSON.stringify({ text: "", research }), [], capabilities);
  expect(parse({ ...start, goal: `  ${start.goal}  ` }).research).toEqual(
    start,
  );
  expect(
    parse({ ...start, goal: "g".repeat(3000), connections: [] }).research,
  ).toBeDefined();
  for (const action of ["list", "inspect", "pause", "resume", "stop"]) {
    const command = {
      ...start,
      action,
      id: action === "list" ? null : "a".repeat(64),
      goal: null,
      connections: [],
    };
    expect(parse(command).research).toEqual(command);
    for (const change of [
      { goal: "different scope" },
      { connections: ["another"] },
      { intervalMinutes: 5 },
      { dailyBatches: 48 },
      { id: action === "list" ? "a".repeat(64) : null },
    ])
      expect(() => parse({ ...command, ...change })).toThrow();
  }
  for (const change of [
    { intervalMinutes: 1, dailyBatches: 1, offset: 0 },
    { intervalMinutes: 1440, dailyBatches: 200, offset: 1000000 },
    { connections: Array.from({ length: 8 }, (_, i) => `${i}`.repeat(256)) },
  ])
    expect(() => parse({ ...start, ...change })).not.toThrow();
  for (const change of [
    { action: "rename" },
    { name: "Not part of the contract" },
    { id: "a".repeat(64) },
    { goal: null },
    { goal: " \n " },
    { goal: "g".repeat(3001) },
    { connections: ["same", "same"] },
    { connections: [""] },
    { connections: ["c".repeat(257)] },
    { connections: Array.from({ length: 9 }, (_, i) => `${i}`) },
    { intervalMinutes: 0 },
    { intervalMinutes: 1441 },
    { intervalMinutes: 1.5 },
    { dailyBatches: 0 },
    { dailyBatches: 201 },
    { dailyBatches: 1.5 },
    { offset: -1 },
    { offset: 1000001 },
    { offset: 0.5 },
  ])
    expect(() => parse({ ...start, ...change })).toThrow();
  for (const id of ["a".repeat(63), "a".repeat(65), "g".repeat(64)])
    expect(() =>
      parse({ ...start, action: "inspect", id, goal: null, connections: [] }),
    ).toThrow();
  for (const key of Object.keys(start)) {
    const incomplete = { ...start };
    Reflect.deleteProperty(incomplete, key);
    expect(() => parse(incomplete)).toThrow();
  }
});

it("keeps research exclusive and empty-text, and filters required fields with role grants", () => {
  const grants = {
    ...capabilities,
    webSearchAvailable: true,
    turnTakingAvailable: true,
    executionAvailable: true,
  };
  for (const change of [
    { text: "started" },
    { webSearch: "public opening hours" },
    { reaction: "wave" },
    { coding: { workspace: "garden", goal: "another task" } },
    { messages: ["started"] },
    { question: { prompt: "Which?", options: ["one", "two"] } },
    { execution: [{ agent: "other", action: "run", task: "another task" }] },
  ])
    expect(() =>
      parseReply(
        JSON.stringify({ text: "", research: start, ...change }),
        ["garden"],
        grants,
      ),
    ).toThrow();
  expect(parseReply('{"text":"ok","research":null}', [], capabilities)).toEqual(
    { text: "ok" },
  );
  for (const agentRole of [
    undefined,
    "execution",
    "interaction",
    "repository",
  ] as const) {
    const scoped = { ...capabilities, agentRole };
    const schema = replyJsonSchema([], scoped);
    expect(schema.required.sort()).toEqual(
      Object.keys(schema.properties).sort(),
    );
    if (agentRole === "interaction" || agentRole === "repository") {
      expect(schema.properties).not.toHaveProperty("research");
      for (const research of [start, null])
        expect(() =>
          parseReply(JSON.stringify({ text: "", research }), [], scoped),
        ).toThrow();
    } else {
      expect(schema.properties).toHaveProperty("research");
      const command = Reflect.get(schema.properties, "research");
      if (!command) throw new Error("Missing research schema");
      expect(command.required.sort()).toEqual(
        Object.keys(command.properties).sort(),
      );
      expect(command.additionalProperties).toBe(false);
      expect(
        parseReply(JSON.stringify({ text: "", research: start }), [], scoped)
          .research,
      ).toEqual(start);
    }
  }
  expect(replyJsonSchema([]).properties).not.toHaveProperty("research");
});

it("admits research on configured routes without owner-private eligibility and intersects the saved ceiling", () => {
  expect(executionCapabilities(deps, event).researchAvailable).toBe(true);
  expect(
    executionCapabilities({ ...deps, research: undefined }, event)
      .researchAvailable,
  ).toBe(false);
  expect(currentExecutionCapabilities(deps, event, {}).researchAvailable).toBe(
    false,
  );
  expect(
    currentExecutionCapabilities(deps, event, capabilities).researchAvailable,
  ).toBe(true);
  expect(
    currentExecutionCapabilities(
      { ...deps, research: undefined },
      event,
      capabilities,
    ).researchAvailable,
  ).not.toBe(true);
  for (const change of [
    { senderId: "guest" },
    { metadata: undefined },
    { direct: false, metadata: { channelType: "channel" as const } },
    {
      senderId: "guest",
      direct: false,
      botMentioned: true,
      metadata: { channelType: "channel" as const },
    },
    {
      senderId: "guest",
      direct: false,
      metadata: { channelType: "mpim" as const },
    },
    {
      address: {
        channel: "whatsapp" as const,
        accountId: "phone",
        conversationId: "dm",
      },
    },
  ]) {
    const source = { ...event, ...change };
    expect(executionCapabilities(deps, source).researchAvailable).toBe(true);
    const request = buildModelRequest({
      ...input,
      event: source,
      agentRole: "execution",
    });
    expect(request.researchAvailable).toBe(true);
    expect(
      parseReply(JSON.stringify({ text: "", research: start }), [], request)
        .research,
    ).toEqual(start);
  }
  for (const source of [
    { ...event, senderId: "guest", metadata: undefined },
    {
      ...event,
      senderId: "guest",
      direct: false,
      metadata: { channelType: "channel" as const },
    },
    {
      ...event,
      senderId: "guest",
      direct: true,
      metadata: { channelType: "mpim" as const },
    },
    { ...event, address: { ...event.address, accountId: "other" } },
  ]) {
    expect(executionCapabilities(deps, source).researchAvailable).not.toBe(
      true,
    );
    // Unadmitted input has no prompt at all, rather than a tool-less prompt.
    expect(() =>
      buildModelRequest({
        ...input,
        event: source,
        agentRole: "execution",
      }),
    ).toThrow("Prompt requires an authorized event");
  }
  const report = buildModelRequest({
    ...input,
    agentRole: "execution",
    capabilities: {},
  });
  expect(report.researchAvailable).toBe(false);
  expect(replyJsonSchema([], report).properties).not.toHaveProperty("research");
});

it.for([
  "legacy",
  "interaction",
  "execution",
  "watch",
  "decision",
  "report",
  "synthesis",
] as const)(
  "carries generic research knowledge into %s without promoting it to authority",
  (role) => {
    const automated = role === "watch" || role === "decision";
    const available = !automated && role !== "report" && role !== "synthesis";
    const request = buildModelRequest({
      ...input,
      ...(role === "report"
        ? { agentRole: "execution" as const, capabilities: {} }
        : {}),
      ...(role === "synthesis" ? { webResults: [] } : {}),
      ...(role === "interaction" || role === "execution"
        ? { agentRole: role }
        : {}),
      ...(automated
        ? {
            wakeup: {
              ...(role === "decision" ? { mode: "decision" as const } : {}),
              runId: "run",
              jobId: "job",
              instruction: "Observe",
              event: {
                id: "tick",
                source: "timer",
                type: "due",
                occurredAt: 1,
                data: {},
              },
            },
          }
        : {}),
    });
    expect(request.system).toContain("host-owned background timer");
    expect(request.system).toContain("explicit intent for ongoing research");
    expect(request.system).toContain("one-off");
    expect(request.system).toContain("no-progress backoff");
    expect(request.system).toContain("Raw MCP");
    expect(request.researchAvailable).toBe(available);
    if (!available || role === "interaction") {
      expect(replyJsonSchema([], request).properties).not.toHaveProperty(
        "research",
      );
      expect(request.system).not.toContain("research:{action:");
    } else {
      expect(replyJsonSchema([], request).properties).toHaveProperty(
        "research",
      );
      expect(request.system).toContain("research:{action:");
    }
    if (role === "interaction") expect(request.system).toContain('"research"');
  },
);

it.for(["event", "job_result", "execution_result", "wakeup"] as const)(
  "projects activity research capability only from live messages, not %s authority",
  async (kind, t) => {
    const store = new EvidenceStore(":memory:", randomBytes(32));
    t.onTestFinished(() => store.close());
    const received: ConversationInput =
      kind === "event"
        ? { type: kind, event }
        : kind === "job_result"
          ? {
              type: kind,
              source: event,
              jobId: "job",
              attempt: 1,
              text: "Done",
            }
          : kind === "execution_result"
            ? {
                type: kind,
                source: event,
                agentId: "worker",
                requestId: "task",
              }
            : {
                type: kind,
                source: event,
                wakeup: {
                  runId: "run",
                  jobId: "job",
                  instruction: "Observe",
                  event: {
                    id: "tick",
                    source: "timer",
                    type: "due",
                    occurredAt: 1,
                    data: {},
                  },
                },
              };
    const id = conversationInputId(received);
    const key = ["private", "owner"];
    const host: SessionHost = {
      key,
      state: {
        history: [],
        events: {},
        deliveries: {},
        lastInbound: {},
        jobs: {},
        ...(received.type === "event"
          ? { pendingInputs: { [id]: event } }
          : { pendingNotifications: { [id]: received } }),
        ingress: {
          sequence: 1,
          receivedThrough: 100,
          receipts: {
            [id]: {
              sequence: 1,
              receivedAt: 100,
              kind: kind === "event" ? "message" : "notification",
              lane: "session",
            },
          },
        },
        migration: {
          phase: "sessions",
          scope: JSON.stringify(key),
          epoch: "a".repeat(64),
          barrier: "b".repeat(64),
          legacyInputs: [],
          archivedInputs: [],
          barrierObserved: true,
        },
      },
      persist: async () => {},
      personality: async () => defaultGlobalPersonality,
      publish: async () => {},
      enqueue: async () => {},
      schedule: async () => {},
      publishNative: async () => {},
      wakeupContext: async () => ({ evidenceIds: [], retentionTracked: true }),
      claimWakeup: async () => true,
      completeWakeup: async () => {},
      worker: () => ({
        summary: async () => ({ pending: 0, evidenceIds: [] }),
        result: async () => ({
          status: "completed",
          task: "research",
          report: "Done",
          evidenceIds: [],
        }),
        submit: async () => true,
        cancel: async () => {},
        recordCodingResult: async () => {},
      }),
    };
    const catalog = createSessionCatalog(
      {
        ...deps,
        sessions: { idleMs: 1000 },
        memory: { store, source: () => undefined },
      },
      () => true,
      () => "test",
    );
    await catalog.pump(host);
    const turn = host.state.sessions?.turns[id];
    if (!turn) throw new Error("Missing assignment");
    const prepared = await catalog.prepare(host, turn.assignment, []);
    if ("control" in prepared) throw new Error("Unexpected control turn");
    expect(prepared.request.researchAvailable).toBe(kind === "event");
    expect(prepared.request.system).toContain("host-owned background timer");
    expect(prepared.request.system).not.toContain("research:{action:");
    expect(replyJsonSchema([], prepared.request).properties).not.toHaveProperty(
      "research",
    );
  },
);

it.for(["openai", "anthropic"] as const)(
  "keeps %s MCP read ceilings and observations host-only",
  async (protocol) => {
    const bodies: string[] = [];
    const provider = createModelProvider({
      protocol,
      model: "test",
      apiKey: "test",
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));
        return Response.json(
          protocol === "openai"
            ? {
                status: "completed",
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: '{"text":"ok"}' }],
                  },
                ],
              }
            : {
                type: "message",
                role: "assistant",
                stop_reason: "end_turn",
                content: [{ type: "text", text: '{"text":"ok"}' }],
              },
        );
      },
    });
    const request: ModelRequest = {
      system: "test",
      messages: [],
      workspaces: [],
      mcpReadScope: { connections: ["HOST-ONLY-CONNECTION"] },
      onMcpObservation: () => {
        throw new Error("Provider must not invoke host observer");
      },
    };
    await provider.reply(request);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain("HOST-ONLY-CONNECTION");
    expect(bodies[0]).not.toContain("mcpReadScope");
    expect(bodies[0]).not.toContain("onMcpObservation");
  },
);
