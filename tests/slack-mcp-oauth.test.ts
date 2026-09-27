import { describe, expect, it, vi } from "vitest";
import { createSlackMcpOAuth } from "../src/tools/slack-mcp-oauth.js";

function setup(tokenOverride = {}, identityOverride = {}) {
  let time = 1000;
  let generation = "connected";
  const saveAuthorization = vi.fn(async () => {});
  const fetchMock = vi.fn<typeof fetch>(async (url) =>
    Response.json(
      String(url).endsWith("auth.test")
        ? { ok: true, user_id: "U1", team_id: "T1", ...identityOverride }
        : {
            ok: true,
            token_type: "user",
            access_token: "xoxp-private",
            refresh_token: "refresh-private",
            expires_in: 3600,
            authed_user: { id: "U1", scope: "search:read" },
            team: { id: "T1" },
            ...tokenOverride,
          },
    ),
  );
  const oauth = createSlackMcpOAuth(
    {
      clientId: "client",
      clientSecret: "secret-private",
      redirectUrl: "https://june.example/oauth/slack",
      userId: "U1",
      teamId: "T1",
      scopes: ["search:read", "search:read.public"],
      generation: () => generation,
      saveAuthorization,
    },
    { fetch: fetchMock, now: () => time },
  );
  const authorize = new URL(oauth.begin("owner"));
  const callback = `https://june.example/oauth/slack?state=${authorize.searchParams.get("state")}&code=private-code`;
  return {
    oauth,
    authorize,
    callback,
    fetchMock,
    saveAuthorization,
    disconnect: () => {
      generation = "disconnected";
    },
    expire: () => {
      time += 600_000;
    },
  };
}

describe("Slack MCP OAuth security boundary", () => {
  it("does not save an authorization after a disconnect during identity verification", async () => {
    const s = setup();
    const original = s.fetchMock.getMockImplementation();
    s.fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith("auth.test")) s.disconnect();
      if (!original) throw new Error("missing fixture");
      return original(url, init);
    });
    await expect(s.oauth.complete("owner", s.callback)).rejects.toThrow();
    expect(s.saveAuthorization).not.toHaveBeenCalled();
  });
  it("binds state to owner, verifies the same user token, and prevents replay", async () => {
    const s = setup();
    expect(s.authorize.origin + s.authorize.pathname).toBe(
      "https://slack.com/oauth/v2_user/authorize",
    );
    expect(s.authorize.searchParams.get("resource")).toBe(
      "https://mcp.slack.com",
    );
    expect(s.authorize.searchParams.has("client_secret")).toBe(false);
    expect(s.authorize.searchParams.has("code_challenge")).toBe(false);
    await expect(s.oauth.complete("other", s.callback)).rejects.toThrow(
      "slack_mcp_oauth_failed",
    );
    expect(s.fetchMock).not.toHaveBeenCalled();
    await s.oauth.complete("owner", `${s.callback}&iss=https://mcp.slack.com`);
    expect(s.fetchMock).toHaveBeenCalledTimes(2);
    const exchange = s.fetchMock.mock.calls[0]?.[1];
    const body = exchange?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get("client_secret")).toBe(
      "secret-private",
    );
    expect(s.fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
      authorization: "Bearer xoxp-private",
    });
    for (const [, init] of s.fetchMock.mock.calls) {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(s.saveAuthorization).toHaveBeenCalledWith({
      accessToken: "xoxp-private",
      refreshToken: "refresh-private",
      expiresAt: 3_601_000,
      userId: "U1",
      teamId: "T1",
      scopes: ["search:read"],
    });
    await expect(s.oauth.complete("owner", s.callback)).rejects.toThrow();
    expect(s.fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ token_type: "bot" }, {}],
    [{ access_token: "xoxb-private" }, {}],
    [{ authed_user: { id: "U2", scope: "search:read" } }, {}],
    [{ team: { id: "T2" } }, {}],
    [{ authed_user: { id: "U1", scope: "search:read,chat:write" } }, {}],
    [{ scope: "chat:write" }, {}],
    [{}, { user_id: "U2" }],
    [{}, { team_id: "T2" }],
    [{}, { bot_id: "B1" }],
  ])(
    "rejects identity, bot and scope violations (%j, %j)",
    async (token, identity) => {
      const s = setup(token, identity);
      await expect(s.oauth.complete("owner", s.callback)).rejects.toThrow(
        "slack_mcp_oauth_failed",
      );
      expect(s.saveAuthorization).not.toHaveBeenCalled();
      const calls = s.fetchMock.mock.calls.length;
      await expect(s.oauth.complete("owner", s.callback)).rejects.toThrow();
      expect(s.fetchMock).toHaveBeenCalledTimes(calls);
    },
  );

  it("expires and bounds pending attempts without network calls", async () => {
    const s = setup();
    expect(() => s.oauth.begin("owner")).toThrow();
    for (let i = 1; i < 32; i++) s.oauth.begin(`owner-${i}`);
    expect(() => s.oauth.begin("overflow")).toThrow();
    s.expire();
    await expect(s.oauth.complete("owner", s.callback)).rejects.toThrow();
    expect(() => s.oauth.begin("owner")).not.toThrow();
    expect(s.fetchMock).not.toHaveBeenCalled();
  });

  it("sanitizes network failures and consumes state before exchange", async () => {
    const s = setup();
    s.fetchMock.mockRejectedValue(new Error("secret-private private-code"));
    await expect(s.oauth.complete("owner", s.callback)).rejects.toThrow(
      /^slack_mcp_oauth_failed$/,
    );
    await expect(s.oauth.complete("owner", s.callback)).rejects.toThrow();
    expect(s.fetchMock).toHaveBeenCalledTimes(1);
    expect(s.saveAuthorization).not.toHaveBeenCalled();
  });

  it("rejects oversized responses and bounds even a stalled fetch", async () => {
    const oversized = setup();
    oversized.fetchMock.mockResolvedValue(new Response("x".repeat(65_537)));
    await expect(
      oversized.oauth.complete("owner", oversized.callback),
    ).rejects.toThrow(/^slack_mcp_oauth_failed$/);
    expect(oversized.saveAuthorization).not.toHaveBeenCalled();
    vi.useFakeTimers();
    try {
      const stalled = setup();
      stalled.fetchMock.mockImplementation(() => new Promise(() => {}));
      const result = expect(
        stalled.oauth.complete("owner", stalled.callback),
      ).rejects.toThrow(/^slack_mcp_oauth_failed$/);
      await vi.advanceTimersByTimeAsync(15_000);
      await result;
      expect(stalled.saveAuthorization).not.toHaveBeenCalled();
      expect(stalled.fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
