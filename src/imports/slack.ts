import { z } from "zod";
import { redactBrowserPin } from "../core/private-input.js";
import { PRIVATE_REFLECTION_REVIEW_PREFIX } from "../core/reflection-review.js";
import { RIVET_REPLY_PREFIX } from "../core/rivet.js";
import { PRIVATE_SENTINEL_PREFIX } from "../core/sentinel.js";
import { PRIVATE_SLACK_HISTORY_PREFIX } from "../core/slack-history.js";
import type { PageFetcher, Source } from "../memory/store.js";
import {
  bindCoverage,
  type ConnectorConfig,
  decode,
  getJson,
  limited,
  nextCursor,
  readCursor,
} from "./common.js";
import { slackSource } from "./identity.js";

const timestamp = z.string().regex(/^\d+\.\d{6}$/);
const responseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  messages: z
    .array(
      z.object({
        ts: timestamp,
        text: z.string().optional(),
        user: z.string().optional(),
        bot_id: z.string().optional(),
        thread_ts: timestamp.optional(),
        reply_count: z.number().optional(),
        files: z.array(z.unknown()).optional(),
      }),
    )
    .optional(),
  has_more: z.boolean().optional(),
  is_limited: z.boolean().optional(),
  response_metadata: z
    .object({ next_cursor: z.string().optional() })
    .optional(),
});

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
  return async ({ coverage, cursor, signal }) => {
    authorize(coverage);
    const { index, token } = readCursor(cursor, coverage.conversations.length);
    const conversation = coverage.conversations[index];
    if (!conversation) throw new Error("Missing selected conversation");
    const [channel, thread] = conversation.split("/");
    if (!channel) throw new Error("Missing selected channel");
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
    try {
      // Pin one token for identity verification and history (refresh cannot switch accounts).
      signal?.throwIfAborted();
      const accessToken = await config.accessToken(signal);
      const pinned = { ...config, accessToken: async () => accessToken };
      const identity = decode(
        z.object({
          ok: z.boolean(),
          team_id: z.string().optional(),
          url: z.string().optional(),
        }),
        await getJson(
          pinned,
          new URL("https://slack.com/api/auth.test"),
          signal,
        ),
      );
      if (!identity.ok || identity.team_id !== coverage.account)
        throw new Error("Slack credential does not match selected workspace");
      if (
        !identity.url ||
        !/^https:\/\/[a-z0-9-]+\.slack\.com\/$/.test(identity.url)
      )
        throw new Error("Slack did not return a workspace source URL");
      const data = decode(responseSchema, await getJson(pinned, url, signal));
      if (!data.ok) {
        if (data.error === "ratelimited")
          return {
            sources: [],
            nextCursor: cursor,
            rateLimited: true,
            retryAfterMs: 60_000,
          };
        throw new Error(
          "Slack history unavailable; check credentials, selection and permissions",
        );
      }
      if (!data.messages) throw new Error("Slack history omitted messages");
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
        if (
          source.observedAt < coverage.from ||
          source.observedAt >= coverage.to
        )
          continue;
        if (thread && source.conversation !== conversation)
          throw new Error("Slack returned a different thread");
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
        throw new Error("Slack truncated history without a resumable cursor");
      return {
        sources,
        gaps,
        nextCursor: nextCursor(index, next, coverage.conversations.length),
        retryAfterMs: 60_000,
      };
    } catch (error) {
      const page = limited(error, cursor);
      if (page) return page;
      throw error;
    }
  };
}
