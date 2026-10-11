import { Context, Effect, Layer, Schema } from "effect";
import type { SlackThreads } from "../channels/slack-threads.js";
import { redactBrowserPin } from "../core/private-input.js";
import type {
  WebConversation,
  WebConversationList,
  WebMessage,
  WebTranscript,
} from "./contracts.js";

export class WebReadError extends Schema.TaggedError<WebReadError>()(
  "WebReadError",
  {
    code: Schema.Literals([
      "unavailable",
      "access_denied",
      "missing_scope",
      "rate_limited",
      "invalid_request",
    ]),
    retryAfter: Schema.optional(Schema.Number),
  },
) {}

const channelId = Schema.String.check(
  Schema.isPattern(/^[CDG][A-Z0-9]{1,30}$/),
);
const timestamp = Schema.String.check(Schema.isPattern(/^\d{1,16}\.\d{6}$/));
export const transcriptQuery = Schema.Struct({
  channel: channelId,
  thread: Schema.NullOr(timestamp),
  cursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000))),
});

const channelSchema = Schema.Struct({
  id: channelId,
  name: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  is_im: Schema.optional(Schema.Boolean),
  is_mpim: Schema.optional(Schema.Boolean),
  is_member: Schema.optional(Schema.Boolean),
  is_private: Schema.optional(Schema.Boolean),
});
const messageSchema = Schema.Struct({
  ts: timestamp,
  thread_ts: Schema.optional(Schema.String),
  channel: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  hidden: Schema.optional(Schema.Boolean),
  subtype: Schema.optional(Schema.String),
  edited: Schema.optional(Schema.Unknown),
  reply_count: Schema.optional(Schema.Number),
  files: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.optional(Schema.String),
        mimetype: Schema.optional(Schema.String),
      }),
    ),
  ),
});
const envelope = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  team_id: Schema.optional(Schema.String),
  user_id: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  is_enterprise_install: Schema.optional(Schema.Boolean),
  channel: Schema.optional(channelSchema),
  channels: Schema.optional(Schema.Array(channelSchema)),
  members: Schema.optional(Schema.Array(Schema.String)),
  messages: Schema.optional(Schema.Array(messageSchema)),
  has_more: Schema.optional(Schema.Boolean),
  is_limited: Schema.optional(Schema.Boolean),
  response_metadata: Schema.optional(
    Schema.Struct({ next_cursor: Schema.optional(Schema.String) }),
  ),
  // auth.test returns a username here; users.info returns a profile object.
  user: Schema.optional(
    Schema.Union([
      Schema.String,
      Schema.Struct({
        id: Schema.String,
        profile: Schema.optional(
          Schema.Struct({
            display_name: Schema.optional(Schema.String),
            real_name: Schema.optional(Schema.String),
          }),
        ),
      }),
    ]),
  ),
});

const clean = (text: string, max = 120) =>
  text.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, max);
const nextCursor = (data: typeof envelope.Type) =>
  data.response_metadata?.next_cursor || null;
const unavailable = () => new WebReadError({ code: "unavailable" });

export interface WebConversationReader {
  list(before: number | null): Effect.Effect<WebConversationList, WebReadError>;
  read(
    query: typeof transcriptQuery.Type,
  ): Effect.Effect<WebTranscript, WebReadError>;
}

export class WebConversations extends Context.Service<
  WebConversations,
  WebConversationReader
