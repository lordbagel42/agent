import type { ChannelAdapter, SendResult } from "../core/contracts.js";
import { RIVET_REPLY_PREFIX } from "../core/rivet.js";
import {
  PRIVATE_SLACK_HISTORY_PREFIX,
  slackHistorySchema,
} from "../core/slack-history.js";

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && /^\d+\.\d{6}$/.test(value);
const escapeText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

class HistoryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Bot-token reads only. Raw text goes straight to a verified owner DM, never
 * through a model, a user-token search, a caller-selected destination or a log. */
export function createSlackHistory({
  teamId,
  botUserId,
  botToken,
  ownerUserIds,
  fetch: fetchImpl,
  send,
}: {
  teamId: string;
  botUserId: string;
  botToken: string;
  ownerUserIds: ReadonlySet<string>;
  fetch: typeof globalThis.fetch;
  send: ChannelAdapter["send"];
}): NonNullable<ChannelAdapter["shareHistory"]> {
  return async (event, input, operationId, isCurrent, signal) => {
    const rejected = (code: string): SendResult => ({
      status: "rejected",
      code,
      retryable: false,
    });
    const ownerId = event.senderId;
    if (
      event.address.channel !== "slack" ||
      event.address.accountId !== teamId ||
      !ownerUserIds.has(ownerId) ||
      ownerId === botUserId
    )
      return rejected("history_owner_required");
    const parsed = slackHistorySchema.safeParse(input);
    if (!parsed.success) return rejected("history_invalid_request");
    const request = parsed.data;
    const deadline = AbortSignal.timeout(15_000);
    const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const check = async () => {
      readSignal.throwIfAborted();
      if (!ownerUserIds.has(ownerId) || !(await isCurrent()))
        throw new HistoryError("history_invalidated");
      readSignal.throwIfAborted();
    };
    async function read(
      method: string,
      body: JsonObject = {},
    ): Promise<JsonObject> {
      await check();
      // auth.teams.list documents form encoding, unlike the conversation APIs.
      const form = method === "auth.teams.list";
      const response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${botToken}`,
          "content-type": form
            ? "application/x-www-form-urlencoded"
            : "application/json",
        },
        body: form
          ? new URLSearchParams(
              Object.entries(body).map(([key, value]) => [key, String(value)]),
            )
          : JSON.stringify(body),
        signal: readSignal,
      });
      if (response.status === 429)
        throw new HistoryError("history_rate_limited");
      if (!response.ok) throw new HistoryError("history_unavailable");
      const data: unknown = await response.json();
      if (!isObject(data) || data.ok !== true) {
        const code = isObject(data) ? data.error : undefined;
        throw new HistoryError(
          code === "missing_scope"
            ? "history_missing_scope"
            : code === "ratelimited"
              ? "history_rate_limited"
              : "history_unavailable",
        );
      }
      return data;
    }
    function nextCursor(data: JsonObject): string {
      const value = isObject(data.response_metadata)
        ? data.response_metadata.next_cursor
        : undefined;
      if (value === undefined || value === "") return "";
      if (typeof value !== "string" || value.length > 2000)
        throw new HistoryError("history_unavailable");
      return value;
    }
    async function info(channel: string): Promise<JsonObject> {
      const data = await read("conversations.info", { channel });
      if (!isObject(data.channel) || data.channel.id !== channel)
        throw new HistoryError("history_unavailable");
      return data.channel;
    }
    async function userId(target: string): Promise<string> {
      const mention = /^<@([UW][A-Z0-9]+)(?:\|[^>]+)?>$/.exec(target);
      if (mention?.[1]) return mention[1];
      if (/^[UW][A-Z0-9]+$/.test(target)) return target;
      const name = target.replace(/^@/, "").toLowerCase();
      const matches = new Set<string>();
      let cursor = "";
      for (let page = 0; page < 5; page++) {
        const data = await read("users.list", {
          team_id: teamId,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        if (!Array.isArray(data.members))
          throw new HistoryError("history_unavailable");
        for (const user of data.members) {
          if (
            !isObject(user) ||
            typeof user.id !== "string" ||
            !/^[UW][A-Z0-9]+$/.test(user.id)
          )
            continue;
          const profile = isObject(user.profile) ? user.profile : {};
          if (
            [
              user.name,
              user.real_name,
              profile.display_name,
              profile.real_name,
            ].some(
              (value) =>
                typeof value === "string" && value.toLowerCase() === name,
            )
          )
            matches.add(user.id);
        }
        if (matches.size > 1) throw new HistoryError("history_use_user_id");
        cursor = nextCursor(data);
        if (!cursor) {
          const match = matches.values().next().value;
          if (match) return match;
          break;
        }
      }
      // An incomplete directory is not proof a name is unique.
      throw new HistoryError("history_use_user_id");
    }
    try {
      const identity = await read("auth.test");
      if (identity.user_id !== botUserId || !identity.bot_id)
        throw new HistoryError("history_wrong_identity");
      const enterprise = identity.is_enterprise_install === true;
      if (enterprise) {
        // Org tokens identify the enterprise, not the workspace. Verify the
        // workspace grant explicitly rather than accepting any enterprise ID.
        let approved = false;
        let cursor = "";
        for (let page = 0; page < 5; page++) {
          const data = await read("auth.teams.list", {
            limit: 200,
            ...(cursor ? { cursor } : {}),
          });
          if (!Array.isArray(data.teams))
            throw new HistoryError("history_unavailable");
          approved = data.teams.some(
            (team) => isObject(team) && team.id === teamId,
          );
          if (approved) break;
          cursor = nextCursor(data);
          if (!cursor) break;
        }
        if (!approved) throw new HistoryError("history_wrong_identity");
      } else if (identity.team_id !== teamId) {
        throw new HistoryError("history_wrong_identity");
      }
      let target = request.target;
      const targetUser = /^[CDG][A-Z0-9]+$/.test(target)
        ? undefined
        : await userId(target);
      let ownerDm: string | undefined;
      let targetDm: string | undefined;
      let cursor = "";
      for (let page = 0; page < 5; page++) {
        const data = await read("conversations.list", {
          team_id: teamId,
          types: "im",
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        if (!Array.isArray(data.channels))
          throw new HistoryError("history_unavailable");
        for (const channel of data.channels) {
          if (
            !isObject(channel) ||
            channel.is_im !== true ||
            typeof channel.id !== "string" ||
            !/^D[A-Z0-9]+$/.test(channel.id)
          )
            continue;
          if (channel.user === ownerId) ownerDm = channel.id;
          if (channel.user === targetUser) targetDm = channel.id;
        }
        if (ownerDm && (!targetUser || targetDm)) break;
        cursor = nextCursor(data);
        if (!cursor) break;
      }
      if (!ownerDm) throw new HistoryError("history_owner_dm_unavailable");
      if (targetUser) {
        if (!targetDm) throw new HistoryError("history_dm_not_found");
        target = targetDm;
      }
      if (enterprise && !targetUser && target !== ownerDm) {
        // An org token can read a supplied ID from a different workspace.
        // Require explicit source IDs in the bot's workspace-scoped membership
        // list before even requesting conversation info (which may include text).
        let member = false;
        let cursor = "";
        for (let page = 0; page < 5; page++) {
          const data = await read("users.conversations", {
            team_id: teamId,
            types: target.startsWith("D")
              ? "im"
              : "public_channel,private_channel,mpim",
            limit: 200,
            ...(cursor ? { cursor } : {}),
          });
          if (!Array.isArray(data.channels))
            throw new HistoryError("history_unavailable");
          member = data.channels.some(
            (channel) => isObject(channel) && channel.id === target,
          );
          if (member) break;
          cursor = nextCursor(data);
          if (!cursor) break;
        }
        if (!member) throw new HistoryError("history_not_a_member");
      }
      // Confirm the recipient before fetching any contents. An owner user ID is
      // not a destination, and a channel named after the owner is never a DM.
      const destination = await info(ownerDm);
      if (
        destination.is_im !== true ||
        destination.is_mpim === true ||
        destination.user !== ownerId
      )
        throw new HistoryError("history_owner_dm_unavailable");
      const source = target === ownerDm ? destination : await info(target);
      if (source.is_im === true) {
        if (
          source.is_mpim === true ||
          !/^D[A-Z0-9]+$/.test(target) ||
          typeof source.user !== "string" ||
          (targetUser && source.user !== targetUser)
        )
          throw new HistoryError("history_not_a_member");
      } else if (source.is_member !== true || !/^[CG][A-Z0-9]+$/.test(target)) {
        throw new HistoryError("history_not_a_member");
      }
      const data = await read(
        request.threadTs ? "conversations.replies" : "conversations.history",
        {
          channel: target,
          limit: 15,
          ...(request.threadTs ? { ts: request.threadTs } : {}),
          ...(request.cursor ? { cursor: request.cursor } : {}),
        },
      );
      if (!Array.isArray(data.messages))
        throw new HistoryError("history_unavailable");
      const rows: string[] = [];
      for (const message of data.messages.slice(0, 15)) {
        if (
          !isObject(message) ||
          !timestamp(message.ts) ||
          message.hidden === true ||
          message.subtype === "message_deleted" ||
          message.subtype === "message_changed" ||
          (message.channel !== undefined && message.channel !== target) ||
          (request.threadTs &&
            message.ts !== request.threadTs &&
            message.thread_ts !== request.threadTs) ||
          (!request.threadTs &&
            message.thread_ts !== undefined &&
            message.thread_ts !== message.ts)
        )
          continue;
        // Do not wrap a volatile inspection in another transcript: excerpting
        // could remove its marker and let a later read retain the copied body.
        if (
          typeof message.text === "string" &&
          (message.text.includes(RIVET_REPLY_PREFIX) ||
            (message.user === botUserId &&
              message.text.startsWith(PRIVATE_SLACK_HISTORY_PREFIX)))
        )
          continue;
        const author =
          typeof message.user === "string" &&
          /^[UW][A-Z0-9]+$/.test(message.user)
            ? message.user
            : typeof message.bot_id === "string" &&
                /^B[A-Z0-9]+$/.test(message.bot_id)
              ? message.bot_id
              : "unknown";
        const text =
          typeof message.text === "string"
            ? message.text
            : "[No plain text; attachments are not downloaded.]";
        const escaped = escapeText(text);
        const excerpt = Array.from(escaped).slice(0, 1800).join("");
        rows.push(
          `${author === botUserId ? "June" : author} · ${message.ts}${typeof message.reply_count === "number" && message.reply_count > 0 ? ` · ${message.reply_count} thread replies` : ""}\n${excerpt}${excerpt !== escaped ? "\n[Message truncated at 1800 escaped characters.]" : ""}`,
        );
      }
      const next = nextCursor(data);
      const text =
        PRIVATE_SLACK_HISTORY_PREFIX +
        `Source: ${target}${request.threadTs ? ` / ${request.threadTs}` : " (timeline; thread replies require a separate lookup)"}\n` +
        "Available retained plain text only; at most 15 messages per page. Attachments, deleted and expired messages are not recovered.\n\n" +
        (rows.join("\n\n") || "No readable messages on this page.") +
        (data.is_limited === true
          ? "\n\nSlack reports retention-limited history."
          : "") +
        (next
          ? `\n\nMore history is available. Ask me to continue with target ${target}${request.threadTs ? `, threadTs ${request.threadTs}` : ""}, cursor ${escapeText(next)}.`
          : data.has_more === true
            ? "\n\nSlack reports more history but supplied no continuation cursor; this is incomplete."
            : "\n\nEnd of this available page range; this is not proof of complete history.");
      // Revalidate after reads as well as before them. Raw content is never
      // returned, and callers cannot redirect it through reply placement.
      const currentDestination = await info(ownerDm);
      if (
        currentDestination.is_im !== true ||
        currentDestination.is_mpim === true ||
        currentDestination.user !== ownerId
      )
        throw new HistoryError("history_owner_dm_unavailable");
      await check();
      const result = await send({
        id: operationId,
        address: {
          channel: "slack",
          accountId: teamId,
          conversationId: ownerDm,
        },
        lastInboundAt: event.occurredAt,
        content: { type: "text", text },
      }).catch(
        (): SendResult => ({
          status: "unknown",
          code: "history_send_uncertain",
        }),
      );
      // Slack documents partial success for these errors, even with HTTP 200.
      return result.status === "rejected" &&
        (result.code === "internal_error" || result.code === "fatal_error")
        ? { status: "unknown", code: "history_send_uncertain" }
        : result;
    } catch (error) {
      return rejected(
        error instanceof HistoryError ? error.code : "history_unavailable",
      );
    }
  };
}
