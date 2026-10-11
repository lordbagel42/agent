import { createHmac, timingSafeEqual } from "node:crypto";
import { Effect, Option, Schema } from "effect";
import type {
  ChannelAdapter,
  ChannelEvent,
  OutboundMessage,
  ReceiptEvent,
  SendResult,
} from "../core/contracts.js";
import type { JuneRuntime } from "../effect/runtime.js";

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const GRAPH_REQUEST_TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARACTERS = 4_096;
const reactionSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

type JsonObject = Record<string, unknown>;
const isNonEmptyString = Schema.is(Schema.NonEmptyString);

/** Unix seconds as a digit string; the receipt ID keeps the original text. */
const WhatsAppTimestamp = Schema.String.check(
  Schema.makeFilter((value) => parseWhatsAppTimestamp(value) !== undefined),
);
function parseWhatsAppTimestamp(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const milliseconds = Number(value) * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

// Meta adds fields over time; like the payload itself, ignore unknown keys.
// Each item decodes on its own, so one malformed item never drops the rest.
const UnknownArray = Schema.Array(Schema.Unknown);
const UnknownObject = Schema.Record(Schema.String, Schema.Unknown);
const inbound = {
  from: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  timestamp: WhatsAppTimestamp,
};
const InboundMessage = Schema.Union([
  Schema.Struct({
    ...inbound,
    type: Schema.Literal("text"),
    text: Schema.Struct({ body: Schema.String }),
    context: Schema.optionalKey(Schema.Unknown),
  }),
  Schema.Struct({
    ...inbound,
    type: Schema.Literal("reaction"),
    reaction: Schema.Struct({
      message_id: Schema.NonEmptyString,
      emoji: Schema.String,
    }),
  }),
]);
const StatusUpdate = Schema.Struct({
  id: Schema.NonEmptyString,
  recipient_id: Schema.NonEmptyString,
  status: Schema.Literals(["sent", "delivered", "read", "failed"]),
  timestamp: WhatsAppTimestamp,
});
const Webhook = Schema.Struct({
  object: Schema.Literal("whatsapp_business_account"),
  entry: UnknownArray,
});
const Entry = Schema.Struct({ changes: UnknownArray });
const Change = Schema.Struct({
  field: Schema.Literal("messages"),
  value: Schema.Struct({
    metadata: Schema.Struct({ phone_number_id: Schema.Unknown }),
    messages: Schema.optionalKey(Schema.Unknown),
    statuses: Schema.optionalKey(Schema.Unknown),
  }),
});
const decodeWebhook = Schema.decodeUnknownOption(Webhook);
const decodeEntry = Schema.decodeUnknownOption(Entry);
const decodeChange = Schema.decodeUnknownOption(Change);
const decodeArray = Schema.decodeUnknownOption(UnknownArray);
const decodeObject = Schema.decodeUnknownOption(UnknownObject);
const decodeMessage = Schema.decodeUnknownOption(InboundMessage);
const decodeStatus = Schema.decodeUnknownOption(StatusUpdate);
const items = (value: unknown) =>
  Option.getOrElse(decodeArray(value), () => []);

function normalizeMessage(
  value: unknown,
  phoneNumberId: string,
): ChannelEvent | undefined {
  const decoded = decodeMessage(value);
  if (Option.isNone(decoded)) return undefined;
  const message = decoded.value;
  const occurredAt = parseWhatsAppTimestamp(message.timestamp) as number;
  const address = {
    channel: "whatsapp" as const,
    accountId: phoneNumberId,
    conversationId: message.from,
  };

  if (message.type === "text") {
    const body = message.text.body;
    const context = Option.getOrUndefined(decodeObject(message.context));
    return {
      id: message.id,
      type: "message",
      messageId: message.id,
      senderId: message.from,
      direct: true,
      text: body,
      occurredAt,
      address,
      ...(/^!mcp-(cancel|reconcile)(?:\s|$)/.test(body.trim())
        ? {
            mcpCommandEligible:
              context === undefined ||
              (context.forwarded !== true &&
                context.frequently_forwarded !== true),
          }
        : {}),
    };
  }

  const { message_id: messageId, emoji } = message.reaction;
  return {
    id: message.id,
    type: "reaction",
    messageId,
    senderId: message.from,
    emoji,
    removed: emoji.length === 0,
    occurredAt,
    address,
  };
}

function normalizeReceipt(
  value: unknown,
  phoneNumberId: string,
): ReceiptEvent | undefined {
  const decoded = decodeStatus(value);
  if (Option.isNone(decoded)) return undefined;
  const { id, recipient_id: recipientId, status, timestamp } = decoded.value;
  return {
    id: `receipt:${id}:${status}:${timestamp}`,
    type: "receipt",
    messageId: id,
    status,
    occurredAt: parseWhatsAppTimestamp(timestamp) as number,
    address: {
      channel: "whatsapp",
      accountId: phoneNumberId,
      conversationId: recipientId,
    },
  };
}

function normalizeWebhook(
  payload: unknown,
  phoneNumberId: string,
): ChannelEvent[] {
  const webhook = decodeWebhook(payload);
  if (Option.isNone(webhook)) return [];

  const events: ChannelEvent[] = [];
  for (const rawEntry of webhook.value.entry) {
    const entry = decodeEntry(rawEntry);
    if (Option.isNone(entry)) continue;

    for (const rawChange of entry.value.changes) {
      const change = decodeChange(rawChange);
      if (
        Option.isNone(change) ||
        change.value.value.metadata.phone_number_id !== phoneNumberId
      ) {
        continue;
      }

      for (const message of items(change.value.value.messages)) {
        const event = normalizeMessage(message, phoneNumberId);
        if (event !== undefined) events.push(event);
      }
      for (const status of items(change.value.value.statuses)) {
        const event = normalizeReceipt(status, phoneNumberId);
        if (event !== undefined) events.push(event);
      }
    }
  }

  return events;
}

function hasValidSignature(
  rawBody: Uint8Array,
  signature: string | null,
  appSecret: string,
): boolean {
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const supplied = Buffer.alloc(expected.length);
  const match = signature?.match(/^sha256=([\da-fA-F]{64})$/);

  if (match?.[1] !== undefined) {
    Buffer.from(match[1], "hex").copy(supplied);
  }

  const signaturesMatch = timingSafeEqual(expected, supplied);
  return match !== null && match !== undefined && signaturesMatch;
}

function plainResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function receiveChallenge(
  request: Request,
  verifyToken: string,
): { response: Response; events: ChannelEvent[] } {
  const search = new URL(request.url).searchParams;
  const valid =
    search.get("hub.mode") === "subscribe" &&
    search.get("hub.verify_token") === verifyToken;
  if (!valid) {
    return { response: plainResponse("Forbidden", 403), events: [] };
  }

  const challenge = search.get("hub.challenge");
  if (challenge === null) {
    return { response: plainResponse("Bad Request", 400), events: [] };
  }

  return { response: plainResponse(challenge, 200), events: [] };
}

type Received = { response: Response; events: ChannelEvent[] };
const badRequest = (): Received => ({
  response: plainResponse("Bad Request", 400),
  events: [],
});

const receiveWebhook = Effect.fnUntraced(function* (
  request: Request,
  appSecret: string,
  phoneNumberId: string,
) {
  const rawBody = yield* Effect.tryPromise(() => request.arrayBuffer()).pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.option,
  );
  if (Option.isNone(rawBody)) return badRequest();

  if (
    !hasValidSignature(
      rawBody.value,
      request.headers.get("x-hub-signature-256"),
      appSecret,
    )
  ) {
    return {
      response: plainResponse("Unauthorized", 401),
      events: [],
    } satisfies Received;
  }

  const payload = Option.liftThrowable((bytes: Uint8Array) =>
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  )(rawBody.value);
  if (Option.isNone(payload)) return badRequest();

  return {
    response: plainResponse("EVENT_RECEIVED", 200),
    events: normalizeWebhook(payload.value as unknown, phoneNumberId),
  } satisfies Received;
});

