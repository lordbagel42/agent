import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
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
import { parseReply, replyJsonSchema } from "../models/provider.js";
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
  it("dispatches release tools only in owner-private turns and journals the result", async (t) => {
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
      blocked: false,
      events: [],
    };
    let directive: NonNullable<CompanionReply["release"]> = {
      action: "request",
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
            // A nonconforming provider must not bypass the runtime audience gate.
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
      directive = { action: index === 0 ? "request" : "inspect", revision };
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
      expect(content.text.length).toBeLessThan(3500);
    }
    expect(requests[0]?.system).toContain("Release tracking");
    expect(JSON.stringify(sent[0]?.content)).toContain("tracking intent only");
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
    expect(JSON.stringify(sent[7]?.content)).toContain("owner-private turn");
    expect(JSON.stringify(sent[7]?.content)).not.toContain(running);
    expect(sent[0]?.address.threadId).toBe("123.0");
    for (const release of [
      { action: "approve", revision },
      { action: "request", revision: null },
      { action: "request", revision: "main" },
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
        JSON.stringify({ text: "", release: { action: "request", revision } }),
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
        expect(delivery.message.address).toEqual(
          source.address.channel === "slack" &&
            delivery.message.content.type === "text"
            ? { ...source.address, threadId: "123.456" }
            : source.address,
        );
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
              expect(candidate).toEqual({
                ...source,
                address: { ...source.address, threadId: source.messageId },
              });
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
          metadata: { senderName: "Raygen", threadTs: "234.567" },
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
        return "PRIVATE_DEPLOYMENT_REVISION_17";
      },
      model: {
        async reply(request) {
          requests.push(structuredClone(request));
          return { text: "Hello." };
        },
      },
      coding: {
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
    expect(requests[0]?.system).toContain("PRIVATE_DEPLOYMENT_REVISION_17");
    expect(statusReads).toBe(1);
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
      const expectedThread = scenario.thread ?? source.messageId;
      expect(typing).toEqual([
        { active: true, threadId: expectedThread },
        { active: false, threadId: expectedThread },
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
      expect(sent[0]?.address.threadId).toBe(message.messageId);
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
