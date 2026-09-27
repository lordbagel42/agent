import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MessageEvent, OutboundMessage } from "../core/contracts.js";
import { RIVET_REPLY_PREFIX } from "../core/rivet.js";
import { createSlackAdapter } from "./slack.js";
import {
  createSlackIngressDiagnostics,
  type SlackIngressStage,
} from "./slack-ingress.js";
import { SlackThreads } from "./slack-threads.js";

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

function makeAdapter(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  options: Partial<Parameters<typeof createSlackAdapter>[0]> = {},
) {
  return createSlackAdapter({
    signingSecret,
    botToken: "test-bot-token",
    teamId,
    botUserId,
    ownerUserIds: ["U_HUMAN"],
    fetch: fetchImpl,
    now: () => now,
    ...options,
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
  it.each([
    {
      kind: "personality",
      text: '!personality revise {"expectedVersion":0,"changes":{"tone":"dry"},"explanation":"Try it","publish":true}',
      field: "personalityCommandEligible" as const,
    },
    {
      kind: "backup",
      text: "!memory-backup",
      field: "memoryBackupEligible" as const,
    },
  ])(
    "marks only fresh plain owner-DM $kind commands as eligible",
    async ({ text, field }) => {
      const adapter = makeAdapter();
      const event = {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U_HUMAN",
        ts: "123.456",
        text,
      };
      const normalize = async (changes: Record<string, unknown> = {}) => {
        const result = await adapter.receive(
          signedRequest(eventBody({ ...event, ...changes })),
        );
        return result.events[0] as MessageEvent;
      };
      expect((await normalize())[field]).toBe(true);
      for (const type of [
        "rich_text_section",
        "rich_text_quote",
        "rich_text_preformatted",
      ]) {
        const normalized = await normalize({
          blocks: [
            {
              type: "rich_text",
              elements: [{ type, elements: [{ type: "text", text }] }],
            },
          ],
        });
        expect(normalized[field]).toBe(type === "rich_text_section");
      }
      for (const changes of [
        { user: "U_GUEST" },
        { attachments: [] },
        { subtype: "me_message" },
        { text: "ordinary chat" },
        {
          text:
            field === "personalityCommandEligible"
              ? text.replace("Try it", "`Try it`")
              : `\`${text}\``,
        },
      ]) {
        expect((await normalize(changes))[field]).not.toBe(true);
      }
      const unsigned = await adapter.receive(
        signedRequest(eventBody(event), Math.floor(now / 1000), "wrong-body"),
      );
      expect(unsigned.events).toEqual([]);
    },
  );

  it("marks reflection review eligible only for ordinary signed owner-DM input", async () => {
    const adapter = makeAdapter();
    const text = "!reflection list";
    const event = {
      type: "message",
      channel_type: "im",
      channel: "D1",
      user: "U_HUMAN",
      ts: "123.456",
      text,
    };
    for (const type of [
      "rich_text_section",
      "rich_text_quote",
      "rich_text_preformatted",
    ]) {
      const result = await adapter.receive(
        signedRequest(
          eventBody({
            ...event,
            blocks: [
              {
                type: "rich_text",
                elements: [{ type, elements: [{ type: "text", text }] }],
              },
            ],
          }),
        ),
      );
      expect((result.events[0] as MessageEvent).reflectionReviewEligible).toBe(
        type === "rich_text_section",
      );
    }
  });

  it("admits owner follow-ups only in threads June successfully posted to", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "june-slack-threads-"));
    const file = join(root, "threads.sqlite");
    let threads = new SlackThreads(file);
    t.onTestFinished(() => {
      threads.close();
      rmSync(root, { recursive: true, force: true });
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ ok: true, ts: "100.123", channel: "C_THREAD" }),
      );
    let adapter = makeAdapter(fetchImpl, { threads });
    const reply = async (overrides: Record<string, unknown> = {}) =>
      (
        await adapter.receive(
          signedRequest(
            eventBody({
              type: "message",
              channel_type: "channel",
              channel: "C_THREAD",
              user: "U_HUMAN",
              ts: "101.456",
              thread_ts: "100.123",
              text: "and what about this?",
              ...overrides,
            }),
          ),
        )
      ).events;
    expect(await reply()).toEqual([]);
    await adapter.send(
      textMessage({
        channel: "slack",
        accountId: teamId,
        conversationId: "C_THREAD",
      }),
    );
    threads.close();
    threads = new SlackThreads(file);
    adapter = makeAdapter(fetchImpl, { threads });
    expect(threads.has("T_OTHER", botUserId, "C_THREAD", "100.123")).toBe(
      false,
    );
    expect(threads.has(teamId, "U_OTHER_BOT", "C_THREAD", "100.123")).toBe(
      false,
    );
    expect(await reply()).toMatchObject([
      { botMentioned: false, address: { threadId: "100.123" } },
    ]);
    expect(await reply({ channel: "C_OTHER" })).toEqual([]);
    expect(await reply({ thread_ts: "99.999" })).toEqual([]);
    expect(await reply({ thread_ts: undefined })).toEqual([]);
    expect(await reply({ user: "U_GUEST" })).toEqual([]);
    expect(await reply({ text: "## don't read" })).toEqual([]);
    fetchImpl.mockResolvedValue(
      jsonResponse({ ok: true, ts: "102.789", channel: "C_THREAD" }),
    );
    await adapter.send({
      ...textMessage({
        channel: "slack",
        accountId: teamId,
        conversationId: "C_THREAD",
      }),
      content: { type: "text", text: "reply", replyTo: "99.999" },
    });
    expect(await reply({ thread_ts: "99.999" })).toHaveLength(1);
    fetchImpl.mockResolvedValue(
      jsonResponse({ ok: false, error: "not_in_channel" }),
    );
    await adapter.send(
      textMessage({
        channel: "slack",
        accountId: teamId,
        conversationId: "C_THREAD",
        threadId: "88.888",
      }),
    );
    expect(await reply({ thread_ts: "88.888" })).toEqual([]);
    fetchImpl.mockResolvedValue(
      jsonResponse({ ok: true, ts: "103.456", channel: "C_THREAD" }),
    );
    await adapter.send(
      textMessage({
        channel: "slack",
        accountId: teamId,
        conversationId: "C_THREAD",
        threadId: "77.777",
      }),
    );
    expect(await reply({ thread_ts: "77.777" })).toHaveLength(1);
    fetchImpl.mockRejectedValue(new Error("ambiguous connection failure"));
    await adapter.send(
      textMessage({
        channel: "slack",
        accountId: teamId,
        conversationId: "C_THREAD",
        threadId: "66.666",
      }),
    );
    expect(await reply({ thread_ts: "66.666" })).toEqual([]);
    // Recognition is local and does not add a Slack API round trip on ingress.
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("preserves successful sends and explicit contact when the thread ledger fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ ok: true, ts: "300.123", channel: "C_THREAD" }),
      );
    const unavailable = () => {
      throw new Error("ledger unavailable");
    };
    const adapter = makeAdapter(fetchImpl, {
      threads: { has: unavailable, record: unavailable },
    });
    try {
      expect(await adapter.send(textMessage())).toEqual({
        status: "sent",
        messageId: "300.123",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      for (const channel_type of ["im", "channel"]) {
        const result = await adapter.receive(
          signedRequest(
            eventBody({
              type: "message",
              channel_type,
              channel: channel_type === "im" ? "D1" : "C1",
              user: "U_HUMAN",
              ts: "301.234",
              thread_ts: "300.123",
              text: channel_type === "im" ? "follow up" : "<@U_BOT> follow up",
            }),
          ),
        );
        expect(result.events).toHaveLength(1);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("recognizes Slack's signed June-authored thread parent without stored history", async () => {
    const adapter = makeAdapter();
    const reply = async (overrides: Record<string, unknown>) =>
      (
        await adapter.receive(
          signedRequest(
            eventBody({
              type: "message",
              channel_type: "channel",
              channel: "C_OLD",
              user: "U_HUMAN",
              ts: "201.234",
              thread_ts: "200.123",
              parent_user_id: botUserId,
              text: "follow up",
              ...overrides,
            }),
          ),
        )
      ).events;
    expect(await reply({})).toHaveLength(1);
    expect(await reply({ parent_user_id: "U_OTHER" })).toEqual([]);
    expect(await reply({ user: "U_GUEST" })).toEqual([]);
    expect(await reply({ thread_ts: undefined })).toEqual([]);
    expect(await reply({ thread_ts: "201.234" })).toEqual([]);
    expect(await reply({ text: "## ignored" })).toEqual([]);
  });

  it.each([
    ["## private", false],
    ["## <@U_BOT> !stop", false],
    ["### heading", false],
    ["##", false],
    [" ## leading space", true],
    ["\n## leading newline", true],
    ["# heading", true],
    ["hello ## inline", true],
    ["<> quiet", true],
    ["<> <@U_BOT> hello", true],
    [" <> leading space", true],
    ["&lt;&gt; quiet", true],
    ["<!subteam^S_GROUP|@team> hello", true],
    ["<!subteam^S_GROUP> <@U_BOT> hello", true],
    ["<!here> hello", true],
    ["<!channel> hello", true],
    ["<!everyone> hello", true],
    ["<@U_BOT> !stop", true],
    [" <@U_BOT>  !STOP \n", true],
    ["<@u_bot> !stop", true],
    ["<@U_OTHER> !stop", true],
    ["ordinary message", true],
    [`Can you remember this?\n${RIVET_REPLY_PREFIX}\nPRIVATE_COPY`, false],
  ])(
    "blocks raw ## prefixes and private inspection copies: %j",
    async (text, accepted) => {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({
          ok: true,
          channel: { id: "C1", name: "raygen-project", is_channel: true },
        }),
      );
      const adapter = makeAdapter(fetchMock, {
        participateInOwnerChannels: true,
      });
      for (const type of ["message", "app_mention"]) {
        const result = await adapter.receive(
          signedRequest(
            eventBody({
              type,
              text,
              user: "U_HUMAN",
              channel: type === "message" ? "D1" : "C1",
              channel_type: type === "message" ? "im" : "channel",
              ts: "123.456",
              thread_ts: "123.000",
            }),
          ),
        );
        expect(result.response.status).toBe(200);
        expect(result.events).toHaveLength(accepted ? 1 : 0);
        if (accepted) expect(result.events[0]).toMatchObject({ text });
      }
      if (!accepted) expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("admits signed guest mentions and reuses native thread typing without capturing search authority", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true }));
    const adapter = makeAdapter(fetchMock, { searchEnabled: true });
    const result = await adapter.receive(
      signedRequest(
        eventBody({
          type: "app_mention",
          user: "U_STRANGER",
          channel: "C123",
          ts: "1712345678.000001",
          text: "<@U_BOT> hey",
          action_token: "guest-token",
        }),
      ),
    );
    const event = result.events[0];
    expect(event?.type).toBe("message");
    if (event?.type !== "message") throw new Error("missing guest message");
    expect(event.botMentioned).toBe(true);
    expect((await adapter.search?.(event, "private info"))?.status).toBe(
      "unavailable",
    );
    await adapter.setTyping?.(
      { ...event, address: { ...event.address, threadId: event.messageId } },
      true,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://slack.com/api/assistant.threads.setStatus",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      channel_id: "C123",
      thread_ts: event.messageId,
      status: "is thinking…",
    });
  });

  it("shows and clears a thinking reaction in unthreaded DMs without creating a thread", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse({ ok: true }));
    const adapter = makeAdapter(fetchImpl);
    const event: MessageEvent = {
      type: "message",
      id: "dm-thinking",
      occurredAt: now,
      messageId: "1712345678.002",
      senderId: "U_HUMAN",
      direct: true,
      text: "hello",
      address: { channel: "slack", accountId: teamId, conversationId: "D123" },
    };
    await adapter.setTyping?.(event, true);
    await adapter.setTyping?.(event, true);
    await adapter.setTyping?.(event, false);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://slack.com/api/reactions.add",
      "https://slack.com/api/reactions.remove",
    ]);
    for (const [, init] of fetchImpl.mock.calls)
      expect(JSON.parse(String(init?.body))).toEqual({
        channel: "D123",
        timestamp: event.messageId,
        name: "hourglass_flowing_sand",
      });
    expect(event.address.threadId).toBeUndefined();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "already_reacted" }),
    );
    await adapter.setTyping?.(event, true);
    await adapter.setTyping?.(event, false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(
      "https://slack.com/api/reactions.add",
    );
  });

  it("keeps typing scoped to admitted senders and never creates a thread or placeholder message", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true }));
    const adapter = makeAdapter(fetchImpl);
    const event: MessageEvent = {
      type: "message",
      id: "typing-event",
      occurredAt: now,
      messageId: "1712345678.002",
      senderId: "U_HUMAN",
      direct: false,
      text: "private input must not enter a status request",
      address: {
        channel: "slack",
        accountId: teamId,
        conversationId: "C_CONTEXT",
      },
    };
    await adapter.setTyping?.(event, true);
    const threaded = {
      ...event,
      address: { ...event.address, threadId: "1712345678.001" },
    };
    await adapter.setTyping?.({ ...threaded, senderId: "U_OTHER" }, true);
    await adapter.setTyping?.(
      { ...threaded, address: { ...threaded.address, accountId: "T_OTHER" } },
      true,
    );
    await adapter.setTyping?.(threaded, true, AbortSignal.abort());
    expect(fetchImpl).not.toHaveBeenCalled();
    await adapter.setTyping?.(threaded, true);
    fetchImpl.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await adapter.setTyping?.(threaded, false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [index, [url, init]] of fetchImpl.mock.calls.entries()) {
      expect(url).toBe("https://slack.com/api/assistant.threads.setStatus");
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual({
        channel_id: "C_CONTEXT",
        thread_ts: "1712345678.001",
        status: index === 0 ? "is thinking…" : "",
      });
    }
    expect(event.address.threadId).toBeUndefined();
  });

  it("diagnoses rejection without relaxing signature or workspace enforcement", async () => {
    const ingressDiagnostics = createSlackIngressDiagnostics();
    const adapter = createSlackAdapter({
      signingSecret,
      botToken: "test-bot-token",
      teamId,
      botUserId,
      ownerUserIds: ["private-user"],
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

  it("carries opaque correlation across replacement without reading request data", () => {
    const diagnostics = createSlackIngressDiagnostics();
    const unreadable: ProxyHandler<Request> = {
      get() {
        throw new Error("Diagnostics must not read request properties");
      },
    };
    const original = new Proxy(signedRequest("private-original"), unreadable);
    const replacement = new Proxy(
      signedRequest("private-replacement"),
      unreadable,
    );
    const unrelated = new Proxy(signedRequest("private-unrelated"), unreadable);
    diagnostics.record(original, "arrival");
    diagnostics.associate(original, replacement);
    diagnostics.record(replacement, "adapter_received");
    diagnostics.record(unrelated, "arrival");
    const snapshot = diagnostics.snapshot();
    expect(snapshot.counts).toEqual({ arrival: 2, adapter_received: 1 });
    expect(snapshot.recent.map((entry) => entry.stage)).toEqual([
      "arrival",
      "adapter_received",
      "arrival",
    ]);
    expect(snapshot.recent[1]?.requestId).toBe(snapshot.recent[0]?.requestId);
    expect(snapshot.recent[2]?.requestId).not.toBe(
      snapshot.recent[0]?.requestId,
    );
    expect(JSON.stringify(snapshot)).not.toContain("private-");
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

  it.each([undefined, "me_message", "file_share", "thread_broadcast"])(
    "normalizes a human direct message (%s) without parsing Slack timestamp IDs",
    async (subtype) => {
      const body = eventBody(
        {
          type: "message",
          subtype,
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
          id: "slack:T_CONFIGURED:D123:1712345678.000200",
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
          botMentioned: false,
          metadata: { channelType: "im", threadTs: "1712345000.000100" },
        },
      ]);
    },
  );

  it.each([
    ["leaves top-level placement to the model", undefined, undefined],
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
          id: "slack:T_CONFIGURED:C123:1712345678.000300",
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
          botMentioned: true,
          metadata: { channelType: "channel", threadTs },
        },
      ]);
    },
  );

  it("rejects unmentioned guests, bots and unsupported surfaces before channel-name lookup", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    const adapter = makeAdapter(fetchMock, {
      participateInOwnerChannels: true,
      contextEnabled: true,
    });
    const event = {
      type: "message",
      user: "U_HUMAN",
      channel: "C123",
      channel_type: "channel",
      ts: "1712345678.000001",
      text: "hello",
    };
    for (const override of [
      { user: "U_STRANGER" },
      { user: "U_STRANGER", type: "app_mention" },
      { user: botUserId },
      { bot_id: "B123" },
      { app_id: "A123" },
      { subtype: "bot_message" },
      { channel_type: "mpim", channel: "G123" },
      { channel_type: "mpim", channel: "G123", type: "app_mention" },
      { subtype: "message_changed" },
      { subtype: "message_deleted" },
      { subtype: "channel_join" },
      { hidden: true },
    ]) {
      const result = await adapter.receive(
        signedRequest(eventBody({ ...event, ...override })),
      );
      expect(result.events).toEqual([]);
    }
    const unconfigured = makeAdapter(fetchMock, { ownerUserIds: [] });
    expect(
      (await unconfigured.receive(signedRequest(eventBody(event)))).events,
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires channel proof for legacy group mentions that could be group DMs", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    const adapter = makeAdapter(fetchMock);
    const mention = {
      type: "app_mention",
      user: "U_HUMAN",
      channel: "G123",
      ts: "1712345678.000001",
      text: "<@U_BOT> hello",
    };
    for (const [response, accepted] of [
      [{ ok: false, error: "missing_scope" }, false],
      [
        {
          ok: true,
          channel: { id: "G123", is_mpim: true, name: "raygen-group-dm" },
        },
        false,
      ],
      [
        {
          ok: true,
          channel: {
            id: "G123",
            is_group: true,
            is_private: true,
            is_mpim: false,
            name: "private-project",
          },
        },
        true,
      ],
    ] as const) {
      fetchMock.mockResolvedValueOnce(jsonResponse(response));
      const { events } = await adapter.receive(
        signedRequest(eventBody(mention)),
      );
      expect(events).toHaveLength(accepted ? 1 : 0);
      if (accepted)
        expect(events[0]).toMatchObject({
          direct: false,
          metadata: { channelType: "group", channelName: "private-project" },
        });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("allows unmentioned owner messages only by the current Slack channel name", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    const adapter = makeAdapter(fetchMock, {
      participateInOwnerChannels: true,
    });
    const event = {
      type: "message",
      user: "U_HUMAN",
      channel: "C123",
      channel_type: "channel",
      ts: "1712345678.000001",
      text: "the text says raygen but cannot grant access",
      channel_name: "raygen-not-authoritative",
    };
    for (const [channel, allowed] of [
      [
        {
          id: "C123",
          name: "project-raygen-chat",
          is_channel: true,
          is_mpim: false,
        },
        true,
      ],
      [
        { id: "C123", name: "general", is_channel: true, is_mpim: false },
        false,
      ],
      [{ id: "C123", name: "raygen", is_mpim: true }, false],
      [{ id: "C_OTHER", name: "raygen", is_channel: true }, false],
      [undefined, false],
    ] as const) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          channel
            ? { ok: true, channel }
            : { ok: false, error: "missing_scope" },
        ),
      );
      const { events } = await adapter.receive(signedRequest(eventBody(event)));
      expect(events).toHaveLength(allowed ? 1 : 0);
      if (allowed) {
        expect(events[0]).toMatchObject({
          direct: false,
          metadata: {
            channelType: "channel",
            channelName: "project-raygen-chat",
          },
        });
        expect(events[0]?.address.threadId).toBeUndefined();
      }
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const call of fetchMock.mock.calls) {
      const request = new Request(...call);
      expect(request.url).toBe("https://slack.com/api/conversations.info");
      await expect(request.json()).resolves.toEqual({ channel: "C123" });
      expect(request.redirect).toBe("error");
    }
  });

  it("gives both callback types and retries the same durable identity without dropping retries", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    const adapter = makeAdapter(fetchMock, {
      participateInOwnerChannels: true,
    });
    const identities: unknown[] = [];
    for (const [type, eventId] of [
      ["message", "Ev_message"],
      ["app_mention", "Ev_mention"],
      ["message", "Ev_retry"],
    ]) {
      const { events } = await adapter.receive(
        signedRequest(
          eventBody(
            {
              type,
              user: "U_HUMAN",
              channel: "C123",
              channel_type: "channel",
              ts: "1712345678.000001",
              text: "<@U_BOT> hello",
            },
            { eventId },
          ),
        ),
      );
      expect(events).toHaveLength(1);
      identities.push({ id: events[0]?.id, address: events[0]?.address });
    }
    expect(identities).toEqual(
      Array(3).fill({
        id: "slack:T_CONFIGURED:C123:1712345678.000001",
        address: {
          channel: "slack",
          accountId: teamId,
          conversationId: "C123",
        },
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

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

  it.each([false, true])(
    "sends threaded text with bearer auth, stable ID and plainText=%s",
    async (plainText) => {
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
      if (plainText)
        message.content = {
          type: "text",
          text: "hello from June",
          plainText: true,
        };

      const result = await makeAdapter(fetchMock).send(message);

      expect(result).toEqual({
        status: "sent",
        messageId: "1712345678.000600",
      });
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
        ...(plainText
          ? {
              mrkdwn: false,
              parse: "none",
              unfurl_links: false,
              unfurl_media: false,
            }
          : {}),
      });
      expect(signalFromAdapter).toBeInstanceOf(AbortSignal);
    },
  );

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
