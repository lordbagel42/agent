import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { createSlackAdapter } from "../src/channels/slack.js";
import type { OutboundMessage } from "../src/core/contracts.js";
import { routeEvent } from "../src/core/routing.js";
import { parseReply, replyJsonSchema } from "../src/models/provider.js";

const question = {
  prompt: "Which day works?",
  options: ["Tuesday", "Thursday"],
};
const secret = "test-signing-secret";
const now = 1_800_000_000_000;

test("native question schema permits conversation, not worker output or mixed tool authority", () => {
  const capabilities = {
    agentRole: "interaction" as const,
    turnTakingAvailable: true,
  };
  expect(
    parseReply(JSON.stringify({ text: "", question }), [], capabilities),
  ).toMatchObject({ question });
  expect(replyJsonSchema([], capabilities).properties).toHaveProperty(
    "question",
  );
  expect(() =>
    parseReply(JSON.stringify({ text: "", question }), [], {
      agentRole: "execution",
      turnTakingAvailable: true,
    }),
  ).toThrow();
  expect(() =>
    parseReply(
      JSON.stringify({
        text: "",
        question,
        execution: [{ agent: "worker", action: "run", task: "do it" }],
      }),
      [],
      { ...capabilities, executionAvailable: true },
    ),
  ).toThrow();
  expect(() =>
    parseReply(
      JSON.stringify({
        text: "",
        question: { ...question, options: ["Same", "Same"] },
      }),
      [],
      capabilities,
    ),
  ).toThrow();
});

test("Block Kit question round trip authenticates owner, surface, expiry and value without granting command authority", async () => {
  let sent: Record<string, unknown> | undefined;
  let clock = now;
  const adapter = createSlackAdapter({
    signingSecret: secret,
    botToken: "test-bot-token",
    teamId: "T1",
    botUserId: "UBOT",
    ownerUserIds: ["UOWNER"],
    now: () => clock,
    fetch: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ ok: true, ts: "123.456" });
    },
  });
  await adapter.send({
    id: "question-unique",
    address: {
      channel: "slack",
      accountId: "T1",
      conversationId: "D1",
      threadId: "111.222",
    },
    lastInboundAt: now,
    content: {
      type: "text",
      text: "Which day works?\n1. Tuesday\n2. Thursday",
      question,
    },
  } as OutboundMessage);
  assert(sent);
  expect(sent.thread_ts).toBe("111.222");
  const blocks = sent.blocks as {
    type: string;
    elements?: { action_id: string; value: string; text: { text: string } }[];
  }[];
  expect(blocks?.map((block) => block.type)).toEqual(["section", "actions"]);
  const second = blocks[1]?.elements?.[1];
  assert(second);
  expect(second.text.text).toBe("Thursday");
  const payload = {
    type: "block_actions",
    team: { id: "T1" },
    user: { id: "UOWNER" },
    channel: { id: "D1" },
    message: { user: "UBOT", ts: "123.456" },
    actions: [
      {
        type: "button",
        action_id: second.action_id,
        value: second.value,
        action_ts: "1800000000.100",
      },
    ],
  };
  const callback = async (value: unknown, validSignature = true) => {
    const body = new URLSearchParams({
      payload: JSON.stringify(value),
    }).toString();
    const timestamp = Math.floor(clock / 1000);
    const signature = createHmac("sha256", secret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex");
    return adapter.receive(
      new Request("https://june.example/webhooks/slack", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": String(timestamp),
          "x-slack-signature": `v0=${validSignature ? signature : "0".repeat(64)}`,
        },
      }),
    );
  };
  const first = await callback(payload);
  expect(first.events).toHaveLength(1);
  const event = first.events[0];
  assert(event && event.type === "message");
  expect(event.text).toContain("Thursday");
  expect(event.text).toContain("Which day works?");
  expect(event.address).toEqual({
    channel: "slack",
    accountId: "T1",
    conversationId: "D1",
    threadId: "111.222",
  });
  expect(event.mcpCommandEligible).toBeUndefined();
  expect(event.codingCommandEligible).toBeUndefined();
  expect(
    routeEvent(event, {
      id: "owner",
      identities: [{ channel: "slack", accountId: "T1", senderId: "UOWNER" }],
    }),
  ).toEqual({ key: ["private", "owner"], private: true });
  expect((await callback(payload)).events[0]?.id).toBe(event.id);
  expect(
    (await callback({ ...payload, user: { id: "UOTHER" } })).events,
  ).toEqual([]);
  expect(
    (await callback({ ...payload, channel: { id: "DOTHER" } })).events,
  ).toEqual([]);
  expect(
    (
      await callback({
        ...payload,
        actions: [{ ...payload.actions[0], value: `${second.value}x` }],
      })
    ).events,
  ).toEqual([]);
  expect((await callback(payload, false)).response.status).toBe(401);
  clock += 8 * 86_400_000;
  expect((await callback(payload)).events).toEqual([]);
});
