import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address, OutboundMessage } from "../core/contracts.js";
import { createWhatsAppAdapter } from "./whatsapp.js";

const APP_SECRET = "whatsapp-app-secret";
const VERIFY_TOKEN = "exact-verify-token";
const ACCESS_TOKEN = "whatsapp-access-token";
const PHONE_NUMBER_ID = "109876543210";
const API_VERSION = "v23.0";
const NOW = 2_000_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

type FetchArguments = Parameters<typeof globalThis.fetch>;

function mockFetch(
  implementation: (...arguments_: FetchArguments) => Promise<Response>,
): typeof globalThis.fetch {
  return vi.fn(implementation) as unknown as typeof globalThis.fetch;
}

function unexpectedFetch(): typeof globalThis.fetch {
  return mockFetch(async () => {
    throw new Error("unexpected external request");
  });
}

function makeAdapter(options?: {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}) {
  return createWhatsAppAdapter({
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    accessToken: ACCESS_TOKEN,
    phoneNumberId: PHONE_NUMBER_ID,
    apiVersion: API_VERSION,
    fetch: options?.fetch ?? unexpectedFetch(),
    now: options?.now ?? (() => NOW),
  });
}

function signature(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

function signedRequest(body: string, bodySignature = signature(body)): Request {
  return new Request("https://agent.example.test/webhooks/whatsapp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": bodySignature,
    },
    body,
  });
}

function textMessage(
  overrides: Partial<Omit<OutboundMessage, "address" | "content">> & {
    address?: Address;
    content?: OutboundMessage["content"];
  } = {},
): OutboundMessage {
  return {
    id: "operation-1",
    address: {
      channel: "whatsapp",
      accountId: PHONE_NUMBER_ID,
      conversationId: "15551234567",
    },
    lastInboundAt: NOW - 1_000,
    content: { type: "text", text: "hello from June" },
    ...overrides,
  };
}

