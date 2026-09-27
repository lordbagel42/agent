import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { PUCK_MCP_URL, PUCK_RESOURCE_METADATA_URL } from "./puck.js";

const ISSUER = "https://auth.ampcode.com";
const AUTHORIZE = `${ISSUER}/oauth2/authorize`;
const TOKEN = `${ISSUER}/oauth2/token`;
const METADATA = `${ISSUER}/.well-known/oauth-authorization-server`;

export interface PuckOAuthOptions {
  /** Public operator-hosted HTTPS non-root JSON document, not a PIN portal. */
  clientMetadataUrl: string;
  /** Exact HTTPS or HTTP loopback callback URI, bound before begin(). */
  redirectUrl: string;
  scopes: readonly ("openid" | "profile" | "email" | "offline_access")[];
  /** OIDC nonce verified by the credential owner before saving authorization. */
  nonce?: string;
  /** Atomically save in June's dedicated credential store, outside journals and
   * repos. Verify owner/account identity before exposing PuckAuthorization.
   * Never log tokens or decode an unverified id_token as authenticated identity. */
  saveTokens(
    tokens: OAuthTokens,
    binding: {
      clientId: string;
      issuer: string;
      resource: string;
      receivedAt: number;
    },
  ): Promise<void>;
}

function failed(): never {
  throw new Error("puck_oauth_failed");
}

/** Operator-only authorization-code/S256/CIMD bootstrap, using SDK 1.30.1's
 * supported auth() API. Does not read Amp CLI/session credentials or perform DCR.
 *
 * Publish clientMetadataDocument at clientMetadataUrl, bind the exact loopback
 * callback, then open begin()'s URL in the owner's browser. Forward that port
 * explicitly if the browser is on another machine. Pass the received absolute
 * callback URL to complete() WITHOUT request/URL logging. This module neither
 * hosts public metadata nor adds a runtime HTTP route; the parent owns those.
 *
 * One instance = one 10-minute attempt. Callback state is consumed before any
 * token exchange. A failed/ambiguous exchange or save cannot replay the code.
 * Cancel/restart discards volatile state; start a fresh owner sign-in afterward.
 * Refresh tokens are handed only to saveTokens; refresh scheduling/rotation and
 * revocation belong to the credential owner, never the MCP read retry path.
 *
 * Sources: https://ampcode.com/.well-known/oauth-protected-resource/mcp,
 * https://auth.ampcode.com/.well-known/oauth-authorization-server,
 * https://github.com/modelcontextprotocol/typescript-sdk/blob/1.30.1/src/client/auth.ts
 */