function rejected(code: string): SendResult {
  return { status: "rejected", code, retryable: false };
}

function validOutboundAddress(
  message: OutboundMessage,
  phoneNumberId: string,
): boolean {
  const { address } = message;
  return (
    address.channel === "whatsapp" &&
    address.accountId === phoneNumberId &&
    typeof address.conversationId === "string" &&
    address.conversationId.trim().length > 0 &&
    address.threadId === undefined
  );
}

function hasOneGrapheme(value: string): boolean {
  const segments = reactionSegmenter.segment(value)[Symbol.iterator]();
  return !segments.next().done && segments.next().done === true;
}

function buildGraphPayload(message: OutboundMessage): JsonObject | undefined {
  const common = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: message.address.conversationId,
  };

  if (message.content.type === "text") {
    if (
      typeof message.content.text !== "string" ||
      message.content.text.length === 0 ||
      [...message.content.text].length > MAX_TEXT_CHARACTERS ||
      (message.content.replyTo !== undefined &&
        !isNonEmptyString(message.content.replyTo))
    ) {
      return undefined;
    }

    return {
      ...common,
      ...(message.content.replyTo === undefined
        ? {}
        : { context: { message_id: message.content.replyTo } }),
      ...(message.content.artifact?.imageUrl
        ? {
            type: "image",
            image: {
              link: message.content.artifact.imageUrl,
              caption: message.content.text.slice(0, 1024),
            },
          }
        : { type: "text", text: { body: message.content.text } }),
    };
  }

  if (
    message.content.type === "reaction" &&
    isNonEmptyString(message.content.messageId) &&
    typeof message.content.emoji === "string" &&
    hasOneGrapheme(message.content.emoji) &&
    (message.content.remove === undefined ||
      typeof message.content.remove === "boolean")
  ) {
    return {
      ...common,
      type: "reaction",
      reaction: {
        message_id: message.content.messageId,
        emoji: message.content.remove === true ? "" : message.content.emoji,
      },
    };
  }

  return undefined;
}

function parseRetryAfter(
  value: string | null,
  now: number,
): number | undefined {
  if (value === null) {
    return undefined;
  }

  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value) * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }

  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) {
    return undefined;
  }

  return Math.max(0, retryAt - now);
}

