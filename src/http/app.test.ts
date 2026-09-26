import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSlackAdapter } from "../channels/slack.js";
import type { ChannelEvent } from "../core/contracts.js";
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

  it("ignores unknown identities and rejects modified signatures before submission", async () => {
    const events: ChannelEvent[] = [];
    const app = createHttpApp(
      dependencies({
        async submit(_scope, event) {
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
    expect(events).toEqual([]);
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
