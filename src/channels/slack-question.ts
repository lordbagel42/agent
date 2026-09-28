import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { MessageEvent, OutboundMessage } from "../core/contracts.js";
import { questionSchema } from "../core/question.js";

const buttonSchema = z.strictObject({
  id: z.string().min(1).max(200),
  team: z.string().min(1).max(80),
  channel: z.string().regex(/^D[A-Z0-9_]+$/),
  user: z.string().min(1).max(80),
  thread: z.string().max(100).optional(),
  expires: z.number().int(),
  prompt: z.string().min(1).max(300),
  option: z.string().min(1).max(75),
  index: z.number().int().min(0).max(4),
});

function signature(value: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`june-question-v1:${value}`)
    .digest("base64url");
}

/** Stateless signed choices survive restarts without another persistence store.
 * The existing durable inbox deduplicates a question's first answer per owner. */
export function slackQuestionBlocks(
  message: OutboundMessage,
  owner: string,
  secret: string,
  now: number,
) {
  if (
    message.content.type !== "text" ||
    !message.address.conversationId.startsWith("D")
  )
    return undefined;
  const parsed = questionSchema.safeParse(message.content.question);
  if (!parsed.success) return undefined;
  const question = parsed.data;
  const thread = message.address.threadId ?? message.content.replyTo;
  const elements = question.options.map((option, index) => {
    const value = Buffer.from(
      JSON.stringify({
        id: message.id,
        team: message.address.accountId,
        channel: message.address.conversationId,
        user: owner,
        thread,
        expires: now + 7 * 86_400_000,
        prompt: question.prompt,
        option,
        index,
      }),
    ).toString("base64url");
    return {
      type: "button",
      action_id: `june.question.${index}`,
      text: { type: "plain_text", text: option, emoji: true },
      value: `${value}.${signature(value, secret)}`,
    };
  });
  if (elements.some((element) => element.value.length > 2000)) return undefined;
  return [
    {
      type: "section",
      text: { type: "plain_text", text: question.prompt, emoji: true },
    },
    { type: "actions", elements },
  ];
}

const callbackSchema = z.object({
  type: z.literal("block_actions"),
  team: z.object({ id: z.string() }),
  user: z.object({ id: z.string() }),
  channel: z.object({ id: z.string() }),
  message: z.object({ user: z.string(), ts: z.string().regex(/^\d+\.\d+$/) }),
  actions: z
    .array(
      z.object({
        type: z.literal("button"),
        action_id: z.string(),
        value: z.string().max(2000),
      }),
    )
    .length(1),
});

/** Call only after verifying Slack's signature over the original raw request. */
export function slackQuestionAnswer(
  payload: unknown,
  team: string,
  bot: string,
  owners: ReadonlySet<string>,
  secret: string,
  now: number,
): MessageEvent | undefined {
  const parsed = callbackSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  const action = value.actions[0];
  if (
    !action ||
    value.team.id !== team ||
    value.message.user !== bot ||
    !owners.has(value.user.id)
  )
    return undefined;
  const [encoded, digest, extra] = action.value.split(".");
  if (!encoded || !digest || extra !== undefined) return undefined;
  const expected = Buffer.from(signature(encoded, secret));
  const actual = Buffer.from(digest);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString());
  } catch {
    return undefined;
  }
  const button = buttonSchema.safeParse(decoded);
  if (!button.success) return undefined;
  const choice = button.data;
  if (
    choice.team !== team ||
    choice.channel !== value.channel.id ||
    choice.user !== value.user.id ||
    choice.expires <= now ||
    action.action_id !== `june.question.${choice.index}`
  )
    return undefined;
  return {
    type: "message",
    id: `slack-question:${team}:${choice.id}:${choice.user}`,
    address: {
      channel: "slack",
      accountId: team,
      conversationId: choice.channel,
      ...(choice.thread ? { threadId: choice.thread } : {}),
    },
    occurredAt: now,
    messageId: value.message.ts,
    senderId: choice.user,
    direct: true,
    text: `Selected option ${choice.index + 1}: ${JSON.stringify(choice.option)} for June's question ${JSON.stringify(choice.prompt)}. This is a conversational selection, not confirmation of a protected action.`,
    metadata: {
      channelType: "im",
      ...(choice.thread ? { threadTs: choice.thread } : {}),
    },
    // No privileged command-eligibility flags: buttons are conversational input.
  };
}
