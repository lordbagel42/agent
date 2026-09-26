import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OutboundMessage } from "../core/contracts.js";
import { createSlackAdapter } from "./slack.js";
import {
  createSlackIngressDiagnostics,
  type SlackIngressStage,
} from "./slack-ingress.js";

const signingSecret = "slack-signing-secret";
const now = 1_800_000_000_000;
const teamId = "T_CONFIGURED";
const botUserId = "U_BOT";

function signatureFor(body: string, timestamp: number): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
}

function signedRequest(
  body: string,
  timestamp = Math.floor(now / 1_000),
  signedBody = body,
): Request {
  return new Request("https://agent.example/webhooks/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signatureFor(signedBody, timestamp),
    },
    body,
  });
}

function makeAdapter(fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
  return createSlackAdapter({
    signingSecret,
    botToken: "test-bot-token",
    teamId,
    botUserId,
    fetch: fetchImpl,
    now: () => now,
  });
}

function eventBody(
  event: Record<string, unknown>,
  options: { eventId?: string; eventTime?: number; eventTeamId?: string } = {},
): string {
  return JSON.stringify({
    type: "event_callback",
    team_id: options.eventTeamId ?? teamId,
    event_id: options.eventId ?? "Ev_default",
    event_time: options.eventTime ?? 1_712_345_678,
    event,
  });
}

