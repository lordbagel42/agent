import type {
  ConversationMessage,
  MessageEvent,
  MessageMetadata,
} from "../core/contracts.js";

const CONTEXT_TIMEOUT_MS = 1_000;
const MESSAGE_LIMIT = 15;
const TEXT_LIMIT = 2_000;
const NAME_LOOKUP_LIMIT = 4;
const NAME_CACHE_LIMIT = 256;
const NAME_TTL_MS = 5 * 60_000;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function label(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 256)
    : undefined;
}

function senderName(message: JsonObject): string | undefined {
  const profile = isObject(message.user_profile) ? message.user_profile : {};
  const bot = isObject(message.bot_profile) ? message.bot_profile : {};
  return (
    label(profile.display_name) ??
    label(profile.real_name) ??
    label(message.username) ??
    label(bot.name)
  );
}

export function slackMessageId(
  teamId: string,
  channel: string,
  ts: string,
): string {
  // Both app_mention and message callbacks identify the same durable turn.
  return `slack:${teamId}:${channel}:${ts}`;
}

export function slackMetadata(
  message: JsonObject,
  channelType: MessageMetadata["channelType"],
): MessageMetadata {
  const files: NonNullable<MessageMetadata["files"]> = [];
  if (Array.isArray(message.files)) {
    for (const file of message.files.slice(0, 10)) {
      if (!isObject(file) || typeof file.id !== "string" || !file.id) continue;
      files.push({
        id: file.id,
        ...(label(file.name) ? { name: label(file.name) } : {}),
        ...(label(file.title) ? { title: label(file.title) } : {}),
        ...(label(file.mimetype) ? { mimetype: label(file.mimetype) } : {}),
      });
    }
  }
  const name = senderName(message);
  return {
    channelType,
    ...(name ? { senderName: name } : {}),
    ...(typeof message.thread_ts === "string" && message.thread_ts
      ? { threadTs: message.thread_ts }
      : {}),
    ...(files.length ? { files } : {}),
  };
}

// Compare Slack timestamps as decimal strings, never round their opaque IDs.
function compareTs(left: string, right: string): number {
  const [ls = "", lf = ""] = left.split(".");
  const [rs = "", rf = ""] = right.split(".");
  const a = ls.padStart(Math.max(ls.length, rs.length), "0");
  const b = rs.padStart(Math.max(ls.length, rs.length), "0");
  if (a !== b) return a < b ? -1 : 1;
  const af = lf.padEnd(Math.max(lf.length, rf.length), "0");
  const bf = rf.padEnd(Math.max(lf.length, rf.length), "0");
  return af === bf ? 0 : af < bf ? -1 : 1;
}

