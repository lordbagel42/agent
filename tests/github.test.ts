import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createHttpApp } from "../src/http/app.js";
import { McpConnections } from "../src/tools/connections.js";
import { createGitHubOAuth } from "../src/tools/github-oauth.js";
import { createGitHubWebhooks } from "../src/wakeups/github.js";
import type { WakeupEvent } from "../src/wakeups/state.js";

test("GitHub OAuth binds PKCE, owner, account and generation and consumes exchanges once", async () => {
  let generation = "first";
  let user = 42;
  const saved: unknown[] = [];
  const requests: RequestInit[] = [];
  const oauth = createGitHubOAuth(
    {
      clientId: "client",
      clientSecret: "private-secret",
      redirectUrl: "https://june.example/console/connections/github/callback",
      userId: 42,
      generation: () => generation,
      saveAuthorization: async (value) => {
        saved.push(value);
      },
    },
    {
      fetch: async (url, init) => {
        requests.push(init ?? {});
        return Response.json(
          String(url).endsWith("/user")
            ? { id: user, login: "owner" }
            : {
                access_token: "ghu_private",
                token_type: "bearer",
                expires_in: 28800,
                refresh_token: "ghr_private",
                refresh_token_expires_in: 15897600,
              },
        );
      },
    },
  );
  const begin = () => {
    const auth = new URL(oauth.begin("owner"));
    return {
      auth,
      callback: `https://june.example/console/connections/github/callback?code=private-code&state=${auth.searchParams.get("state")}`,
    };
  };
  const first = begin();
  await expect(oauth.complete("attacker", first.callback)).rejects.toThrow();
  expect(requests).toHaveLength(0);
  await oauth.complete("owner", first.callback);
  const exchange = requests[0]?.body as URLSearchParams;
  expect(
    createHash("sha256")
      .update(exchange.get("code_verifier") ?? "")
      .digest("base64url"),
  ).toBe(first.auth.searchParams.get("code_challenge"));
  expect(first.auth.searchParams.get("code_challenge_method")).toBe("S256");
  expect(saved).toMatchObject([
    { accessToken: "ghu_private", refreshToken: "ghr_private", account: "42" },
  ]);
  await expect(oauth.complete("owner", first.callback)).rejects.toThrow();
  const second = begin();
  user = 73;
  await expect(oauth.complete("owner", second.callback)).rejects.toThrow();
  const third = begin();
  generation = "disconnected";
  await expect(oauth.complete("owner", third.callback)).rejects.toThrow();
  expect(saved).toHaveLength(1);
});

test("GitHub ingress authenticates bytes, retains lookup context within UTF-8 budget, and rejects failed admission", async () => {
  const events: WakeupEvent[] = [];
  let accepted = true;
  const publish = vi.fn(async (event: WakeupEvent) => {
    events.push(event);
    return { accepted, duplicate: false };
  });
  const secret = "x".repeat(40);
  const host = createHttpApp({
    owner: { id: "owner", identities: [] },
    channels: {},
    operatorToken: "o".repeat(40),
    github: { secret, publish },
    ready: async () => true,
    submit: async () => {},
    inspectConversation: async () => ({}),
    inspectJob: async () => undefined,
    resumeJob: async () => false,
  });
  const app = {
    request: (_path: string, init: RequestInit) =>
      host.request("/webhooks/github", init),
  };
  const raw = JSON.stringify({
    action: "created",
    repository: {
      id: 99,
      full_name: "owner/repo",
      html_url: "https://github.com/owner/repo",
    },
    installation: { id: 123 },
    sender: { id: 42, login: "owner" },
    future_resource: {
      id: 71,
      html_url: "https://github.com/owner/repo/issues/7",
      created_at: "2026-09-28T06:00:00Z",
    },
    token: "DO_NOT_KEEP",
    description: "猫".repeat(500000),
  });
  const headers = {
    "content-type": "application/json",
    "x-github-event": "future_event",
    "x-github-delivery": "c4fe0a60-2287-11ee-a9c7-123456789abc",
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
  };
  expect(
    (await app.request("/", { method: "POST", headers, body: `${raw} ` }))
      .status,
  ).toBe(401);
  expect(events).toHaveLength(0);
  expect(
    (await app.request("/", { method: "POST", headers, body: raw })).status,
  ).toBe(202);
  expect(events[0]).toMatchObject({
    source: "github",
    type: "future_event",
    data: {
      repository: { id: 99, fullName: "owner/repo" },
      installation: { id: 123 },
      resources: [{ kind: "future_resource", id: 71 }],
      truncation: { truncated: true },
    },
  });
  expect(Buffer.byteLength(JSON.stringify(events[0]))).toBeLessThanOrEqual(
    16384,
  );
  expect(JSON.stringify(events[0])).not.toContain("DO_NOT_KEEP");
  expect(JSON.stringify(events[0])).toContain("2026-09-28T06:00:00Z");
  accepted = false;
  expect(
    (await app.request("/", { method: "POST", headers, body: raw })).status,
  ).toBe(503);
});