function textMessage(
  address: OutboundMessage["address"] = {
    channel: "slack",
    accountId: teamId,
    conversationId: "D_CONVERSATION",
  },
): OutboundMessage {
  return {
    id: "operation-123",
    address,
    lastInboundAt: now - 1_000,
    content: { type: "text", text: "hello from June" },
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

describe("createSlackAdapter", () => {
  it("diagnoses rejection without relaxing signature or workspace enforcement", async () => {
    const ingressDiagnostics = createSlackIngressDiagnostics();
    const adapter = createSlackAdapter({
      signingSecret,
      botToken: "test-bot-token",
      teamId,
      botUserId,
      ingressDiagnostics,
      now: () => now,
    });
    const payload = {
      type: "event_callback",
      event_id: "private-event-id",
      event_time: now / 1_000,
      event: {
        type: "message",
        user: "private-user",
        channel: "private-channel",
        channel_type: "im",
        ts: "private-message-id",
        text: "private-message-text",
        action_token: "private-action-token",
      },
    };
    const unsigned = new Request("https://example.com/webhooks/slack", {
      method: "POST",
      body: JSON.stringify({ ...payload, team_id: teamId }),
    });
    expect((await adapter.receive(unsigned)).response.status).toBe(401);
    expect(
      ingressDiagnostics.snapshot().recent.map((entry) => entry.stage),
    ).toEqual(["adapter_received", "signature_rejected"]);

    for (const workspace of [undefined, null, "E_ENTERPRISE", "T_OTHER"]) {
      const result = await adapter.receive(
        signedRequest(JSON.stringify({ ...payload, team_id: workspace })),
      );
      expect(result.response.status).toBe(403);
      expect(result.events).toEqual([]);
    }
    const valid = signedRequest(
      JSON.stringify({ ...payload, team_id: teamId }),
    );
    ingressDiagnostics.record(valid, "arrival");
    const accepted = await adapter.receive(valid);
    expect(accepted.events).toHaveLength(1);
    const snapshot = ingressDiagnostics.snapshot();
    expect(snapshot.counts).toEqual({
      arrival: 1,
      adapter_received: 6,
      signature_rejected: 1,
      signature_verified: 5,
      workspace_rejected: 4,
      normalized: 1,
    });
    expect(
      new Set(snapshot.recent.slice(-4).map((entry) => entry.requestId)).size,
    ).toBe(1);
    for (const sensitive of [
      "private-",
      signingSecret,
      teamId,
      botUserId,
      valid.headers.get("x-slack-signature"),
    ]) {
      expect(JSON.stringify(snapshot)).not.toContain(sensitive);
    }
  });

  it("bounds private diagnostics and rejects arbitrary metadata at runtime", () => {
    const diagnostics = createSlackIngressDiagnostics();
    const request = signedRequest("private-body");
    diagnostics.record(request, "private-token" as SlackIngressStage);
    for (let i = 0; i < 300; i++) diagnostics.record(request, "arrival");
    const snapshot = diagnostics.snapshot();
    expect(snapshot.counts).toEqual({ arrival: 300 });
    expect(snapshot.recent).toHaveLength(256);
    expect(request.bodyUsed).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("private-");
    snapshot.counts.arrival = 0;
    for (const entry of snapshot.recent) entry.requestId = "private-injected";
    expect(diagnostics.snapshot().counts.arrival).toBe(300);
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain("private-");
  });

  it("answers an authenticated URL verification challenge", async () => {
    const adapter = createSlackAdapter({
      signingSecret,
      botToken: "xoxb-test-token",
      teamId: "T_CONFIGURED",
      botUserId: "U_BOT",
      now: () => now,
    });
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-value",
    });

    const result = await adapter.receive(signedRequest(body));

    expect(result.response.status).toBe(200);
    await expect(result.response.text()).resolves.toBe("challenge-value");
    expect(result.events).toEqual([]);
  });

  it("rejects missing, malformed, and body-mismatched signatures before parsing", async () => {
    const invalidJson = "{not-json";
    const timestamp = Math.floor(now / 1_000);
    const missing = new Request("https://agent.example/webhooks/slack", {
      method: "POST",
      headers: { "x-slack-request-timestamp": String(timestamp) },
      body: invalidJson,
    });
    const malformed = signedRequest(invalidJson);
    malformed.headers.set("x-slack-signature", `v0=${"0".repeat(64)}`);
    const originalBody = JSON.stringify({
      type: "url_verification",
      challenge: "original",
    });
    const modifiedBody = JSON.stringify({
      type: "url_verification",
      challenge: "modified",
    });
    const modified = signedRequest(modifiedBody, timestamp, originalBody);

    for (const request of [missing, malformed, modified]) {
      const result = await makeAdapter().receive(request);
      expect(result.response.status).toBe(401);
      expect(result.events).toEqual([]);
    }
  });

  it("rejects missing and non-numeric signing timestamps", async () => {
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-value",
    });
    const missing = signedRequest(body);
    missing.headers.delete("x-slack-request-timestamp");
    const malformed = signedRequest(body);
    malformed.headers.set("x-slack-request-timestamp", "not-a-timestamp");

    for (const request of [missing, malformed]) {
      const result = await makeAdapter().receive(request);
      expect(result.response.status).toBe(401);
      expect(result.events).toEqual([]);
    }
  });

  it.each([
    ["past", -301],
    ["future", 301],
  ])(
    "rejects a signing timestamp over 300 seconds in the %s",
    async (_label, offset) => {
      const body = JSON.stringify({
        type: "url_verification",
        challenge: "challenge-value",
      });
      const timestamp = Math.floor(now / 1_000) + offset;

      const result = await makeAdapter().receive(
        signedRequest(body, timestamp),
      );

      expect(result.response.status).toBe(401);
      expect(result.events).toEqual([]);
    },
  );

  it("accepts a signing timestamp exactly 300 seconds away", async () => {
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "boundary-challenge",
    });
    const timestamp = Math.floor(now / 1_000) + 300;

    const result = await makeAdapter().receive(signedRequest(body, timestamp));

    expect(result.response.status).toBe(200);
    await expect(result.response.text()).resolves.toBe("boundary-challenge");
  });

  it("rejects invalid JSON only after its raw bytes authenticate", async () => {
    const result = await makeAdapter().receive(signedRequest("{not-json"));

    expect(result.response.status).toBe(400);
    expect(result.events).toEqual([]);
  });

  it("binds event callbacks to the configured Slack team", async () => {
    const body = eventBody(
      {
        type: "message",
        user: "U_HUMAN",
        text: "hello",
        channel: "D_OTHER_TEAM",
        channel_type: "im",
        ts: "1712345678.000001",
      },
      { eventTeamId: "T_OTHER" },
    );

    const result = await makeAdapter().receive(signedRequest(body));

    expect(result.response.status).toBe(403);
    expect(result.events).toEqual([]);
  });

  it("normalizes a human direct message without parsing Slack timestamp IDs", async () => {
    const body = eventBody(
      {
        type: "message",
        user: "U_HUMAN",
        text: "keep my IDs exact",
        channel: "D123",
        channel_type: "im",
        ts: "1712345678.000200",
        thread_ts: "1712345000.000100",
      },
      { eventId: "Ev_dm_1", eventTime: 1_712_345_678 },
    );

    const result = await makeAdapter().receive(signedRequest(body));

    expect(result.response.status).toBe(200);
    expect(result.events).toEqual([
      {
        id: "Ev_dm_1",
        type: "message",
        address: {
          channel: "slack",
          accountId: teamId,
          conversationId: "D123",
          threadId: "1712345000.000100",
        },
        occurredAt: 1_712_345_678_000,
        messageId: "1712345678.000200",
        senderId: "U_HUMAN",
        direct: true,
        text: "keep my IDs exact",
      },
    ]);
  });

  it.each([
    ["starts a new thread", undefined, "1712345678.000300"],
    ["keeps the existing root", "1712345000.000100", "1712345000.000100"],
  ])(
    "normalizes an app mention and %s",
    async (_label, threadTs, expectedThread) => {
      const body = eventBody(
        {
          type: "app_mention",
          user: "U_HUMAN",
          text: "<@U_BOT> status?",
          channel: "C123",
          ts: "1712345678.000300",
          ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
        },
        { eventId: `Ev_mention_${threadTs ?? "root"}` },
      );

      const result = await makeAdapter().receive(signedRequest(body));

      expect(result.response.status).toBe(200);
      expect(result.events).toEqual([
        {
          id: `Ev_mention_${threadTs ?? "root"}`,
          type: "message",
          address: {
            channel: "slack",
            accountId: teamId,
            conversationId: "C123",
            threadId: expectedThread,
          },
          occurredAt: 1_712_345_678_000,
          messageId: "1712345678.000300",
          senderId: "U_HUMAN",
          direct: false,
          text: "<@U_BOT> status?",
        },
      ]);
    },
  );

  it.each([
    [
      "bot messages",
      {
        type: "message",
        subtype: "bot_message",
        bot_id: "B123",
        user: "U_APP",
        text: "bot output",
        channel: "D123",
        channel_type: "im",
        ts: "1712345678.000400",
      },
    ],
    [
      "message edits",
      {
        type: "message",
        subtype: "message_changed",
        channel: "D123",
        channel_type: "im",
        ts: "1712345678.000401",
        message: { user: "U_HUMAN", text: "edited" },
      },
    ],
    [
      "ordinary public messages",
      {
        type: "message",
        user: "U_HUMAN",
        text: "not a mention",
        channel: "C123",
        channel_type: "channel",
        ts: "1712345678.000402",
      },
    ],
    [
      "the bot's own direct messages",
      {
        type: "message",
        user: botUserId,
        text: "self output",
        channel: "D123",
        channel_type: "im",
        ts: "1712345678.000403",
      },
    ],
    [
      "the bot's own mentions",
      {
        type: "app_mention",
        user: botUserId,
        text: "<@U_BOT> self output",
        channel: "C123",
        ts: "1712345678.000404",
      },
    ],
    [
      "the bot's own reactions",
      {
        type: "reaction_added",
        user: botUserId,
        reaction: "robot_face",
        item: { type: "message", channel: "C123", ts: "1712345678.000405" },
      },
    ],
  ])("acknowledges but ignores %s", async (_label, event) => {
    const body = eventBody(event, { eventId: "Ev_ignored" });

    const result = await makeAdapter().receive(signedRequest(body));

    expect(result.response.status).toBe(200);
    expect(result.events).toEqual([]);
  });

  it.each([
    ["reaction_added", false, "Ev_reaction_add"],
    ["reaction_removed", true, "Ev_reaction_remove"],
  ])("normalizes native %s events", async (type, removed, eventId) => {
    const body = eventBody(
      {
        type,
        user: "U_HUMAN",
        reaction: "eyes",
        item: {
          type: "message",
          channel: "C123",
          ts: "1712345678.000500",
        },
      },
      { eventId, eventTime: 1_712_345_679 },
    );

    const result = await makeAdapter().receive(signedRequest(body));

    expect(result.response.status).toBe(200);
    expect(result.events).toEqual([
      {
        id: eventId,
        type: "reaction",
        address: {
          channel: "slack",
          accountId: teamId,
          conversationId: "C123",
        },
        occurredAt: 1_712_345_679_000,
        messageId: "1712345678.000500",
        senderId: "U_HUMAN",
        emoji: "eyes",
        removed,
      },
    ]);
  });

  it("sends threaded text with bearer auth and a stable client message ID", async () => {
    let requestFromAdapter: Request | undefined;
    let signalFromAdapter: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requestFromAdapter = new Request(input, init);
      signalFromAdapter = init?.signal;
      return jsonResponse({
        ok: true,
        channel: "D_CONVERSATION",
        ts: "1712345678.000600",
      });
    });
    const message = textMessage({
      channel: "slack",
      accountId: teamId,
      conversationId: "D_CONVERSATION",
      threadId: "1712345000.000100",
    });

    const result = await makeAdapter(fetchMock).send(message);

    expect(result).toEqual({ status: "sent", messageId: "1712345678.000600" });
    expect(requestFromAdapter).toBeDefined();
    if (requestFromAdapter === undefined) {
      throw new Error("Slack request was not captured");
    }
    expect(requestFromAdapter.url).toBe(
      "https://slack.com/api/chat.postMessage",
    );
    expect(requestFromAdapter.method).toBe("POST");
    expect(requestFromAdapter.headers.get("authorization")).toBe(
      "Bearer test-bot-token",
    );
    expect(requestFromAdapter.headers.get("content-type")).toBe(
      "application/json",
    );
    await expect(requestFromAdapter.json()).resolves.toEqual({
      channel: "D_CONVERSATION",
      text: "hello from June",
      client_msg_id: "operation-123",
      thread_ts: "1712345000.000100",
    });
    expect(signalFromAdapter).toBeInstanceOf(AbortSignal);
  });

  it("rejects wrong channel and account destinations without network access", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    const adapter = makeAdapter(fetchMock);
    const wrongChannel = textMessage({
      channel: "whatsapp",
      accountId: teamId,
      conversationId: "D_CONVERSATION",
    });
    const wrongAccount = textMessage({
      channel: "slack",
      accountId: "T_OTHER",
      conversationId: "D_CONVERSATION",
    });

    await expect(adapter.send(wrongChannel)).resolves.toEqual({
      status: "rejected",
      code: "wrong_channel",
      retryable: false,
    });
    await expect(adapter.send(wrongAccount)).resolves.toEqual({
      status: "rejected",
      code: "wrong_account",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects text beyond Slack's 40,000-character limit without truncating or fetching", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    const message = textMessage();
    message.content = { type: "text", text: "a".repeat(40_001) };

    const result = await makeAdapter(fetchMock).send(message);

    expect(result).toEqual({
      status: "rejected",
      code: "message_too_long",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [false, "reactions.add"],
    [true, "reactions.remove"],
  ])("sends a native reaction when remove is %s", async (remove, method) => {
    let requestFromAdapter: Request | undefined;
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requestFromAdapter = new Request(input, init);
      return jsonResponse({ ok: true });
    });
    const message: OutboundMessage = {
      id: `operation-reaction-${String(remove)}`,
      address: {
        channel: "slack",
        accountId: teamId,
        conversationId: "C123",
        threadId: "1712345000.000100",
      },
      lastInboundAt: now - 1_000,
      content: {
        type: "reaction",
        messageId: "1712345678.000700",
        emoji: "white_check_mark",
        remove,
      },
    };

    const result = await makeAdapter(fetchMock).send(message);

    expect(result).toEqual({ status: "sent", messageId: "1712345678.000700" });
    expect(requestFromAdapter).toBeDefined();
    if (requestFromAdapter === undefined) {
      throw new Error("Slack request was not captured");
    }
    expect(requestFromAdapter.url).toBe(`https://slack.com/api/${method}`);
    expect(requestFromAdapter.method).toBe("POST");
    expect(requestFromAdapter.headers.get("authorization")).toBe(
      "Bearer test-bot-token",
    );
    await expect(requestFromAdapter.json()).resolves.toEqual({
      channel: "C123",
      timestamp: "1712345678.000700",
      name: "white_check_mark",
    });
  });

  it.each([
    [undefined, "already_reacted"],
    [false, "already_reacted"],
    [true, "no_reaction"],
  ])(
    "confirms the desired reaction state for remove=%s and %s",
    async (remove, error) => {
      const fetchMock = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(jsonResponse({ ok: false, error }));
      const message = textMessage();
      message.content = {
        type: "reaction",
        messageId: "1712345678.000700",
        emoji: "eyes",
        ...(remove === undefined ? {} : { remove }),
      };

      await expect(makeAdapter(fetchMock).send(message)).resolves.toEqual({
        status: "sent",
        messageId: "1712345678.000700",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [false, "no_reaction"],
    [true, "already_reacted"],
    [false, "not_in_channel"],
    [true, "not_in_channel"],
  ])(
    "does not swallow the opposite or unrelated reaction error for remove=%s and %s",
    async (remove, error) => {
      const fetchMock = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(jsonResponse({ ok: false, error }));
      const message = textMessage();
      message.content = {
        type: "reaction",
        messageId: "1712345678.000700",
        emoji: "eyes",
        remove,
      };

      await expect(makeAdapter(fetchMock).send(message)).resolves.toEqual({
        status: "rejected",
        code: error,
        retryable: false,
      });
    },
  );

  it.each(["already_reacted", "no_reaction"])(
    "does not swallow reaction error %s for a text operation",
    async (error) => {
      const fetchMock = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(jsonResponse({ ok: false, error }));
      await expect(makeAdapter(fetchMock).send(textMessage())).resolves.toEqual(
        {
          status: "rejected",
          code: error,
          retryable: false,
        },
      );
    },
  );

  it("returns a bounded retryable rejection for Slack rate limiting", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({ ok: false, error: "ratelimited" }, 429, {
        "retry-after": "999999",
      }),
    );

    const result = await makeAdapter(fetchMock).send(textMessage());

    expect(result).toEqual({
      status: "rejected",
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 300_000,
    });
  });

  it("returns Slack API errors as non-retryable rejections", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ ok: false, error: "not_in_channel" }));

    const result = await makeAdapter(fetchMock).send(textMessage());

    expect(result).toEqual({
      status: "rejected",
      code: "not_in_channel",
      retryable: false,
    });
  });

  it("treats network failures as unknown rather than safe retries", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError("connection closed"));

    const result = await makeAdapter(fetchMock).send(textMessage());

    expect(result).toEqual({ status: "unknown", code: "network_error" });
  });

  it("treats Slack 5xx responses as unknown even when they contain an explicit error", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        jsonResponse({ ok: false, error: "fatal_error" }, 503),
      );

    const result = await makeAdapter(fetchMock).send(textMessage());

    expect(result).toEqual({ status: "unknown", code: "slack_server_error" });
  });

  it.each([
    ["non-JSON", new Response("not-json", { status: 200 })],
    ["a text success without a message timestamp", jsonResponse({ ok: true })],
  ])("treats %s as an unknown malformed success", async (_label, response) => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response);

    const result = await makeAdapter(fetchMock).send(textMessage());

    expect(result).toEqual({ status: "unknown", code: "malformed_response" });
  });

  it("bounds an outbound fetch with a timeout and reports an unknown outcome", async () => {
    let signalFromAdapter: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          signalFromAdapter = init?.signal;
          if (signalFromAdapter === undefined || signalFromAdapter === null) {
            reject(new Error("missing abort signal"));
            return;
          }
          signalFromAdapter.addEventListener(
            "abort",
            () => reject(signalFromAdapter?.reason),
            { once: true },
          );
        }),
    );

    const result = await makeAdapter(fetchMock).send(textMessage());

    expect(result).toEqual({ status: "unknown", code: "timeout" });
    expect(signalFromAdapter?.aborted).toBe(true);
  }, 15_000);
});
