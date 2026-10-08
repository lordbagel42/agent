import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ChannelAdapter,
  ChannelSearchResult,
  MessageEvent,
} from "../core/contracts.js";
import { createSlackAdapter } from "./slack.js";
import {
  createSlackSearch,
  type SlackPrivateSearchAuthorization,
} from "./slack-search.js";

const initialNow = 1_800_000_000_000;
const signingSecret = "search-signing-secret";
const teamId = "T123ABC";
const actionToken = "ephemeral-action-grant";
const messageTs = "1800000000.000123";
const permalink =
  "https://example.slack.com/archives/C123ABC/p1800000000000123";
const authorizationRequired = {
  status: "unavailable",
  code: "authorization_required",
};

function payload(
  event: Record<string, unknown> = {},
  envelope: Record<string, unknown> = {},
) {
  return {
    type: "event_callback",
    team_id: teamId,
    event_id: "Ev_search",
    event_time: initialNow / 1_000,
    event: {
      type: "message",
      channel_type: "im",
      channel: "D123ABC",
      user: "U123ABC",
      ts: messageTs,
      text: "/search launch status",
      action_token: actionToken,
      ...event,
    },
    ...envelope,
  };
}

function signedRequest(body: unknown, now = initialNow) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(now / 1_000));
  const signature = createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${raw}`)
    .digest("hex");
  return new Request("https://agent.example/webhooks/slack", {
    method: "POST",
    body: raw,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${signature}`,
    },
  });
}

function resultMessage(overrides: Record<string, unknown> = {}) {
  return {
    author_name: "Alex",
    author_user_id: "U456DEF",
    team_id: teamId,
    channel_id: "C123ABC",
    channel_name: "launch",
    message_ts: messageTs,
    content: "Ready for launch",
    is_author_bot: false,
    permalink,
    ...overrides,
  };
}

function results(messages: unknown[] = [resultMessage()]) {
  return { ok: true, results: { messages } };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function setup(response: unknown = results(), enabled = true) {
  let now = initialNow;
  const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
    jsonResponse(response),
  );
  const adapter = createSlackAdapter({
    signingSecret,
    botToken: "search-bot-token",
    teamId,
    botUserId: "U_BOT",
    ownerUserIds: ["U123ABC"],
    searchEnabled: enabled,
    fetch: fetchMock,
    now: () => now,
  });
  return {
    adapter,
    fetchMock,
    advance: (ms: number) => {
      now += ms;
    },
    receive: (body: unknown = payload()) =>
      adapter.receive(signedRequest(body, now)),
  };
}

async function receiveMessage(
  context: ReturnType<typeof setup>,
  body: unknown = payload(),
): Promise<MessageEvent> {
  const received = await context.receive(body);
  expect(received.response.status).toBe(200);
  const event = received.events[0];
  if (event?.type !== "message") throw new Error("Expected a human message");
  return event;
}

async function search(
  adapter: ChannelAdapter,
  event: MessageEvent,
  query = "launch status",
): Promise<ChannelSearchResult> {
  expect(adapter.search).toBeTypeOf("function");
  if (!adapter.search) throw new Error("Search must be enabled");
  return adapter.search(event, query);
}

