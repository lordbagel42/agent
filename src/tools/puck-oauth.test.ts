import { createHash } from "node:crypto";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { expect, test } from "vitest";
import { createPuckOAuth } from "./puck-oauth.js";

function fixture(mode = "ok") {
  const saved: OAuthTokens[] = [];
  const posts: URLSearchParams[] = [];
  let now = 1000;
  const flow = createPuckOAuth(
    {
      clientMetadataUrl: "https://june.example/oauth/amp-client.json",
      redirectUrl: "http://127.0.0.1:18427/oauth/callback",
      scopes: ["openid", "offline_access"],
      saveTokens: async (tokens, binding) => {
        expect(binding).toEqual({
          clientId: "https://june.example/oauth/amp-client.json",
          issuer: "https://auth.ampcode.com",
          resource: "https://ampcode.com/mcp",
          receivedAt: now,
        });
        if (mode === "save-failure") throw new Error("fixture-save-secret");
        saved.push(tokens);
      },
    },
    {
      now: () => now,
      fetch: async (input, init) => {
        const url = String(input);
        expect(init?.redirect).toBe("error");
        expect(init?.credentials).toBe("omit");
        if (
          url === "https://ampcode.com/.well-known/oauth-protected-resource/mcp"
        )
          return Response.json({
            resource: "https://ampcode.com/mcp",
            authorization_servers: ["https://auth.ampcode.com"],
          });
        if (
          url ===
          "https://auth.ampcode.com/.well-known/oauth-authorization-server"
        )
          return Response.json({
            issuer: "https://auth.ampcode.com",
            authorization_endpoint:
              mode === "evil-issuer"
                ? "https://evil.example/authorize"
                : "https://auth.ampcode.com/oauth2/authorize",
            token_endpoint: "https://auth.ampcode.com/oauth2/token",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            client_id_metadata_document_supported: true,
            token_endpoint_auth_methods_supported: ["none"],
          });
        if (url !== "https://auth.ampcode.com/oauth2/token")
          throw new Error("unexpected_destination");
        posts.push(new URLSearchParams(String(init?.body)));
        if (mode === "disconnect") throw new Error("fixture-token-secret");
        if (mode === "invalid-grant")
          return Response.json(
            {
              error: "invalid_grant",
              error_description: "fixture-token-secret",
            },
            { status: 400 },
          );
        return Response.json({
          access_token: "new-june-token",
          token_type: "Bearer",
          expires_in: 300,
          refresh_token: "june-refresh",
          scope: "openid offline_access",
        });
      },
    },
  );
  return {
    flow,
    posts,
    saved,
    expire: () => {
      now += 600_001;
    },
  };
}

test("CIMD bootstrap binds resource, S256 verifier and one-shot state before saving dedicated tokens", async () => {
  const f = fixture();
  expect(f.flow.clientMetadataDocument).toMatchObject({
    client_id: "https://june.example/oauth/amp-client.json",
    redirect_uris: ["http://127.0.0.1:18427/oauth/callback"],
    token_endpoint_auth_method: "none",
  });
  const url = await f.flow.begin();
  expect(url.origin + url.pathname).toBe(
    "https://auth.ampcode.com/oauth2/authorize",
  );
  expect(url.searchParams.get("client_id")).toBe(
    "https://june.example/oauth/amp-client.json",
  );
  expect(url.searchParams.get("resource")).toBe("https://ampcode.com/mcp");
  expect(url.searchParams.get("scope")).toBe("openid offline_access");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  const callback = new URL(
    "http://127.0.0.1:18427/oauth/callback?code=new-code&state=wrong",
  );
  await expect(f.flow.complete(callback)).rejects.toThrow("puck_oauth_failed");
  expect(f.posts).toHaveLength(0);
  callback.searchParams.set("state", url.searchParams.get("state") ?? "");
  await f.flow.complete(callback);
  expect(f.posts).toHaveLength(1);
  const body = f.posts[0];
  expect(body?.get("grant_type")).toBe("authorization_code");
  expect(body?.get("code")).toBe("new-code");
  expect(body?.get("resource")).toBe("https://ampcode.com/mcp");
  expect(body?.get("redirect_uri")).toBe(
    "http://127.0.0.1:18427/oauth/callback",
  );
  expect(
    createHash("sha256")
      .update(body?.get("code_verifier") ?? "")
      .digest("base64url"),
  ).toBe(url.searchParams.get("code_challenge"));
  expect(f.saved).toHaveLength(1);
  await expect(f.flow.complete(callback)).rejects.toThrow("puck_oauth_failed");
  expect(f.posts).toHaveLength(1);
});

test.each(["disconnect", "invalid-grant", "save-failure"])(
  "%s never replays a code exchange or exposes secrets",
  async (mode) => {
    const f = fixture(mode);
    const url = await f.flow.begin();
    const callback = new URL(
      "http://127.0.0.1:18427/oauth/callback?code=new-code",
    );
    callback.searchParams.set("state", url.searchParams.get("state") ?? "");
    await expect(f.flow.complete(callback)).rejects.toThrow(
      "puck_oauth_failed",
    );
    await expect(f.flow.complete(callback)).rejects.toThrow(
      "puck_oauth_failed",
    );
    expect(f.posts).toHaveLength(1);
    expect(f.saved).toHaveLength(0);
  },
);

test("expired, cross-origin, and duplicate callback parameters cannot exchange a code", async () => {
  const f = fixture();
  const url = await f.flow.begin();
  const callback = new URL(
    "http://127.0.0.1:18427/oauth/callback?code=new-code",
  );
  callback.searchParams.set("state", url.searchParams.get("state") ?? "");
  const hostile = new URL(callback);
  hostile.hostname = "evil.example";
  await expect(f.flow.complete(hostile)).rejects.toThrow();
  const duplicate = new URL(callback);
  duplicate.searchParams.append("code", "other-code");
  await expect(f.flow.complete(duplicate)).rejects.toThrow();
  f.expire();
  await expect(f.flow.complete(callback)).rejects.toThrow();
  expect(f.posts).toHaveLength(0);
});

test("discovery cannot redirect authorization to another issuer", async () => {
  const f = fixture("evil-issuer");
  await expect(f.flow.begin()).rejects.toThrow("puck_oauth_failed");
  expect(f.posts).toHaveLength(0);
});
