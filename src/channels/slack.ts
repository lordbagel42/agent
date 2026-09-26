import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  Address,
  ChannelAdapter,
  ChannelEvent,
  OutboundMessage,
  SendResult,
} from "../core/contracts.js";
import type { SlackIngressDiagnostics } from "./slack-ingress.js";
import {
  createSlackSearch,
  type SlackPrivateSearchOptions,
} from "./slack-search.js";

const SIGNATURE_TOLERANCE_SECONDS = 300;
const SLACK_TEXT_LIMIT = 40_000;
const FETCH_TIMEOUT_MS = 10_000;
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 300_000;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function verifySignature(input: {
  rawBody: Uint8Array;
  timestampHeader: string | null;
  signatureHeader: string | null;
  signingSecret: string;
  now: number;
}): boolean {
  const { rawBody, timestampHeader, signatureHeader, signingSecret, now } =
    input;
  if (
    timestampHeader === null ||
    signatureHeader === null ||
    !/^\d+$/.test(timestampHeader)
  ) {
    return false;
  }

  const timestamp = Number(timestampHeader);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(now / 1_000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS
  ) {
    return false;
  }

  const digest = createHmac("sha256", signingSecret)
    .update(`v0:${timestampHeader}:`)
    .update(rawBody)
    .digest("hex");
  const expected = Buffer.from(`v0=${digest}`, "utf8");
  const supplied = Buffer.from(signatureHeader, "utf8");

  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

function occurredAtFrom(payload: JsonObject): number | undefined {
  const eventTime = payload.event_time;
  if (
    typeof eventTime !== "number" ||
    !Number.isSafeInteger(eventTime) ||
    eventTime < 0
  ) {
    return undefined;
  }
  return eventTime * 1_000;
}

function isHumanEvent(
  event: JsonObject,
  botUserId: string,
): event is JsonObject & { user: string } {
  return (
    nonEmptyString(event.user) &&
    event.user !== botUserId &&
    !("bot_id" in event) &&
    !("app_id" in event) &&
    event.subtype !== "bot_message"
  );
}

function slackAddress(
  teamId: string,
  conversationId: string,
  threadId?: string,
): Address {
  return {
    channel: "slack",
    accountId: teamId,
    conversationId,
    ...(threadId === undefined ? {} : { threadId }),
  };
}

function normalizeEvent(
  payload: JsonObject,
  teamId: string,
  botUserId: string,
): ChannelEvent[] {
  if (!nonEmptyString(payload.event_id) || !isJsonObject(payload.event)) {
    return [];
  }

  const occurredAt = occurredAtFrom(payload);
  if (occurredAt === undefined) {
    return [];
  }

  const event = payload.event;
  if (event.type === "message") {
    if (
      event.channel_type !== "im" ||
      !isHumanEvent(event, botUserId) ||
      event.subtype === "message_changed" ||
      event.subtype === "message_deleted" ||
      event.hidden === true ||
      !nonEmptyString(event.channel) ||
      !nonEmptyString(event.ts) ||
      typeof event.text !== "string"
    ) {
      return [];
    }

    const threadId = nonEmptyString(event.thread_ts)
      ? event.thread_ts
      : undefined;
    return [
      {
        id: payload.event_id,
        type: "message",
        address: slackAddress(teamId, event.channel, threadId),
        occurredAt,
        messageId: event.ts,
        senderId: event.user,
        direct: true,
        text: event.text,
      },
    ];
  }

  if (event.type === "app_mention") {
    if (
      !isHumanEvent(event, botUserId) ||
      !nonEmptyString(event.channel) ||
      !nonEmptyString(event.ts) ||
      typeof event.text !== "string"
    ) {
      return [];
    }

    const threadId = nonEmptyString(event.thread_ts)
      ? event.thread_ts
      : event.ts;
    return [
      {
        id: payload.event_id,
        type: "message",
        address: slackAddress(teamId, event.channel, threadId),
        occurredAt,
        messageId: event.ts,
        senderId: event.user,
        direct: false,
        text: event.text,
      },
    ];
  }

  if (event.type === "reaction_added" || event.type === "reaction_removed") {
    if (
      !isHumanEvent(event, botUserId) ||
      !nonEmptyString(event.reaction) ||
      !isJsonObject(event.item) ||
      event.item.type !== "message" ||
      !nonEmptyString(event.item.channel) ||
      !nonEmptyString(event.item.ts)
    ) {
      return [];
    }

    return [
      {
        id: payload.event_id,
        type: "reaction",
        address: slackAddress(teamId, event.item.channel),
        occurredAt,
        messageId: event.item.ts,
        senderId: event.user,
        emoji: event.reaction,
        removed: event.type === "reaction_removed",
      },
    ];
  }

  return [];
}

function retryAfterMs(header: string | null): number {
  const seconds = header === null ? Number.NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return MIN_RETRY_AFTER_MS;
  }
  return Math.min(
    MAX_RETRY_AFTER_MS,
    Math.max(MIN_RETRY_AFTER_MS, Math.ceil(seconds * 1_000)),
  );
}