describe("Slack Real-time Search", () => {
  it("inspects only a live exact-message public token without consuming or exposing it", async () => {
    const context = setup();
    const event = await receiveMessage(context);
    const inspect = context.adapter.hasSearchToken;
    expect(inspect?.(event)).toBe(true);
    expect(inspect?.(event)).toBe(true);
    for (const changed of [
      { ...event, senderId: "U_OTHER" },
      { ...event, messageId: "1800000000.999999" },
      { ...event, address: { ...event.address, threadId: "123.456" } },
    ])
      expect(inspect?.(changed)).toBe(false);
    expect(context.fetchMock).not.toHaveBeenCalled();
    await search(context.adapter, event);
    expect(inspect?.(event)).toBe(false);
    expect(context.fetchMock).toHaveBeenCalledTimes(1);

    const expiring = setup();
    const expiringEvent = await receiveMessage(expiring);
    expiring.advance(5 * 60_000 - 1);
    expect(expiring.adapter.hasSearchToken?.(expiringEvent)).toBe(true);
    expiring.advance(1);
    expect(expiring.adapter.hasSearchToken?.(expiringEvent)).toBe(false);
    expect(expiring.fetchMock).not.toHaveBeenCalled();

    const missing = setup();
    const missingEvent = await receiveMessage(
      missing,
      payload({ action_token: undefined }),
    );
    expect(missing.adapter.hasSearchToken?.(missingEvent)).toBe(false);
    expect(missing.adapter.hasSearchToken?.(event)).toBe(false);
    expect(missing.fetchMock).not.toHaveBeenCalled();
    expect(setup(results(), false).adapter.hasSearchToken).toBeUndefined();
  });

  it("keeps ## content available through an explicit search", async () => {
    const context = setup(
      results([resultMessage({ content: "## explicitly retrieved" })]),
    );
    const event = await receiveMessage(context);
    const found = await search(context.adapter, event);
    expect(found.status).toBe("ready");
    if (found.status === "ready")
      expect(found.text).toContain("## explicitly retrieved");
  });

  it("is absent by default and when explicitly disabled", () => {
    expect(
      createSlackAdapter({
        signingSecret,
        botToken: "search-bot-token",
        teamId,
        botUserId: "U_BOT",
      }),
    ).not.toHaveProperty("search");
    expect(setup(results(), false).adapter).not.toHaveProperty("search");
  });

  it.each([
    ["DM", {}, "D123ABC"],
    ["guest DM", { user: "UGUEST" }, "D123ABC"],
    [
      "guest group DM",
      { user: "UGUEST", channel_type: "mpim", channel: "G123ABC" },
      "G123ABC",
    ],
    [
      "guest mention",
      {
        user: "UGUEST",
        type: "app_mention",
        channel: "C123ABC",
        channel_type: "channel",
        text: "<@U_BOT> search launch",
      },
      "C123ABC",
    ],
    [
      "mention",
      {
        type: "app_mention",
        channel: "C123ABC",
        channel_type: "channel",
        text: "<@U_BOT> search launch",
      },
      "C123ABC",
    ],
  ])(
    "uses a signed %s grant once with a public-only JSON request",
    async (_name, rawEvent, channel) => {
      const context = setup();
      const event = await receiveMessage(context, payload(rawEvent));

      const result = await search(
        context.adapter,
        event,
        "  launch status 🚀  ",
      );

      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw new Error("Expected search results");
      expect(result.text).toContain("Ready for launch");
      expect(result.text).toContain(`<${permalink}|`);
      expect(result.text).toContain("launch");
      expect(result.text).toContain("Alex");
      expect(context.fetchMock).toHaveBeenCalledTimes(1);
      const call = context.fetchMock.mock.calls[0];
      if (!call) throw new Error("Expected a search request");
      const request = new Request(...call);
      expect(request.url).toBe(
        "https://slack.com/api/assistant.search.context",
      );
      expect(request.method).toBe("POST");
      expect(request.redirect).toBe("error");
      expect(request.headers.get("authorization")).toBe(
        "Bearer search-bot-token",
      );
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
      await expect(request.json()).resolves.toEqual({
        query: "launch status 🚀",
        action_token: actionToken,
        context_channel_id: channel,
        content_types: ["messages"],
        channel_types: ["public_channel"],
        include_context_messages: false,
        include_bots: false,
        limit: 5,
      });
      expect(JSON.stringify(event)).not.toContain(actionToken);
      expect(JSON.stringify(event)).not.toContain("action_token");
      expect(Object.keys(event).sort()).toEqual([
        "address",
        "botMentioned",
        "direct",
        "id",
        "messageId",
        "metadata",
        "occurredAt",
        "senderId",
        "text",
        "type",
      ]);
      await expect(search(context.adapter, event)).resolves.toEqual(
        authorizationRequired,
      );
      expect(context.fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "  "],
    ["wrong type", { token: actionToken }],
    ["oversized", "a".repeat(8_193)],
  ])("refuses a %s grant without fetching", async (_label, token) => {
    const context = setup();
    const event = await receiveMessage(
      context,
      payload({ action_token: token }),
    );
    await expect(search(context.adapter, event)).resolves.toEqual(
      authorizationRequired,
    );
    expect(context.fetchMock).not.toHaveBeenCalled();
  });

  it("does not accept action_token from the outer event envelope", async () => {
    const context = setup();
    const event = await receiveMessage(
      context,
      payload({ action_token: undefined }, { action_token: actionToken }),
    );
    await expect(search(context.adapter, event)).resolves.toEqual(
      authorizationRequired,
    );
    expect(context.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "signature",
    "bytes",
    "workspace",
    "missing workspace",
    "bot",
    "reaction",
    "hidden mention",
    "edit",
  ])(
    "does not capture authority from a rejected or ignored %s event",
    async (kind) => {
      const context = setup();
      // An otherwise identical token-free event supplies the identity to probe.
      const event = await receiveMessage(
        context,
        payload({ action_token: undefined }),
      );
      const body = payload();
      if (kind === "workspace") body.team_id = "T_FOREIGN";
      if (kind === "missing workspace") Reflect.deleteProperty(body, "team_id");
      if (kind === "bot") Object.assign(body.event, { bot_id: "B123" });
      if (kind === "reaction")
        Object.assign(body.event, {
          type: "reaction_added",
          reaction: "eyes",
          item: { type: "message", channel: "D123ABC", ts: messageTs },
        });
      if (kind === "hidden mention")
        Object.assign(body.event, { type: "app_mention", hidden: true });
      if (kind === "edit")
        Object.assign(body.event, { subtype: "message_changed" });
      let request = signedRequest(body);
      if (kind === "signature") request.headers.delete("x-slack-signature");
      if (kind === "bytes")
        request = new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify({ ...body, event_id: "Ev_tampered" }),
        });
      const received = await context.adapter.receive(request);
      expect(JSON.stringify(received.events)).not.toContain(actionToken);
      const candidate = received.events[0];
      const probe = candidate?.type === "message" ? candidate : event;
      await expect(search(context.adapter, probe)).resolves.toEqual(
        authorizationRequired,
      );
      expect(context.fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["event", { id: "Ev_other" }],
    ["sender", { senderId: "U_OTHER" }],
    ["message", { messageId: "1800000000.000999" }],
    [
      "workspace",
      {
        address: {
          channel: "slack",
          accountId: "T_OTHER",
          conversationId: "D123ABC",
        },
      },
    ],
    [
      "transport",
      {
        address: {
          channel: "whatsapp",
          accountId: teamId,
          conversationId: "D123ABC",
        },
      },
    ],
    [
      "conversation",
      {
        address: {
          channel: "slack",
          accountId: teamId,
          conversationId: "D_OTHER",
        },
      },
    ],
    [
      "thread",
      {
        address: {
          channel: "slack",
          accountId: teamId,
          conversationId: "D123ABC",
          threadId: "1800000000.000000",
        },
      },
    ],
  ] as const)("binds a grant to its initiating %s", async (_label, changes) => {
    const context = setup();
    const event = await receiveMessage(context);
    await expect(
      search(context.adapter, { ...event, ...changes }),
    ).resolves.toEqual(authorizationRequired);
    expect(context.fetchMock).not.toHaveBeenCalled();
    await expect(search(context.adapter, event)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it.each(["", " \n\t ", "a".repeat(501), "🚀".repeat(501)])(
    "rejects invalid query %j locally without spending the grant",
    async (query) => {
      const context = setup();
      const event = await receiveMessage(context);
      await expect(search(context.adapter, event, query)).resolves.toEqual({
        status: "unavailable",
        code: "unavailable",
      });
      expect(context.fetchMock).not.toHaveBeenCalled();
      await expect(
        search(context.adapter, event, "🚀".repeat(500)),
      ).resolves.toMatchObject({ status: "ready" });
    },
  );

  it("does not replace a grant or extend its local five-minute lifetime on duplicate delivery", async () => {
    const context = setup();
    const mentioned = {
      channel: "C123ABC",
      channel_type: "channel",
      text: "<@U_BOT> search for launch status",
    };
    const event = await receiveMessage(context, payload(mentioned));
    context.advance(240_000);
    const duplicate = await receiveMessage(
      context,
      payload(
        {
          ...mentioned,
          type: "app_mention",
          action_token: "replacement-token",
        },
        { event_id: "Ev_different_callback" },
      ),
    );
    expect(duplicate.id).toBe(event.id);
    await search(context.adapter, event);
    const body = context.fetchMock.mock.calls[0]?.[1]?.body;
    expect(JSON.parse(String(body)).action_token).toBe(actionToken);
    await receiveMessage(context, payload(mentioned));
    await expect(search(context.adapter, duplicate)).resolves.toEqual(
      authorizationRequired,
    );
    context.advance(60_000);
    // A freshly signed retry cannot revive the old event after the cache TTL.
    await receiveMessage(context, payload(mentioned));
    await expect(search(context.adapter, event)).resolves.toEqual(
      authorizationRequired,
    );
    expect(context.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("expires an unused grant even if it is delivered again just before expiry", async () => {
    const context = setup();
    const event = await receiveMessage(context);
    context.advance(299_999);
    await receiveMessage(context);
    context.advance(1);
    await expect(search(context.adapter, event)).resolves.toEqual(
      authorizationRequired,
    );
    expect(context.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects stale and future-dated event authority despite a fresh request signature", async () => {
    for (const eventTime of [
      initialNow / 1_000 - 300,
      initialNow / 1_000 + 301,
    ]) {
      const context = setup();
      const event = await receiveMessage(
        context,
        payload({}, { event_time: eventTime }),
      );
      await expect(search(context.adapter, event)).resolves.toEqual(
        authorizationRequired,
      );
      expect(context.fetchMock).not.toHaveBeenCalled();
    }
  });

  it("bounds grants and consumed tombstones without eviction allowing a replay", async () => {
    const context = setup();
    const first = await receiveMessage(context);
    await search(context.adapter, first);
    for (let index = 1; index < 256; index++) {
      await receiveMessage(
        context,
        payload(
          { ts: `1800000000.${String(index + 1_000).padStart(6, "0")}` },
          { event_id: `Ev_${index}` },
        ),
      );
    }
    const overflow = await receiveMessage(
      context,
      payload({ ts: "1800000000.999999" }, { event_id: "Ev_overflow" }),
    );
    await receiveMessage(context);
    await expect(search(context.adapter, first)).resolves.toEqual(
      authorizationRequired,
    );
    await expect(search(context.adapter, overflow)).resolves.toEqual(
      authorizationRequired,
    );
    expect(context.fetchMock).toHaveBeenCalledTimes(1);
    context.advance(300_001);
    const fresh = await receiveMessage(
      context,
      payload(
        {},
        {
          event_id: "Ev_fresh",
          event_time: (initialNow + 300_000) / 1_000,
        },
      ),
    );
    await expect(search(context.adapter, fresh)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("consumes the grant before awaiting the network, including failed requests", async () => {
    const context = setup();
    let rejectRequest: ((error: Error) => void) | undefined;
    context.fetchMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    const event = await receiveMessage(context);
    expect(context.adapter.search).toBeTypeOf("function");
    const pending = search(context.adapter, event);
    await expect(search(context.adapter, event)).resolves.toEqual(
      authorizationRequired,
    );
    rejectRequest?.(new Error("private upstream failure"));
    await expect(pending).resolves.toEqual({
      status: "unavailable",
      code: "unavailable",
    });
    await receiveMessage(context);
    await expect(search(context.adapter, event)).resolves.toEqual(
      authorizationRequired,
    );
    expect(context.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("formats only public human-message snippets, dropping foreign and malformed results", async () => {
    const context = setup({
      ...results([
        resultMessage({ team_id: "T_FOREIGN", content: "foreign secret" }),
        resultMessage({ content: { text: "malformed secret" } }),
        resultMessage({ is_author_bot: true, content: "bot secret" }),
        resultMessage(),
      ]),
      files: [{ content: "file secret" }],
    });
    const event = await receiveMessage(context);
    const result = await search(context.adapter, event);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected snippets");
    expect(result.text).toContain("Ready for launch");
    expect(result.text).not.toMatch(
      /secret|author_user_id|team_id|context_messages/,
    );
  });

  it("escapes untrusted labels and snippets instead of letting them create markup, links or mentions", async () => {
    const malicious =
      "<@U123> <!channel> <https://evil.test|click> *bold* _italic_ ~strike~ `code` @here & https://evil.test www.evil.test";
    const context = setup(
      results([
        resultMessage({
          content: malicious,
          channel_name: `launch|${malicious}`,
          author_name: malicious,
          context_messages: { before: [{ text: "context secret" }] },
        }),
      ]),
    );
    const result = await search(context.adapter, await receiveMessage(context));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected snippets");
    expect(result.text.match(/<[^>]*>/g)).toHaveLength(1);
    expect(result.text).toContain(`<${permalink}|`);
    expect(result.text).toContain("&lt;");
    expect(result.text).toContain("&amp;");
    expect(result.text).not.toMatch(
      /<@|<!|https:\/\/evil|www\.evil|@here|\*bold\*|_italic_|~strike~|`code`|context secret/,
    );
    expect(result.text.match(/\|/g)).toHaveLength(1);
  });

  it.each([
    "http://example.slack.com/archives/C123ABC/p1800000000000123",
    "https://example.slack.com.evil.test/archives/C123ABC/p1800000000000123",
    "https://evil.test/archives/C123ABC/p1800000000000123",
    "https://example.slack.com@evil.test/archives/C123ABC/p1800000000000123",
    "https://example.slack.com:444/archives/C123ABC/p1800000000000123",
    "https://slack.com/archives/C123ABC/p1800000000000123",
    "https://example.slack.com/files/U123/F123",
    "https://example.slack.com/archives/D123ABC/p1800000000000123",
    "https://example.slack.com/archives/C_OTHER/p1800000000000123",
    "https://example.slack.com/archives/C123ABC/p9999999999999999",
    `${permalink}?redirect=https://evil.test`,
    `${permalink}#<@U123>`,
    `${permalink}|<!channel>`,
    `${permalink}\n`,
    "https://example.slack.com/archives/C123ABC/../p1800000000000123",
  ])(
    "drops a result with an unsafe or mismatched permalink %s",
    async (link) => {
      const context = setup(
        results([resultMessage({ permalink: link, content: "unsafe result" })]),
      );
      const result = await search(
        context.adapter,
        await receiveMessage(context),
      );
      expect(result.status).toBe("ready");
      if (result.status !== "ready")
        throw new Error("Expected safe empty results");
      expect(result.text).not.toContain("unsafe result");
      expect(result.text).not.toContain(link);
      expect(result.text).not.toContain("<");
    },
  );

  it("bounds escaped output to 3,500 codepoints and five results without pagination", async () => {
    const context = setup({
      ...results(
        Array.from({ length: 7 }, (_, index) =>
          resultMessage({
            content: `${index === 5 ? "SIXTH_RESULT" : "snippet"} ${"🚀 & <@U123>".repeat(2_000)}`,
            author_name: "author".repeat(1_000),
            channel_name: "channel".repeat(1_000),
          }),
        ),
      ),
      response_metadata: { next_cursor: "never-fetch-next-page" },
    });
    const result = await search(context.adapter, await receiveMessage(context));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected bounded snippets");
    expect(Array.from(result.text).length).toBeLessThanOrEqual(3_500);
    expect(result.text.match(/<https:\/\//g)).toHaveLength(5);
    expect(result.text).not.toContain("SIXTH_RESULT");
    expect(result.text).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(context.fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(
    [
      null,
      [],
      {},
      { ok: "true" },
      { ok: true },
      { ok: true, results: {} },
      { ok: true, results: { messages: {} } },
      { ok: true, results: { messages: "private raw data" } },
    ].map((response) => [response]),
  )("sanitizes malformed response %j", async (response) => {
    const context = setup(response);
    await expect(
      search(context.adapter, await receiveMessage(context)),
    ).resolves.toEqual({
      status: "unavailable",
      code: "unavailable",
    });
  });

  it.each([
    ["missing_scope", "authorization_required"],
    ["invalid_action_token", "authorization_required"],
    ["invalid_auth", "authorization_required"],
    ["token_expired", "authorization_required"],
    ["token_revoked", "authorization_required"],
    ["not_authed", "authorization_required"],
    ["no_permission", "authorization_required"],
    ["team_access_not_granted", "authorization_required"],
    ["rate_limited", "rate_limited"],
    ["ratelimited", "rate_limited"],
    ["feature_not_enabled", "unavailable"],
    ["private token/body details", "unavailable"],
  ])(
    "maps Slack error %s to a safe %s result without retrying",
    async (error, code) => {
      const context = setup({ ok: false, error });
      await expect(
        search(context.adapter, await receiveMessage(context)),
      ).resolves.toEqual({ status: "unavailable", code });
      expect(context.fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [401, "authorization_required"],
    [403, "authorization_required"],
    [429, "rate_limited"],
    [500, "unavailable"],
    [503, "unavailable"],
    [302, "unavailable"],
    [400, "unavailable"],
  ])("maps HTTP %s to a safe %s result", async (status, code) => {
    const context = setup();
    context.fetchMock.mockResolvedValue(
      new Response("private error body", { status }),
    );
    await expect(
      search(context.adapter, await receiveMessage(context)),
    ).resolves.toEqual({ status: "unavailable", code });
    expect(context.fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["network", "malformed JSON"])(
    "sanitizes %s failures",
    async (failure) => {
      const context = setup();
      if (failure === "network")
        context.fetchMock.mockRejectedValue(new Error("sensitive exception"));
      else
        context.fetchMock.mockResolvedValue(
          new Response("sensitive non-JSON body"),
        );
      await expect(
        search(context.adapter, await receiveMessage(context)),
      ).resolves.toEqual({ status: "unavailable", code: "unavailable" });
      expect(context.fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("aborts a stalled request within ten seconds and never retries", async () => {
    const context = setup();
    let signal: AbortSignal | null | undefined;
    context.fetchMock.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal;
          if (!signal) throw new Error("Expected timeout signal");
          signal.addEventListener("abort", () => reject(signal?.reason), {
            once: true,
          });
        }),
    );
    const event = await receiveMessage(context);
    await expect(search(context.adapter, event)).resolves.toEqual({
      status: "unavailable",
      code: "unavailable",
    });
    expect(signal?.aborted).toBe(true);
    await expect(search(context.adapter, event)).resolves.toEqual(
      authorizationRequired,
    );
    expect(context.fetchMock).toHaveBeenCalledTimes(1);
  }, 15_000);
});

describe("owner-authorized private Slack search", () => {
  function privateSetup() {
    let now = initialNow;
    let authorization: SlackPrivateSearchAuthorization | undefined = {
      ownerId: "owner",
      userId: "U123ABC",
      teamId,
      userToken: "xoxp-owner-test-token",
      grantedScopes: ["search:read.public", "search:read.im"],
      expiresAt: initialNow + 600_000,
    };
    const event: MessageEvent = {
      type: "message",
      id: "Ev_private",
      senderId: "U123ABC",
      address: {
        channel: "slack",
        accountId: teamId,
        conversationId: "D123ABC",
      },
      direct: true,
      messageId: messageTs,
      occurredAt: initialNow,
      text: "/search launch",
    };
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (url) =>
      jsonResponse(
        String(url).endsWith("auth.test")
          ? { ok: true, team_id: teamId, user_id: "U123ABC" }
          : results([
              resultMessage({
                channel_id: "D456DEF",
                permalink: permalink.replace("C123ABC", "D456DEF"),
                content: "private sentinel",
              }),
            ]),
      ),
    );
    const options = {
      teamId,
      botToken: "public-bot-token",
      fetch: fetchMock,
      now: () => now,
      privateSearch: {
        ownerId: "owner",
        userId: "U123ABC",
        getAuthorization: () => authorization,
      },
    };
    const engine = createSlackSearch(options);
    const adapter = createSlackAdapter({
      ...options,
      signingSecret,
      botUserId: "U_BOT",
      ownerUserIds: ["U123ABC"],
      searchEnabled: true,
    });
    return {
      engine,
      adapter,
      event,
      fetchMock,
      revoke: () => {
        authorization = undefined;
      },
      update: (changes: Partial<SlackPrivateSearchAuthorization>) => {
        if (authorization) authorization = { ...authorization, ...changes };
      },
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("does not start private search when superseded during token verification", async () => {
    const { engine, event, fetchMock } = privateSetup();
    const identity = Promise.withResolvers<Response>();
    fetchMock.mockImplementationOnce(() => identity.promise);
    let current = true;
    engine.capture(event, undefined);
    const pending = engine.search(event, "launch", () => current);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    current = false;
    identity.resolve(
      jsonResponse({ ok: true, team_id: teamId, user_id: "U123ABC" }),
    );
    await expect(pending).resolves.toEqual({
      status: "unavailable",
      code: "unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://slack.com/api/auth.test",
    );
  });

  it.each([false, true])(
    "requires fresh captured ingress and spends one DM-bound delivery (reply thread: %s)",
    async (threadedReply) => {
      const context = privateSetup();
      const { engine, event, fetchMock } = context;
      await expect(engine.search(event, "launch")).resolves.toEqual(
        authorizationRequired,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      engine.capture(event, undefined);
      const pending = engine.search(event, "launch");
      await expect(engine.search(event, "launch")).resolves.toEqual(
        authorizationRequired,
      );
      const result = await pending;
      expect(result.status).toBe("private_ready");
      if (result.status !== "private_ready")
        throw new Error("Expected private result");
      expect(JSON.stringify(result)).toBe('{"status":"private_ready"}');
      expect(result).not.toHaveProperty("text");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const call = fetchMock.mock.calls[1];
      if (!call) throw new Error("Expected search");
      const request = new Request(...call);
      expect(request.headers.get("authorization")).toBe(
        "Bearer xoxp-owner-test-token",
      );
      await expect(request.json()).resolves.toEqual({
        query: "launch",
        context_channel_id: "D123ABC",
        content_types: ["messages"],
        channel_types: ["public_channel", "im"],
        include_context_messages: false,
        include_bots: false,
        limit: 5,
      });
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        "https://slack.com/api/auth.test",
      );
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        method: "POST",
        headers: { authorization: request.headers.get("authorization") },
        redirect: "error",
      });
      for (const modified of [
        { ...event, id: "Ev_replay" },
        { ...event, senderId: "UOTHER" },
        { ...event, direct: false },
        { ...event, messageId: "1800000000.000124" },
        { ...event, occurredAt: initialNow + 1 },
        {
          ...event,
          address: { ...event.address, channel: "whatsapp" as const },
        },
        ...["C123ABC", "G123ABC", "DOTHER"].map((conversationId) => ({
          ...event,
          address: { ...event.address, conversationId },
        })),
        { ...event, address: { ...event.address, threadId: "other" } },
        { ...event, address: { ...event.address, accountId: "TOTHER" } },
      ]) {
        const rejected = privateSetup();
        rejected.engine.capture(rejected.event, undefined);
        const guarded = await rejected.engine.search(rejected.event, "launch");
        if (guarded.status !== "private_ready")
          throw new Error("Expected private result");
        expect(guarded.consume(modified)).toBeUndefined();
        expect(guarded.consume(rejected.event)).toBeUndefined();
      }
      context.advance(299_999);
      expect(
        result.consume({
          ...event,
          address: {
            ...event.address,
            ...(threadedReply ? { threadId: event.messageId } : {}),
          },
        }),
      ).toContain("private sentinel");
      expect(result.consume(event)).toBeUndefined();
      engine.capture(event, undefined);
      await expect(engine.search(event, "launch")).resolves.toEqual(
        authorizationRequired,
      );
      expect(JSON.stringify(event)).not.toMatch(/sentinel|xoxp|grantedScopes/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["existing-root", "message-root", undefined])(
    "does not relocate an existing private thread to %s",
    async (destination) => {
      const { engine, event } = privateSetup();
      event.address.threadId = "existing-root";
      engine.capture(event, undefined);
      const result = await engine.search(event, "launch");
      if (result.status !== "private_ready")
        throw new Error("Expected private result");
      const text = result.consume({
        ...event,
        address: {
          ...event.address,
          threadId:
            destination === "message-root" ? event.messageId : destination,
        },
      });
      if (destination === "existing-root")
        expect(text).toContain("private sentinel");
      else expect(text).toBeUndefined();
    },
  );

  it.each([
    { ownerId: "other" },
    { teamId: "TOTHER" },
    { userId: "UOTHER" },
    { userToken: "xoxb-bot" },
    { expiresAt: initialNow },
    { grantedScopes: ["search:read.im"] },
    { grantedScopes: ["search:read.public"] },
  ])(
    "rejects unbound or incomplete authorization %j without bot fallback",
    async (changes) => {
      const context = privateSetup();
      context.update(changes);
      context.engine.capture(context.event, actionToken);
      await expect(
        context.engine.search(context.event, "launch"),
      ).resolves.toEqual(authorizationRequired);
      expect(context.fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { user_id: "UOTHER" },
    { team_id: "TOTHER" },
    { bot_id: "B123" },
    { ok: false, error: "token_revoked" },
  ])("rejects actual token identity %j before querying", async (identity) => {
    const context = privateSetup();
    context.fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        team_id: teamId,
        user_id: "U123ABC",
        ...identity,
      }),
    );
    context.engine.capture(context.event, undefined);
    await expect(
      context.engine.search(context.event, "launch"),
    ).resolves.toEqual(authorizationRequired);
    expect(context.fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    "before",
    "identity",
    "search",
    "delivery",
    "expiry",
    "consent expiry",
    "scopes",
  ])("blocks revocation/expiry at %s and does not replay", async (stage) => {
    const context = privateSetup();
    const { engine, event, fetchMock } = context;
    if (stage === "consent expiry")
      context.update({ expiresAt: initialNow + 60_000 });
    engine.capture(event, undefined);
    if (stage === "before") context.revoke();
    if (stage === "identity" || stage === "search") {
      const original = fetchMock.getMockImplementation();
      fetchMock.mockImplementation(async (...args) => {
        const result = await original?.(...args);
        if (
          String(args[0]).endsWith(
            stage === "identity" ? "auth.test" : "assistant.search.context",
          )
        )
          context.revoke();
        if (!result) throw new Error("Expected response");
        return result;
      });
    }
    const result = await engine.search(event, "launch");
    if (["delivery", "expiry", "consent expiry", "scopes"].includes(stage)) {
      expect(result.status).toBe("private_ready");
      if (result.status !== "private_ready")
        throw new Error("Expected private result");
      if (stage === "expiry") context.advance(300_000);
      else if (stage === "consent expiry") context.advance(60_000);
      else if (stage === "scopes")
        context.update({ grantedScopes: ["search:read.public"] });
      else context.revoke();
      expect(
        result.consume({
          ...event,
          address: { ...event.address, threadId: event.messageId },
        }),
      ).toBeUndefined();
      // Restoring scopes cannot resurrect a rejected delivery.
      context.update({
        grantedScopes: ["search:read.public", "search:read.im"],
      });
      expect(result.consume(event)).toBeUndefined();
    } else expect(result).toEqual(authorizationRequired);
    engine.capture(event, undefined);
    await expect(engine.search(event, "launch")).resolves.toEqual(
      authorizationRequired,
    );
    expect(fetchMock).toHaveBeenCalledTimes(
      stage === "before" ? 0 : stage === "identity" ? 1 : 2,
    );
  });

  it("actively releases unused private output at expiry without more traffic", async () => {
    vi.useFakeTimers();
    try {
      const { engine, event } = privateSetup();
      engine.capture(event, undefined);
      const result = await engine.search(event, "launch");
      if (result.status !== "private_ready")
        throw new Error("Expected private result");
      // Leave the injected clock unchanged to distinguish timer cleanup from
      // the independent consume-time expiry check.
      vi.advanceTimersByTime(300_000);
      expect(result.consume(event)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["UGUEST", "im", "D456DEF"],
    ["U123ABC", "channel", "C123ABC"],
    ["UGUEST", "channel", "C123ABC"],
    ["UGUEST", "group", "G123ABC"],
    ["UGUEST", "mpim", "G123ABC"],
  ] as const)(
    "uses real stored consent for signed %s/%s requests without changing requester or OAuth identity",
    async (user, channel_type, channel) => {
      for (const destination of [channel, "DOTHER"]) {
        const context = privateSetup();
        const received = await context.adapter.receive(
          signedRequest(
            payload({
              user,
              channel_type,
              channel,
              text: "<@U_BOT> search launch",
              action_token: undefined,
            }),
          ),
        );
        const event = received.events[0];
        if (event?.type !== "message")
          throw new Error("Expected admitted request");
        expect(event.senderId).toBe(user);
        expect(context.adapter.hasSearchToken?.(event)).toBe(false);
        const result = await search(context.adapter, event, "launch");
        expect(result.status).toBe("private_ready");
        if (result.status !== "private_ready")
          throw new Error("Expected bound result");
        expect(JSON.stringify(result)).toBe('{"status":"private_ready"}');
        expect(JSON.stringify(event)).not.toMatch(
          /sentinel|xoxp|grantedScopes/,
        );
        expect(context.fetchMock).toHaveBeenCalledTimes(2);
        expect(String(context.fetchMock.mock.calls[0]?.[0])).toBe(
          "https://slack.com/api/auth.test",
        );
        const call = context.fetchMock.mock.calls[1];
        if (!call) throw new Error("Expected OAuth search");
        const request = new Request(...call);
        expect(request.headers.get("authorization")).toMatch(/^Bearer xoxp-/);
        expect(await request.json()).toEqual({
          query: "launch",
          context_channel_id: channel,
          content_types: ["messages"],
          channel_types: ["public_channel", "im"],
          include_context_messages: false,
          include_bots: false,
          limit: 5,
        });
        const text = result.consume({
          ...event,
          address: { ...event.address, conversationId: destination },
        });
        if (destination === channel) expect(text).toContain("private sentinel");
        else expect(text).toBeUndefined();
        expect(result.consume(event)).toBeUndefined();
      }
    },
  );

  it("cannot substitute requester identity for the configured OAuth account or revive revoked channel consent", async () => {
    for (const stage of ["account", "before", "delivery"]) {
      const context = privateSetup();
      const event = {
        ...context.event,
        senderId: "UGUEST",
        direct: false,
        address: { ...context.event.address, conversationId: "C123ABC" },
      };
      if (stage === "account") context.update({ userId: "UGUEST" });
      if (stage === "before") context.revoke();
      context.engine.capture(event, actionToken);
      const result = await context.engine.search(event, "launch");
      if (stage === "delivery") {
        if (result.status !== "private_ready")
          throw new Error("Expected bound result");
        context.revoke();
        expect(result.consume(event)).toBeUndefined();
      } else {
        expect(result).toEqual(authorizationRequired);
        expect(context.fetchMock).not.toHaveBeenCalled();
      }
    }
  });
});