function assertRequest(value: Request | undefined): asserts value is Request {
  expect(value).toBeInstanceOf(Request);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createWhatsAppAdapter receive", () => {
  it("returns the GET challenge only for an exact subscribe verification token", async () => {
    const adapter = makeAdapter();
    const valid = await adapter.receive(
      new Request(
        `https://agent.example.test/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=challenge-value`,
      ),
    );

    expect(adapter.channel).toBe("whatsapp");
    expect(adapter.capabilities).toEqual({
      text: true,
      reactions: true,
      threads: false,
    });
    expect(valid.response.status).toBe(200);
    expect(await valid.response.text()).toBe("challenge-value");
    expect(valid.events).toEqual([]);

    const invalid = await adapter.receive(
      new Request(
        "https://agent.example.test/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=exact-verify-token%20&hub.challenge=do-not-leak-me",
      ),
    );

    expect(invalid.response.status).toBe(403);
    expect(await invalid.response.text()).not.toContain("do-not-leak-me");
    expect(invalid.events).toEqual([]);
  });

  it("authenticates the exact POST bytes before attempting to parse JSON", async () => {
    const adapter = makeAdapter();
    const malformedBody = '{"entry":';

    const unauthenticated = await adapter.receive(
      signedRequest(malformedBody, signature('{"entry":[]}')),
    );

    expect(unauthenticated.response.status).toBe(401);
    expect(unauthenticated.events).toEqual([]);

    const authenticated = await adapter.receive(signedRequest(malformedBody));

    expect(authenticated.response.status).toBe(400);
    expect(authenticated.events).toEqual([]);
  });

  it("normalizes all text, reaction, removal, and receipt events in signed batches for the configured account", async () => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-one",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550000000",
                  phone_number_id: PHONE_NUMBER_ID,
                },
                contacts: [
                  { profile: { name: "Owner" }, wa_id: "15550001111" },
                ],
                messages: [
                  {
                    from: "15550001111",
                    id: "wamid.text.opaque/==",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "  keep this text exactly  " },
                  },
                  {
                    from: "15550002222",
                    id: "wamid.reaction.opaque+==",
                    timestamp: "1700000001",
                    type: "reaction",
                    reaction: {
                      message_id: "wamid.target.opaque/+=",
                      emoji: "👍🏽",
                    },
                  },
                  {
                    from: "15550002222",
                    id: "wamid.removal.opaque+==",
                    timestamp: "1700000002",
                    type: "reaction",
                    reaction: {
                      message_id: "wamid.target.opaque/+=",
                      emoji: "",
                    },
                  },
                  {
                    from: "15550001111",
                    id: "wamid.unsupported-image",
                    timestamp: "1700000002",
                    type: "image",
                    image: { id: "media-id" },
                  },
                ],
                statuses: [
                  {
                    id: "wamid.outbound.opaque/==",
                    recipient_id: "15550001111",
                    status: "sent",
                    timestamp: "1700000003",
                  },
                  {
                    id: "wamid.outbound.opaque/==",
                    recipient_id: "15550001111",
                    status: "delivered",
                    timestamp: "1700000004",
                  },
                ],
              },
            },
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "different-phone-number-id" },
                messages: [
                  {
                    from: "15559999999",
                    id: "wamid.other-account",
                    timestamp: "1700000004",
                    type: "text",
                    text: { body: "must be ignored" },
                  },
                ],
              },
            },
          ],
        },
        {
          id: "waba-two",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                statuses: [
                  {
                    id: "wamid.outbound.opaque/==",
                    recipient_id: "15550001111",
                    status: "read",
                    timestamp: "1700000005",
                  },
                  {
                    errors: [{ code: 131047, title: "Re-engagement message" }],
                    id: "wamid.failed.opaque/==",
                    recipient_id: "15550003333",
                    status: "failed",
                    timestamp: "1700000006",
                  },
                  {
                    id: "wamid.unknown-status",
                    recipient_id: "15550003333",
                    status: "deleted",
                    timestamp: "1700000006",
                  },
                ],
              },
            },
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                messages: [
                  {
                    from: "15550004444",
                    id: "wamid.second-text",
                    timestamp: "1700000007",
                    type: "text",
                    text: { body: "second batch message" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const result = await makeAdapter().receive(signedRequest(body));

    expect(result.response.status).toBe(200);
    expect(result.events).toEqual([
      {
        id: "wamid.text.opaque/==",
        type: "message",
        messageId: "wamid.text.opaque/==",
        senderId: "15550001111",
        direct: true,
        text: "  keep this text exactly  ",
        occurredAt: 1_700_000_000_000,
        address: {
          channel: "whatsapp",
          accountId: PHONE_NUMBER_ID,
          conversationId: "15550001111",
        },
      },
      {
        id: "wamid.reaction.opaque+==",
        type: "reaction",
        messageId: "wamid.target.opaque/+=",
        senderId: "15550002222",
        emoji: "👍🏽",
        removed: false,
        occurredAt: 1_700_000_001_000,
        address: {
          channel: "whatsapp",
          accountId: PHONE_NUMBER_ID,
          conversationId: "15550002222",
        },
      },
      {
        id: "wamid.removal.opaque+==",
        type: "reaction",
        messageId: "wamid.target.opaque/+=",
        senderId: "15550002222",
        emoji: "",
        removed: true,
        occurredAt: 1_700_000_002_000,
        address: {
          channel: "whatsapp",
          accountId: PHONE_NUMBER_ID,
          conversationId: "15550002222",
        },
      },
      {
        id: "receipt:wamid.outbound.opaque/==:sent:1700000003",
        type: "receipt",
        messageId: "wamid.outbound.opaque/==",
        status: "sent",
        occurredAt: 1_700_000_003_000,
        address: {
          channel: "whatsapp",
          accountId: PHONE_NUMBER_ID,
          conversationId: "15550001111",
        },
      },
      {
        id: "receipt:wamid.outbound.opaque/==:delivered:1700000004",
        type: "receipt",
        messageId: "wamid.outbound.opaque/==",
        status: "delivered",
        occurredAt: 1_700_000_004_000,
        address: {
          channel: "whatsapp",
          accountId: PHONE_NUMBER_ID,
          conversationId: "15550001111",
        },
      },
      {
        id: "receipt:wamid.outbound.opaque/==:read:1700000005",
        type: "receipt",
        messageId: "wamid.outbound.opaque/==",
        status: "read",
        occurredAt: 1_700_000_005_000,
        address: {
          channel: "whatsapp",
          accountId: PHONE_NUMBER_ID,
          conversationId: "15550001111",
        },
      },
      {
        id: "receipt:wamid.failed.opaque/==:failed:1700000006",
        type: "receipt",
        messageId: "wamid.failed.opaque/==",
        status: "failed",
        occurredAt: 1_700_000_006_000,
        address: {
          channel: "whatsapp",
          accountId: PHONE_NUMBER_ID,
          conversationId: "15550003333",
        },
      },
      {
        id: "wamid.second-text",
        type: "message",
        messageId: "wamid.second-text",
        senderId: "15550004444",
        direct: true,
        text: "second batch message",
        occurredAt: 1_700_000_007_000,
        address: {
          channel: "whatsapp",
          accountId: PHONE_NUMBER_ID,
          conversationId: "15550004444",
        },
      },
    ]);
  });
});

