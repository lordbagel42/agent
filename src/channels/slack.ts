import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  Address,
  ChannelAdapter,
  ChannelEvent,
  MessageMetadata,
  OutboundMessage,
  SendResult,
} from "../core/contracts.js";
import type { LatencyDiagnostics } from "../runtime/latency.js";
import {
  createSlackContext,
  slackMessageId,
  slackMetadata,
} from "./slack-context.js";
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
const CHANNEL_LOOKUP_TIMEOUT_MS = 750;

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

async function normalizeEvent(
  payload: JsonObject,
  teamId: string,
  botUserId: string,
  ownerUserIds: ReadonlySet<string>,
  participateInOwnerChannels: boolean,
  context: ReturnType<typeof createSlackContext>,
): Promise<ChannelEvent[]> {
  if (!nonEmptyString(payload.event_id) || !isJsonObject(payload.event)) {
    return [];
  }

  const occurredAt = occurredAtFrom(payload);
  if (occurredAt === undefined) {
    return [];
  }

  const event = payload.event;
  // No lookup or action-token capture may precede the configured owner check.
  if (!isHumanEvent(event, botUserId) || !ownerUserIds.has(event.user)) {
    return [];
  }
  if (event.type === "message" || event.type === "app_mention") {
    if (
      (event.subtype !== undefined &&
        event.subtype !== "file_share" &&
        event.subtype !== "me_message" &&
        event.subtype !== "thread_broadcast") ||
      event.hidden === true ||
      !nonEmptyString(event.channel) ||
      !nonEmptyString(event.ts) ||
      typeof event.text !== "string" ||
      event.channel_type === "mpim"
    ) {
      return [];
    }

    let channelType: MessageMetadata["channelType"];
    if (
      event.channel_type === "im" ||
      event.channel_type === "channel" ||
      event.channel_type === "group"
    ) {
      channelType = event.channel_type;
    }
    let channelName: string | undefined;
    if (event.type === "app_mention" && channelType === undefined) {
      // app_mention is a channel event, but legacy G IDs can also be MPIMs.
      // Fail closed on that ambiguity; public C mentions need no extra grant.
      if (event.channel.startsWith("C")) channelType = "channel";
      else if (event.channel.startsWith("G")) {
        const info = await context.conversation(
          event.channel,
          AbortSignal.timeout(CHANNEL_LOOKUP_TIMEOUT_MS),
        );
        channelType = info?.type;
        channelName = info?.name;
      }
    }
    if (
      channelType !== "im" &&
      channelType !== "channel" &&
      channelType !== "group"
    )
      return [];
    if (event.type === "app_mention" && channelType === "im") return [];

    const mentioned =
      event.type === "app_mention" || event.text.includes(`<@${botUserId}>`);
    if (channelType !== "im" && !mentioned) {
      if (!participateInOwnerChannels) return [];
      // Never authorize by an ID, event-supplied name, text, or stale name cache.
      const info = await context.conversation(
        event.channel,
        AbortSignal.timeout(CHANNEL_LOOKUP_TIMEOUT_MS),
      );
      if (
        (info?.type !== "channel" && info?.type !== "group") ||
        !info.name?.toLowerCase().includes("raygen")
      )
        return [];
      channelType = info.type;
      channelName = info.name;
    }
    if (channelType !== "im" && event.channel.startsWith("D")) {
      return [];
    }

    const threadId = nonEmptyString(event.thread_ts)
      ? event.thread_ts
      : undefined;
    return [
      {
        id: slackMessageId(teamId, event.channel, event.ts),
        type: "message",
        address: slackAddress(teamId, event.channel, threadId),
        occurredAt,
        messageId: event.ts,
        senderId: event.user,
        direct: channelType === "im",
        text: event.text,
        metadata: {
          ...slackMetadata(event, channelType),
          ...(channelName ? { channelName } : {}),
        },
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
  ownerUserIds = [],
  participateInOwnerChannels = false,
  contextEnabled = false,
  searchEnabled = false,
  privateSearch,
  ingressDiagnostics,
  latency,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
}: {
  signingSecret: string;
  botToken: string;
  teamId: string;
  botUserId: string;
  /** Verified human Slack IDs for this team. Empty/missing fails closed. */
  ownerUserIds?: readonly string[];
  /** Also accept owner messages in channels whose current name contains raygen. */
  participateInOwnerChannels?: boolean;
  /** Same-channel/thread reads, including the enriched initiating message. */
  contextEnabled?: boolean;
  searchEnabled?: boolean;
  privateSearch?: SlackPrivateSearchOptions;
  ingressDiagnostics?: SlackIngressDiagnostics;
  latency?: LatencyDiagnostics;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): ChannelAdapter {
  const owners = new Set(ownerUserIds);
  const context = createSlackContext({
    teamId,
    botToken,
    botUserId,
    ownerUserIds: owners,
    fetch: fetchImpl,
    now,
  });
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
    ...(contextEnabled ? { context: context.context } : {}),
    async setTyping(event, active, signal) {
      const { address } = event;
      // Slack's status UI is thread-scoped and can auto-open that thread. The
      // caller must supply its selected reply thread; never post a placeholder.
      // https://docs.slack.dev/reference/methods/assistant.threads.setStatus/
      if (
        address.channel !== "slack" ||
        address.accountId !== teamId ||
        !owners.has(event.senderId) ||
        event.senderId === botUserId ||
        event.metadata?.channelType === "mpim" ||
        !address.threadId ||
        signal?.aborted
      )
        return;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(abort, 1_000);
      let response: Response | undefined;
      try {
        if (active) latency?.mark(event, "typing_started");
        response = await fetchImpl(
          "https://slack.com/api/assistant.threads.setStatus",
          {
            method: "POST",
            redirect: "error",
            credentials: "omit",
            headers: {
              authorization: `Bearer ${botToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              channel_id: address.conversationId,
              thread_ts: address.threadId,
              status: active ? "is thinking…" : "",
            }),
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error("typing_unavailable");
        const result: unknown = await response.json();
        if (!isJsonObject(result) || result.ok !== true)
          throw new Error("typing_unavailable");
        latency?.mark(event, active ? "typing_accepted" : "typing_cleared");
        // No remote response content, source text or credential reaches history.
      } catch {
        latency?.mark(event, "typing_unavailable");
        throw new Error("typing_unavailable");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        controller.abort();
        await response?.body?.cancel().catch(() => {});
      }
    },
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

      const events = await normalizeEvent(
        payload,
        teamId,
        botUserId,
        owners,
        participateInOwnerChannels,
        context,
      );
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
