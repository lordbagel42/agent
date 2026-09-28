import { expect, it } from "vitest";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { buildModelRequest } from "../runtime/prompt.js";
import type { MessageEvent } from "./contracts.js";
import { messageDestinations } from "./messaging.js";

it("keeps directed sends owner-only independently of private-read grants and worker flags", () => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const event: MessageEvent = {
    id: "event",
    type: "message",
    senderId: "U1",
    direct: false,
    botMentioned: true,
    metadata: { channelType: "channel" },
    messageId: "123.456",
    occurredAt: 1,
    text: "DM me metadata",
    address: {
      channel: "slack",
      accountId: "T1",
      conversationId: "C1",
      threadId: "123.456",
    },
  };
  const sendMessages = [
    { conversationId: "owner", threadId: null, text: "metadata" },
  ];
  const body = JSON.stringify({ text: "", sendMessages });
  for (const source of [
    { ...event, senderId: "UGUEST" },
    { ...event, address: { ...event.address, accountId: "TOTHER" } },
  ]) {
    expect(() => messageDestinations(sendMessages, source, owner)).toThrow();
    if (source.address.accountId !== "T1") continue;
    const request = buildModelRequest({
      event: source,
      owner,
      now: new Date(),
      history: [],
      models: { current: { provider: "test", model: "test" } },
      agentRole: "interaction",
      capabilities: { messagingAvailable: true },
    });
    expect(request.messagingAvailable).toBe(false);
    expect(() => parseReply(body, [], request)).toThrow();
  }
  const request = buildModelRequest({
    event,
    owner,
    now: new Date(),
    history: [],
    models: { current: { provider: "test", model: "test" } },
    agentRole: "interaction",
    capabilities: { messagingAvailable: true, inspectionAvailable: true },
  });
  expect(request.messagingAvailable).toBe(true);
  expect(request.inspectionAvailable).toBe(false);
  expect(parseReply(body, [], request).sendMessages).toEqual(sendMessages);
  expect(
    replyJsonSchema([], { ...request, agentRole: "execution" }).properties,
  ).not.toHaveProperty("sendMessages");
  expect(() =>
    parseReply(body, [], { ...request, agentRole: "execution" }),
  ).toThrow();
  expect(() =>
    parseReply(body, [], { ...request, messagingAvailable: false }),
  ).toThrow();
});