>()("june/web/Conversations") {
  static layer(options: {
    teamId: string;
    botUserId: string;
    botToken: string;
    ownerUserIds: readonly string[];
    threads: Pick<SlackThreads, "list" | "has">;
    redact(text: string): string;
    fetch?: typeof globalThis.fetch;
  }) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    // No message, membership, or access cache. Rate-limit backoff is global to
    // this bot reader so refresh cannot ignore Slack's Retry-After.
    let retryAt = 0;
    const call = Effect.fn("june.web.slack.read")(function* (
      method: string,
      fields: Record<string, string> = {},
    ) {
      if (retryAt > Date.now())
        return yield* new WebReadError({
          code: "rate_limited",
          retryAfter: Math.ceil((retryAt - Date.now()) / 1000),
        });
      const data = yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await fetchImpl(`https://slack.com/api/${method}`, {
            method: "POST",
            redirect: "error",
            headers: {
              authorization: `Bearer ${options.botToken}`,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(fields),
            signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
          });
          if (response.status === 429) {
            const wait = Number(response.headers.get("retry-after"));
            const seconds = Number.isFinite(wait)
              ? Math.max(1, Math.min(3600, wait))
              : 60;
            retryAt = Date.now() + seconds * 1000;
            await response.body?.cancel();
            throw new WebReadError({
              code: "rate_limited",
              retryAfter: seconds,
            });
          }
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw unavailable();
          }
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            for (;;) {
              const item = await reader.read();
              if (item.done) break;
              bytes += item.value.byteLength;
              if (bytes > 2_000_000) throw unavailable();
              chunks.push(item.value);
            }
          } finally {
            await reader.cancel();
          }
          return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        },
        catch: (error) =>
          error instanceof WebReadError ? error : unavailable(),
      });
      const result = yield* Schema.decodeUnknownEffect(envelope)(data).pipe(
        Effect.mapError(unavailable),
      );
      if (!result.ok) {
        if (result.error === "ratelimited") {
          retryAt = Date.now() + 60_000;
          return yield* new WebReadError({
            code: "rate_limited",
            retryAfter: 60,
          });
        }
        return yield* new WebReadError({
          code:
            result.error === "missing_scope"
              ? "missing_scope"
              : [
                    "channel_not_found",
                    "not_in_channel",
                    "access_denied",
                    "thread_not_found",
                  ].includes(result.error ?? "")
                ? "access_denied"
                : "unavailable",
        });
      }
      return result;
    });
    const identity = Effect.fn("june.web.identity")(function* () {
      const auth = yield* call("auth.test");
      // Org installations require separate workspace grant verification; never
      // interpret an enterprise token as a grant to the configured workspace.
      if (
        auth.team_id !== options.teamId ||
        auth.user_id !== options.botUserId ||
        !auth.bot_id ||
        auth.is_enterprise_install === true ||
        !options.ownerUserIds.length
      )
        return yield* new WebReadError({ code: "access_denied" });
    });
    const authorize = Effect.fn("june.web.authorize")(function* (
      channel: string,
      thread: string | null,
    ): Effect.fn.Return<WebConversation, WebReadError> {
      const result = yield* call("conversations.info", { channel });
      const info = result.channel;
      if (!info || info.id !== channel) return yield* unavailable();
      const privateDm =
        info.is_im === true &&
        info.is_mpim !== true &&
        !!info.user &&
        options.ownerUserIds.includes(info.user);
      if (info.is_im === true && !privateDm)
        return yield* new WebReadError({ code: "access_denied" });
      if (!privateDm) {
        if (
          !thread ||
          info.is_member !== true ||
          !options.threads.has(
            options.teamId,
            options.botUserId,
            channel,
            thread,
          )
        )
          return yield* new WebReadError({ code: "access_denied" });
        let cursor = "";
        let member = false;
        for (let page = 0; page < 5; page++) {
          const members = yield* call("conversations.members", {
            channel,
            limit: "200",
            ...(cursor ? { cursor } : {}),
          });
          if (!members.members) return yield* unavailable();
          member = members.members.some((id) =>
            options.ownerUserIds.includes(id),
          );
          if (member) break;
          cursor = nextCursor(members) ?? "";
          if (!cursor) break;
        }
        if (!member) return yield* new WebReadError({ code: "access_denied" });
      }
      const name = privateDm
        ? "With June"
        : info.is_mpim
          ? "Group conversation"
          : `#${clean(info.name || channel)}`;
      const url = new URL("https://app.slack.com/client/");
      url.pathname += `${options.teamId}/${channel}${thread ? `/thread/${channel}-${thread}` : ""}`;
      return {
        id: `${options.teamId}:${channel}:${thread ?? ""}`,
        team: options.teamId,
        channel,
        thread,
        name,
        scope: privateDm ? "private" : "shared",
        audience: privateDm
          ? "You and June"
          : info.is_mpim
            ? "Members of this group DM"
            : `Members of ${name}${info.is_private ? " · private channel" : ""}`,
        slackUrl: url.href,
      };
    });
    const list = Effect.fn("june.web.list")(function* (before: number | null) {
      yield* identity();
      const conversations: WebConversation[] = [];
      let limited = false;
      // Private DM discovery is bounded and never opens a new Slack DM.
      if (before === null) {
        let cursor = "";
        for (let page = 0; page < 5; page++) {
          const data = yield* call("conversations.list", {
            team_id: options.teamId,
            types: "im",
            limit: "200",
            ...(cursor ? { cursor } : {}),
          });
          if (!data.channels) return yield* unavailable();
          for (const channel of data.channels) {
            if (
              channel.is_im &&
              channel.user &&
              options.ownerUserIds.includes(channel.user)
            )
              conversations.push(yield* authorize(channel.id, null));
          }
          cursor = nextCursor(data) ?? "";
          if (!cursor || conversations.length >= options.ownerUserIds.length)
            break;
          if (page === 4) limited = true;
        }
      }
      const rows = yield* Effect.try({
        try: () =>
          options.threads.list(options.teamId, options.botUserId, before),
        catch: unavailable,
      });
      // Sequential and bounded: do not burst the bot's Slack quota on refresh.
      for (const row of rows) {
        const conversation = yield* authorize(row.channel, row.thread).pipe(
          Effect.catch((error) =>
            error.code === "access_denied"
              ? Effect.succeed(null)
              : Effect.fail(error),
          ),
        );
        if (conversation) conversations.push(conversation);
      }
      return {
        conversations,
        next: rows.length === 12 ? (rows.at(-1)?.cursor ?? null) : null,
        observedAt: new Date().toISOString(),
        limited,
      };
    });
    const read = Effect.fn("june.web.transcript")(function* (
      input: typeof transcriptQuery.Type,
    ) {
      const query = yield* Schema.decodeUnknownEffect(transcriptQuery)(
        input,
      ).pipe(
        Effect.mapError(() => new WebReadError({ code: "invalid_request" })),
      );
      yield* identity();
      yield* authorize(query.channel, query.thread);
      const data = yield* call(
        query.thread ? "conversations.replies" : "conversations.history",
        {
          channel: query.channel,
          limit: "15",
          ...(query.thread ? { ts: query.thread } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
        },
      );
      if (!data.messages) return yield* unavailable();
      const messages: WebMessage[] = [];
      const names = new Map<string, string>();
      for (const row of data.messages.slice(0, 15)) {
        if (
          row.hidden ||
          ["message_deleted", "message_changed"].includes(row.subtype ?? "") ||
          (row.channel && row.channel !== query.channel) ||
          (query.thread
            ? row.ts !== query.thread && row.thread_ts !== query.thread
            : row.thread_ts && row.thread_ts !== row.ts)
        )
          continue;
        const id = row.user ?? row.bot_id ?? "unknown";
        const june = id === options.botUserId;
        if (!june && row.user && !names.has(id) && names.size < 8) {
          const user = yield* call("users.info", { user: id }).pipe(
            Effect.catch((error) =>
              error.code === "rate_limited"
                ? Effect.fail(error)
                : Effect.succeed(null),
            ),
          );
          names.set(
            id,
            typeof user?.user !== "string" && user?.user?.id === id
              ? clean(
                  user.user.profile?.display_name ||
                    user.user.profile?.real_name ||
                    id,
                )
              : id,
          );
        }
        const text = options.redact(
          redactBrowserPin(row.text ?? "[No plain-text content]"),
        );
        messages.push({
          id: `${options.teamId}:${query.channel}:${row.ts}`,
          author: { id, name: june ? "June" : names.get(id) || id, june },
          origin: "Slack",
          timestamp: row.ts,
          text: text.slice(0, 12_000),
          truncated: text.length > 12_000,
          edited: row.edited !== undefined,
          replyCount: Math.max(0, row.reply_count ?? 0),
          files: (row.files ?? []).slice(0, 10).map((file) => ({
            id: clean(file.id),
            name: clean(file.name || "Untitled file", 256),
            type: clean(file.mimetype || "File"),
          })),
        });
      }
      // Recheck access after the asynchronous content/name reads. No transcript
      // data, including filenames, survives a failed final authorization.
      const conversation = yield* authorize(query.channel, query.thread);
      return {
        conversation,
        messages: query.thread ? messages : messages.reverse(),
        next: nextCursor(data),
        more: data.has_more === true,
        limited: data.is_limited === true,
        observedAt: new Date().toISOString(),
      };
    });
    return Layer.succeed(WebConversations, { list, read });
  }
}