export function createPuckOAuth(
  options: PuckOAuthOptions,
  dependencies: { fetch?: typeof fetch; now?: () => number } = {},
) {
  let metadataUrl: URL;
  let redirectUrl: URL;
  try {
    metadataUrl = new URL(options.clientMetadataUrl);
    redirectUrl = new URL(options.redirectUrl);
  } catch {
    return failed();
  }
  if (
    metadataUrl.protocol !== "https:" ||
    metadataUrl.pathname === "/" ||
    metadataUrl.username ||
    metadataUrl.password ||
    metadataUrl.search ||
    metadataUrl.hash ||
    (redirectUrl.protocol !== "https:" &&
      !(
        redirectUrl.protocol === "http:" &&
        redirectUrl.hostname === "127.0.0.1" &&
        redirectUrl.port
      )) ||
    redirectUrl.pathname === "/" ||
    redirectUrl.username ||
    redirectUrl.password ||
    redirectUrl.search ||
    redirectUrl.hash ||
    !options.scopes.includes("openid") ||
    new Set(options.scopes).size !== options.scopes.length ||
    options.scopes.some(
      (scope) =>
        !["openid", "profile", "email", "offline_access"].includes(scope),
    )
  )
    return failed();
  const clientId = metadataUrl.href;
  const redirect = redirectUrl.href;
  const scope = options.scopes.join(" ");
  const now = dependencies.now ?? Date.now;
  const fetchImpl = dependencies.fetch ?? fetch;
  const { saveTokens } = options;
  const clientMetadata: OAuthClientMetadata = {
    client_name: "June",
    redirect_uris: [redirect],
    grant_types: options.scopes.includes("offline_access")
      ? ["authorization_code", "refresh_token"]
      : ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope,
  };
  let phase: "new" | "starting" | "waiting" | "exchanging" | "finished" = "new";
  let state: string | undefined;
  let verifier: string | undefined;
  let expiresAt = 0;
  let client: OAuthClientInformationMixed | undefined;
  let discovery: OAuthDiscoveryState | undefined;
  let authorizationUrl: URL | undefined;
  let controller: AbortController | undefined;
  let tokenPosted = false;
  let saved = false;

  const provider: OAuthClientProvider = {
    redirectUrl: redirect,
    clientMetadataUrl: clientId,
    clientMetadata,
    state: () => state ?? failed(),
    clientInformation: () => client,
    saveClientInformation(value) {
      if (value.client_id !== clientId || value.client_secret) failed();
      client = { client_id: clientId };
    },
    // This bootstrap intentionally cannot inherit or refresh any existing login.
    tokens: () => undefined,
    async saveTokens(tokens) {
      if (
        phase !== "exchanging" ||
        saved ||
        controller?.signal.aborted ||
        tokens.token_type.toLowerCase() !== "bearer"
      )
        failed();
      saved = true;
      await saveTokens(
        { ...tokens },
        {
          clientId,
          issuer: ISSUER,
          resource: PUCK_MCP_URL,
          receivedAt: now(),
        },
      );
    },
    redirectToAuthorization(url) {
      if (
        url.origin + url.pathname !== AUTHORIZE ||
        url.searchParams.get("client_id") !== clientId ||
        url.searchParams.get("redirect_uri") !== redirect ||
        url.searchParams.get("resource") !== PUCK_MCP_URL ||
        url.searchParams.get("state") !== state ||
        url.searchParams.get("code_challenge_method") !== "S256"
      )
        failed();
      if (options.nonce) url.searchParams.set("nonce", options.nonce);
      authorizationUrl = new URL(url);
    },
    saveCodeVerifier(value) {
      verifier = value;
    },
    codeVerifier: () => verifier ?? failed(),
    invalidateCredentials() {
      // SDK recovery must not resubmit a one-use authorization code.
      client = undefined;
      verifier = undefined;
    },
    discoveryState: () => discovery,
    saveDiscoveryState(value) {
      const metadata = value.authorizationServerMetadata;
      if (
        value.authorizationServerUrl !== ISSUER ||
        value.resourceMetadata?.resource !== PUCK_MCP_URL ||
        value.resourceMetadata.authorization_servers?.join(",") !== ISSUER ||
        metadata?.issuer !== ISSUER ||
        metadata.authorization_endpoint !== AUTHORIZE ||
        metadata.token_endpoint !== TOKEN ||
        metadata.client_id_metadata_document_supported !== true ||
        !metadata.code_challenge_methods_supported?.includes("S256")
      )
        failed();
      discovery = value;
    },
  };

  async function run(code?: string) {
    controller = new AbortController();
    const timer = setTimeout(() => controller?.abort(), 15_000);
    let remaining = 131_072;
    try {
      return await auth(provider, {
        serverUrl: PUCK_MCP_URL,
        resourceMetadataUrl: new URL(PUCK_RESOURCE_METADATA_URL),
        scope,
        authorizationCode: code,
        fetchFn: async (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          const method = init?.method?.toUpperCase() ?? "GET";
          if (url === TOKEN && method === "POST") {
            if (phase !== "exchanging" || tokenPosted) failed();
            tokenPosted = true;
          } else if (
            method !== "GET" ||
            ![PUCK_RESOURCE_METADATA_URL, METADATA].includes(url)
          )
            failed();
          const signal = AbortSignal.any([
            controller?.signal ?? AbortSignal.abort(),
            ...(init?.signal ? [init.signal] : []),
          ]);
          signal.throwIfAborted();
          const response = await fetchImpl(input, {
            ...init,
            signal,
            redirect: "error",
            credentials: "omit",
          });
          const reader = response.body?.getReader();
          if (!reader) failed();
          const chunks: Uint8Array[] = [];
          try {
            for (;;) {
              signal.throwIfAborted();
              const { value, done } = await reader.read();
              if (done) break;
              remaining -= value.byteLength;
              if (remaining < 0) failed();
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          return new Response(Buffer.concat(chunks), {
            status: response.status,
            headers: response.headers,
          });
        },
      });
    } catch {
      return failed();
    } finally {
      clearTimeout(timer);
    }
  }

  function cancel() {
    phase = "finished";
    controller?.abort();
    verifier = undefined;
    state = undefined;
    authorizationUrl = undefined;
  }

  return {
    clientMetadataDocument: {
      client_id: clientId,
      ...structuredClone(clientMetadata),
    },
    async begin(): Promise<URL> {
      if (phase !== "new") failed();
      phase = "starting";
      state = randomBytes(32).toString("base64url");
      expiresAt = now() + 600_000;
      try {
        if (
          (await run()) !== "REDIRECT" ||
          !authorizationUrl ||
          !verifier ||
          !state
        )
          failed();
        phase = "waiting";
        return new URL(authorizationUrl);
      } catch {
        cancel();
        return failed();
      }
    },
    async complete(callback: URL): Promise<void> {
      const suppliedState = callback.searchParams.get("state") ?? "";
      const code = callback.searchParams.get("code");
      if (
        phase !== "waiting" ||
        !state ||
        now() >= expiresAt ||
        callback.origin + callback.pathname !== redirect ||
        callback.username ||
        callback.password ||
        callback.hash ||
        [...callback.searchParams.keys()].some(
          (key) => callback.searchParams.getAll(key).length !== 1,
        ) ||
        callback.searchParams.has("error") ||
        !code ||
        code.length > 8192 ||
        (callback.searchParams.has("iss") &&
          callback.searchParams.get("iss") !== ISSUER) ||
        Buffer.byteLength(suppliedState) !== Buffer.byteLength(state) ||
        !timingSafeEqual(Buffer.from(suppliedState), Buffer.from(state))
      )
        failed();
      phase = "exchanging";
      try {
        if ((await run(code)) !== "AUTHORIZED") failed();
      } finally {
        cancel();
      }
    },
    cancel,
  };
}

/** Dedicated, owner-started console sign-in. No refresh grant or CLI credential
 * reuse. Expired access requires another explicit sign-in. The selected Amp
 * account is verified with its signed ID token, not inferred from a bearer. */
export function createPuckConsoleOAuth(
  options: {
    origin: string;
    generation(): string;
    saveAuthorization(value: {
      accessToken: string;
      expiresAt: number;
      account: string;
    }): Promise<void>;
  },
  dependencies: { fetch?: typeof fetch; now?: () => number } = {},
) {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || origin.protocol !== "https:")
    failed();
  const now = dependencies.now ?? Date.now;
  const fetchImpl = dependencies.fetch ?? fetch;
  const clientMetadataUrl = `${origin.origin}/console/connections/amp/client.json`;
  const redirectUrl = `${origin.origin}/console/connections/amp/callback`;
  const jwks = createRemoteJWKSet(new URL(`${ISSUER}/oauth2/jwks`), {
    timeoutDuration: 10_000,
    [customFetch]: async (input, init) => {
      const response = await fetchImpl(input, {
        ...init,
        redirect: "error",
        credentials: "omit",
      });
      if (!response.ok) failed();
      const reader = response.body?.getReader();
      if (!reader) failed();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 131_072) failed();
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return new Response(Buffer.concat(chunks), {
        status: response.status,
        headers: response.headers,
      });
    },
  });
  let attempt:
    | {
        principal: string;
        generation: string;
        flow: ReturnType<typeof createPuckOAuth>;
        busy: boolean;
        expiresAt: number;
      }
    | undefined;
  const makeFlow = (nonce: string, generation: string) =>
    createPuckOAuth(
      {
        clientMetadataUrl,
        redirectUrl,
        scopes: ["openid"],
        nonce,
        async saveTokens(tokens, binding) {
          if (
            typeof tokens.id_token !== "string" ||
            !Number.isSafeInteger(tokens.expires_in) ||
            (tokens.expires_in ?? 0) <= 0
          )
            failed();
          const { payload } = await jwtVerify(tokens.id_token, jwks, {
            issuer: ISSUER,
            audience: clientMetadataUrl,
            algorithms: ["RS256"],
            requiredClaims: ["sub", "iat", "exp", "nonce"],
            currentDate: new Date(now()),
          });
          const expiresAt =
            binding.receivedAt + (tokens.expires_in ?? 0) * 1000;
          if (
            payload.nonce !== nonce ||
            typeof payload.sub !== "string" ||
            !payload.sub ||
            payload.sub.length > 256 ||
            (payload.azp !== undefined && payload.azp !== clientMetadataUrl) ||
            !Number.isSafeInteger(expiresAt) ||
            expiresAt <= now() ||
            options.generation() !== generation
          )
            failed();
          await options.saveAuthorization({
            accessToken: tokens.access_token,
            expiresAt,
            account: payload.sub,
          });
        },
      },
      dependencies,
    );
  return {
    // Public, static application metadata only: never account/state/token data.
    clientMetadataDocument: makeFlow("", "").clientMetadataDocument,
    async begin(principal: string): Promise<string> {
      if (!principal || attempt?.busy) failed();
      attempt?.flow.cancel();
      const generation = options.generation();
      const pending = {
        principal,
        generation,
        flow: makeFlow(randomBytes(32).toString("base64url"), generation),
        busy: true,
        expiresAt: now() + 600_000,
      };
      attempt = pending;
      try {
        return (await pending.flow.begin()).href;
      } catch {
        attempt = undefined;
        return failed();
      } finally {
        pending.busy = false;
      }
    },
    async complete(principal: string, callback: string): Promise<void> {
      const pending = attempt;
      if (
        !pending ||
        pending.busy ||
        pending.principal !== principal ||
        pending.expiresAt <= now() ||
        pending.generation !== options.generation()
      )
        failed();
      pending.busy = true;
      try {
        await pending.flow.complete(new URL(callback));
      } catch {
        return failed();
      } finally {
        pending.flow.cancel();
        attempt = undefined;
      }
    },
  };
}
