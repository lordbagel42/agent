import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSlackAdapter } from "../channels/slack.js";
import { createSlackIngressDiagnostics } from "../channels/slack-ingress.js";
import type { ChannelEvent } from "../core/contracts.js";
import { createLifecycle } from "../runtime/lifecycle.js";
import { CapabilityBroker } from "../tools/broker.js";
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
  it("authenticates private intake separately without bypassing Slack signatures, routing or durable ACK", async () => {
    const intakeToken = "separate-intake-token-32-characters-long";
    const deployment = {
      token: "deploy-token-32-characters-long-12345",
      intakeToken,
      supported: true,
    };
    const lifecycle = createLifecycle();
    const submit = vi.fn(async () => {});
    const deps = dependencies({
      deployment,
      lifecycle,
      revision: "a".repeat(40),
      submit,
    });
    const app = createHttpApp(deps);
    const receivedAt = Date.now() - 86_400_000;
    const replay = (credential = intakeToken, body?: string) => {
      const request = new Request(
        "http://localhost/operator/deployment/slack",
        signed(body),
      );
      request.headers.set("x-june-intake-token", credential);
      request.headers.set("x-june-revision", "a".repeat(40));
      request.headers.set("x-june-received-at", String(receivedAt));
      return request;
    };
    for (const credential of ["", token, deployment.token])
      expect((await app.request(replay(credential))).status).toBe(401);
    expect(submit).not.toHaveBeenCalled();
    const wrongRevision = replay();
    wrongRevision.headers.set("x-june-revision", "b".repeat(40));
    expect((await app.request(wrongRevision)).status).toBe(409);
    const probe = await app.request(
      replay(
        intakeToken,
        JSON.stringify({
          type: "url_verification",
          team_id: "T1",
          challenge: "private-probe",
        }),
      ),
    );
    expect(await probe.text()).toBe("private-probe");
    expect(submit).not.toHaveBeenCalled();
    const unsigned = replay();
    unsigned.headers.delete("x-slack-signature");
    expect((await app.request(unsigned)).status).toBe(401);
    const stale = replay();
    const staleTimestamp = String(now / 1000 - 1000);
    stale.headers.set("x-slack-request-timestamp", staleTimestamp);
    stale.headers.set(
      "x-slack-signature",
      `v0=${createHmac("sha256", "test-secret")
        .update(`v0:${staleTimestamp}:${JSON.stringify(payload)}`)
        .digest("hex")}`,
    );
    const publicRequest = new Request(
      "http://localhost/webhooks/slack",
      stale.clone(),
    );
    expect((await app.request(stale)).status).toBe(401);
    expect((await app.request(publicRequest)).status).toBe(401);
    expect(
      (
        await app.request(
          replay(
            intakeToken,
            JSON.stringify({
              ...payload,
              event: { ...payload.event, user: "other" },
            }),
          ),
        )
      ).status,
    ).toBe(200);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        private: false,
        key: ["guest", "slack", "T1", "D1", "", "other"],
      }),
      expect.objectContaining({ senderId: "other" }),
      receivedAt,
    );
    submit.mockClear();
    // Click accepted before expiry, delivered afterward: only authenticated
    // intake may supply the earlier time. Public header spoofing cannot do so.
    const choice = Buffer.from(
      JSON.stringify({
        id: "question-1",
        team: "T1",
        channel: "D1",
        user: "U1",
        expires: now - 1000,
        prompt: "Which?",
        option: "First",
        index: 0,
      }),
    ).toString("base64url");
    const choiceSignature = createHmac("sha256", "test-secret")
      .update(`june-question-v1:${choice}`)
      .digest("base64url");
    const click = replay(
      intakeToken,
      JSON.stringify({
        type: "block_actions",
        team: { id: "T1" },
        user: { id: "U1" },
        channel: { id: "D1" },
        message: { user: "B1", ts: "123.45" },
        actions: [
          {
            type: "button",
            action_id: "june.question.0",
            value: `${choice}.${choiceSignature}`,
          },
        ],
      }),
    );
    click.headers.set("x-june-received-at", String(now - 2000));
    const publicClick = new Request(
      "http://localhost/webhooks/slack",
      click.clone(),
    );
    expect((await app.request(publicClick)).status).toBe(200);
    expect(submit).not.toHaveBeenCalled();
    expect((await app.request(click)).status).toBe(200);
    expect(submit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "slack-question:T1:question-1:U1",
        occurredAt: now - 2000,
      }),
      now - 2000,
    );
    submit.mockClear();
    expect((await app.request(replay())).status).toBe(200);
    expect(submit).toHaveBeenCalledTimes(1);
    submit.mockRejectedValueOnce(new Error("storage offline"));
    expect((await app.request(replay())).status).toBe(503);
    await lifecycle.drain();
    expect((await app.request(replay())).status).toBe(503);
    for (const duplicate of [token, deployment.token])
      expect(() =>
        createHttpApp({
          ...deps,
          deployment: { ...deployment, intakeToken: duplicate },
        }),
      ).toThrow(/separate/);
  });

  it("mounts opt-in capabilities without weakening bearer, scope, or single-use enforcement", async (t) => {
    const headers = { authorization: `Bearer ${token}` };
    const base = "/operator/capabilities";
    const disabled = createHttpApp(dependencies());
    expect((await disabled.request(`${base}/status`, { headers })).status).toBe(
      404,
    );
    expect(
      (await disabled.request(`${base}/grants`, { method: "POST", headers }))
        .status,
    ).toBe(404);
    let executions = 0;
    let resolutions = 0;
    const options = {
      owner: "raygen",
      resolveCredential: async () => {
        resolutions++;
        return "fixture-credential";
      },
    };
    const empty = new CapabilityBroker(":memory:", { ...options, tools: {} });
    const broker = new CapabilityBroker(":memory:", {
      ...options,
      tools: {
        fixture: {
          execute: async (_action, credential) => {
            expect(credential).toBe("fixture-credential");
            executions++;
          },
        },
      },
    });
    t.onTestFinished(() => {
      empty.close();
      broker.close();
    });
    const dormant = createHttpApp(dependencies({ capabilities: empty }));
    expect(
      await (await dormant.request(`${base}/status`, { headers })).json(),
    ).toEqual({ mounted: true, registeredTools: 0 });
    const action = {
      tool: "fixture",
      account: "test",
      item: "test",
      origin: "https://fixture.example",
      arguments: { value: 7 },
    };
    const grantInput = {
      audience: "raygen",
      action,
      expiresAt: Date.now() + 60000,
    };
    expect(
      (
        await dormant.request(`${base}/grants`, {
          method: "POST",
          headers,
          body: JSON.stringify(grantInput),
        })
      ).status,
    ).toBe(400);
    const lifecycle = createLifecycle();
    const app = createHttpApp(
      dependencies({
        capabilities: broker,
        lifecycle,
        console: {
          origin: "https://june.example",
          inspect: async () => ({ observedAt: "now", sections: {} }),
        },
      }),
    );
    // Obtain a valid private-console session: it must still not authorize grants.
    const loginPage = await (
      await app.request("/console/session/login")
    ).text();
    const proof = loginPage.match(/name="proof" value="([^"]+)"/)?.[1] ?? "";
    const login = await app.request("/console/session/login", {
      method: "POST",
      headers: {
        origin: "https://june.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ proof, token }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).not.toBe("");
    expect(
      (await app.request("/console", { headers: { cookie } })).status,
    ).toBe(200);
    for (const deniedHeaders of [
      new Headers(),
      new Headers({ cookie }),
      new Headers({ authorization: "Bearer wrong" }),
    ]) {
      expect(
        (await app.request(`${base}/status`, { headers: deniedHeaders }))
          .status,
      ).toBe(401);
      expect(
        (
          await app.request(`${base}/grants`, {
            method: "POST",
            headers: deniedHeaders,
            body: JSON.stringify(grantInput),
          })
        ).status,
      ).toBe(401);
    }
    const post = (path: string, input: unknown, extraHeaders = {}) =>
      app.request(`${base}${path}`, {
        method: "POST",
        headers: { ...headers, ...extraHeaders },
        body: JSON.stringify(input),
      });
    expect(
      (await post("/grants", grantInput, { origin: "https://foreign.example" }))
        .status,
    ).toBe(403);
    expect(
      (await post("/grants", grantInput, { "sec-fetch-site": "cross-site" }))
        .status,
    ).toBe(403);
    expect(
      (await post("/grants", { ...grantInput, audience: "other" })).status,
    ).toBe(400);
    expect(
      (await post("/proposals", { ...action, arguments: "x".repeat(65536) }))
        .status,
    ).toBe(413);
    expect(await (await post("/proposals", action)).json()).toEqual(action);
    expect((await post("/grants/missing/execute", action)).status).toBe(400);
    expect(resolutions).toBe(0);
    expect(executions).toBe(0);
    const granted = await post("/grants", grantInput, {
      origin: "https://june.example",
    });
    expect(granted.status).toBe(201);
    const { grantId } = await granted.json();
    expect(
      (
        await post(`/grants/${grantId}/execute`, {
          ...action,
          arguments: { value: 8 },
        })
      ).status,
    ).toBe(400);
    const executed = await post(`/grants/${grantId}/execute`, action);
    expect(executed.status).toBe(200);
    const receipt = await executed.json();
    expect(receipt.status).toBe("succeeded");
    expect(
      await (await post(`/grants/${grantId}/execute`, action)).json(),
    ).toEqual(receipt);
    expect(executions).toBe(1);
    expect(resolutions).toBe(1);
    const audit = await app.request(`${base}/audit`, { headers });
    expect(audit.headers.get("cache-control")).toBe("no-store");
    expect(await audit.text()).not.toContain("fixture-credential");
    await lifecycle.drain();
    expect((await post("/grants", grantInput)).status).toBe(503);
  });

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

  it("limits workspace diff reads to bearer-authenticated job IDs", async () => {
    const inspectJobDiff = vi.fn(async () => null);
    const app = createHttpApp(dependencies({ inspectJobDiff }));
    const url = `/operator/jobs/${"a".repeat(64)}/diff`;
    expect((await app.request(url)).status).toBe(401);
    const headers = { authorization: `Bearer ${token}` };
    for (const input of [
      "/operator/jobs/..%2Fescape/diff",
      `${url}?path=/etc/passwd`,
      `${url}?command=whoami`,
    ])
      expect((await app.request(input, { headers })).status).toBe(400);
    expect(inspectJobDiff).not.toHaveBeenCalled();
    const response = await app.request(url, { headers });
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "diff_unavailable" });
    expect(inspectJobDiff).toHaveBeenCalledExactlyOnceWith("a".repeat(64));
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
