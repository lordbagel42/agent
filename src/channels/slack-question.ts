import { createHmac, timingSafeEqual } from "node:crypto";
import { Option, Schema } from "effect";
import type { MessageEvent, OutboundMessage } from "../core/contracts.js";
import { questionSchema } from "../core/question.js";
import { Int, isPattern } from "../effect/schema.js";

const bounded = (min: number, max: number) =>
  Schema.String.check(Schema.isMinLength(min), Schema.isMaxLength(max));
const buttonSchema = Schema.Struct({
  id: bounded(1, 200),
  team: bounded(1, 80),
  channel: Schema.String.check(isPattern(/^[CDG][A-Z0-9_]+$/)),
  channelType: Schema.optionalKey(
    Schema.Literals(["im", "mpim", "channel", "group"]),
  ),
  user: bounded(1, 80),
  thread: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
  expires: Int(),
  prompt: bounded(1, 300),
  option: bounded(1, 75),
  index: Int({ minimum: 0, maximum: 4 }),
});
const decodeButton = Schema.decodeUnknownOption(buttonSchema, {
  onExcessProperty: "error",
});

function signature(value: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`june-question-v1:${value}`)
    .digest("base64url");
}

/** Stateless signed choices survive restarts without another persistence store.
 * The existing durable inbox deduplicates a question's first answer per requester. */
export function slackQuestionBlocks(
  message: OutboundMessage,
  secret: string,
  now: number,
) {
  if (message.content.type !== "text") return undefined;
  const target = message.content.questionTarget;
  if (
    !target?.userId ||
    !["im", "mpim", "channel", "group"].includes(target.channelType) ||
    !/^[CDG][A-Z0-9_]+$/.test(message.address.conversationId) ||
    (target.channelType === "im") !==
      message.address.conversationId.startsWith("D")
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
        channelType: target.channelType,
        user: target.userId,
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

const id = Schema.Struct({ id: Schema.String });
/** Slack's payload carries many more fields; like Zod objects, ignore them. */
const callbackSchema = Schema.Struct({
  type: Schema.Literal("block_actions"),
  team: id,
  user: id,
  channel: id,
  message: Schema.Struct({
    user: Schema.String,
    ts: Schema.String.check(isPattern(/^\d+\.\d+$/)),
  }),
  actions: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("button"),
      action_id: Schema.String,
      value: Schema.String.check(Schema.isMaxLength(2000)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
});
const decodeCallback = Schema.decodeUnknownOption(callbackSchema);

/** Call only after verifying Slack's signature over the original raw request. */
export function slackQuestionAnswer(
  payload: unknown,
  team: string,
  bot: string,
  secret: string,
  now: number,
): MessageEvent | undefined {
  const parsed = decodeCallback(payload);
  if (Option.isNone(parsed)) return undefined;
  const value = parsed.value;
  const action = value.actions[0];
  if (!action || value.team.id !== team || value.message.user !== bot)
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
  const button = decodeButton(decoded);
  if (Option.isNone(button)) return undefined;
  const choice = button.value;
  // Existing signed DM buttons predate the explicit surface field.
  const channelType =
    choice.channelType ?? (choice.channel.startsWith("D") ? "im" : undefined);
  if (
    !channelType ||
    (channelType === "im") !== choice.channel.startsWith("D") ||
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
    direct: channelType === "im",
    questionAnswered: true,
    text: `Selected option ${choice.index + 1}: ${JSON.stringify(choice.option)} for June's question ${JSON.stringify(choice.prompt)}. This is a conversational selection, not confirmation of a protected action.`,
    metadata: {
      channelType,
      ...(choice.thread ? { threadTs: choice.thread } : {}),
    },
    // No privileged command-eligibility flags: buttons are conversational input.
  };
}
