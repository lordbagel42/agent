import type { ChannelSearchResult, MessageEvent } from "../core/contracts.js";
import { redactBrowserPin } from "../core/private-input.js";

// Conservative local policy, not a statement about Slack's action-token expiry.
const GRANT_TTL_MS = 5 * 60_000;
const MAX_GRANTS = 256;
const MAX_TOKEN_LENGTH = 8_192;
const FETCH_TIMEOUT_MS = 10_000;
const RESULT_LIMIT = 5;
const RESULT_TEXT_LIMIT = 3_500;

type JsonObject = Record<string, unknown>;
type UnavailableCode = Extract<
  ChannelSearchResult,
  { status: "unavailable" }
>["code"];

/**
 * Supplied by trusted OAuth/credential code after admin installation and user
 * consent. Scopes must be the actual OAuth grant, never a manifest/model claim.
 */
export interface SlackPrivateSearchAuthorization {
  ownerId: string;
  teamId: string;
  userId: string;
  userToken: string;
  grantedScopes: readonly string[];
  expiresAt: number;
}

export interface SlackPrivateSearchOptions {
  /** Operator-verified owner identity, independent of the OAuth grant. */
  ownerId: string;
  userId: string;
  /**
   * Synchronous current authority; return undefined on revocation. The host must
   * keep this in sync with consent, not capture a static startup credential.
   * Never log returned credentials or expose them to model/history/import code.
   */
  getAuthorization(): SlackPrivateSearchAuthorization | undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(
  code: UnavailableCode = "unavailable",
): ChannelSearchResult {
  return { status: "unavailable", code };
}

function binding(event: MessageEvent): string {
  return JSON.stringify([
    event.id,
    event.type,
    event.address.channel,
    event.address.accountId,
    event.senderId,
    event.address.conversationId,
    event.address.threadId ?? null,
    event.messageId,
    event.occurredAt,
    event.direct,
  ]);
}

// Slack only defines entities for &, < and >. Replace the other control syntax
// with readable punctuation, including @ and URL punctuation to prevent pings
// and automatic bare-link conversion. Never truncate an entity or codepoint.
const TEXT_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "|": "｜",
  "*": "＊",
  _: "＿",
  "~": "～",
  "`": "｀",
  "@": "＠",
  ".": "．",
  ":": "：",
};

function escapeText(value: string, limit: number): string {
  let text = "";
  let length = 0;
  const plain = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  for (const character of plain) {
    const escaped = TEXT_ESCAPES[character] ?? character;
    const size = Array.from(escaped).length;
    if (length + size > limit - 1) return `${text}…`;
    text += escaped;
    length += size;
  }
  return text;
}

function safePermalink(
  message: JsonObject,
  privateSearch: boolean,
): string | undefined {
  if (
    typeof message.permalink !== "string" ||
    message.permalink.length > 256 ||
    typeof message.message_ts !== "string" ||
    !/^\d+\.\d+$/.test(message.message_ts)
  )
    return undefined;

  // Match the original string, not a URL parser's normalized path. No ports,
  // credentials, escaping, query/fragment, redirects, or non-message surfaces.
  const match =
    /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.slack\.com\/archives\/([CGD][A-Z0-9]+)\/p(\d+)$/.exec(
      message.permalink,
    );
  if (
    !match ||
    (!privateSearch && !match[1]?.startsWith("C")) ||
    match[1] !== message.channel_id ||
    match[2] !== message.message_ts.replace(".", "")
  )
    return undefined;
  return message.permalink;
}

function formatResults(
  payload: JsonObject,
  teamId: string,
  privateSearch = false,
): ChannelSearchResult {
  if (!isObject(payload.results) || !Array.isArray(payload.results.messages)) {
    return unavailable();
  }

  const snippets: string[] = [];
  for (const message of payload.results.messages.slice(0, RESULT_LIMIT)) {
    if (
      !isObject(message) ||
      message.team_id !== teamId ||
      message.is_author_bot !== false ||
      typeof message.channel_name !== "string" ||
      typeof message.author_name !== "string" ||
      typeof message.content !== "string" ||
      !message.content.trim()
    )
      continue;
    const link = safePermalink(message, privateSearch);
    if (!link) continue;

    const label = `${escapeText(message.channel_name, 45)} — ${escapeText(message.author_name, 45)}`;
    const citation = `• <${link}|#${label}>\n`;
    // Five complete citations/snippets plus separators remain below 3,500.
    const snippetBudget =
      Math.floor(RESULT_TEXT_LIMIT / RESULT_LIMIT) -
      2 -
      Array.from(citation).length;
    snippets.push(
      `${citation}${escapeText(redactBrowserPin(message.content), snippetBudget)}`,
    );
  }
  return {
    status: "ready",
    text:
      snippets.length > 0
        ? snippets.join("\n\n")
        : privateSearch
          ? "No matching Slack messages found in the authorized search scope."
          : "No matching public Slack messages found.",
  };
}

