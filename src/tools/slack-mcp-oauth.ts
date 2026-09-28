import { randomBytes } from "node:crypto";

export const SLACK_MCP_URL = "https://mcp.slack.com/mcp";
export const SLACK_APP_ID = "A0C4749KM3R";
const RESOURCE = "https://mcp.slack.com";
const AUTHORIZE = "https://slack.com/oauth/v2_user/authorize";
const TOKEN = "https://slack.com/api/oauth.v2.user.access";
const AUTH_TEST = "https://slack.com/api/auth.test";
const TTL = 600_000;
const MAX_ATTEMPTS = 32;

export const slackOAuthStages = [
  "callback",
  "token_exchange",
  "token_validation",
  "scope_validation",
  "token_lifetime",
  "identity_request",
  "identity_validation",
  "connection_generation",
  "save",
] as const;
// Only these fixed labels may reach diagnostics, never provider text or values.
export const slackOAuthReasons = [
  "validation_failed",
  "operation_failed",
  "provider_rejected",
  "http_error",
  "timeout",
  "wrong_user",
  "wrong_team",
  "wrong_app",
  "invalid_code",
  "invalid_client_id",
  "bad_client_secret",
  "bad_redirect_uri",
  "invalid_scope",
  "missing_scope",
  "invalid_auth",
  "access_denied",
  "token_revoked",
  "token_expired",
  "ratelimited",
  "team_access_not_granted",
  "oauth_authorization_url_mismatch",
] as const;
export interface SlackMcpOAuthFailure {
  stage: (typeof slackOAuthStages)[number];
  reason: (typeof slackOAuthReasons)[number];
}

export interface SlackMcpOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  teamId: string;
  userId: string;
  scopes: readonly string[];
  /** Current connection generation; disconnect must change it, even if absent. */
  generation?(): string;
  onFailure?(failure: SlackMcpOAuthFailure): void;
  saveAuthorization(value: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    userId: string;
    teamId: string;
    scopes: string[];
  }): Promise<void>;
}

class OAuthFailure extends Error {
  constructor(readonly reason: SlackMcpOAuthFailure["reason"]) {
    super("slack_mcp_oauth_failed");
  }
}

function failed(
  reason: SlackMcpOAuthFailure["reason"] = "validation_failed",
): never {
  throw new OAuthFailure(reason);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) failed();
  return value as Record<string, unknown>;
}

/** The caller authenticates the owner before BOTH methods and supplies the same
 * stable, server-authenticated principal (never a callback/query parameter).
 * State stays volatile, owner-bound and one-use; a failed exchange/save requires
 * a fresh begin. This confidential-client flow deliberately does not enable PKCE.
 * Never log callback URLs, credentials, tokens, or upstream response bodies.
 */