describe("createWhatsAppAdapter send", () => {
  it("sends text and reply context through the configured Graph API account", async () => {
    let outboundRequest: Request | undefined;
    const fetch = mockFetch(async (input, init) => {
      outboundRequest = new Request(input, init);
      return new Response(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: "15551234567", wa_id: "15551234567" }],
          messages: [{ id: "wamid.outbound.opaque/==" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const adapter = makeAdapter({ fetch });

    const result = await adapter.send(
      textMessage({
        content: {
          type: "text",
          text: "reply without modification",
          replyTo: "wamid.inbound.opaque+==",
        },
      }),
    );

    expect(result).toEqual({
      status: "sent",
      messageId: "wamid.outbound.opaque/==",
    });
    assertRequest(outboundRequest);
    expect(outboundRequest.url).toBe(
      `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    );
    expect(outboundRequest.method).toBe("POST");
    expect(outboundRequest.headers.get("authorization")).toBe(
      `Bearer ${ACCESS_TOKEN}`,
    );
    expect(outboundRequest.headers.get("content-type")).toBe(
      "application/json",
    );
    expect(await outboundRequest.json()).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15551234567",
      context: { message_id: "wamid.inbound.opaque+==" },
      type: "text",
      text: { body: "reply without modification" },
    });
  });

  it.each([
    [false, "👍🏽"],
    [true, ""],
  ])("serializes native reaction removal=%s", async (remove, expectedEmoji) => {
    let outboundRequest: Request | undefined;
    const fetch = mockFetch(async (input, init) => {
      outboundRequest = new Request(input, init);
      return new Response(
        JSON.stringify({ messages: [{ id: "wamid.reaction-result" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await makeAdapter({ fetch }).send(
      textMessage({
        content: {
          type: "reaction",
          messageId: "wamid.target.opaque/+=",
          emoji: "👍🏽",
          remove,
        },
      }),
    );

    expect(result).toEqual({
      status: "sent",
      messageId: "wamid.reaction-result",
    });
    assertRequest(outboundRequest);
    expect(await outboundRequest.json()).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15551234567",
      type: "reaction",
      reaction: {
        message_id: "wamid.target.opaque/+=",
        emoji: expectedEmoji,
      },
    });
  });

  it("allows free-form text just inside 24 hours and rejects the exact boundary before networking", async () => {
    const fetch = mockFetch(async () =>
      Response.json({ messages: [{ id: "wamid.inside-window" }] }),
    );
    const adapter = makeAdapter({ fetch });

    const inside = await adapter.send(
      textMessage({ lastInboundAt: NOW - DAY_MS + 1 }),
    );
    const boundary = await adapter.send(
      textMessage({ lastInboundAt: NOW - DAY_MS }),
    );

    expect(inside).toEqual({
      status: "sent",
      messageId: "wamid.inside-window",
    });
    expect(boundary).toEqual({
      status: "rejected",
      code: "service_window_closed",
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, NOW + 1, NOW - 0.5])(
    "rejects invalid or future lastInboundAt=%s before networking",
    async (lastInboundAt) => {
      const fetch = mockFetch(async () =>
        Response.json({ messages: [{ id: "must-not-send" }] }),
      );

      const result = await makeAdapter({ fetch }).send(
        textMessage({ lastInboundAt }),
      );

      expect(result).toEqual({
        status: "rejected",
        code: "invalid_last_inbound_at",
        retryable: false,
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "another channel",
      {
        channel: "slack",
        accountId: PHONE_NUMBER_ID,
        conversationId: "15551234567",
      },
    ],
    [
      "another account",
      {
        channel: "whatsapp",
        accountId: "different-phone-number-id",
        conversationId: "15551234567",
      },
    ],
    [
      "an empty recipient",
      {
        channel: "whatsapp",
        accountId: PHONE_NUMBER_ID,
        conversationId: "",
      },
    ],
    [
      "a thread",
      {
        channel: "whatsapp",
        accountId: PHONE_NUMBER_ID,
        conversationId: "15551234567",
        threadId: "not-supported",
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, Address]>)(
    "rejects %s address before networking",
    async (_name, address) => {
      const fetch = mockFetch(async () =>
        Response.json({ messages: [{ id: "must-not-send" }] }),
      );

      const result = await makeAdapter({ fetch }).send(
        textMessage({ address }),
      );

      expect(result).toEqual({
        status: "rejected",
        code: "invalid_address",
        retryable: false,
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("preserves the 4096-character text limit and rejects longer payloads without truncation or networking", async () => {
    let outboundRequest: Request | undefined;
    const fetch = mockFetch(async (input, init) => {
      outboundRequest = new Request(input, init);
      return Response.json({ messages: [{ id: "wamid.max-length" }] });
    });
    const adapter = makeAdapter({ fetch });
    const maximumText = "x".repeat(4_096);

    const maximum = await adapter.send(
      textMessage({ content: { type: "text", text: maximumText } }),
    );
    const tooLong = await adapter.send(
      textMessage({ content: { type: "text", text: `${maximumText}x` } }),
    );

    expect(maximum).toEqual({
      status: "sent",
      messageId: "wamid.max-length",
    });
    assertRequest(outboundRequest);
    const body = (await outboundRequest.json()) as {
      text: { body: string };
    };
    expect(body.text.body).toBe(maximumText);
    expect(tooLong).toEqual({
      status: "rejected",
      code: "unsupported_payload",
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { type: "text", text: "" } as const,
    {
      type: "reaction",
      messageId: "wamid.target",
      emoji: "👍👍",
    } as const,
    { type: "reaction", messageId: "", emoji: "👍" } as const,
  ])(
    "rejects an unsupported $type payload before networking",
    async (content) => {
      const fetch = mockFetch(async () =>
        Response.json({ messages: [{ id: "must-not-send" }] }),
      );

      const result = await makeAdapter({ fetch }).send(
        textMessage({ content }),
      );

      expect(result).toEqual({
        status: "rejected",
        code: "unsupported_payload",
        retryable: false,
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("classifies HTTP 429 as a retryable rejection and honors Retry-After", async () => {
    const fetch = mockFetch(async () =>
      Response.json(
        { error: { message: "Application request limit reached" } },
        { status: 429, headers: { "retry-after": "7" } },
      ),
    );

    const result = await makeAdapter({ fetch }).send(textMessage());

    expect(result).toEqual({
      status: "rejected",
      code: "http_429",
      retryable: true,
      retryAfterMs: 7_000,
    });
  });

  it("classifies a clear 4xx response as a permanent rejection", async () => {
    const fetch = mockFetch(async () =>
      Response.json(
        { error: { message: "Invalid parameter", code: 100 } },
        { status: 400 },
      ),
    );

    const result = await makeAdapter({ fetch }).send(textMessage());

    expect(result).toEqual({
      status: "rejected",
      code: "http_400",
      retryable: false,
    });
  });

  it("classifies a 5xx response as an unknown send outcome", async () => {
    const fetch = mockFetch(async () =>
      Response.json({ error: { message: "Internal error" } }, { status: 503 }),
    );

    const result = await makeAdapter({ fetch }).send(textMessage());

    expect(result).toEqual({ status: "unknown", code: "http_503" });
  });

  it.each([
    new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    Response.json({ messages: [] }),
    Response.json({ messages: [{ id: "" }] }),
  ])("classifies a malformed success response as unknown", async (response) => {
    const fetch = mockFetch(async () => response);

    const result = await makeAdapter({ fetch }).send(textMessage());

    expect(result).toEqual({
      status: "unknown",
      code: "malformed_response",
    });
  });

  it("times out an unresolved Graph API request", async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const pending = makeAdapter({ fetch }).send(textMessage());
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({
      status: "unknown",
      code: "timeout",
    });
  });

  it("redacts credentials from network errors and logs", async () => {
    const consoleSpies = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    const fetch = mockFetch(async () => {
      throw new Error(`${APP_SECRET} ${VERIFY_TOKEN} ${ACCESS_TOKEN}`);
    });

    const result = await makeAdapter({ fetch }).send(textMessage());

    expect(result).toEqual({ status: "unknown", code: "network_error" });
    const observableOutput = JSON.stringify({
      result,
      logs: consoleSpies.flatMap((spy) => spy.mock.calls).map(String),
    });
    expect(observableOutput).not.toContain(APP_SECRET);
    expect(observableOutput).not.toContain(VERIFY_TOKEN);
    expect(observableOutput).not.toContain(ACCESS_TOKEN);
  });
});
