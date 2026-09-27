import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { createConsoleLoginLinks } from "../console/session.js";
import type {
  ChannelAdapter,
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
  ReactionEvent,
  SendResult,
} from "../core/contracts.js";
import {
  createDeploymentReader,
  createReleaseTool,
  type DeploymentFeed,
} from "../deployment/feed.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { UsageLedger } from "../models/usage.js";
import { createLifecycle } from "./lifecycle.js";
import { createJuneRegistry } from "./registry.js";

const owner = {
  id: "raygen",
  identities: [
    { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    { channel: "whatsapp" as const, accountId: "P1", senderId: "15551234" },
  ],
};
const message: MessageEvent = {
  id: "Ev1",
  type: "message",
  messageId: "123.456",
  occurredAt: Date.now(),
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  senderId: "U1",
  direct: true,
  text: "My favorite bird is the heron.",
};

function conversationText(request: ModelRequest | undefined) {
  return request?.messages.map(({ role, content }) => ({
    role,
    content: JSON.parse(content).text,
  }));
}

function transport(
  channel: "slack" | "whatsapp",
  sent: OutboundMessage[],
  outcome: SendResult | ((message: OutboundMessage) => SendResult) = {
    status: "sent",
    messageId: "out1",
  },
): ChannelAdapter {
  return {
    channel,
    capabilities: { text: true, reactions: true, threads: channel === "slack" },
    async receive() {
      return { response: new Response(), events: [] };
    },
    // Serialize at the transport boundary, just like the real HTTP adapters.
    // Rivet's write-through state proxy is not structuredClone-compatible.
    async send(outbound) {
      sent.push(JSON.parse(JSON.stringify(outbound)) as OutboundMessage);
      return typeof outcome === "function" ? outcome(outbound) : outcome;
    },
  };
}

describe("Rivet conversation workflow", () => {
  it("only proposes browser mutations in owner-private turns and rejects mixed or forged authority", async (t) => {
    const sent: OutboundMessage[] = [];
    const requests: ModelRequest[] = [];
    const proposed: (string | null)[] = [];
    let directive: CompanionReply = {
      text: "",
      browserProposal: { operation: null },
    };
    let search = false;
    const registry = createJuneRegistry({
      owner,
      channels: { slack: transport("slack", sent) },
      browserProposal(operation) {
        proposed.push(operation);
        return "PRIVATE exact proposal; nothing ran";
      },
      webSearch: {
        available: true,
        description: "fixture",
        async search() {
          return { status: "ready", results: [] };
        },
      },
      model: {
        async reply(request) {
          requests.push(request);
          expect(
            Object.hasOwn(
              replyJsonSchema([], request).properties,
              "browserProposal",
            ),
          ).toBe(request.browserProposalAvailable === true);
          if (search && request.webSearchAvailable)
            return { text: "", webSearch: "public query" };
          // Return forged directives too: host must revalidate custom providers.
          return directive;
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const deliver = async (
      id: string,
      extra: Partial<MessageEvent> = {},
      key = ["private", "raygen"],
    ) => {
      const actor = client.conversation.getOrCreate(key);
      const done = Object.values((await actor.snapshot()).events).filter(
        (event) => event.done,
      ).length;
      await actor.send("inbox", {
        type: "event",
        event: { ...message, id, messageId: id, ...extra },
      });
      await expect
        .poll(
          async () =>
            Object.values((await actor.snapshot()).events).filter(
              (event) => event.done,
            ).length,
          { timeout: 5000 },
        )
        .toBe(done + 1);
    };
    await deliver("browser-list");
    expect(proposed).toEqual([null]);
    expect(requests[0]?.system).toContain(
      "Separate authenticated human approval",
    );
    directive = { text: "", browserProposal: { operation: "fill-note" } };
    expect(parseReply(JSON.stringify(directive), [], requests[0])).toEqual(
      directive,
    );
    await deliver("browser-propose");
    expect(proposed).toEqual([null, "fill-note"]);
    directive = { ...directive, reaction: "thumbsup" };
    await deliver("browser-mixed");
    directive = {
      text: "",
      browserProposal: { operation: "fill-note", ...{ grant: true } },
    };
    await deliver("browser-forged");
    directive = { text: "", browserProposal: { operation: "fill-note" } };
    for (const [id, extra, key] of [
      ["browser-public", { direct: false }, ["slack", "T1", "D1", ""]],
      [
        "browser-guest",
        { senderId: "U2", metadata: { channelType: "im" } },
        ["guest", "slack", "T1", "D1", "", "U2"],
      ],
    ] as const) {
      await deliver(id, extra, [...key]);
      expect(requests.at(-1)?.browserProposalAvailable).not.toBe(true);
      expect(JSON.stringify(sent.at(-1)?.content)).not.toContain("PRIVATE");
    }
    search = true;
    await deliver("browser-synthesis");
    expect(requests.at(-1)?.browserProposalAvailable).toBe(false);
    expect(proposed).toEqual([null, "fill-note"]);
    expect(() => parseReply(JSON.stringify(directive), [])).toThrow();
  });

  it("lets June issue login links only in owner-private turns, never public or synthesis turns", async (t) => {
    const links = createConsoleLoginLinks("https://june.example");
    const sent: OutboundMessage[] = [];
    const requests: ModelRequest[] = [];
    let search = false;
    const registry = createJuneRegistry({
      owner,
      channels: { slack: transport("slack", sent) },
      dashboardLogin: links,
      webSearch: {
        available: true,
        description: "fixture",
        async search() {
          return {
            status: "ready",
            results: [
              {
                title: "fixture",
                url: "https://example.com",
                snippet: "public evidence",
              },
            ],
          };
        },
      },
      model: links.wrapModel({
        async reply(request) {
          requests.push(request);
          if (search && request.webSearchAvailable)
            return { text: "", webSearch: "public query" };
          if (request.dashboardLoginAvailable) {
            expect(replyJsonSchema([], request).properties).toHaveProperty(
              "dashboardLogin",
            );
            return parseReply('{"text":"","dashboardLogin":true}', [], request);
          }
          expect(replyJsonSchema([], request).properties).not.toHaveProperty(
            "dashboardLogin",
          );
          // Even a provider ignoring the schema cannot mint a private login link.
          return { text: "", dashboardLogin: true };
        },
      }),
    });
    const { client } = await setupTest(t, registry);
    const deliver = async (
      id: string,
      extra: Partial<MessageEvent> = {},
      key = ["private", "raygen"],
    ) => {
      const actor = client.conversation.getOrCreate(key);
      const done = Object.values((await actor.snapshot()).events).filter(
        (event) => event.done,
      ).length;
      await actor.send("inbox", {
        type: "event",
        event: {
          ...message,
          id,
          messageId: id,
          text: "Give me a dashboard login link",
          ...extra,
        },
      });
      await expect
        .poll(
          async () =>
            Object.values((await actor.snapshot()).events).filter(
              (event) => event.done,
            ).length,
        )
        .toBe(done + 1);
    };
    await deliver("login-link");
    const text = JSON.stringify(sent[0]?.content ?? "");
    const url = text.match(/https:\/\/june\.example\/([A-Za-z0-9_-]{24})/);
    expect(url).not.toBeNull();
    expect(links.has(url?.[1] ?? "")).toBe(true);
    expect(requests).toHaveLength(1);
    await deliver("login-followup", { text: `Can you repeat ${url?.[0]}?` });
    expect(JSON.stringify(requests.at(-1))).not.toContain(url?.[1]);
    // The delivery record still holds the actual link; model history does not.
    expect(JSON.stringify(sent[0]?.content)).toContain(url?.[0]);
    await deliver(
      "public-link",
      { direct: false, address: { ...message.address, conversationId: "C1" } },
      ["slack", "T1", "C1", ""],
    );
    expect(JSON.stringify(sent.at(-1)?.content)).not.toContain(
      "https://june.example/",
    );
    expect(requests.at(-1)?.dashboardLoginAvailable).toBe(false);
    await deliver(
      "guest-link",
      { senderId: "U2", metadata: { channelType: "im" } },
      ["guest", "slack", "T1", "D1", "", "U2"],
    );
    expect(JSON.stringify(sent.at(-1)?.content)).not.toContain(
      "https://june.example/",
    );
    search = true;
    await deliver("synthesis-link");
    expect(requests.at(-1)?.dashboardLoginAvailable).toBe(false);
    expect(JSON.stringify(sent.at(-1)?.content)).not.toContain(
      "https://june.example/",
    );
    expect(() => parseReply('{"text":"","dashboardLogin":true}', [])).toThrow();
    expect(() =>
      parseReply(
        '{"text":"","dashboardLogin":true,"analytics":{"days":7}}',
        [],
        { dashboardLoginAvailable: true, analyticsAvailable: true },
      ),
    ).toThrow();
  });

  it("reads analytics once through June and denies public, guest, synthesis and failed reads without leaking data", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "june-analytics-"));
    const usage = new UsageLedger(join(directory, "usage.sqlite"));
    const memory = new EvidenceStore(":memory:", randomBytes(32));
    t.onTestFinished(async () => {
      usage.close();
      memory.close();
      await rm(directory, { recursive: true, force: true });
    });
    memory.retrieve("private-audience", "SECRET MEMORY QUERY");
    expect(() =>
      memory.retrieve("private-audience", "SECRET FAILED QUERY", { limit: 0 }),
    ).toThrow();
    await usage.track(
      { provider: "codex", model: "private-model-name", stage: "fast" },
      async (report) => {
        report({
          input: 113,
          output: 29,
          cached: 17,
          cacheWrite: null,
          reasoning: 11,
        });
      },
    );
    await usage.track(
      { provider: "codex", model: "private-model-name", stage: "deep" },
      async () => {},
    );
    const sent: OutboundMessage[] = [];
    const requests: ModelRequest[] = [];
    let reads = 0;
    let fail = false;
    let search = false;
    const registry = createJuneRegistry({
      owner,
      channels: { slack: transport("slack", sent) },
      webSearch: {
        available: true,
        description: "fixture",
        async search() {
          return {
            status: "ready",
            results: [
              {
                title: "fixture",
                url: "https://example.com",
                snippet: "public evidence",
              },
            ],
          };
        },
      },
      model: {
        async reply(request) {
          requests.push(request);
          if (search && request.webSearchAvailable)
            return { text: "", webSearch: "public query" };
          if (request.analyticsAvailable) {
            expect(request.system).toContain(
              "inspect your own token analytics",
            );
            expect(request.system).toContain("memory retrieval timing");
            expect(replyJsonSchema([], request).properties).toHaveProperty(
              "analytics",
            );
            return parseReply(
              '{"text":"","analytics":{"days":7}}',
              [],
              request,
            );
          }
          expect(replyJsonSchema([], request).properties).not.toHaveProperty(
            "analytics",
          );
          // Nonconforming providers must not bypass the host gate.
          return { text: "", analytics: { days: 7 } };
        },
      },
      analytics: (days) => {
        reads++;
        if (fail) throw new Error("private database path and secret");
        return `${usage.report(days)}\n\n${memory.operationReport()}`;
      },
    });
    const { client } = await setupTest(t, registry);
    const deliver = async (
      id: string,
      extra: Partial<MessageEvent> = {},
      key = ["private", "raygen"],
    ) => {
      const actor = client.conversation.getOrCreate(key);
      const done = Object.values((await actor.snapshot()).events).filter(
        (event) => event.done,
      ).length;
      await actor.send("inbox", {
        type: "event",
        event: {
          ...message,
          id,
          messageId: id,
          text: "Show your usage analytics for the last seven days",
          ...extra,
        },
      });
      await expect
        .poll(
          async () =>
            Object.values((await actor.snapshot()).events).filter(
              (event) => event.done,
            ).length,
        )
        .toBe(done + 1);
    };
    await deliver("usage");
    const report = JSON.stringify(sent[0]?.content);
    expect(report).toContain("input tokens: 113 (1/2 calls reporting)");
    expect(report).toContain("output tokens: 29 (1/2 calls reporting)");
    expect(report).toContain("cache writes: unknown");
    expect(report).toContain("remaining balance: unavailable");
    expect(report).not.toContain("private-model-name");
    expect(report).toContain("Memory operation snapshot");
    expect(report).toContain('\\"calls\\":2,\\"completed\\":1,\\"failed\\":1');
    expect(report).toContain("not the selected usage day window");
    expect(report).not.toContain("SECRET");
    expect(report).not.toContain("private-audience");
    expect(report.length).toBeLessThan(3500);
    expect(reads).toBe(1);
    expect(requests).toHaveLength(1);
    await deliver(
      "public-usage",
      { direct: false, address: { ...message.address, conversationId: "C1" } },
      ["slack", "T1", "C1", ""],
    );
    expect(JSON.stringify(sent[1]?.content)).toContain("owner-private turn");
    expect(reads).toBe(1);
    await deliver(
      "guest-usage",
      { senderId: "U2", metadata: { channelType: "im" } },
      ["guest", "slack", "T1", "D1", "", "U2"],
    );
    expect(reads).toBe(1);
    fail = true;
    await deliver("failed-usage");
    expect(JSON.stringify(sent.at(-1)?.content)).toContain(
      "Usage analytics are unavailable",
    );
    expect(JSON.stringify(sent)).not.toContain("private database path");
    expect(reads).toBe(2);
    fail = false;
    search = true;
    await deliver("synthesis-usage");
    expect(requests.at(-1)?.analyticsAvailable).toBe(false);
    expect(reads).toBe(2);
    for (const action of [
      { days: 0 },
      { days: 365 },
      { days: 7, model: "private" },
    ]) {
      expect(() =>
        parseReply(JSON.stringify({ text: "", analytics: action }), [], {
          analyticsAvailable: true,
        }),
      ).toThrow();
    }
    expect(() =>
      parseReply('{"text":"","analytics":{"days":7}}', []),
    ).toThrow();
    expect(() =>
      parseReply('{"text":"","analytics":{"days":7},"latency":"recent"}', [], {
        analyticsAvailable: true,
        latencyAvailable: true,
      }),
    ).toThrow();
  });

  it("excludes ## from queued events and legacy/prefill context while delivering advisory rules on later turns", async (t) => {
    const requests: ModelRequest[] = [];
    const sent: OutboundMessage[] = [];
    const registry = createJuneRegistry({
      owner,
      channels: {
        slack: {
          ...transport("slack", sent),
          async context(event) {
            return [
              {
                role: "user",
                content: "## ignored prefill",
                source: { ...event, id: "prefill", messageId: "122.456" },
              },
            ];
          },
        },
      },
      model: {
        async reply(request) {
          requests.push(structuredClone(request));
          return { text: "" };
        },
      },
    });
    const actorConfig = registry.config.use.conversation.config;
    if (!("state" in actorConfig)) throw new Error("Expected initial state");
    Object.assign(actorConfig.state, {
      history: [
        { id: "legacy", role: "user", content: "## ignored legacy" },
        {
          id: "legacy:reply",
          role: "assistant",
          content: "## ignored old assistant",
        },
      ],
      events: {
        legacy: {
          event: { ...message, text: "## ignored legacy" },
          done: true,
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(["private", "raygen"]);
    for (const [id, text, botMentioned] of [
      ["ignored", "## <@U_BOT> !stop", true],
      ["stop", "<@U_BOT> !stop", true],
      ["next", "new request after stop", false],
    ] as const) {
      await june.send("inbox", {
        type: "event",
        event: {
          ...message,
          id,
          messageId: id === "stop" ? "124.456" : "125.456",
          address: { ...message.address, threadId: "123.000" },
          text,
          botMentioned,
        },
      });
    }
    await expect
      .poll(
        async () =>
          Object.values((await june.snapshot()).events).filter(
            (record) => record.done,
          ).length,
        { timeout: 15_000 },
      )
      .toBe(3);
    expect(requests).toHaveLength(2);
    expect(conversationText(requests[0])).toEqual([
      { role: "user", content: "<@U_BOT> !stop" },
    ]);
    expect(conversationText(requests[1])?.at(-1)).toEqual({
      role: "user",
      content: "new request after stop",
    });
    expect(JSON.stringify(requests)).not.toContain("ignored");
    expect(requests[0]?.system).toContain('"botMentioned":true');
    expect(requests[1]?.system).toContain('"botMentioned":false');
    for (const request of requests) {
      expect(request.system).toContain("Slack participation guidance");
      expect(request.system).toContain("!stop");
      expect(request.system).toContain("<!subteam^");
      expect(request.system).toContain("raw text begins with <>");
    }
    expect(sent).toEqual([]);
  });

  it.for([
    { direct: true, thread: undefined, choice: undefined, want: undefined },
    { direct: false, thread: undefined, choice: false, want: undefined },
    { direct: false, thread: undefined, choice: true, want: "123.456" },
    { direct: true, thread: "older-root", choice: false, want: undefined },
    { direct: false, thread: "older-root", choice: true, want: "older-root" },
    { direct: true, thread: "older-root", choice: null, want: "older-root" },
  ])(
    "lets June choose Slack reply placement ($direct/$thread/$choice)",
    async (scenario, t) => {
      const sent: OutboundMessage[] = [];
      const requests: ModelRequest[] = [];
      const source: MessageEvent = {
        ...message,
        direct: scenario.direct,
        address: {
          ...message.address,
          conversationId: scenario.direct ? "D1" : "C1",
          ...(scenario.thread ? { threadId: scenario.thread } : {}),
        },
      };
      const registry = createJuneRegistry({
        owner,
        channels: { slack: transport("slack", sent) },
        model: {
          async reply(request) {
            requests.push(request);
            return parseReply(
              JSON.stringify({ text: "Here.", replyInThread: scenario.choice }),
              [],
              request,
            );
          },
        },
      });
      const { client } = await setupTest(t, registry);
      const june = client.conversation.getOrCreate(
        scenario.direct
          ? ["private", "raygen"]
          : ["slack", "T1", "C1", scenario.thread ?? ""],
      );
      await june.send("inbox", { type: "event", event: source });
      await expect.poll(() => sent.length).toBe(1);
      expect(requests[0]?.replyPlacementAvailable).toBe(true);
      expect(sent[0]?.content).toEqual({ type: "text", text: "Here." });
      expect(sent[0]?.address).toEqual({
        ...source.address,
        threadId: scenario.want,
      });
    },
  );

  it("lets June inspect the model pool only in an owner-private turn", async (t) => {
    const sent: OutboundMessage[] = [];
    let inspections = 0;
    const registry = createJuneRegistry({
      owner,
      channels: { slack: transport("slack", sent) },
      model: {
        async reply(request) {
          if (request.modelStatusAvailable) {
            expect(request.system).toContain("modelStatus");
            return parseReply('{"text":"","modelStatus":true}', [], request);
          }
          expect(() =>
            parseReply('{"text":"","modelStatus":true}', [], request),
          ).toThrow();
          return { text: "", modelStatus: true };
        },
      },
      modelStatus: () => {
        inspections++;
        return "Hot Codex: idle 2, active 1; prewarm completion unknown.";
      },
    });
    const { client } = await setupTest(t, registry);
    const privateChat = client.conversation.getOrCreate(["private", "raygen"]);
    await privateChat.send("inbox", { type: "event", event: message });
    await expect.poll(() => sent.length).toBe(1);
    expect(JSON.stringify(sent[0]?.content)).toContain("idle 2, active 1");
    const publicChat = client.conversation.getOrCreate([
      "slack",
      "T1",
      "C1",
      "",
    ]);
    await publicChat.send("inbox", {
      type: "event",
      event: {
        ...message,
        id: "pool-public",
        direct: false,
        botMentioned: true,
        address: { ...message.address, conversationId: "C1" },
      },
    });
    await expect.poll(() => sent.length).toBe(2);
    expect(JSON.stringify(sent[1]?.content)).not.toContain("idle 2");
    expect(inspections).toBe(1);
  });

  it("dispatches release inspection for owner DMs and channels, never guests", async (t) => {
    const sent: OutboundMessage[] = [];
    const requests: ModelRequest[] = [];
    const revision = "b".repeat(40);
    const running = "c".repeat(40);
    const directory = await mkdtemp(join(tmpdir(), "june-release-tool-"));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, "events.json");
    const read = createDeploymentReader({
      file,
      ownerId: owner.id,
      trustedUid: process.getuid?.(),
    });
    const feed: DeploymentFeed = {
      version: 1,
      repository: "lordbagel42/agent",
      branch: "main",
      lastHealthyRevision: "a".repeat(40),
      repositorySnapshot: {
        observedAt: 1500,
        revision,
        totalCommitCount: 73,
        commits: [
          {
            revision,
            title: "fix(private): inspect repository metadata",
            description: "Owner-only commit description.",
            truncated: false,
          },
        ],
      },
      blocked: false,
      events: [],
    };
    const directive: NonNullable<CompanionReply["release"]> = {
      action: "inspect",
      revision,
    };
    const registry = createJuneRegistry({
      owner,
      channels: { slack: transport("slack", sent) },
      model: {
        async reply(request) {
          requests.push(request);
          if (!request.releaseAvailable) {
            expect(replyJsonSchema([], request).properties).not.toHaveProperty(
              "release",
            );
            // A nonconforming provider must not bypass owner authentication.
            return { text: "", release: directive };
          }
          expect(replyJsonSchema([], request).properties).toHaveProperty(
            "release",
          );
          return parseReply(
            JSON.stringify({
              text: "",
              release: directive,
              replyInThread: request.replyPlacementAvailable ? true : null,
            }),
            [],
            request,
          );
        },
      },
      release: createReleaseTool({
        read: () => read(owner.id),
        runningRevision: running,
      }),
    });
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(["private", "raygen"]);
    const scenarios = [
      {
        status: "received",
        reason: null,
        expected: "Last recorded candidate status: received",
      },
      {
        status: "failed",
        reason: "preflight_failed",
        expected: "Preparation/preflight failed",
      },
      {
        status: "blocked",
        reason: "unsafe_rollback",
        expected: "Operator forward recovery required",
      },
      {
        status: "deferred",
        reason: "drain_busy",
        expected: "Controller defers",
      },
      {
        status: "healthy",
        reason: null,
        expected: "Last recorded candidate status: healthy",
      },
      {
        status: "fetch_failed",
        reason: "fetch_failed",
        expected: "Last recorded candidate status: healthy",
      },
    ] as const;
    for (const [index, scenario] of scenarios.entries()) {
      feed.blocked = scenario.status === "blocked";
      feed.events.push({
        sequence: index + 1,
        revision,
        status: scenario.status,
        reason: scenario.reason,
        at: 2000 + index,
        committedAt: 1000,
        elapsedMs: index,
      });
      await writeFile(file, JSON.stringify(feed), { mode: 0o640 });
      await june.send("inbox", {
        type: "event",
        event: {
          ...message,
          id: `release-${index}`,
          messageId: `123.${index}`,
          text: `Inspect release ${revision}`,
        },
      });
      await expect
        .poll(
          async () =>
            Object.values((await june.snapshot()).events).filter(
              (event) => event.done,
            ).length,
        )
        .toBe(index + 1);
      const content = sent[index]?.content;
      expect(content?.type).toBe("text");
      if (content?.type !== "text") throw new Error("Missing release receipt");
      expect(content.text).toContain(scenario.expected);
      expect(content.text).toContain(`Running revision: ${running}`);
      expect(content.text).not.toContain(`Running revision: ${revision}`);
      expect(content.text).not.toContain(
        `Running revision: ${feed.lastHealthyRevision}`,
      );
      expect(content.text).toContain("not individual check logs");
      expect(content.text).toContain("Total commit count: 73");
      expect(content.text).toContain("Owner-only commit description.");
      expect(content.text).toContain(
        "fix(private): inspect repository metadata",
      );
      expect([...content.text].length).toBeLessThanOrEqual(4096);
    }
    expect(requests[0]?.system).toContain("Deployment tracking");
    expect(requests[0]?.system).toContain("total commit count");
    expect(JSON.stringify(sent[0]?.content)).not.toContain("request recorded");
    expect(JSON.stringify(sent[4]?.content)).toContain(
      "Controller verified this revision healthy at",
    );
    expect(JSON.stringify(sent[4]?.content)).toContain(
      "Exact revision matches running process: no",
    );
    await rm(file);
    await june.send("inbox", {
      type: "event",
      event: { ...message, id: "unavailable", messageId: "123.9" },
    });
    await expect.poll(async () => sent.length).toBe(7);
    expect(JSON.stringify(sent[6]?.content)).toContain(
      "Controller feed unavailable",
    );
    expect(JSON.stringify(sent[6]?.content)).toContain(
      `Running revision: ${running}`,
    );
    await writeFile(file, JSON.stringify(feed), { mode: 0o640 });
    const channel = client.conversation.getOrCreate(["slack", "T1", "C1", ""]);
    await channel.send("inbox", {
      type: "event",
      event: {
        ...message,
        id: "public",
        direct: false,
        address: { ...message.address, conversationId: "C1" },
      },
    });
    await expect.poll(async () => sent.length).toBe(8);
    expect(requests[7]?.releaseAvailable).toBe(true);
    expect(requests[7]?.system).toContain("including channels");
    expect(JSON.stringify(sent[7]?.content)).toContain(
      `Running revision: ${running}`,
    );
    expect(JSON.stringify(sent[7]?.content)).toContain(
      "Controller verified this revision healthy at",
    );
    expect(JSON.stringify(sent[7]?.content)).toContain(
      "Total commit count: 73",
    );
    expect(requests[7]?.system).toContain("without a review pass");
    expect(sent[7]?.address.conversationId).toBe("C1");
    await client.conversation
      .getOrCreate(["guest", "slack", "T1", "C1", "", "U2"])
      .send("inbox", {
        type: "event",
        event: {
          ...message,
          id: "guest-release",
          senderId: "U2",
          direct: false,
          botMentioned: true,
          metadata: { channelType: "channel", senderName: "Raygen" },
          address: { ...message.address, conversationId: "C1" },
        },
      });
    await expect.poll(async () => sent.length).toBe(9);
    expect(requests[8]?.releaseAvailable).toBe(false);
    expect(JSON.stringify(sent[8]?.content)).toContain("verified owner");
    expect(JSON.stringify(sent[8]?.content)).not.toContain(running);
    expect(JSON.stringify(sent[8]?.content)).not.toContain("Owner-only commit");
    expect(JSON.stringify(sent[8]?.content)).not.toContain("fix(private)");
    expect(JSON.stringify(sent[8]?.content)).not.toContain(
      "Total commit count",
    );
    expect(sent[0]?.address.threadId).toBe("123.0");
    for (const release of [
      { action: "approve", revision },
      { action: "request", revision },
      { action: "inspect", revision: "main" },
      { action: "inspect", revision, principal: owner.id },
    ]) {
      expect(() =>
        parseReply(JSON.stringify({ text: "", release }), [], {
          releaseAvailable: true,
        }),
      ).toThrow();
    }
    expect(() =>
      parseReply(
        JSON.stringify({ text: "", release: { action: "inspect", revision } }),
        [],
        {},
      ),
    ).toThrow();
  });

  const replyCases: {
    name: string;
    channel: "slack" | "whatsapp";
    reply: CompanionReply;
    outcomes?: Partial<Record<"text" | "reaction", SendResult>>;
    content: OutboundMessage["content"][];
    history: string;
  }[] = [
    {
      name: "nonblank text without a forced reaction",
      channel: "slack",
      reply: { text: "  A fine bird.\n" },
      content: [{ type: "text", text: "  A fine bird.\n" }],
      history: "  A fine bird.\n",
    },
    {
      name: "a Slack reaction without fallback text",
      channel: "slack",
      reply: { text: "", reaction: "heart" },
      content: [{ type: "reaction", emoji: "heart", messageId: "123.456" }],
      history: "[Reaction sent: heart on message 123.456]",
    },
    {
      name: "a WhatsApp reaction with whitespace-only text",
      channel: "whatsapp",
      reply: { text: " \n\t", reaction: "❤️" },
      content: [{ type: "reaction", emoji: "❤️", messageId: "wa1" }],
      history: "[Reaction sent: ❤️ on message wa1]",
    },
    {
      name: "intentional silence for empty text and no reaction",
      channel: "slack",
      reply: { text: "" },
      content: [],
      history: "[Intentional silence; no text or reaction sent]",
    },
    {
      name: "intentional silence for whitespace-only text and no reaction",
      channel: "slack",
      reply: { text: " \n\t" },
      content: [],
      history: "[Intentional silence; no text or reaction sent]",
    },
    {
      name: "an unknown reaction-only outcome without retrying or claiming it was sent",
      channel: "slack",
      reply: { text: "", reaction: "eyes" },
      outcomes: { reaction: { status: "unknown", code: "timeout" } },
      content: [{ type: "reaction", emoji: "eyes", messageId: "123.456" }],
      history:
        "[Reaction delivery unknown: eyes on message 123.456; do not assume the user saw a reaction]",
    },
    {
      name: "a rejected reaction-only outcome without claiming it was sent",
      channel: "slack",
      reply: { text: "", reaction: "wave" },
      outcomes: {
        reaction: {
          status: "rejected",
          code: "invalid_name",
          retryable: false,
        },
      },
      content: [{ type: "reaction", emoji: "wave", messageId: "123.456" }],
      history:
        "[Reaction delivery rejected: wave on message 123.456; do not assume the user saw a reaction]",
    },
    {
      name: "delivered text alongside an unknown reaction",
      channel: "slack",
      reply: { text: "Nice sighting.", reaction: "eyes" },
      outcomes: { reaction: { status: "unknown", code: "timeout" } },
      content: [
        { type: "text", text: "Nice sighting." },
        { type: "reaction", emoji: "eyes", messageId: "123.456" },
      ],
      history:
        "Nice sighting.\n[Reaction delivery unknown: eyes on message 123.456; do not assume the user saw a reaction]",
    },
    {
      name: "a delivered reaction without treating rejected text as sent",
      channel: "slack",
      reply: { text: "That is lovely.", reaction: "heart" },
      outcomes: {
        text: { status: "rejected", code: "too_long", retryable: false },
      },
      content: [
        { type: "text", text: "That is lovely." },
        { type: "reaction", emoji: "heart", messageId: "123.456" },
      ],
      history:
        "[Text delivery rejected; do not assume the user saw this] That is lovely.\n[Reaction sent: heart on message 123.456]",
    },
  ];

  it.for(replyCases)(
    "records $name across duplicate events",
    async (scenario, t) => {
      const sent: OutboundMessage[] = [];
      const requests: ModelRequest[] = [];
      const registry = createJuneRegistry({
        owner,
        channels: {
          [scenario.channel]: transport(
            scenario.channel,
            sent,
            (outbound) =>
              scenario.outcomes?.[outbound.content.type] ?? {
                status: "sent",
                messageId: "out1",
              },
          ),
        },
        model: {
          async reply(request) {
            requests.push(structuredClone(request));
            return requests.length === 1
              ? scenario.reply
              : { text: "A separate turn." };
          },
        },
      });
      const source: MessageEvent =
        scenario.channel === "slack"
          ? message
          : {
              ...message,
              id: "wa1",
              messageId: "wa1",
              senderId: "15551234",
              address: {
                channel: "whatsapp",
                accountId: "P1",
                conversationId: "15551234",
              },
            };
      const { client } = await setupTest(t, registry);
      const june = client.conversation.getOrCreate(["private", "raygen"]);
      await Promise.all([
        june.send("inbox", { type: "event", event: source }),
        june.send("inbox", { type: "event", event: source }),
      ]);
      await expect
        .poll(
          async () =>
            Object.values((await june.snapshot()).events).filter(
              (event) => event.done,
            ).length,
          { timeout: 2500 },
        )
        .toBe(1);

      expect(sent.map((outbound) => outbound.content)).toEqual(
        scenario.content,
      );
      const snapshot = await june.snapshot();
      expect(
        snapshot.history.map(({ role, content }) => ({ role, content })),
      ).toEqual([
        { role: "user", content: source.text },
        { role: "assistant", content: scenario.history },
      ]);
      expect(Object.values(snapshot.deliveries)).toHaveLength(
        scenario.content.length,
      );
      for (const delivery of Object.values(snapshot.deliveries)) {
        expect(delivery).toMatchObject({
          phase: "settled",
          attempts: 1,
          result: scenario.outcomes?.[delivery.message.content.type] ?? {
            status: "sent",
            messageId: "out1",
          },
        });
        expect(delivery.message.address).toEqual(source.address);
      }

      await june.send("inbox", { type: "event", event: source });
      await june.send("inbox", {
        type: "event",
        event: {
          ...source,
          id: "next-turn",
          messageId: "123.457",
          text: "Next turn",
        },
      });
      // A later completed turn is a barrier proving the duplicates were consumed.
      await expect
        .poll(
          async () =>
            Object.values((await june.snapshot()).events).filter(
              (event) => event.done,
            ).length,
          { timeout: 2500 },
        )
        .toBe(2);
      expect(requests).toHaveLength(2);
      expect(conversationText(requests[1])).toEqual([
        { role: "user", content: source.text },
        { role: "assistant", content: scenario.history },
        { role: "user", content: "Next turn" },
      ]);
      expect(sent.map((outbound) => outbound.content)).toEqual([
        ...scenario.content,
        { type: "text", text: "A separate turn." },
      ]);
      expect((await june.snapshot()).history).toHaveLength(4);
    },
  );

  it("keeps incoming Slack reactions in an audit-only scope without inferring a private conversation", async (t) => {
    const sent: OutboundMessage[] = [];
    const requests: ModelRequest[] = [];
    const registry = createJuneRegistry({
      owner,
      channels: { slack: transport("slack", sent) },
      model: {
        async reply(request) {
          requests.push(structuredClone(request));
          return { text: "This should not be sent." };
        },
      },
    });
    const reaction: ReactionEvent = {
      id: "reaction-added",
      type: "reaction",
      address: message.address,
      occurredAt: message.occurredAt,
      senderId: message.senderId,
      messageId: message.messageId,
      emoji: "eyes",
      removed: false,
    };
    const { client } = await setupTest(t, registry);
    const audit = client.conversation.getOrCreate(["slack", "T1", "D1", ""]);
    await audit.send("inbox", { type: "event", event: reaction });
    await audit.send("inbox", { type: "event", event: reaction });
    await audit.send("inbox", {
      type: "event",
      event: { ...reaction, id: "reaction-removed", removed: true },
    });
    await expect
      .poll(
        async () =>
          Object.values((await audit.snapshot()).events).filter(
            (event) => event.done,
          ).length,
        { timeout: 2500 },
      )
      .toBe(2);
    const snapshot = await audit.snapshot();
    expect(Object.values(snapshot.events).map(({ event }) => event)).toEqual([
      reaction,
      { ...reaction, id: "reaction-removed", removed: true },
    ]);
    expect(snapshot).toMatchObject({
      history: [],
      deliveries: {},
      jobs: {},
      lastInbound: {},
    });
    expect(requests).toEqual([]);
    expect(sent).toEqual([]);
  });

  it.for(["public", "private"] as const)(
    "sends %s on-demand search citations without retaining them or showing them to the model",
    async (visibility, t) => {
      const sent: OutboundMessage[] = [];
      const requests: ModelRequest[] = [];
      const searches: string[] = [];
      const adapter = transport("slack", sent);
      const firstClear = Promise.withResolvers<void>();
      t.onTestFinished(() => firstClear.resolve());
      const typing: boolean[] = [];
      adapter.setTyping = async (_event, active) => {
        typing.push(active);
        if (typing.length === 2) await firstClear.promise;
      };
      adapter.search = async (source, query) => {
        expect(source.id).toBe("Ev1");
        searches.push(query);
        if (visibility === "private")
          return {
            status: "private_ready",
            consume(candidate) {
              expect(candidate).toEqual(source);
              expect(sent).toHaveLength(0);
              return "EPHEMERAL_SEARCH_RESULT_93";
            },
          };
        return { status: "ready", text: "EPHEMERAL_SEARCH_RESULT_93" };
      };
      const registry = createJuneRegistry({
        owner,
        channels: { slack: adapter },
        model: {
          async reply(request) {
            requests.push(structuredClone(request));
            return requests.length === 1
              ? { text: "", search: "heron" }
              : { text: "You're welcome." };
          },
        },
      });
      const { client } = await setupTest(t, registry);
      const june = client.conversation.getOrCreate(["private", "raygen"]);
      const source = { ...message, text: "Find Slack messages about herons." };
      await june.send("inbox", { type: "event", event: source });
      await expect.poll(() => typing).toEqual([true, false]);
      expect(searches).toEqual([]);
      firstClear.resolve();
      await expect.poll(() => sent.length, { timeout: 2500 }).toBe(1);
      expect(typing).toEqual([true, false, true, false]);
      expect(sent[0]?.content).toEqual({
        type: "text",
        text: "EPHEMERAL_SEARCH_RESULT_93",
      });
      await june.send("inbox", { type: "event", event: source });
      await june.send("inbox", {
        type: "event",
        event: { ...source, id: "Ev2", messageId: "123.457", text: "Thanks!" },
      });
      await expect.poll(() => sent.length, { timeout: 2500 }).toBe(2);
      expect(searches).toEqual(["heron"]);
      expect(requests[0]).toMatchObject({ searchAvailable: true });
      expect(JSON.stringify(requests)).not.toContain(
        "EPHEMERAL_SEARCH_RESULT_93",
      );
      expect(JSON.stringify(await june.snapshot())).not.toContain(
        "EPHEMERAL_SEARCH_RESULT_93",
      );
      expect((await june.snapshot()).history[1]?.content).toContain(
        "not retained",
      );
    },
  );

  it("deduplicates deliveries and continues a private conversation on WhatsApp", async (t) => {
    const sent: OutboundMessage[] = [];
    const requests: ModelRequest[] = [];
    const registry = createJuneRegistry({
      owner,
      channels: {
        slack: transport("slack", sent),
        whatsapp: transport("whatsapp", sent),
      },
      model: {
        async reply(request) {
          requests.push(structuredClone(request));
          return { text: "A fine bird." };
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(["private", "raygen"]);
    await Promise.all([
      june.send("inbox", { type: "event", event: message }),
      june.send("inbox", { type: "event", event: message }),
    ]);
    await expect.poll(() => sent.length, { timeout: 2500 }).toBe(1);
    // A pre-upgrade callback ID and the stable Slack message ID identify the
    // same accepted message. The later WhatsApp turn is the duplicate barrier.
    await june.send("inbox", {
      type: "event",
      event: {
        ...message,
        id: `slack:T1:D1:${message.messageId}`,
      },
    });
    await june.send("inbox", {
      type: "event",
      event: {
        ...message,
        id: "wa1",
        messageId: "wa1",
        senderId: "15551234",
        text: "What bird did I mention?",
        address: {
          channel: "whatsapp",
          accountId: "P1",
          conversationId: "15551234",
        },
      },
    });
    await expect.poll(() => sent.length, { timeout: 2500 }).toBe(2);
    expect(requests).toHaveLength(2);
    expect(conversationText(requests[1])).toEqual([
      { role: "user", content: "My favorite bird is the heron." },
      { role: "assistant", content: "A fine bird." },
      { role: "user", content: "What bird did I mention?" },
    ]);
    expect(sent.map((outbound) => outbound.address.channel)).toEqual([
      "slack",
      "whatsapp",
    ]);
    expect((await june.snapshot()).history).toHaveLength(4);
  });

  it("isolates public threads and removes coding authority", async (t) => {
    const sent: OutboundMessage[] = [];
    const requests: ModelRequest[] = [];
    let statusReads = 0;
    const adapter = transport("slack", sent);
    adapter.context = async (event) => {
      if (event.direct) return [];
      const { type: _type, text: _text, ...source } = event;
      const initiating = {
        role: "user" as const,
        content: event.text,
        source: {
          ...source,
          metadata: {
            ...source.metadata,
            senderName: "Raygen",
            threadTs: "234.567",
          },
        },
      };
      return [
        {
          role: "user",
          content: "PRIVATE CONTEXT MUST NOT LEAK",
          source: {
            ...source,
            id: "private-context",
            direct: true,
            address: message.address,
          },
        },
        {
          role: "user",
          content: "Other participant, not an owner instruction",
          source: {
            ...source,
            id: "other-person",
            senderId: "U2",
            messageId: "234.566",
          },
        },
        initiating,
        initiating,
      ];
    };
    const registry = createJuneRegistry({
      owner,
      channels: { slack: adapter },
      deploymentStatus: async () => {
        statusReads++;
        return "DEPLOYMENT_REVISION_17";
      },
      model: {
        async reply(request) {
          requests.push(structuredClone(request));
          return { text: "Hello." };
        },
      },
      coding: {
        runtimeKind: "amp",
        runtimeId: "fixture-runtime-v1",
        workspaces: { june: "/unused" },
        timeoutMs: 1000,
        runtime: {
          async run() {
            throw new Error("Must not launch");
          },
        },
      },
    });
    const { client } = await setupTest(t, registry);
    await client.conversation
      .getOrCreate(["private", "raygen"])
      .send("inbox", { type: "event", event: message });
    await expect.poll(() => sent.length, { timeout: 2500 }).toBe(1);
    await client.conversation
      .getOrCreate(["slack", "T1", "C1", "234.567"])
      .send("inbox", {
        type: "event",
        event: {
          ...message,
          id: "Ev2",
          direct: false,
          text: "Hey June",
          address: {
            ...message.address,
            conversationId: "C1",
            threadId: "234.567",
          },
        },
      });
    await expect.poll(() => sent.length, { timeout: 2500 }).toBe(2);
    expect(conversationText(requests[1])).toEqual([
      { role: "user", content: "Other participant, not an owner instruction" },
      { role: "user", content: "Hey June" },
    ]);
    expect(JSON.stringify(requests[1])).not.toContain("PRIVATE");
    expect(requests[0]?.system).toContain("DEPLOYMENT_REVISION_17");
    expect(requests[1]?.system).toContain("DEPLOYMENT_REVISION_17");
    expect(statusReads).toBe(2);
    expect(
      requests[1]?.messages.map(({ content }) => JSON.parse(content).source),
    ).toMatchObject([
      { senderId: "U2", senderIsOwner: false },
      {
        eventId: "Ev2",
        senderId: "U1",
        senderIsOwner: true,
        senderName: "Raygen",
      },
    ]);
    expect(requests[1]?.workspaces).toEqual([]);
    expect(sent[1]?.address.threadId).toBe("234.567");
    await client.conversation
      .getOrCreate(["guest", "slack", "T1", "C1", "234.567", "U2"])
      .send("inbox", {
        type: "event",
        event: {
          ...message,
          id: "guest-status",
          senderId: "U2",
          direct: false,
          botMentioned: true,
          metadata: { channelType: "channel" },
          address: {
            ...message.address,
            conversationId: "C1",
            threadId: "234.567",
          },
        },
      });
    await expect.poll(() => sent.length).toBe(3);
    expect(requests[2]?.system).not.toContain("DEPLOYMENT_REVISION_17");
    expect(statusReads).toBe(2);
  });

  it("records an ambiguous send without retrying it on webhook redelivery", async (t) => {
    const sent: OutboundMessage[] = [];
    const registry = createJuneRegistry({
      owner,
      channels: {
        slack: transport("slack", sent, { status: "unknown", code: "timeout" }),
      },
      model: {
        async reply() {
          return { text: "Hello." };
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(["private", "raygen"]);
    await june.send("inbox", { type: "event", event: message });
    await expect
      .poll(async () => Object.values((await june.snapshot()).deliveries), {
        timeout: 2500,
      })
      .toEqual([
        expect.objectContaining({
          result: { status: "unknown", code: "timeout" },
        }),
      ]);
    await june.send("inbox", { type: "event", event: message });
    await june.send("inbox", {
      type: "event",
      event: { ...message, id: "Ev2", messageId: "123.457", text: "Next turn" },
    });
    await expect.poll(() => sent.length, { timeout: 2500 }).toBe(2);
    expect(sent.map((outbound) => outbound.content)).toEqual([
      { type: "text", text: "Hello." },
      { type: "text", text: "Hello." },
    ]);
  });

  it.for([
    { thread: undefined, place: true, unknown: false },
    { thread: "existing-root", place: false, unknown: false },
    { thread: undefined, place: false, unknown: true },
  ])(
    "holds duplicate acknowledgments and bounds deep work ($thread/$unknown)",
    async (scenario, t) => {
      const sent: OutboundMessage[] = [];
      const fast: ModelRequest[] = [];
      const deep: ModelRequest[] = [];
      const typing: { active: boolean; threadId: string | undefined }[] = [];
      const admission = Promise.withResolvers<void>();
      let waiting = 0;
      let active = 0;
      let failed = false;
      t.onTestFinished(() => admission.resolve());
      const registry = createJuneRegistry({
        owner,
        lifecycle: {
          async enter(signal) {
            expect(signal.aborted).toBe(false);
            waiting++;
            await admission.promise;
            active++;
            return () => {
              active--;
            };
          },
          fail() {
            failed = true;
          },
        },
        channels: {
          slack: {
            ...transport(
              "slack",
              sent,
              scenario.unknown
                ? { status: "unknown", code: "timeout" }
                : { status: "sent", messageId: "ack-or-answer" },
            ),
            async setTyping(event, value) {
              expect(active).toBe(1);
              typing.push({ active: value, threadId: event.address.threadId });
              if (scenario.unknown) throw new Error("typing unavailable");
            },
          },
        },
        model: {
          async reply(request) {
            fast.push(structuredClone(request));
            return fast.length === 1
              ? {
                  text: "Let me work through the heron question.",
                  escalate: true,
                  replyInThread: scenario.place,
                }
              : { text: "A separate quick turn." };
          },
        },
        deepModel: {
          async reply(request) {
            deep.push(structuredClone(request));
            expect(active).toBe(1);
            expect(sent.map(({ content }) => content)).toEqual([
              { type: "text", text: "Let me work through the heron question." },
            ]);
            const acknowledgments = Object.values(
              (await june.snapshot()).deliveries,
            );
            expect(acknowledgments).toHaveLength(1);
            expect(acknowledgments[0]).toMatchObject({
              phase: "settled",
              result: { status: "sent" },
            });
            // Even a provider bypassing schema validation cannot recurse or relocate.
            return {
              text: "Here is the answer.",
              escalate: true,
              replyInThread: false,
            };
          },
        },
      });
      const { client } = await setupTest(t, registry);
      const june = client.conversation.getOrCreate([
        "slack",
        "T1",
        "C1",
        scenario.thread ?? "",
      ]);
      const source: MessageEvent = {
        ...message,
        direct: false,
        address: {
          ...message.address,
          conversationId: "C1",
          ...(scenario.thread ? { threadId: scenario.thread } : {}),
        },
      };
      const done = async () =>
        Object.values((await june.snapshot()).events).filter(({ done }) => done)
          .length;
      await june.send("inbox", { type: "event", event: source });
      await expect.poll(() => waiting).toBe(1);
      expect(fast).toEqual([]);
      expect(sent).toEqual([]);
      expect(typing).toEqual([]);
      expect((await june.snapshot()).events).toEqual({});
      admission.resolve();
      await expect.poll(done).toBe(1);
      await expect.poll(() => active).toBe(0);
      expect(failed).toBe(false);
      const expectedThread = scenario.place
        ? (scenario.thread ?? source.messageId)
        : undefined;
      expect(typing).toEqual([
        { active: true, threadId: scenario.thread },
        { active: false, threadId: scenario.thread },
        ...(scenario.unknown
          ? []
          : [
              { active: true, threadId: expectedThread },
              { active: false, threadId: expectedThread },
            ]),
      ]);
      expect(sent).toHaveLength(scenario.unknown ? 1 : 2);
      expect(
        sent.every(({ address }) => address.threadId === expectedThread),
      ).toBe(true);
      expect(new Set(sent.map(({ id }) => id)).size).toBe(sent.length);
      expect(deep).toHaveLength(scenario.unknown ? 0 : 1);
      if (!scenario.unknown) {
        expect(sent[1]?.content).toEqual({
          type: "text",
          text: "Here is the answer.",
        });
        expect(deep[0]).toMatchObject({
          escalationAvailable: false,
          replyPlacementAvailable: false,
        });
      }
      await june.send("inbox", { type: "event", event: source });
      await june.send("inbox", {
        type: "event",
        event: {
          ...source,
          id: "next-turn",
          messageId: "123.457",
          text: "hello",
        },
      });
      await expect.poll(done).toBe(2);
      expect(fast).toHaveLength(2);
      expect(deep).toHaveLength(scenario.unknown ? 0 : 1);
      expect(sent).toHaveLength(scenario.unknown ? 2 : 3);
      expect(typing).toHaveLength(scenario.unknown ? 4 : 6);
    },
  );

  it.for([false, true])(
    "never repeats a public query or exports private context (ambiguous=$0)",
    async (ambiguous, t) => {
      const sent: OutboundMessage[] = [];
      const requests: ModelRequest[] = [];
      const queries: unknown[][] = [];
      const registry = createJuneRegistry({
        owner,
        channels: { slack: transport("slack", sent) },
        model: {
          async reply(request) {
            requests.push(structuredClone(request));
            if (requests.length === 1)
              return { text: "", webSearch: "heron migration" };
            if (!request.webSearchAvailable)
              return {
                text: "The public snippet says herons migrate.",
                webSearch: "do not execute this second query",
                coding: { workspace: "forbidden", goal: "do not execute this" },
                escalate: true,
              };
            return { text: "A separate turn." };
          },
        },
        webSearch: {
          available: true,
          description: "Public fixture search",
          async search(...args) {
            queries.push(args);
            return ambiguous
              ? {
                  status: "error",
                  code: "timeout",
                  requestState: "possibly_sent",
                }
              : {
                  status: "ready",
                  results: [
                    {
                      title: "Herons",
                      url: "https://birds.org/herons",
                      snippet: "Public migration evidence",
                    },
                  ],
                };
          },
        },
      });
      const { client } = await setupTest(t, registry);
      const june = client.conversation.getOrCreate(["private", "raygen"]);
      const source = {
        ...message,
        text: "PRIVATE_NOTE_83: find public heron migration info",
      };
      const done = async () =>
        Object.values((await june.snapshot()).events).filter(({ done }) => done)
          .length;
      await june.send("inbox", { type: "event", event: source });
      await expect.poll(done).toBe(1);
      expect(queries).toHaveLength(1);
      expect(queries[0]).toEqual(["heron migration", expect.any(AbortSignal)]);
      expect(requests).toHaveLength(ambiguous ? 1 : 2);
      if (!ambiguous) {
        expect(requests[1]).toMatchObject({
          workspaces: [],
          escalationAvailable: false,
          searchAvailable: false,
          webSearchAvailable: false,
        });
        expect(requests[1]?.system).toContain("Public migration evidence");
        expect(sent[0]?.content).toEqual({
          type: "text",
          text: "The public snippet says herons migrate.",
        });
      }
      expect(
        Object.values((await june.snapshot()).webInvocations ?? {}),
      ).toEqual([ambiguous ? "uncertain" : "settled"]);
      expect((await june.snapshot()).jobs).toEqual({});
      await june.send("inbox", { type: "event", event: source });
      await june.send("inbox", {
        type: "event",
        event: {
          ...source,
          id: "next-turn",
          messageId: "123.457",
          text: "thanks",
        },
      });
      await expect.poll(done).toBe(2);
      expect(queries).toHaveLength(1);
      expect(sent).toHaveLength(2);
      expect(requests).toHaveLength(ambiguous ? 2 : 3);
    },
  );

  it("delivers before a late status settles but holds deployment admission until it is cleared", async (t) => {
    const lifecycle = createLifecycle();
    const started = Promise.withResolvers<void>();
    const cleared = Promise.withResolvers<void>();
    const typing: boolean[] = [];
    let typingDuringContext: boolean[] = [];
    const sent: OutboundMessage[] = [];
    const registry = createJuneRegistry({
      owner,
      lifecycle,
      model: {
        async reply() {
          return { text: "The answer is ready." };
        },
      },
      channels: {
        slack: {
          ...transport("slack", sent),
          async context() {
            // Status must already be in flight while Slack context is loading.
            typingDuringContext = [...typing];
            return [];
          },
          async setTyping(_event, active) {
            typing.push(active);
            await (active ? started.promise : cleared.promise);
          },
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(["private", "raygen"]);
    try {
      await june.send("inbox", { type: "event", event: message });
      await expect.poll(() => sent.length, { timeout: 2500 }).toBe(1);
      expect(sent[0]?.content).toEqual({
        type: "text",
        text: "The answer is ready.",
      });
      expect(sent[0]?.address.threadId).toBeUndefined();
      expect(typingDuringContext).toEqual([true]);
      expect(typing).toEqual([true]);
      let drained = false;
      const drain = lifecycle.drain().then((value) => {
        drained = value;
        return value;
      });
      expect(lifecycle.active).toBe(1);
      started.resolve();
      await expect.poll(() => typing).toEqual([true, false]);
      expect(drained).toBe(false);
      cleared.resolve();
      expect(await drain).toBe(true);
      expect(lifecycle.active).toBe(0);
      expect(sent).toHaveLength(1);
    } finally {
      started.resolve();
      cleared.resolve();
      lifecycle.resume();
    }
  });

  it("latches admission failure without starting a turn or a send", async (t) => {
    let failed = false;
    let calls = 0;
    const sent: OutboundMessage[] = [];
    const registry = createJuneRegistry({
      owner,
      channels: { slack: transport("slack", sent) },
      lifecycle: {
        async enter() {
          throw new Error("fixture admission failure");
        },
        fail() {
          failed = true;
        },
      },
      model: {
        async reply() {
          calls++;
          return { text: "must not send" };
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(["private", "raygen"]);
    await june.send("inbox", { type: "event", event: message });
    await expect.poll(() => failed).toBe(true);
    expect(calls).toBe(0);
    expect(sent).toEqual([]);
    expect((await june.snapshot()).events).toEqual({});
  });
});