function slackError(error: unknown): ChannelSearchResult {
  if (error === "rate_limited" || error === "ratelimited") {
    return unavailable("rate_limited");
  }
  switch (error) {
    case "invalid_action_token":
    case "missing_scope":
    case "invalid_auth":
    case "not_authed":
    case "token_expired":
    case "token_revoked":
    case "no_permission":
    case "team_access_not_granted":
    case "access_denied":
    case "account_inactive":
    case "not_allowed_token_type":
    case "context_channel_not_found":
      return unavailable("authorization_required");
    default:
      return unavailable();
  }
}

/** Private adapter state: never attach grants or search output to ChannelEvent. */
export function createSlackSearch({
  teamId,
  botToken,
  fetch: fetchImpl,
  now,
  privateSearch,
}: {
  teamId: string;
  botToken: string;
  fetch: typeof globalThis.fetch;
  now: () => number;
  privateSearch?: SlackPrivateSearchOptions;
}) {
  function authorization(event: MessageEvent) {
    if (
      !privateSearch ||
      !event.direct ||
      !/^D[A-Z0-9]+$/.test(event.address.conversationId) ||
      event.address.channel !== "slack" ||
      event.address.accountId !== teamId ||
      event.senderId !== privateSearch.userId
    )
      return undefined;
    try {
      const grant = privateSearch.getAuthorization();
      if (
        !grant ||
        grant.ownerId !== privateSearch.ownerId ||
        grant.teamId !== teamId ||
        grant.userId !== privateSearch.userId ||
        !grant.userToken.startsWith("xoxp-") ||
        !Number.isFinite(grant.expiresAt) ||
        grant.expiresAt <= now() ||
        !grant.grantedScopes.includes("search:read.public")
      )
        return undefined;
      const channelTypes = ["public_channel"];
      for (const [scope, type] of [
        ["search:read.private", "private_channel"],
        ["search:read.im", "im"],
        ["search:read.mpim", "mpim"],
      ] as const) {
        if (grant.grantedScopes.includes(scope)) channelTypes.push(type);
      }
      if (channelTypes.length === 1) return undefined;
      return {
        ...grant,
        grantedScopes: [...grant.grantedScopes],
        channelTypes,
      };
    } catch {
      return undefined;
    }
  }

  const grants = new Map<
    string,
    {
      binding: string;
      token?: string;
      privateAuthorization?: string;
      spent: boolean;
      expiresAt: number;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  function prune(time: number) {
    for (const [id, grant] of grants) {
      if (grant.expiresAt <= time) {
        clearTimeout(grant.timer);
        grants.delete(id);
      }
    }
  }

  return {
    /** Local presence only: do not consume the token or probe Slack permissions. */
    hasActionToken(event: MessageEvent): boolean {
      const grant = grants.get(event.id);
      return (
        event.address.channel === "slack" &&
        event.address.accountId === teamId &&
        !!grant?.token &&
        !grant.spent &&
        grant.expiresAt > now() &&
        grant.binding === binding(event)
      );
    },

    /** Call only after authenticating the bytes, workspace, and human event. */
    capture(event: MessageEvent, token: unknown): void {
      const time = now();
      prune(time);
      // Use the signed event time, not delivery time: a retry cannot revive an
      // expired entry after its tombstone is removed. Reject clock-future events.
      const expiresAt = event.occurredAt + GRANT_TTL_MS;
      const privateGrant =
        privateSearch && event.direct ? authorization(event) : undefined;
      if (
        (privateSearch && event.direct
          ? !privateGrant
          : typeof token !== "string" ||
            !token.trim() ||
            token.length > MAX_TOKEN_LENGTH) ||
        !Number.isFinite(event.occurredAt) ||
        event.occurredAt > time ||
        expiresAt <= time ||
        grants.has(event.id) ||
        grants.size >= MAX_GRANTS
      )
        return;

      const id = event.id;
      // Active expiry also releases unused tokens when no more traffic arrives.
      const timer = setTimeout(() => grants.delete(id), expiresAt - time);
      timer.unref();
      grants.set(id, {
        binding: binding(event),
        ...(privateGrant
          ? { privateAuthorization: JSON.stringify(privateGrant) }
          : { token: token as string }),
        spent: false,
        expiresAt,
        timer,
      });
    },

    async search(
      event: MessageEvent,
      query: string,
      canStartAction?: () => boolean,
    ): Promise<ChannelSearchResult> {
      if (canStartAction?.() === false) return unavailable();
      prune(now());
      const grant = grants.get(event.id);
      if (
        event.address.channel !== "slack" ||
        event.address.accountId !== teamId ||
        !grant ||
        grant.spent ||
        (!grant.token && !grant.privateAuthorization) ||
        grant.binding !== binding(event)
      )
        return unavailable("authorization_required");

      if (typeof query !== "string") return unavailable();
      const trimmed = query.trim();
      if (!trimmed || Array.from(trimmed).length > 500) return unavailable();

      const token = grant.token;
      const privateGrant = grant.privateAuthorization
        ? authorization(event)
        : undefined;
      const privateBinding = grant.privateAuthorization;
      const eventBinding = grant.binding;
      // A top-level DM may be answered in a thread on that exact message.
      // Keep ingress authorization exact; only delivery gains this destination.
      const replyBinding = event.address.threadId
        ? eventBinding
        : binding({
            ...event,
            address: { ...event.address, threadId: event.messageId },
          });
      const authorized = (candidate: MessageEvent) =>
        now() < grant.expiresAt &&
        (binding(candidate) === eventBinding ||
          binding(candidate) === replyBinding) &&
        JSON.stringify(authorization(candidate)) === privateBinding;
      // Spend before the first await, even if the request fails. Keep a tokenless
      // tombstone until expiry, and never evict one to make room for a new grant.
      grant.spent = true;
      delete grant.token;
      delete grant.privateAuthorization;
      if (privateBinding && (!privateGrant || !authorized(event)))
        return unavailable("authorization_required");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        if (privateGrant) {
          // OAuth grant metadata is not enough: verify the token's actual user
          // and workspace. No identity/grant discovery calls at construction.
          const identityResponse = await fetchImpl(
            "https://slack.com/api/auth.test",
            {
              method: "POST",
              headers: { authorization: `Bearer ${privateGrant.userToken}` },
              signal: controller.signal,
              redirect: "error",
            },
          );
          if (identityResponse.status === 429)
            return unavailable("rate_limited");
          if (!identityResponse.ok)
            return unavailable("authorization_required");
          const identity: unknown = await identityResponse.json();
          if (
            !isObject(identity) ||
            identity.ok !== true ||
            identity.team_id !== teamId ||
            identity.user_id !== privateGrant.userId ||
            identity.bot_id !== undefined ||
            !authorized(event)
          )
            return unavailable("authorization_required");
        }
        if (canStartAction?.() === false) return unavailable();
        const response = await fetchImpl(
          "https://slack.com/api/assistant.search.context",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${privateGrant?.userToken ?? botToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              query: trimmed,
              ...(privateGrant ? {} : { action_token: token }),
              context_channel_id: event.address.conversationId,
              content_types: ["messages"],
              channel_types: privateGrant?.channelTypes ?? ["public_channel"],
              include_context_messages: false,
              include_bots: false,
              limit: RESULT_LIMIT,
            }),
            signal: controller.signal,
            redirect: "error",
          },
        );
        if (response.status === 429) return unavailable("rate_limited");
        if (response.status === 401 || response.status === 403) {
          return unavailable("authorization_required");
        }
        if (!response.ok) return unavailable();
        const payload: unknown = await response.json();
        if (!isObject(payload) || typeof payload.ok !== "boolean")
          return unavailable();
        if (!payload.ok) return slackError(payload.error);
        if (privateGrant && !authorized(event))
          return unavailable("authorization_required");
        const result = formatResults(payload, teamId, Boolean(privateGrant));
        if (privateGrant && result.status === "ready") {
          let text: string | undefined = result.text;
          const expiry = setTimeout(() => {
            text = undefined;
          }, Math.min(grant.expiresAt, privateGrant.expiresAt) - now());
          expiry.unref();
          return {
            status: "private_ready",
            // The host supplies the ACTUAL outbound address, then sends without
            // awaiting or persisting in between. Even a rejected attempt spends
            // this closure; revocation cannot be undone by retrying delivery.
            consume(candidate) {
              const value = text;
              text = undefined;
              clearTimeout(expiry);
              return value !== undefined && authorized(candidate)
                ? value
                : undefined;
            },
          };
        }
        return result;
      } catch {
        // Never expose exceptions, HTTP bodies, queries, or tokens to callers.
        return unavailable();
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
