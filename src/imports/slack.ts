import { Effect, Schema } from "effect";
import { redactBrowserPin } from "../core/private-input.js";
import { PRIVATE_REFLECTION_REVIEW_PREFIX } from "../core/reflection-review.js";
import { RIVET_REPLY_PREFIX } from "../core/rivet.js";
import { PRIVATE_SENTINEL_PREFIX } from "../core/sentinel.js";
import { PRIVATE_SLACK_HISTORY_PREFIX } from "../core/slack-history.js";
import type { ImportPage, PageFetcher, Source } from "../memory/store.js";
import {
  bindCoverage,
  type ConnectorConfig,
  decode,
  getJson,
  ImportError,
  limited,
  nextCursor,
  type ProviderError,
  pageFetcher,
  readCursor,
} from "./common.js";
import { slackSource } from "./identity.js";

const timestamp = Schema.String.check(Schema.isPattern(/^\d+\.\d{6}$/));
const Identity = Schema.Struct({
  ok: Schema.Boolean,
  team_id: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
});
const Response = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  messages: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ts: timestamp,
        text: Schema.optional(Schema.String),
        user: Schema.optional(Schema.String),
        bot_id: Schema.optional(Schema.String),
        thread_ts: Schema.optional(timestamp),
        reply_count: Schema.optional(Schema.Finite),
        files: Schema.optional(Schema.Array(Schema.Unknown)),
      }),
    ),
  ),
  has_more: Schema.optional(Schema.Boolean),
  is_limited: Schema.optional(Schema.Boolean),
  response_metadata: Schema.optional(
    Schema.Struct({ next_cursor: Schema.optional(Schema.String) }),
  ),
});
const fail = (message: string) => new ImportError({ message });

/** Only ordinary retained Web API history. Never Slack RTS/search content. */
export function createSlackHistoryFetcher(
  config: ConnectorConfig,
): PageFetcher {
  const authorize = bindCoverage(config, "slack");
  if (
    !/^T[A-Z0-9]+$/.test(config.coverage.account) ||
    config.coverage.conversations.some(
      (c) => !/^[CGD][A-Z0-9]+(?:\/\d+\.\d{6})?$/.test(c),
    )
  )
    throw new Error("Select Slack workspace and channel or channel/thread IDs");
  const fetchPage = Effect.fn("june.imports.slack.page")(function* ({
    coverage,
    cursor,
  }: Parameters<PageFetcher>[0]): Effect.fn.Return<
    ImportPage,
    ImportError | ProviderError
  > {
    yield* authorize(coverage);
    const { index, token } = yield* readCursor(
      cursor,
      coverage.conversations.length,
    );
    const conversation = coverage.conversations[index];
    if (!conversation) return yield* fail("Missing selected conversation");
    const [channel, thread] = conversation.split("/");
    if (!channel) return yield* fail("Missing selected channel");
    const method = thread ? "conversations.replies" : "conversations.history";
    const url = new URL(`https://slack.com/api/${method}`);
    url.searchParams.set("channel", channel);
    if (thread) url.searchParams.set("ts", thread);
    url.searchParams.set(
      "oldest",
      `${Math.floor(coverage.from / 1000)}.${String(coverage.from % 1000).padStart(3, "0")}000`,
    );
    url.searchParams.set(
      "latest",
      `${Math.floor((coverage.to - 1) / 1000)}.${String((coverage.to - 1) % 1000).padStart(3, "0")}999`,
    );
    url.searchParams.set("inclusive", "true");
    url.searchParams.set("limit", "15");
    if (token) url.searchParams.set("cursor", token);
    // Pin one token for identity verification and history (refresh cannot switch accounts).
    const accessToken = yield* Effect.promise((signal) =>
      config.accessToken(signal),
    );
    const pinned = { ...config, accessToken: async () => accessToken };
    const identity = yield* decode(
      Identity,
      yield* getJson(pinned, new URL("https://slack.com/api/auth.test")),
    );
    if (!identity.ok || identity.team_id !== coverage.account)
      return yield* fail("Slack credential does not match selected workspace");
    if (
      !identity.url ||
      !/^https:\/\/[a-z0-9-]+\.slack\.com\/$/.test(identity.url)
    )
      return yield* fail("Slack did not return a workspace source URL");
    const data = yield* decode(Response, yield* getJson(pinned, url));
    if (!data.ok) {
      if (data.error === "ratelimited")
        return {
          sources: [],
          nextCursor: cursor,
          rateLimited: true,
          retryAfterMs: 60_000,
        };
      return yield* fail(
        "Slack history unavailable; check credentials, selection and permissions",
      );
    }
    if (!data.messages) return yield* fail("Slack history omitted messages");
    const gaps: string[] = token
      ? []
      : [
          `${conversation}: available retained messages only; deleted, expired and inaccessible history cannot be recovered; files are not downloaded.`,
          ...(thread
            ? []
            : [
                `${conversation}: channel timeline only; replies require separately authorized channel/thread selections, including threads with older roots.`,
              ]),
        ];
    if (data.is_limited)
      gaps.push(`${conversation}: Slack reports retention-limited history.`);
    const sources: Source[] = [];
    for (const message of data.messages) {
      if (
        message.text?.startsWith("##") ||
        message.text?.startsWith(PRIVATE_SLACK_HISTORY_PREFIX) ||
        message.text?.startsWith(PRIVATE_REFLECTION_REVIEW_PREFIX) ||
        message.text?.includes(PRIVATE_SENTINEL_PREFIX) ||
        message.text?.includes(RIVET_REPLY_PREFIX)
      )
        continue;
      const source = slackSource({
        workspace: coverage.account,
        channel,
        ts: message.ts,
        threadTs: message.thread_ts,
        author: message.user ?? message.bot_id ?? "unknown",
        text: redactBrowserPin(message.text ?? ""),
        workspaceUrl: identity.url,
        audiences: coverage.audiences,
      });
      if (source.observedAt < coverage.from || source.observedAt >= coverage.to)
        continue;
      if (thread && source.conversation !== conversation)
        return yield* fail("Slack returned a different thread");
      if (!thread && message.thread_ts && message.thread_ts !== message.ts)
        continue;
      if (!message.text)
        gaps.push(
          `${conversation}/${message.ts}: no plain text; non-text content omitted.`,
        );
      sources.push(source);
    }
    const next = data.response_metadata?.next_cursor ?? "";
    if (data.has_more && !next)
      return yield* fail("Slack truncated history without a resumable cursor");
    return {
      sources,
      gaps,
      nextCursor: yield* nextCursor(index, next, coverage.conversations.length),
      retryAfterMs: 60_000,
    };
  });
  return pageFetcher(config, (request) =>
    limited(fetchPage(request), request.cursor),
  );
}