test("GitHub credentials refresh privately before MCP discovery and ambiguous refresh is not repeated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "june-github-"));
  let fail = false;
  const refresh = vi.fn(async () => {
    if (fail) throw new Error("unknown_exchange");
    return {
      accessToken: "ghu_new",
      refreshToken: "ghr_new",
      expiresAt: Date.now() + 28800_000,
      refreshExpiresAt: Date.now() + 1_000_000_000,
      account: "42",
    };
  });
  const store = new McpConnections(
    {
      directory,
      key: Buffer.alloc(32, 9),
      owner: "owner",
      origin: "https://june.example",
    },
    {
      refreshGitHub: refresh,
      fetch: async (url, init) => {
        expect(String(url)).toBe("https://api.githubcopilot.com/mcp/");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer ghu_new",
        );
        if (init?.method === "DELETE")
          return new Response(null, { status: 204 });
        const message = JSON.parse(String(init?.body));
        if (message.id === undefined)
          return new Response(null, { status: 202 });
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result:
            message.method === "initialize"
              ? {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "github-fixture", version: "1" },
                }
              : message.method === "tools/call"
                ? {
                    content: [
                      {
                        type: "text",
                        text: "fixture commit changed the wakeup handler",
                      },
                    ],
                  }
                : {
                    tools: [
                      {
                        name: "get_commit",
                        inputSchema: { type: "object", properties: {} },
                      },
                    ],
                  },
        });
      },
    },
  );
  const connect = () =>
    store.connectGitHub({
      accessToken: "ghu_old",
      refreshToken: "ghr_old",
      expiresAt: Date.now() - 1,
      refreshExpiresAt: Date.now() + 1000000,
      account: "42",
    });
  try {
    connect();
    await store.discover("github", store.generation("github"));
    expect(store.list()[0]).toMatchObject({
      status: "connected",
      tools: [{ permission: "approval", contract: { name: "get_commit" } }],
    });
    expect(JSON.stringify(store.list())).not.toMatch(/gh[ur]_/);
    expect(JSON.stringify(store.inventory())).not.toMatch(/gh[ur]_/);
    expect(refresh).toHaveBeenCalledTimes(1);
    store.permit("github", store.generation("github"), "get_commit", "read");
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 28801_000);
    try {
      const answer = await store
        .wrap({
          reply: async (request) => {
            if (request.mcpAvailable)
              return {
                text: "",
                mcp: {
                  connection: "github",
                  tool: "get_commit",
                  argumentsJson: "{}",
                },
              };
            expect(JSON.stringify(request)).toContain(
              "fixture commit changed the wakeup handler",
            );
            expect(JSON.stringify(request)).not.toMatch(/gh[ur]_/);
            return { text: "June inspected the fixture commit" };
          },
        })
        .reply({
          system: "Inspect GitHub",
          messages: [],
          workspaces: [],
          mcpAvailable: true,
        });
      expect(answer.text).toBe("June inspected the fixture commit");
      expect(store.list()[0]?.tools[0]?.permission).toBe("read");
    } finally {
      now.mockRestore();
    }
    expect(refresh).toHaveBeenCalledTimes(2);
    fail = true;
    connect();
    await store.discover("github", store.generation("github"));
    await store.discover("github", store.generation("github"));
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(store.list()[0]?.status).toBe("unavailable");
  } finally {
    await store.close();
    await rm(directory, { recursive: true });
  }
});

test("normalization reserves room for metadata even with escaped Unicode identifiers", async () => {
  const secret = "z".repeat(40);
  let saved: WakeupEvent | undefined;
  const app = createGitHubWebhooks({
    secret,
    publish: async (event) => {
      saved = event;
      return { accepted: true, duplicate: false };
    },
  });
  const body: Record<string, unknown> = {
    token: { id: 42, url: "SECRET_VALUE" },
  };
  for (let i = 0; i < 30; i++)
    body[`${"猫".repeat(79)}${i}`] = {
      id: i + 1,
      url: "猫".repeat(500),
      body: "x".repeat(3000),
    };
  const raw = JSON.stringify(body);
  const response = await app.request("/", {
    method: "POST",
    body: raw,
    headers: {
      "x-github-event": "future_event",
      "x-github-delivery": "test-delivery",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
    },
  });
  expect(response.status).toBe(202);
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(16384);
  expect(JSON.stringify(saved)).not.toContain("SECRET_VALUE");
  expect(saved?.data.truncation).toMatchObject({ truncated: true });
});

