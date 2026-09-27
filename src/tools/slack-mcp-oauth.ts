import { randomBytes } from "node:crypto";

export const SLACK_MCP_URL = "https://mcp.slack.com/mcp";
export const SLACK_APP_ID = "A0C4749KM3R";
const RESOURCE = "https://mcp.slack.com";
const AUTHORIZE = "https://slack.com/oauth/v2_user/authorize";
const TOKEN = "https://slack.com/api/oauth.v2.user.access";
const AUTH_TEST = "https://slack.com/api/auth.test";
const TTL = 600_000;
const MAX_ATTEMPTS = 32;

export interface SlackMcpOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  teamId: string;
  userId: string;
  scopes: readonly string[];
  /** Current connection generation; disconnect must change it, even if absent. */
  generation?(): string;
  saveAuthorization(value: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    userId: string;
    teamId: string;
    scopes: string[];
  }): Promise<void>;
}

function failed(): never {
  throw new Error("slack_mcp_oauth_failed");
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
          if (!response.ok || response.redirected) failed();
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
          if (result.ok !== true) failed();
          return result;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("slack_mcp_oauth_failed"));
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
      if (
        !principal ||
        principal.length > 1024 ||
        attempts.size >= MAX_ATTEMPTS ||
        [...attempts.values()].some((a) => a.principal === principal)
      )
        failed();
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
        const receivedAt = now();
        const user = record(token.authed_user);
        const team = record(token.team);
        if (
          token.token_type !== "user" ||
          typeof token.access_token !== "string" ||
          !token.access_token ||
          token.access_token.startsWith("xoxb-") ||
          user.id !== userId ||
          team.id !== teamId ||
          token.bot_user_id ||
          (token.app_id !== undefined && token.app_id !== SLACK_APP_ID)
        )
          failed();
        const granted = grantedScopes(user.scope);
        if (token.scope !== undefined) grantedScopes(token.scope);
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
        const identity = await request(AUTH_TEST, {
          method: "POST",
          headers: { authorization: `Bearer ${token.access_token}` },
        });
        if (
          identity.user_id !== userId ||
          identity.team_id !== teamId ||
          identity.bot_id ||
          identity.is_bot === true
        )
          failed();
        if (attempt.generation !== options.generation?.()) failed();
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
      } catch {
        failed();
      } finally {
        if (consumedState) attempts.delete(consumedState);
      }
    },
  };
}