export function createSlackContext({
  teamId,
  botToken,
  botUserId,
  ownerUserIds,
  fetch: fetchImpl,
  now,
}: {
  teamId: string;
  botToken: string;
  botUserId: string;
  ownerUserIds: ReadonlySet<string>;
  fetch: typeof globalThis.fetch;
  now: () => number;
}) {
  // Only display names are cached, never responses, messages, files or tokens.
  const names = new Map<string, { name: string; expires: number }>();

  async function read(
    method: string,
    body: JsonObject,
    signal: AbortSignal,
  ): Promise<JsonObject | undefined> {
    if (signal.aborted) return undefined;
    try {
      const response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${botToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) return undefined;
      const result: unknown = await response.json();
      // Missing scopes, rate limits and unsupported token types add no context.
      return isObject(result) && result.ok === true ? result : undefined;
    } catch {
      return undefined;
    }
  }

  async function conversation(channel: string, signal: AbortSignal) {
    const result = await read("conversations.info", { channel }, signal);
    const info = result?.channel;
    if (!isObject(info) || info.id !== channel) return undefined;
    const type: MessageMetadata["channelType"] =
      info.is_mpim === true
        ? "mpim"
        : info.is_im === true
          ? "im"
          : info.is_private === true || info.is_group === true
            ? "group"
            : info.is_channel === true
              ? "channel"
              : undefined;
    return { type, name: label(info.name) };
  }

  async function userName(
    user: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const cached = names.get(user);
    if (cached && cached.expires > now()) return cached.name;
    const result = await read("users.info", { user }, signal);
    const info = result?.user;
    if (!isObject(info) || info.id !== user) return undefined;
    const profile = isObject(info.profile) ? info.profile : {};
    const name =
      label(profile.display_name) ??
      label(profile.real_name) ??
      label(info.real_name) ??
      label(info.name);
    if (name) {
      names.delete(user);
      if (names.size >= NAME_CACHE_LIMIT) {
        const oldest = names.keys().next().value;
        if (oldest !== undefined) names.delete(oldest);
      }
      names.set(user, { name, expires: now() + NAME_TTL_MS });
    }
    return name;
  }

  async function context(
    event: MessageEvent,
    signal?: AbortSignal,
  ): Promise<ConversationMessage[]> {
    const type = event.metadata?.channelType;
    if (
      event.address.channel !== "slack" ||
      event.address.accountId !== teamId ||
      (!ownerUserIds.has(event.senderId) &&
        !event.botMentioned &&
        !event.direct) ||
      event.senderId === botUserId ||
      (type !== "im" && type !== "channel" && type !== "group") ||
      event.direct !== (type === "im") ||
      signal?.aborted
    )
      return [];

    const deadline = AbortSignal.timeout(CONTEXT_TIMEOUT_MS);
    const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const channel = event.address.conversationId;
    const thread = event.address.threadId;
    // Independent reads share one deadline; do not serialize names before history.
    const [info, history, ownerName] = await Promise.all([
      conversation(channel, readSignal),
      read(
        thread ? "conversations.replies" : "conversations.history",
        {
          channel,
          ...(thread ? { ts: thread } : {}),
          latest: event.messageId,
          inclusive: true,
          limit: MESSAGE_LIMIT,
        },
        readSignal,
      ),
      userName(event.senderId, readSignal),
    ]);
    if (
      signal?.aborted ||
      info?.type === "mpim" ||
      (info?.type && (info.type === "im") !== event.direct)
    )
      return [];

    const channelMetadata: MessageMetadata = {
      channelType: info?.type ?? type,
      ...((info?.name ?? event.metadata?.channelName)
        ? { channelName: info?.name ?? event.metadata?.channelName }
        : {}),
    };
    const messages = new Map<string, ConversationMessage>();
    if (Array.isArray(history?.messages)) {
      for (const message of history.messages.slice(0, MESSAGE_LIMIT)) {
        if (
          !isObject(message) ||
          typeof message.ts !== "string" ||
          !/^\d+\.\d+$/.test(message.ts) ||
          compareTs(message.ts, event.messageId) > 0 ||
          (message.channel !== undefined && message.channel !== channel) ||
          (message.team !== undefined && message.team !== teamId) ||
          message.hidden === true ||
          (typeof message.text === "string" && message.text.startsWith("##")) ||
          message.subtype === "message_deleted" ||
          message.subtype === "message_changed" ||
          (thread
            ? message.ts !== thread && message.thread_ts !== thread
            : message.thread_ts !== undefined &&
              message.thread_ts !== message.ts)
        )
          continue;
        const sender =
          typeof message.user === "string"
            ? message.user
            : typeof message.bot_id === "string"
              ? message.bot_id
              : undefined;
        if (
          !sender ||
          (typeof message.text !== "string" && !Array.isArray(message.files))
        )
          continue;
        messages.set(message.ts, {
          role: sender === botUserId ? "assistant" : "user",
          content:
            typeof message.text === "string"
              ? message.text.slice(0, TEXT_LIMIT)
              : "",
          source: {
            id: slackMessageId(teamId, channel, message.ts),
            address: { ...event.address },
            // The observation time belongs to this turn. Exact Slack time remains
            // in messageId; do not invent callback event_time for history rows.
            occurredAt: event.occurredAt,
            messageId: message.ts,
            senderId: sender,
            direct: event.direct,
            metadata: { ...slackMetadata(message, type), ...channelMetadata },
          },
        });
      }
    }
    const { type: _type, text, ...source } = event;
    messages.set(event.messageId, {
      role: "user",
      content: text,
      source: {
        ...source,
        metadata: {
          ...event.metadata,
          ...channelMetadata,
          ...(ownerName ? { senderName: ownerName } : {}),
        },
      },
    });
    const result = [...messages.values()]
      .sort((a, b) =>
        compareTs(a.source?.messageId ?? "", b.source?.messageId ?? ""),
      )
      .slice(-MESSAGE_LIMIT);
    const missingNames = [
      ...new Set(
        result
          .filter((message) => !message.source?.metadata?.senderName)
          .map((message) => message.source?.senderId),
      ),
    ]
      .filter(
        (user): user is string =>
          user !== undefined && user !== event.senderId && /^[UW]/.test(user),
      )
      .slice(0, NAME_LOOKUP_LIMIT - 1);
    const resolvedNames = new Map(
      await Promise.all(
        missingNames.map(
          async (user) => [user, await userName(user, readSignal)] as const,
        ),
      ),
    );
    if (signal?.aborted) return [];
    for (const message of result) {
      const name = message.source && resolvedNames.get(message.source.senderId);
      if (name && message.source?.metadata)
        message.source.metadata.senderName = name;
    }
    return result;
  }

  return { conversation, context };
}
