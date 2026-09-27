import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ChannelAdapter,
  ChannelEvent,
  OutboundMessage,
  ReceiptEvent,
  SendResult,
} from "../core/contracts.js";

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const GRAPH_REQUEST_TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARACTERS = 4_096;
const reactionSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseWhatsAppTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return undefined;
  }

  const milliseconds = Number(value) * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function isReceiptStatus(value: unknown): value is ReceiptEvent["status"] {
  return (
    value === "sent" ||
    value === "delivered" ||
    value === "read" ||
    value === "failed"
  );
}

function normalizeMessage(
  value: unknown,
  phoneNumberId: string,
): ChannelEvent | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const { from, id, timestamp, type } = value;
  const occurredAt = parseWhatsAppTimestamp(timestamp);
  if (
    !isNonEmptyString(from) ||
    !isNonEmptyString(id) ||
    occurredAt === undefined
  ) {
    return undefined;
  }

  const address = {
    channel: "whatsapp" as const,
    accountId: phoneNumberId,
    conversationId: from,
  };

  if (type === "text" && isObject(value.text)) {
    const { body } = value.text;
    if (typeof body !== "string") {
      return undefined;
    }

    return {
      id,
      type: "message",
      messageId: id,
      senderId: from,
      direct: true,
      text: body,
      occurredAt,
      address,
      ...(/^!mcp-(cancel|reconcile)(?:\s|$)/.test(body.trim())
        ? {
            mcpCommandEligible:
              !isObject(value.context) ||
              (value.context.forwarded !== true &&
                value.context.frequently_forwarded !== true),
          }
        : {}),
    };
  }

  if (type === "reaction" && isObject(value.reaction)) {
    const messageId = value.reaction.message_id;
    const emoji = value.reaction.emoji;
    if (!isNonEmptyString(messageId) || typeof emoji !== "string") {
      return undefined;
    }

    return {
      id,
      type: "reaction",
      messageId,
      senderId: from,
      emoji,
      removed: emoji.length === 0,
      occurredAt,
      address,
    };
  }

  return undefined;
}

