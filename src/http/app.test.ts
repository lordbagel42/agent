import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSlackAdapter } from "../channels/slack.js";
import { createSlackIngressDiagnostics } from "../channels/slack-ingress.js";
import type { ChannelEvent } from "../core/contracts.js";
import { createLifecycle } from "../runtime/lifecycle.js";
import { createHttpApp, type HttpDependencies } from "./app.js";

const token = "operator-test-token-not-a-real-key-12345";
const now = 1_790_000_000_000;
const timestamp = String(now / 1000);
const payload = {
  type: "event_callback",
  team_id: "T1",
  event_id: "Ev1",
  event_time: now / 1000,
  event: {
    type: "message",
    channel_type: "im",
    channel: "D1",
    user: "U1",
    ts: "123.45",
    text: "Hi June",
  },
};
function signed(body = JSON.stringify(payload)): Request {
  const signature = createHmac("sha256", "test-secret")
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return new Request("http://localhost/webhooks/slack", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-signature": `v0=${signature}`,
      "x-slack-request-timestamp": timestamp,
    },
  });
}
function dependencies(
  overrides: Partial<HttpDependencies> = {},
): HttpDependencies {
  return {
    owner: {
      id: "raygen",
      identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
    },
    channels: {
      slack: createSlackAdapter({
        signingSecret: "test-secret",
        botToken: "unused",
        teamId: "T1",
        botUserId: "B1",
        ownerUserIds: ["U1"],
        ingressDiagnostics: overrides.slackIngressDiagnostics,
        now: () => now,
      }),
    },
    operatorToken: token,
    async submit() {},
    async ready() {
      return true;
    },
    async inspectConversation() {
      return { history: ["private conversation"] };
    },
    async inspectJob() {
      return undefined;
    },
    async resumeJob() {
      return false;
    },
    ...overrides,
  };
}

