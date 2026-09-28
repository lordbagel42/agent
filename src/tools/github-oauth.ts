import { createHash, randomBytes } from "node:crypto";

export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
export interface GitHubAuthorization {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
  account: string;
}

/** Fixed endpoints only. Provider bodies, callback URLs and credentials must
 * never be logged. Owner confirmation is supplied by connection-oauth routes. */
export function createGitHubOAuth(
  options: {
    clientId: string;
    clientSecret: string;
    redirectUrl: string;
    userId: number;
    generation(): string;
    saveAuthorization(value: GitHubAuthorization): Promise<void>;
  },
  dependencies: { fetch?: typeof fetch; now?: () => number } = {},
) {
  function fail(): never {
    throw new Error("github_authorization_failed");
  }
  const redirect = new URL(options.redirectUrl);
  if (
    !options.clientId ||
    !options.clientSecret ||
    !Number.isSafeInteger(options.userId) ||
    options.userId <= 0 ||
    (redirect.protocol !== "https:" &&
      !(redirect.protocol === "http:" && redirect.hostname === "127.0.0.1")) ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  )
    fail();
  const now = dependencies.now ?? Date.now;
  const fetchImpl = dependencies.fetch ?? fetch;
  const attempts = new Map<
    string,
    {
      principal: string;
      verifier: string;
      expires: number;
      generation: string;
      exchanging: boolean;
    }
  >();
  async function request(url: string, init: RequestInit) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetchImpl(url, {
        ...init,
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
      });
      if (!response.ok || response.redirected || !response.body) fail();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          controller.signal.throwIfAborted();
          if (done) break;
          size += value.byteLength;
          if (size > 65_536) fail();
          chunks.push(value);
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      const result: unknown = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      if (!result || typeof result !== "object" || Array.isArray(result))
        fail();
      return result as Record<string, unknown>;
    } catch {
      return fail();
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  async function exchange(
    parameters: Record<string, string>,
  ): Promise<GitHubAuthorization> {
    const started = now();
    const token = await request("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json" },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        ...parameters,
      }),
    });
    if (
      token.error ||
      token.token_type !== "bearer" ||
      typeof token.access_token !== "string" ||
      !/^ghu_[A-Za-z0-9_]{1,8192}$/.test(token.access_token) ||
      typeof token.refresh_token !== "string" ||
      !/^ghr_[A-Za-z0-9_]{1,8192}$/.test(token.refresh_token) ||
      typeof token.expires_in !== "number" ||
      !Number.isSafeInteger(token.expires_in) ||
      token.expires_in <= 0 ||
      token.expires_in > 28800 ||
      typeof token.refresh_token_expires_in !== "number" ||
      !Number.isSafeInteger(token.refresh_token_expires_in) ||
      token.refresh_token_expires_in <= 0 ||
      token.refresh_token_expires_in > 31_536_000
    )
      fail();
    const identity = await request("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token.access_token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (identity.id !== options.userId) fail();
    return {
      accessToken: token.access_token as string,
      refreshToken: token.refresh_token as string,
      expiresAt: started + (token.expires_in as number) * 1000,
      refreshExpiresAt:
        started + (token.refresh_token_expires_in as number) * 1000,
      account: String(options.userId),
    };
  }
  return {
    begin(principal: string) {
      if (!principal || principal.length > 1024) fail();
      for (const [state, attempt] of attempts) {
        if (attempt.exchanging && attempt.principal === principal) fail();
        if (
          !attempt.exchanging &&
          (attempt.expires <= now() || attempt.principal === principal)
        )
          attempts.delete(state);
      }
      if (attempts.size >= 32) fail();
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      attempts.set(state, {
        principal,
        verifier,
        expires: now() + 600_000,
        generation: options.generation(),
        exchanging: false,
      });
      const url = new URL("https://github.com/login/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: redirect.href,
        state,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        allow_signup: "false",
      }).toString();
      return url.href;
    },
    async complete(principal: string, callback: string) {
      const url = new URL(callback);
      const state = url.searchParams.get("state") ?? "";
      const attempt = attempts.get(state);
      if (
        !attempt ||
        attempt.principal !== principal ||
        attempt.exchanging ||
        attempt.expires <= now() ||
        attempt.generation !== options.generation() ||
        url.origin !== redirect.origin ||
        url.pathname !== redirect.pathname ||
        url.username ||
        url.password ||
        url.hash ||
        url.searchParams.has("error") ||
        url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.getAll("code").length !== 1
      )
        fail();
      const code = url.searchParams.get("code");
      if (!code || code.length > 2048) fail();
      attempt.exchanging = true;
      try {
        const value = await exchange({
          code: code as string,
          redirect_uri: redirect.href,
          code_verifier: attempt.verifier,
        });
        if (
          attempt.generation !== options.generation() ||
          attempt.expires <= now()
        )
          fail();
        await options.saveAuthorization(value);
      } finally {
        attempts.delete(state);
      }
    },
    /** Caller durably consumes the old refresh credential before dispatch. */
    refresh(refreshToken: string) {
      return exchange({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
    },
  };
}