function normalizeReceipt(
  value: unknown,
  phoneNumberId: string,
): ReceiptEvent | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const { id, recipient_id: recipientId, status, timestamp } = value;
  const occurredAt = parseWhatsAppTimestamp(timestamp);
  if (
    !isNonEmptyString(id) ||
    !isNonEmptyString(recipientId) ||
    !isReceiptStatus(status) ||
    occurredAt === undefined
  ) {
    return undefined;
  }

  return {
    id: `receipt:${id}:${status}:${timestamp}`,
    type: "receipt",
    messageId: id,
    status,
    occurredAt,
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
  if (
    !isObject(payload) ||
    payload.object !== "whatsapp_business_account" ||
    !Array.isArray(payload.entry)
  ) {
    return [];
  }

  const events: ChannelEvent[] = [];
  for (const entry of payload.entry) {
    if (!isObject(entry) || !Array.isArray(entry.changes)) {
      continue;
    }

    for (const change of entry.changes) {
      if (
        !isObject(change) ||
        change.field !== "messages" ||
        !isObject(change.value) ||
        !isObject(change.value.metadata) ||
        change.value.metadata.phone_number_id !== phoneNumberId
      ) {
        continue;
      }

      if (Array.isArray(change.value.messages)) {
        for (const message of change.value.messages) {
          const event = normalizeMessage(message, phoneNumberId);
          if (event !== undefined) {
            events.push(event);
          }
        }
      }

      if (Array.isArray(change.value.statuses)) {
        for (const status of change.value.statuses) {
          const event = normalizeReceipt(status, phoneNumberId);
          if (event !== undefined) {
            events.push(event);
          }
        }
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

async function receiveWebhook(
  request: Request,
  appSecret: string,
  phoneNumberId: string,
): Promise<{ response: Response; events: ChannelEvent[] }> {
  let rawBody: Uint8Array;
  try {
    rawBody = new Uint8Array(await request.arrayBuffer());
  } catch {
    return { response: plainResponse("Bad Request", 400), events: [] };
  }

  if (
    !hasValidSignature(
      rawBody,
      request.headers.get("x-hub-signature-256"),
      appSecret,
    )
  ) {
    return { response: plainResponse("Unauthorized", 401), events: [] };
  }

  let payload: unknown;
  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    payload = JSON.parse(body) as unknown;
  } catch {
    return { response: plainResponse("Bad Request", 400), events: [] };
  }

  return {
    response: plainResponse("EVENT_RECEIVED", 200),
    events: normalizeWebhook(payload, phoneNumberId),
  };
}

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
      type: "text",
      text: { body: message.content.text },
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

async function classifyGraphResponse(
  response: Response,
  now: number,
): Promise<SendResult> {
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(
      response.headers.get("retry-after"),
      now,
    );
    return retryAfterMs === undefined
      ? { status: "rejected", code: "http_429", retryable: true }
      : {
          status: "rejected",
          code: "http_429",
          retryable: true,
          retryAfterMs,
        };
  }

  if (response.status >= 400 && response.status < 500) {
    return rejected(`http_${response.status}`);
  }

  if (!response.ok) {
    return { status: "unknown", code: `http_${response.status}` };
  }

  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    return { status: "unknown", code: "malformed_response" };
  }

  if (!isObject(payload) || !Array.isArray(payload.messages)) {
    return { status: "unknown", code: "malformed_response" };
  }

  const firstMessage = payload.messages[0];
  if (!isObject(firstMessage) || !isNonEmptyString(firstMessage.id)) {
    return { status: "unknown", code: "malformed_response" };
  }

  return { status: "sent", messageId: firstMessage.id };
}

async function sendToGraph(options: {
  accessToken: string;
  apiVersion: string;
  fetch: typeof globalThis.fetch;
  now: number;
  payload: JsonObject;
  phoneNumberId: string;
}): Promise<SendResult> {
  const controller = new AbortController();
  const timeoutMarker = Symbol("graph request timeout");
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, rejectPromise) => {
    timeout = setTimeout(() => {
      timedOut = true;
      rejectPromise(timeoutMarker);
      controller.abort();
    }, GRAPH_REQUEST_TIMEOUT_MS);
    timeout.unref?.();
  });

  const endpoint = `https://graph.facebook.com/${encodeURIComponent(options.apiVersion)}/${encodeURIComponent(options.phoneNumberId)}/messages`;
  const request = async (): Promise<SendResult> => {
    const response = await options.fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(options.payload),
      signal: controller.signal,
    });
    return classifyGraphResponse(response, options.now);
  };

  try {
    return await Promise.race([request(), timeoutPromise]);
  } catch (error) {
    return error === timeoutMarker || timedOut
      ? { status: "unknown", code: "timeout" }
      : { status: "unknown", code: "network_error" };
  } finally {
    clearTimeout(timeout);
  }
}

export function createWhatsAppAdapter(options: {
  appSecret: string;
  verifyToken: string;
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): ChannelAdapter {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  return {
    channel: "whatsapp",
    capabilities: { text: true, reactions: true, threads: false },
    async receive(request) {
      if (request.method === "GET") {
        return receiveChallenge(request, options.verifyToken);
      }

      if (request.method === "POST") {
        return receiveWebhook(
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
      };
    },
    async send(message) {
      if (!validOutboundAddress(message, options.phoneNumberId)) {
        return rejected("invalid_address");
      }

      let currentTime: number;
      try {
        currentTime = now();
      } catch {
        return rejected("invalid_last_inbound_at");
      }

      if (
        !Number.isSafeInteger(currentTime) ||
        currentTime < 0 ||
        !Number.isSafeInteger(message.lastInboundAt) ||
        message.lastInboundAt < 0 ||
        message.lastInboundAt > currentTime
      ) {
        return rejected("invalid_last_inbound_at");
      }

      if (currentTime - message.lastInboundAt >= SERVICE_WINDOW_MS) {
        return rejected("service_window_closed");
      }

      const payload = buildGraphPayload(message);
      if (payload === undefined) {
        return rejected("unsupported_payload");
      }

      return sendToGraph({
        accessToken: options.accessToken,
        apiVersion: options.apiVersion,
        fetch,
        now: currentTime,
        payload,
        phoneNumberId: options.phoneNumberId,
      });
    },
  };
}
