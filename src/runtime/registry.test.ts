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
        event: { ...source, id: "next-turn", text: "Next turn" },
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
      expect(requests[1]?.messages).toEqual([
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
      await expect.poll(() => sent.length, { timeout: 2500 }).toBe(1);
      expect(sent[0]?.content).toEqual({
        type: "text",
        text: "EPHEMERAL_SEARCH_RESULT_93",
      });
      await june.send("inbox", { type: "event", event: source });
      await june.send("inbox", {
        type: "event",
        event: { ...source, id: "Ev2", text: "Thanks!" },
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
    expect(requests[1]?.messages).toEqual([
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
    const registry = createJuneRegistry({
      owner,
      channels: { slack: transport("slack", sent) },
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
    expect(requests[1]?.messages).toEqual([
      { role: "user", content: "Hey June" },
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
      event: { ...message, id: "Ev2", text: "Next turn" },
    });
    await expect.poll(() => sent.length, { timeout: 2500 }).toBe(2);
    expect(sent.map((outbound) => outbound.content)).toEqual([
      { type: "text", text: "Hello." },
      { type: "text", text: "Hello." },
    ]);
  });
});