export function createSlackMcpOAuth(
  options: SlackMcpOAuthOptions,
  dependencies: { fetch?: typeof fetch; now?: () => number } = {},
) {
  const { clientId, clientSecret, teamId, userId, saveAuthorization } = options;
  const scopes = [...options.scopes];
  let redirect: URL;
  try {
    redirect = new URL(options.redirectUrl);
  } catch {
    return failed();
  }
  if (
    !clientId ||
    !clientSecret ||
    !teamId ||
    !userId ||
    (redirect.protocol !== "https:" &&
      !(redirect.protocol === "http:" && redirect.hostname === "127.0.0.1")) ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    !scopes.length ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !/^[a-z][a-z0-9:._-]*$/.test(scope))
  )
    failed();
  const redirectUrl = redirect.href;
  const now = dependencies.now ?? Date.now;
  const fetchImpl = dependencies.fetch ?? fetch;
  const attempts = new Map<
    string,
    {
      principal: string;
      expiresAt: number;
      exchanging: boolean;
      generation: string | undefined;
    }
  >();

  function prune() {
    for (const [state, attempt] of attempts) {
      if (!attempt.exchanging && now() >= attempt.expiresAt)
        attempts.delete(state);
    }
  }

  async function request(url: string, init: RequestInit) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(url, {
            ...init,
            signal: controller.signal,
            redirect: "error",
            credentials: "omit",
          });
          if (!response.ok || response.redirected) failed("http_error");
          const reader = response.body?.getReader();
          if (!reader) failed();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              controller.signal.throwIfAborted();
              const { value, done } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 65_536) failed();
              chunks.push(value);
            }
          } finally {
            void reader.cancel().catch(() => {});
          }
          controller.signal.throwIfAborted();
          const result = record(JSON.parse(Buffer.concat(chunks).toString()));
          if (result.ok !== true)
            failed(
              slackOAuthReasons.find((reason) => reason === result.error) ??
                "provider_rejected",
            );
          return result;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new OAuthFailure("timeout"));
          }, 15_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  function grantedScopes(value: unknown): string[] {
    if (typeof value !== "string" || !value.trim()) failed();
    const granted = value.split(/[\s,]+/).filter(Boolean);
    if (!granted.length || granted.some((scope) => !scopes.includes(scope)))
      failed();
    return [...new Set(granted)];
  }

  return {
    begin(principal: string): string {
      prune();
      if (!principal || principal.length > 1024) failed();
      // An owner-authorized restart replaces abandoned consent, not an exchange
      // already in flight. Old callback states can never authorize the new attempt.
      for (const [state, attempt] of attempts) {
        if (attempt.principal !== principal) continue;
        if (attempt.exchanging) failed();
        attempts.delete(state);
      }
      if (attempts.size >= MAX_ATTEMPTS) failed();
      const state = randomBytes(32).toString("base64url");
      attempts.set(state, {
        principal,
        expiresAt: now() + TTL,
        exchanging: false,
        generation: options.generation?.(),
      });
      const url = new URL(AUTHORIZE);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUrl,
        response_type: "code",
        scope: scopes.join(","),
        team: teamId,
        resource: RESOURCE,
        state,
      }).toString();
      return url.href;
    },
    async complete(principal: string, callbackUrl: string): Promise<void> {
      let consumedState: string | undefined;
      let stage: SlackMcpOAuthFailure["stage"] = "callback";
      try {
        prune();
        if (callbackUrl.length > 16_384) failed();
        const callback = new URL(callbackUrl);
        const state = callback.searchParams.get("state") ?? "";
        const attempt = attempts.get(state);
        if (
          !attempt ||
          attempt.exchanging ||
          attempt.principal !== principal ||
          now() >= attempt.expiresAt ||
          callback.origin !== redirect.origin ||
          callback.pathname !== redirect.pathname ||
          callback.username ||
          callback.password ||
          callback.hash ||
          callback.searchParams.getAll("state").length !== 1
        )
          failed();
        attempt.exchanging = true;
        consumedState = state;
        const code = callback.searchParams.get("code");
        if (
          !code ||
          code.length > 8192 ||
          callback.searchParams.has("error") ||
          [...callback.searchParams.keys()].some(
            (key) => callback.searchParams.getAll(key).length !== 1,
          ) ||
          (callback.searchParams.has("iss") &&
            callback.searchParams.get("iss") !== RESOURCE)
        )
          failed();
        stage = "token_exchange";
        const token = await request(TOKEN, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUrl,
            resource: RESOURCE,
          }),
        });
        stage = "token_validation";
        const receivedAt = now();
        const user = record(token.authed_user);
        const team = record(token.team);
        if (
          token.token_type !== "user" ||
          typeof token.access_token !== "string" ||
          !token.access_token ||
          token.access_token.startsWith("xoxb-") ||
          token.bot_user_id
        )
          failed();
        if (user.id !== userId) failed("wrong_user");
        if (team.id !== teamId) failed("wrong_team");
        if (token.app_id !== undefined && token.app_id !== SLACK_APP_ID)
          failed("wrong_app");
        stage = "scope_validation";
        const granted = grantedScopes(user.scope);
        if (token.scope !== undefined) grantedScopes(token.scope);
        stage = "token_lifetime";
        if (
          (token.refresh_token !== undefined &&
            (typeof token.refresh_token !== "string" ||
              !token.refresh_token)) ||
          (token.expires_in !== undefined &&
            (typeof token.expires_in !== "number" ||
              !Number.isSafeInteger(token.expires_in) ||
              token.expires_in <= 0 ||
              !Number.isSafeInteger(receivedAt + token.expires_in * 1000)))
        )
          failed();
        stage = "identity_request";
        const identity = await request(AUTH_TEST, {
          method: "POST",
          headers: { authorization: `Bearer ${token.access_token}` },
        });
        stage = "identity_validation";
        if (identity.user_id !== userId) failed("wrong_user");
        if (identity.team_id !== teamId) failed("wrong_team");
        if (identity.bot_id || identity.is_bot === true) failed();
        stage = "connection_generation";
        if (attempt.generation !== options.generation?.()) failed();
        stage = "save";
        await saveAuthorization({
          accessToken: token.access_token,
          ...(typeof token.refresh_token === "string"
            ? { refreshToken: token.refresh_token }
            : {}),
          ...(typeof token.expires_in === "number"
            ? { expiresAt: receivedAt + token.expires_in * 1000 }
            : {}),
          userId,
          teamId,
          scopes: granted,
        });
      } catch (error) {
        try {
          options.onFailure?.({
            stage,
            reason:
              error instanceof OAuthFailure ? error.reason : "operation_failed",
          });
        } catch {
          // Diagnostics must not change the outcome or expose their own errors.
        }
        failed();
      } finally {
        if (consumedState) attempts.delete(consumedState);
      }
    },
  };
}
