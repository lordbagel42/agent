import { Hono } from "hono";
import { expect, test } from "vitest";
import { CapabilityBroker } from "../tools/broker.js";
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