test.each(["permission", "reconnect", "disconnect", "concurrent"])(
  "refresh preserves the %s boundary during concurrent MCP reads",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "june-github-race-"));
    let release: (() => void) | undefined;
    let refreshing: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      refreshing = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let rotations = 0;
    let calls = 0;
    const store = new McpConnections(
      {
        directory,
        key: Buffer.alloc(32, 1),
        owner: "owner",
        origin: "https://june.example",
      },
      {
        refreshGitHub: async () => {
          rotations++;
          refreshing?.();
          await gate;
          return {
            accessToken: "ghu_rotated",
            refreshToken: "ghr_rotated",
            account: "42",
            expiresAt: Date.now() + 28800_000,
            refreshExpiresAt: Date.now() + 1_000_000_000,
          };
        },
        fetch: async (_url, init) => {
          if (init?.method === "DELETE")
            return new Response(null, { status: 204 });
          const message = JSON.parse(String(init?.body));
          if (message.id === undefined)
            return new Response(null, { status: 202 });
          if (message.method === "tools/call") calls++;
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result:
              message.method === "initialize"
                ? {
                    protocolVersion: "2025-11-25",
                    capabilities: { tools: {} },
                    serverInfo: { name: "fixture", version: "1" },
                  }
                : message.method === "tools/list"
                  ? {
                      tools: [
                        {
                          name: "get_commit",
                          inputSchema: { type: "object", properties: {} },
                        },
                      ],
                    }
                  : { content: [{ type: "text", text: "commit fixture" }] },
          });
        },
      },
    );
    const read = () =>
      store
        .wrap({
          reply: async (request) =>
            request.mcpAvailable
              ? {
                  text: "",
                  mcp: {
                    connection: "github",
                    tool: "get_commit",
                    argumentsJson: "{}",
                  },
                }
              : { text: "read finished" },
        })
        .reply({
          system: "Read",
          messages: [],
          workspaces: [],
          mcpAvailable: true,
        });
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      store.connectGitHub({
        accessToken: "ghu_initial",
        refreshToken: "ghr_initial",
        account: "42",
        expiresAt: Date.now() + 28800_000,
        refreshExpiresAt: Date.now() + 1_000_000_000,
      });
      await store.discover("github", store.generation("github"));
      store.permit("github", store.generation("github"), "get_commit", "read");
      clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 28801_000);
      const first = read();
      await started;
      // A new turn during rotation must still see its allowed tool catalog.
      expect(store.list()[0]?.refreshable).toBe(true);
      const second = read();
      await Promise.resolve();
      const replacementExpiry = Date.now() + 40_000_000;
      if (mode === "reconnect")
        store.connectGitHub({
          accessToken: "ghu_reconnected",
          refreshToken: "ghr_reconnected",
          account: "42",
          expiresAt: replacementExpiry,
          refreshExpiresAt: Date.now() + 1_000_000_000,
        });
      else if (mode === "disconnect")
        store.disconnect("github", store.generation("github"));
      else if (mode === "permission")
        store.permit(
          "github",
          store.generation("github"),
          "get_commit",
          "disabled",
        );
      release?.();
      await Promise.all([first, second]);
      expect(calls).toBe(mode === "concurrent" ? 2 : 0);
      expect(rotations).toBe(1);
      if (mode === "disconnect") {
        expect(store.list()).toEqual([]);
        return;
      }
      if (mode === "reconnect") {
        expect(store.list()[0]).toMatchObject({
          expiresAt: replacementExpiry,
          tools: [],
        });
        return;
      }
      if (mode === "concurrent") return;
      expect(store.list()[0]).toMatchObject({
        refreshable: true,
        tools: [{ permission: "disabled" }],
      });
      expect(store.list()[0]?.expiresAt).toBeGreaterThan(Date.now());
      store.permit("github", store.generation("github"), "get_commit", "read");
      expect((await read()).text).toBe("read finished");
      expect(calls).toBe(1);
      expect(rotations).toBe(1);
    } finally {
      release?.();
      clock?.mockRestore();
      await store.close();
      await rm(directory, { recursive: true });
    }
  },
);