describe("webhook and operator HTTP boundary", () => {
  it("issues short login links only to operators and redeems exactly once after confirmation", async () => {
    const deps = dependencies({
      console: {
        origin: "https://june.example",
        inspect: async () => ({ observedAt: "now", sections: {} }),
      },
    });
    const app = createHttpApp(deps);
    const issue = () =>
      app.request("/operator/console/login-links", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, host: "evil.example" },
      });
    expect((await issue()).status).toBe(201);
    expect(
      (await app.request("/operator/console/login-links", { method: "POST" }))
        .status,
    ).toBe(401);
    const issued = await issue();
    expect(issued.headers.get("cache-control")).toContain("no-store");
    const link = await issued.json();
    expect(link.url).toMatch(/^https:\/\/june\.example\/[A-Za-z0-9_-]{24}$/);
    expect(JSON.stringify(link)).not.toContain(token);
    const path = new URL(link.url).pathname;
    const redirect = await app.request(path);
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("referrer-policy")).toBe("no-referrer");
    const target = redirect.headers.get("location") ?? "";
    // Unfurlers and HEAD requests must not create sessions or consume links.
    for (const method of ["GET", "HEAD", "GET"]) {
      const preview = await app.request(target, { method });
      expect(preview.status).toBe(200);
      expect(preview.headers.get("set-cookie")).toBeNull();
    }
    const form = await (await app.request(target)).text();
    const proof = form.match(/name="proof" value="([^"]+)"/)?.[1] ?? "";
    const redeem = (origin = "https://june.example", value = proof) =>
      app.request(target, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ confirmed: "yes", proof: value }),
      });
    expect((await redeem("https://evil.example")).status).toBe(403);
    expect((await redeem("https://june.example", "bad")).status).toBe(403);
    const responses = await Promise.all([redeem(), redeem()]);
    expect(responses.map((r) => r.status).sort()).toEqual([303, 410]);
    const login = responses.find((r) => r.status === 303);
    if (!login) throw new Error("No successful redemption");
    expect(login.headers.get("location")).toBe("/console");
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain(token);
    const cookie = setCookie.split(";")[0] ?? "";
    expect(
      (await app.request("/console", { headers: { cookie } })).status,
    ).toBe(200);
    expect(
      (
        await app.request("/operator/console/login-links", {
          method: "POST",
          headers: { cookie },
        })
      ).status,
    ).toBe(401);
    expect((await app.request(target)).status).toBe(410);
    const expires = await (await issue()).json();
    const expiredTarget =
      (await app.request(new URL(expires.url).pathname)).headers.get(
        "location",
      ) ?? "";
    const restarted = createHttpApp(deps);
    expect((await restarted.request(expiredTarget)).status).toBe(410);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(expires.expiresAt) - 1);
    expect((await app.request(expiredTarget)).status).toBe(200);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(expires.expiresAt));
    try {
      expect((await app.request(expiredTarget)).status).toBe(410);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("requires a separate deploy credential and fences new work until resumed", async () => {
    const lifecycle = createLifecycle();
    const deployToken = "dedicated-deploy-fixture-token-123456789";
    const revision = "a".repeat(40);
    let submissions = 0;
    const reads: Array<[string, number | undefined]> = [];
    const app = createHttpApp(
      dependencies({
        lifecycle,
        revision,
        deployment: {
          token: deployToken,
          supported: true,
          async read(principal, after) {
            reads.push([principal, after]);
            return {
              version: 1,
              repository: "lordbagel42/agent",
              branch: "main",
              lastHealthyRevision: "b".repeat(40),
              blocked: false,
              events: [],
            };
          },
        },
        async submit() {
          submissions++;
        },
      }),
    );
    const drain = (credential: string, method = "POST") =>
      app.request("/operator/deployment/drain", {
        method,
        headers: { authorization: `Bearer ${credential}` },
      });
    expect((await drain(token)).status).toBe(401);
    expect(lifecycle.ready).toBe(true);
    expect(await (await app.request("/health")).json()).toEqual({
      name: "June",
      ready: true,
      revision,
    });
    const release = await lifecycle.enter(new AbortController().signal);
    const pending = drain(deployToken);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.request(signed())).status).toBe(503);
    expect(submissions).toBe(0);
    expect((await app.request("/health")).status).toBe(503);
    release();
    expect(await (await pending).json()).toEqual({ revision, drained: true });
    expect((await drain(deployToken, "DELETE")).status).toBe(200);
    expect((await app.request(signed())).status).toBe(200);
    expect(submissions).toBe(1);
    expect(
      (
        await app.request("/operator/conversation", {
          headers: { authorization: `Bearer ${deployToken}` },
        })
      ).status,
    ).toBe(401);
    const events = "/operator/deployment/events?after=7";
    for (const credential of [undefined, deployToken]) {
      expect(
        (
          await app.request(events, {
            headers: credential
              ? { authorization: `Bearer ${credential}` }
              : {},
          })
        ).status,
      ).toBe(401);
    }
    expect(reads).toEqual([]);
    const status = await app.request(events, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store, private");
    expect((await status.json()).lastHealthyRevision).toBe("b".repeat(40));
    expect(reads).toEqual([["raygen", 7]]);
    expect(
      (
        await app.request(events, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
    expect(reads).toHaveLength(1);
    lifecycle.fail();
    expect((await drain(deployToken)).status).toBe(409);
    expect((await app.request("/health")).status).toBe(503);
  });

  it("refuses drain when raw background work cannot be accounted for", async () => {
    const lifecycle = createLifecycle();
    const deployToken = "dedicated-deploy-fixture-token-123456789";
    const app = createHttpApp(
      dependencies({
        lifecycle,
        revision: "a".repeat(40),
        deployment: { token: deployToken, supported: false },
      }),
    );
    expect(
      (
        await app.request("/operator/deployment/drain", {
          method: "POST",
          headers: { authorization: `Bearer ${deployToken}` },
        })
      ).status,
    ).toBe(409);
    expect(lifecycle.ready).toBe(true);
  });

  it("confines browser sessions to the optional read-only console, never operator mutations", async () => {
    const unmounted = createHttpApp(dependencies());
    expect((await unmounted.request("/console")).status).toBe(404);
    expect((await unmounted.request("/console/session/login")).status).toBe(
      404,
    );
    let inspections = 0;
    let resumes = 0;
    const deps = dependencies({
      console: {
        origin: "https://june.example",
        async inspect() {
          inspections++;
          return { observedAt: "now", sections: {} };
        },
      },
      async resumeJob() {
        resumes++;
        return true;
      },
    });
    const app = createHttpApp(deps);
    expect((await app.request("/console")).status).toBe(401);
    expect(inspections).toBe(0);
    const loginPage = await app.request("/console/session/login");
    const proof = (await loginPage.text()).match(
      /name="proof" value="([^"]+)"/,
    )?.[1];
    expect(proof).toBeTruthy();
    const login = await app.request("/console/session/login", {
      method: "POST",
      headers: {
        origin: "https://june.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ proof: proof ?? "", token }),
    });
    expect(login.status).toBe(200);
    expect(await login.text()).not.toContain(token);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).not.toBe("");
    const overview = await app.request("/console", { headers: { cookie } });
    expect(overview.status).toBe(200);
    expect(overview.headers.get("cache-control")).toContain("no-store");
    expect(await overview.text()).not.toContain("<form");
    expect(inspections).toBe(1);
    expect(
      (await app.request("/operator/conversation", { headers: { cookie } }))
        .status,
    ).toBe(401);
    expect(
      (
        await app.request(`/operator/jobs/${"a".repeat(64)}/resume`, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            "idempotency-key": "73f9ac38-c99b-4c42-8aa8-a49de85862bf",
          },
          body: JSON.stringify({ confirmedStopped: true }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/console/actions/anything", {
          method: "POST",
          headers: {
            cookie,
            origin: "https://june.example",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ confirmed: "yes" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await app.request("/actions/anything", { headers: { cookie } })).status,
    ).toBe(404);
    expect(resumes).toBe(0);
    expect(
      (await createHttpApp(deps).request("/console", { headers: { cookie } }))
        .status,
    ).toBe(401);
    for (let i = 0; i < 9; i++)
      expect(
        (await app.request("/console/session/login", { method: "POST" }))
          .status,
      ).toBe(403);
    const limited = await app.request("/console/session/login", {
      method: "POST",
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toContain("no-store");
  });

  it("keeps correlated lengthless ingress diagnostics private and records failed durable submission without content", async () => {
    const diagnostics = createSlackIngressDiagnostics();
    const app = createHttpApp(
      dependencies({
        slackIngressDiagnostics: diagnostics,
        async submit() {
          throw new Error("private storage error");
        },
      }),
    );
    const request = signed();
    expect(request.headers.has("content-length")).toBe(false);
    expect((await app.request(request)).status).toBe(503);
    const snapshot = diagnostics.snapshot();
    expect(snapshot.recent.map((entry) => entry.stage)).toEqual([
      "arrival",
      "adapter_received",
      "signature_verified",
      "normalized",
      "owner_accepted",
      "submission_started",
      "submission_failed",
    ]);
    expect(new Set(snapshot.recent.map((entry) => entry.requestId)).size).toBe(
      1,
    );
    expect((await app.request("/operator/ingress/slack")).status).toBe(401);
    const inspected = await app.request("/operator/ingress/slack", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(inspected.headers.get("cache-control")).toBe("no-store");
    expect(await inspected.json()).toEqual(snapshot);
    for (const secret of [
      token,
      payload.event.text,
      "private storage error",
      "Ev1",
      "U1",
      "D1",
    ])
      expect(JSON.stringify(snapshot)).not.toContain(secret);
    const oversized = signed("x".repeat(1_048_577));
    expect((await app.request(oversized)).status).toBe(413);
    const rejected = diagnostics.snapshot().recent.slice(-2);
    expect(rejected.map((entry) => entry.stage)).toEqual([
      "arrival",
      "body_too_large",
    ]);
    expect(new Set(rejected.map((entry) => entry.requestId)).size).toBe(1);
  });

  it("does not acknowledge a verified webhook until durable submission resolves", async () => {
    const committed = Promise.withResolvers<void>();
    const received = Promise.withResolvers<ChannelEvent>();
    const app = createHttpApp(
      dependencies({
        async submit(scope, event) {
          expect(scope).toEqual({ key: ["private", "raygen"], private: true });
          received.resolve(event);
          await committed.promise;
        },
      }),
    );
    let acknowledged = false;
    const response = Promise.resolve(app.request(signed())).then((result) => {
      acknowledged = true;
      return result;
    });
    expect(
      await Promise.race([
        received.promise,
        response.then(() => "acknowledged_too_early"),
      ]),
    ).toEqual(expect.objectContaining({ type: "message" }));
    expect(acknowledged).toBe(false);
    committed.resolve();
    expect((await response).status).toBe(200);
  });

  it("returns a retryable HTTP error when storage fails, without leaking its error", async () => {
    const app = createHttpApp(
      dependencies({
        async submit() {
          throw new Error("secret database credentials");
        },
      }),
    );
    const response = await app.request(signed());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret database credentials");
  });

  it("isolates guest DMs and rejects modified signatures before submission", async () => {
    const events: ChannelEvent[] = [];
    const app = createHttpApp(
      dependencies({
        async submit(scope, event) {
          expect(scope).toEqual({
            key: ["guest", "slack", "T1", "D1", "", "U2"],
            private: false,
          });
          events.push(event);
        },
      }),
    );
    expect(
      (
        await app.request(
          signed(
            JSON.stringify({
              ...payload,
              event: { ...payload.event, user: "U2" },
            }),
          ),
        )
      ).status,
    ).toBe(200);
    const original = signed();
    const modified = new Request(original.url, {
      method: "POST",
      headers: original.headers,
      body: `${JSON.stringify(payload)} `,
    });
    expect((await app.request(modified)).status).toBe(401);
    expect(events).toEqual([expect.objectContaining({ senderId: "U2" })]);
  });

  it("requires bearer auth even on loopback and explicit stopped confirmation for resume", async () => {
    const resumes: string[] = [];
    const app = createHttpApp(
      dependencies({
        async resumeJob(_id, commandId) {
          resumes.push(commandId);
          return true;
        },
      }),
    );
    const unauthorized = await app.request("/operator/conversation");
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).not.toContain("private conversation");
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    expect(
      await (await app.request("/operator/conversation", { headers })).json(),
    ).toEqual({ history: ["private conversation"] });
    const url = `/operator/jobs/${"a".repeat(64)}/resume`;
    expect(
      (
        await app.request(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ confirmedStopped: false }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ confirmedStopped: true }),
        })
      ).status,
    ).toBe(400);
    expect(resumes).toEqual([]);
    const commandId = "73f9ac38-c99b-4c42-8aa8-a49de85862bf";
    expect(
      (
        await app.request(url, {
          method: "POST",
          headers: { ...headers, "idempotency-key": commandId },
          body: JSON.stringify({ confirmedStopped: true }),
        })
      ).status,
    ).toBe(202);
    expect(resumes).toEqual([commandId]);
  });

  it("requires bearer authority for idempotent cancellation and does not claim stoppage", async () => {
    const cancelled: string[] = [];
    const id = "a".repeat(64);
    const app = createHttpApp(
      dependencies({
        async cancelJob(jobId) {
          cancelled.push(jobId);
          return jobId === id;
        },
      }),
    );
    const url = `/operator/jobs/${id}/cancel`;
    expect((await app.request(url, { method: "POST" })).status).toBe(401);
    expect(cancelled).toEqual([]);
    const headers = { authorization: `Bearer ${token}` };
    expect(
      (
        await app.request("/operator/jobs/short/cancel", {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(400);
    const response = await app.request(url, { method: "POST", headers });
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ cancellationRequested: true });
    expect(
      (
        await app.request(`/operator/jobs/${"b".repeat(64)}/cancel`, {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(404);
    expect(cancelled).toEqual([id, "b".repeat(64)]);
  });

  it("reports engine unavailability and rejects oversized payloads", async () => {
    const app = createHttpApp(
      dependencies({
        async ready() {
          return false;
        },
      }),
    );
    expect((await app.request("/health")).status).toBe(503);
    expect((await app.request(signed("x".repeat(1_048_577)))).status).toBe(413);
    expect(() =>
      createHttpApp(dependencies({ operatorToken: "short" })),
    ).toThrow();
  });
});