function rejected(code: string): SendResult {
  return { status: "rejected", code, retryable: false };
}

export function createSlackAdapter({
  signingSecret,
  botToken,
  teamId,
  botUserId,
  searchEnabled = false,
  privateSearch,
  ingressDiagnostics,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
}: {
  signingSecret: string;
  botToken: string;
  teamId: string;
  botUserId: string;
  searchEnabled?: boolean;
  privateSearch?: SlackPrivateSearchOptions;
  ingressDiagnostics?: SlackIngressDiagnostics;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): ChannelAdapter {
  const search = searchEnabled
    ? createSlackSearch({
        teamId,
        botToken,
        fetch: fetchImpl,
        now,
        privateSearch,
      })
    : undefined;
  return {
    channel: "slack",
    capabilities: { text: true, reactions: true, threads: true },
    ...(search === undefined ? {} : { search: search.search }),
    async receive(request: Request) {
      ingressDiagnostics?.record(request, "adapter_received");
      let rawBody: Uint8Array;
      try {
        rawBody = new Uint8Array(await request.arrayBuffer());
      } catch {
        ingressDiagnostics?.record(request, "body_read_failed");
        return { response: new Response(null, { status: 400 }), events: [] };
      }

      if (
        !verifySignature({
          rawBody,
          timestampHeader: request.headers.get("x-slack-request-timestamp"),
          signatureHeader: request.headers.get("x-slack-signature"),
          signingSecret,
          now: now(),
        })
      ) {
        ingressDiagnostics?.record(request, "signature_rejected");
        return { response: new Response(null, { status: 401 }), events: [] };
      }
      ingressDiagnostics?.record(request, "signature_verified");

      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(rawBody));
      } catch {
        ingressDiagnostics?.record(request, "payload_invalid");
        return { response: new Response(null, { status: 400 }), events: [] };
      }
      if (!isJsonObject(payload)) {
        ingressDiagnostics?.record(request, "payload_invalid");
        return { response: new Response(null, { status: 400 }), events: [] };
      }

      if (payload.team_id !== undefined && payload.team_id !== teamId) {
        ingressDiagnostics?.record(request, "workspace_rejected");
        return { response: new Response(null, { status: 403 }), events: [] };
      }

      if (payload.type === "url_verification") {
        if (typeof payload.challenge !== "string") {
          ingressDiagnostics?.record(request, "challenge_invalid");
          return { response: new Response(null, { status: 400 }), events: [] };
        }
        ingressDiagnostics?.record(request, "challenge_answered");
        return {
          response: new Response(payload.challenge, {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
          events: [],
        };
      }

      if (payload.type !== "event_callback") {
        ingressDiagnostics?.record(request, "callback_ignored");
        return { response: new Response(null, { status: 200 }), events: [] };
      }
      if (payload.team_id !== teamId) {
        ingressDiagnostics?.record(request, "workspace_rejected");
        return { response: new Response(null, { status: 403 }), events: [] };
      }

      const events = normalizeEvent(payload, teamId, botUserId);
      ingressDiagnostics?.record(
        request,
        events.length === 0 ? "normalization_ignored" : "normalized",
      );
      if (
        search !== undefined &&
        isJsonObject(payload.event) &&
        payload.event.hidden !== true &&
        payload.event.subtype !== "message_changed" &&
        payload.event.subtype !== "message_deleted"
      ) {
        // Slack's action_token is on the inner message/app_mention event:
        // https://docs.slack.dev/ai/developing-agents#full-example
        // Capture only after signature, workspace and human normalization.
        for (const event of events) {
          if (event.type === "message") {
            search.capture(event, payload.event.action_token);
          }
        }
      }

      return {
        response: new Response(null, { status: 200 }),
        events,
      };
    },
    async send(message: OutboundMessage): Promise<SendResult> {
      if (message.address.channel !== "slack") {
        return rejected("wrong_channel");
      }
      if (message.address.accountId !== teamId) {
        return rejected("wrong_account");
      }

      let endpoint: string;
      let body: JsonObject;
      let successMessageId: string;
      if (message.content.type === "text") {
        if (Array.from(message.content.text).length > SLACK_TEXT_LIMIT) {
          return rejected("message_too_long");
        }
        endpoint = "https://slack.com/api/chat.postMessage";
        successMessageId = "";
        const threadId = message.address.threadId ?? message.content.replyTo;
        body = {
          channel: message.address.conversationId,
          text: message.content.text,
          client_msg_id: message.id,
          ...(threadId === undefined ? {} : { thread_ts: threadId }),
        };
      } else {
        endpoint = `https://slack.com/api/reactions.${message.content.remove === true ? "remove" : "add"}`;
        successMessageId = message.content.messageId;
        body = {
          channel: message.address.conversationId,
          timestamp: message.content.messageId,
          name: message.content.emoji,
        };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${botToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (response.status === 429) {
          return {
            status: "rejected",
            code: "rate_limited",
            retryable: true,
            retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
          };
        }
        if (response.status >= 500) {
          return { status: "unknown", code: "slack_server_error" };
        }

        let responsePayload: unknown;
        try {
          responsePayload = JSON.parse(await response.text());
        } catch {
          if (!response.ok) {
            return rejected(`http_${response.status}`);
          }
          return { status: "unknown", code: "malformed_response" };
        }

        if (!response.ok) {
          if (
            isJsonObject(responsePayload) &&
            responsePayload.ok === false &&
            nonEmptyString(responsePayload.error)
          ) {
            return rejected(responsePayload.error);
          }
          return rejected(`http_${response.status}`);
        }

        if (
          !isJsonObject(responsePayload) ||
          typeof responsePayload.ok !== "boolean"
        ) {
          return { status: "unknown", code: "malformed_response" };
        }
        if (!responsePayload.ok) {
          if (
            message.content.type === "reaction" &&
            responsePayload.error ===
              (message.content.remove === true
                ? "no_reaction"
                : "already_reacted")
          ) {
            return { status: "sent", messageId: successMessageId };
          }
          return rejected(
            nonEmptyString(responsePayload.error)
              ? responsePayload.error
              : "slack_error",
          );
        }

        if (message.content.type === "text") {
          if (!nonEmptyString(responsePayload.ts)) {
            return { status: "unknown", code: "malformed_response" };
          }
          successMessageId = responsePayload.ts;
        }
        return { status: "sent", messageId: successMessageId };
      } catch {
        return controller.signal.aborted
          ? { status: "unknown", code: "timeout" }
          : { status: "unknown", code: "network_error" };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
