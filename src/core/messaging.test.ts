import { expect, it } from "vitest";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { buildModelRequest } from "../runtime/prompt.js";
import type { MessageEvent } from "./contracts.js";
import { messageDestinations } from "./messaging.js";

it("resolves configured destinations for any Slack requester without impersonating the owner", () => {
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
    { conversationId: "UGUEST", threadId: null, text: "your update" },
    { conversationId: "C2", threadId: "234.567", text: "channel update" },
  ];
  const body = JSON.stringify({ text: "", sendMessages });
  for (const senderId of ["U1", "UGUEST"]) {
    const source = { ...event, senderId };
    expect(messageDestinations(sendMessages, source, owner)).toEqual([
      {
        address: { channel: "slack", accountId: "T1", conversationId: "U1" },
        text: "metadata",
      },
      {
        address: {
          channel: "slack",
          accountId: "T1",
          conversationId: "UGUEST",
        },
        text: "your update",
      },
      {
        address: {
          channel: "slack",
          accountId: "T1",
          conversationId: "C2",
          threadId: "234.567",
        },
        text: "channel update",
      },
    ]);
    expect(source.senderId).toBe(senderId);
  }
  for (const source of [
    { ...event, address: { ...event.address, channel: "whatsapp" as const } },
    { ...event, address: { ...event.address, accountId: "TOTHER" } },
  ]) {
    expect(() => messageDestinations(sendMessages, source, owner)).toThrow();
  }
  for (const message of [
    { conversationId: "invented", threadId: null, text: "bad destination" },
    { conversationId: "C2", threadId: "invalid", text: "bad thread" },
    { conversationId: "C2", threadId: null, text: "x".repeat(3501) },
  ])
    expect(() => messageDestinations([message], event, owner)).toThrow();
  const request = buildModelRequest({
    event,
    owner,
    now: new Date(),
    history: [],
    models: { current: { provider: "test", model: "test" } },
    agentRole: "interaction",
    capabilities: { messagingAvailable: true },
  });
  expect(request.messagingAvailable).toBe(true);
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
