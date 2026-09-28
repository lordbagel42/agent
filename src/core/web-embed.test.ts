import { expect, it } from "vitest";
import { createSlackAdapter } from "../channels/slack.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { allowedWebEmbed } from "./web-embed.js";

const embed = {
  url: "https://demo.example.org/view",
  thumbnailUrl: "https://demo.example.org/thumb.png",
  title: "A demo",
};
const origins = ["https://demo.example.org"];

it("accepts only approved public HTTPS origins, without URL credentials or secret-bearing query strings", () => {
  expect(allowedWebEmbed(embed, origins)).toBe(true);
  for (const url of [
    "not a URL",
    "http://demo.example.org/view",
    "https://demo.example.org.evil.com/view",
    "https://user:secret@demo.example.org/view",
    "https://demo.example.org/view?token=secret",
    "https://demo.example.org/view#secret",
    "https://127.0.0.1/view",
    "https://localhost/view",
  ]) {
    expect(allowedWebEmbed({ ...embed, url }, origins)).toBe(false);
    expect(allowedWebEmbed({ ...embed, thumbnailUrl: url }, origins)).toBe(
      false,
    );
  }
  expect(allowedWebEmbed(embed, [])).toBe(false);
  expect(allowedWebEmbed({ ...embed, title: "<@U123>" }, origins)).toBe(false);
});

it("exposes an exclusive webEmbed action to execution, never the interaction model", () => {
  const reply = { text: "", webEmbed: embed };
  expect(
    parseReply(JSON.stringify(reply), [], {
      webEmbedAvailable: true,
      agentRole: "execution",
    }),
  ).toEqual(reply);
  expect(
    replyJsonSchema([], { webEmbedAvailable: true }).properties,
  ).toHaveProperty("webEmbed");
  for (const flags of [
    {},
    { webEmbedAvailable: true, agentRole: "interaction" as const },
  ])
    expect(() => parseReply(JSON.stringify(reply), [], flags)).toThrow();
  expect(() =>
    parseReply(JSON.stringify({ ...reply, text: "sent!" }), [], {
      webEmbedAvailable: true,
    }),
  ).toThrow();
});

it("posts a video block with fallback text through Slack's normal send, and rejects disabled or unsafe embeds before IO", async () => {
  const bodies: Record<string, unknown>[] = [];
  const adapter = createSlackAdapter({
    signingSecret: "fixture",
    botToken: "fixture",
    teamId: "T1",
    botUserId: "B1",
    webEmbedOrigins: origins,
    fetch: async (_url, options) => {
      bodies.push(JSON.parse(String(options?.body)));
      return Response.json({ ok: true, ts: "123" });
    },
  });
  const message = {
    id: "stable-id",
    address: {
      channel: "slack" as const,
      accountId: "T1",
      conversationId: "D1",
      threadId: "12",
    },
    lastInboundAt: Date.now(),
    content: {
      type: "text" as const,
      text: "A demo\nhttps://demo.example.org/view",
      webEmbed: embed,
    },
  };
  expect(await adapter.send(message)).toEqual({
    status: "sent",
    messageId: "123",
  });
  expect(bodies[0]).toMatchObject({
    client_msg_id: "stable-id",
    thread_ts: "12",
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      {
        type: "video",
        video_url: embed.url,
        title_url: embed.url,
        thumbnail_url: embed.thumbnailUrl,
        title: { type: "plain_text", text: "A demo" },
        alt_text: "A demo",
      },
    ],
  });
  expect(
    await adapter.send({
      ...message,
      content: { ...message.content, plainText: true },
    }),
  ).toMatchObject({ status: "rejected" });
  expect(
    await adapter.send({
      ...message,
      content: {
        ...message.content,
        webEmbed: { ...embed, url: "https://other.example.org/view" },
      },
    }),
  ).toMatchObject({ status: "rejected" });
  expect(bodies).toHaveLength(1);
});