const GraphSent = Schema.Struct({ messages: UnknownArray });
const decodeGraphSent = Schema.decodeUnknownOption(GraphSent);
const decodeGraphMessage = Schema.decodeUnknownOption(
  Schema.Struct({ id: Schema.NonEmptyString }),
);
const malformed: SendResult = { status: "unknown", code: "malformed_response" };

const classifyGraphResponse = Effect.fnUntraced(function* (
  response: Response,
  now: number,
) {
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(
      response.headers.get("retry-after"),
      now,
    );
    return (
      retryAfterMs === undefined
        ? { status: "rejected", code: "http_429", retryable: true }
        : {
            status: "rejected",
            code: "http_429",
            retryable: true,
            retryAfterMs,
          }
    ) satisfies SendResult;
  }

  if (response.status >= 400 && response.status < 500) {
    return rejected(`http_${response.status}`);
  }

  if (!response.ok) {
    return {
      status: "unknown",
      code: `http_${response.status}`,
    } satisfies SendResult;
  }

  const payload = yield* Effect.tryPromise(
    () => response.json() as Promise<unknown>,
  ).pipe(Effect.option);
  const sent = Option.flatMap(payload, decodeGraphSent);
  if (Option.isNone(sent)) return malformed;

  const firstMessage = decodeGraphMessage(sent.value.messages[0]);
  if (Option.isNone(firstMessage)) return malformed;

  return {
    status: "sent",
    messageId: firstMessage.value.id,
  } satisfies SendResult;
});

const sendToGraph = Effect.fnUntraced(function* (options: {
  accessToken: string;
  apiVersion: string;
  fetch: typeof globalThis.fetch;
  now: number;
  payload: JsonObject;
  phoneNumberId: string;
}) {
  const controller = new AbortController();
  const endpoint = `https://graph.facebook.com/${encodeURIComponent(options.apiVersion)}/${encodeURIComponent(options.phoneNumberId)}/messages`;

  // Keep lifecycle admission until the raw request AND response body settle.
  // The timeout aborts the request instead of racing it, so deployment drain
  // never sees a send that is still live.
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      const timeout = setTimeout(
        () => controller.abort(),
        GRAPH_REQUEST_TIMEOUT_MS,
      );
      timeout.unref?.();
      return timeout;
    }),
    () =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise(() =>
          options.fetch(endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.accessToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(options.payload),
            signal: controller.signal,
          }),
        );
        // Error classification needs only headers. Close even a stalled error
        // body before releasing admission; a failed cleanup leaves the outcome
        // unknown.
        if (!response.ok)
          yield* Effect.tryPromise(async () => {
            await response.body?.cancel();
          });
        return yield* classifyGraphResponse(response, options.now);
      }).pipe(
        Effect.catch(() =>
          Effect.succeed<SendResult>(
            controller.signal.aborted
              ? { status: "unknown", code: "timeout" }
              : { status: "unknown", code: "network_error" },
          ),
        ),
      ),
    (timeout) => Effect.sync(() => clearTimeout(timeout)),
  );
});

export function createWhatsAppAdapter(options: {
  appSecret: string;
  verifyToken: string;
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  effectRuntime: JuneRuntime;
}): ChannelAdapter {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  const receive = Effect.fn("june.whatsapp.receive")(function* (
    request: Request,
  ) {
    if (request.method === "GET") {
      return receiveChallenge(request, options.verifyToken);
    }

    if (request.method === "POST") {
      return yield* receiveWebhook(
        request,
        options.appSecret,
        options.phoneNumberId,
      );
    }

    return {
      response: new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET, POST" },
      }),
      events: [],
    } satisfies Received;
  });

  const send = Effect.fn("june.whatsapp.send")(function* (
    message: OutboundMessage,
  ) {
    if (!validOutboundAddress(message, options.phoneNumberId)) {
      return rejected("invalid_address");
    }

    const currentTime = Option.liftThrowable(now)();
    if (
      Option.isNone(currentTime) ||
      !Number.isSafeInteger(currentTime.value) ||
      currentTime.value < 0 ||
      !Number.isSafeInteger(message.lastInboundAt) ||
      message.lastInboundAt < 0 ||
      message.lastInboundAt > currentTime.value
    ) {
      return rejected("invalid_last_inbound_at");
    }

    if (currentTime.value - message.lastInboundAt >= SERVICE_WINDOW_MS) {
      return rejected("service_window_closed");
    }

    const payload = buildGraphPayload(message);
    if (payload === undefined) {
      return rejected("unsupported_payload");
    }

    return yield* sendToGraph({
      accessToken: options.accessToken,
      apiVersion: options.apiVersion,
      fetch,
      now: currentTime.value,
      payload,
      phoneNumberId: options.phoneNumberId,
    });
  });

  return {
    channel: "whatsapp",
    capabilities: { text: true, reactions: true, threads: false },
    receive: (request) => options.effectRuntime.runPromise(receive(request)),
    send: (message) => options.effectRuntime.runPromise(send(message)),
  };
}
