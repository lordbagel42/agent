import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { createHttpApp, type HttpDependencies } from "../http/app.js";
import { CapabilityBroker, type ToolAdapter } from "../tools/broker.js";
import { OpaqueActionLinks } from "./opaque.js";
import { createActionLinkRoutes } from "./routes.js";

test("private link HTTP boundary: inert unfurls, CSRF, exact review, audience and once-only execution", async () => {
  let calls = 0;
  const broker = new CapabilityBroker(":memory:", {
    owner: "owner",
    resolveCredential: async () => null,
    tools: {
      send: {
        execute: async () => {
          calls++;
          throw new Error("ambiguous secret transport error");
        },
      },
    },
  });
  try {
    const links = new OpaqueActionLinks(broker);
    const action = {
      tool: "send",
      account: "mail",
      item: "sender",
      origin: "https://example.com",
      arguments: { body: "<script>bad()</script>" },
    };
    let resolved = action;
    const grantId = broker.grant("owner", {
      audience: "owner",
      action,
      expiresAt: Date.now() + 60_000,
    });
    const token = links.issue("owner", grantId, Date.now() + 30_000);
    const app = new Hono().route(
      "/private/actions",
      createActionLinkRoutes({
        security: {
          origin: "https://console.example",
          csrfSecret: "x".repeat(32),
          authenticate: async (req) =>
            req.headers.get("test-principal") ?? undefined,
        },
        links,
        resolveAction: async () => resolved,
      }),
    );
    const path = `/private/actions/${token}`;
    expect((await app.request(path)).status).toBe(401);
    expect(
      (await app.request(path, { headers: { "test-principal": "stranger" } }))
        .status,
    ).toBe(404);
    const headers = {
      "test-principal": "owner",
      "user-agent": "Slackbot-LinkExpanding",
    };
    const get = await app.request(path, { headers });
    const markup = await get.text();
    expect(get.headers.get("cache-control")).toContain("no-store");
    expect(get.headers.get("referrer-policy")).toBe("no-referrer");
    expect(get.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(markup).not.toContain(token);
    expect(markup).not.toContain("<script>");
    expect((await app.request(path, { method: "HEAD", headers })).status).toBe(
      200,
    );
    expect(calls).toBe(0);
    const proof = markup.match(/name="proof" value="([^"]+)"/)?.[1];
    expect(proof).toBeTruthy();
    const body = new URLSearchParams({ proof: proof ?? "", confirmed: "yes" });
    const post = (origin: string, value = body) =>
      app.request(path, {
        method: "POST",
        headers: {
          ...headers,
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: value,
      });
    expect((await post("https://evil.example")).status).toBe(403);
    expect(
      (
        await post(
          "https://console.example",
          new URLSearchParams({ confirmed: "yes" }),
        )
      ).status,
    ).toBe(403);
    resolved = { ...action, arguments: { body: "changed" } };
    expect((await post("https://console.example")).status).toBe(403);
    expect(calls).toBe(0);
    resolved = action;
    const responses = await Promise.all([
      post("https://console.example"),
      post("https://console.example"),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(calls).toBe(1);
    const receiptPage = await responses[0]?.text();
    expect(receiptPage).toContain("Outcome unknown");
    expect(receiptPage).not.toContain("secret transport");
    links.revoke("owner", token);
    expect((await post("https://console.example")).status).toBe(404);
  } finally {
    broker.close();
  }
});

test("mounted links require owner auth, preserve exact grants, and fail closed on replay, expiry, revoke and restart", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_000);
  const execute = vi.fn<ToolAdapter["execute"]>(async () => {});
  const broker = new CapabilityBroker(":memory:", {
    owner: "owner",
    tools: { send: { execute } },
    resolveCredential: async () => null,
  });
  const operatorToken = "fixture-operator-token-129-not-a-real-key";
  const auth = { authorization: `Bearer ${operatorToken}` };
  const origin = "https://console.example";
  const formHeaders = {
    origin,
    "content-type": "application/x-www-form-urlencoded",
  };
  const deps: HttpDependencies = {
    owner: { id: "owner", identities: [] },
    channels: {},
    operatorToken,
    capabilities: broker,
    console: {
      origin,
      inspect: async () => ({ observedAt: "now", sections: {} }),
    },
    submit: async () => {},
    ready: async () => true,
    inspectConversation: async () => ({}),
    inspectJob: async () => undefined,
    resumeJob: async () => false,
  };
  const action = {
    tool: "send",
    account: "mail",
    item: "sender",
    origin: "https://example.com",
    arguments: { body: "Only this exact fixture payload" },
  };
  const grant = (audience = "owner") =>
    broker.grant("owner", {
      audience,
      action,
      expiresAt: Date.now() + 120_000,
    });
  const proof = async (response: Response) =>
    (await response.text()).match(/name="proof" value="([^"]+)"/)?.[1] ?? "";
  try {
    const app = createHttpApp(deps);
    const json = (path: string, value: unknown, headers = auth) =>
      app.request(path, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    const grantId = grant();
    const input = { grantId, action, expiresAt: Date.now() + 60_000 };
    const issue = () => json("/operator/capabilities/links", input);
    expect(
      (await json("/operator/capabilities/links", input, { authorization: "" }))
        .status,
    ).toBe(401);
    expect(
      (
        await json("/operator/capabilities/links", {
          ...input,
          action: { ...action, arguments: { body: "different" } },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await json("/operator/capabilities/links", {
          ...input,
          grantId: grant("worker"),
        })
      ).status,
    ).toBe(400);
    const issued = await issue();
    expect(issued.status).toBe(201);
    const path = new URL((await issued.json()).url).pathname;
    expect(path).toMatch(/^\/console\/action-links\/[A-Za-z0-9_-]{43}$/u);
    expect((await app.request(path)).status).toBe(401);
    const login = await app.request("/console/session/login", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({
        token: operatorToken,
        proof: await proof(await app.request("/console/session/login")),
      }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const review = await app.request(path, { headers: { cookie } });
    expect(review.status).toBe(200);
    expect(review.headers.get("cache-control")).toContain("no-store");
    expect(review.headers.get("referrer-policy")).toBe("no-referrer");
    const reviewed = await proof(review);
    expect(reviewed).not.toBe("");
    expect(
      (await app.request(path, { method: "HEAD", headers: { cookie } })).status,
    ).toBe(200);
    expect(execute).not.toHaveBeenCalled();
    const post = (
      route = path,
      proofValue = reviewed,
      requestOrigin = origin,
    ) =>
      app.request(route, {
        method: "POST",
        headers: { ...formHeaders, origin: requestOrigin, cookie },
        body: new URLSearchParams({ confirmed: "yes", proof: proofValue }),
      });
    expect((await post(path, "")).status).toBe(403);
    expect((await post(path, reviewed, "https://evil.example")).status).toBe(
      403,
    );
    const otherPath = new URL((await (await issue()).json()).url).pathname;
    expect((await post(otherPath)).status).toBe(403); // Proof is token/path-bound.
    expect(
      (
        await app.request("/operator/capabilities/links", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(401);
    const results = await Promise.all([post(), post()]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual(action);
    expect(await results[0]?.text()).toContain("confirmed success");
    expect((await post()).status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    const restarted = createHttpApp(deps);
    // Reissuing for the same grant must not restore the old token's payload.
    expect(
      (
        await restarted.request("/operator/capabilities/links", {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(201);
    expect(
      await (await restarted.request(otherPath, { headers: auth })).text(),
    ).toContain("Action details unavailable");
    expect(
      (
        await restarted.request(otherPath, {
          method: "POST",
          headers: { ...auth, ...formHeaders },
          body: new URLSearchParams({ confirmed: "yes", proof: reviewed }),
        })
      ).status,
    ).toBe(503);
    const revoke = `/operator/capabilities/links/${otherPath.split("/").at(-1)}/revoke`;
    expect(
      (await app.request(revoke, { method: "POST", headers: { cookie } }))
        .status,
    ).toBe(401);
    expect((await json(revoke, {})).status).toBe(200);
    expect((await post(otherPath)).status).toBe(404);
    clock.mockReturnValue(input.expiresAt - 1);
    expect((await app.request(path, { headers: auth })).status).toBe(200);
    clock.mockReturnValue(input.expiresAt);
    expect((await post()).status).toBe(404);
    expect(execute).toHaveBeenCalledTimes(1);
    for (const missing of [
      { ...deps, capabilities: undefined },
      { ...deps, console: undefined },
    ]) {
      const unmounted = createHttpApp(missing);
      expect((await unmounted.request(path, { headers: auth })).status).toBe(
        404,
      );
      expect(
        (
          await unmounted.request("/operator/capabilities/links", {
            method: "POST",
            headers: auth,
          })
        ).status,
      ).toBe(404);
    }
  } finally {
    clock.mockRestore();
    broker.close();
  }
});
