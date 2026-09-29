import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  Address,
  ChannelAdapter,
  ChannelEvent,
  MessageMetadata,
  OutboundMessage,
  SendResult,
} from "../core/contracts.js";
import { PRIVATE_REFLECTION_REVIEW_PREFIX } from "../core/reflection-review.js";
import { RIVET_REPLY_PREFIX } from "../core/rivet.js";
import { PRIVATE_SLACK_HISTORY_PREFIX } from "../core/slack-history.js";
import { allowedWebEmbed } from "../core/web-embed.js";
import type { LatencyDiagnostics } from "../runtime/latency.js";
import {
  createSlackContext,
  slackMessageId,
  slackMetadata,
} from "./slack-context.js";
import { createSlackHistory } from "./slack-history.js";
import type { SlackIngressDiagnostics } from "./slack-ingress.js";
import { slackQuestionAnswer, slackQuestionBlocks } from "./slack-question.js";
import {
  createSlackSearch,
  type SlackPrivateSearchOptions,
} from "./slack-search.js";
import type { SlackThreads } from "./slack-threads.js";

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

/** Slack's fallback text alone does not prove the composer wasn't a quote.
 * Commands allow only ordinary rich-text sections, never quotes/code/lists or
 * attachment fallbacks. Historical/context readers never set this marker. */
export function isPlainSlackCommand(
  event: JsonObject,
  botUserId?: string,
): boolean {
  if (
    (event.type !== "message" &&
      !(botUserId && event.type === "app_mention")) ||
    typeof event.text !== "string" ||
    event.text.includes("`") ||
    event.subtype !== undefined ||
    event.attachments !== undefined ||
    event.files !== undefined
  )
    return false;
  if (event.blocks === undefined) return true;
  if (!Array.isArray(event.blocks) || event.blocks.length !== 1) return false;
  const block = event.blocks[0];
  if (
    !isJsonObject(block) ||
    block.type !== "rich_text" ||
    !Array.isArray(block.elements) ||
    block.elements.length !== 1
  )
    return false;
  const section = block.elements[0];
  if (
    !isJsonObject(section) ||
    section.type !== "rich_text_section" ||
    !Array.isArray(section.elements) ||
    !section.elements.length ||
    !section.elements.every(
      (element) =>
        isJsonObject(element) &&
        ((element.type === "text" && typeof element.text === "string") ||
          (botUserId &&
            element.type === "user" &&
            element.user_id === botUserId)) &&
        (!isJsonObject(element.style) || element.style.code !== true),
    )
  )
    return false;
  // Decode only Slack's three display escapes, never strip quote/markdown syntax.
  const fallback = event.text.replace(/&(?:amp|lt|gt);/g, (entity) =>
    entity === "&amp;" ? "&" : entity === "&lt;" ? "<" : ">",
  );
  return (
    section.elements
      .map((element) =>
        element.type === "user" ? `<@${element.user_id}>` : element.text,
      )
      .join("") === fallback
  );
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
  threads?: Pick<SlackThreads, "has" | "record">,
): Promise<ChannelEvent[]> {
  if (!nonEmptyString(payload.event_id) || !isJsonObject(payload.event)) {
    return [];
  }

  const occurredAt = occurredAtFrom(payload);
  if (occurredAt === undefined) {
    return [];
  }

  const event = payload.event;
  if (!isHumanEvent(event, botUserId) || ownerUserIds.size === 0) {
    return [];
  }
  const owner = ownerUserIds.has(event.user);
  const mentioned =
    typeof event.text === "string" && event.text.includes(`<@${botUserId}>`);
  // Ignore opt-outs and intact inspection copies before memory or actor ingress.
  if (
    typeof event.text === "string" &&
    (event.text.startsWith("##") || event.text.includes(RIVET_REPLY_PREFIX))
  )
    return [];
  // Guests must explicitly address June. Direct DMs also count as contact.
  if (
    !owner &&
    !mentioned &&
    !(event.type === "message" && event.channel_type === "im")
  )
    return [];
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

    const named = owner && /\bjune\b/i.test(event.text);
    const participatingThread =
      channelType !== "im" &&
      !mentioned &&
      !named &&
      owner &&
      nonEmptyString(event.thread_ts) &&
      event.thread_ts !== event.ts &&
      (event.parent_user_id === botUserId ||
        threads?.has(teamId, botUserId, event.channel, event.thread_ts));
    if (channelType !== "im" && !mentioned && !named && !participatingThread) {
      if (!owner || !participateInOwnerChannels) return [];
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
    // Only session controls accept one boundary mention. Validate the original
    // rich text before removing it; don't grant other command families new syntax.
    const prefix = `<@${botUserId}> `;
    const suffix = ` <@${botUserId}>`;
    const sessionText = event.text.startsWith(prefix)
      ? event.text.slice(prefix.length)
      : event.text.endsWith(suffix)
        ? event.text.slice(0, -suffix.length)
        : event.text;
    const sessionCandidate =
      owner &&
      /^(?:PING|PINGMODEL|CLEARHISTORY|DEBUGSHARE(?: [^\r\n]*)?)$/.test(
        sessionText,
      );
    const sessionEligible =
      sessionCandidate && isPlainSlackCommand(event, botUserId);
    // Subscribe on contact, not on a reply: June may intentionally stay silent.
    // Keep guest admission and direct-ping policy separate from name matching.
    if (
      channelType !== "im" &&
      owner &&
      (mentioned || named || participatingThread)
    ) {
      try {
        threads?.record(teamId, botUserId, event.channel, threadId ?? event.ts);
      } catch {
        // A failed subscription must not discard already-authorized contact.
        console.warn("Could not save Slack thread subscription");
      }
    }
    return [
      {
        id: slackMessageId(teamId, event.channel, event.ts),
        type: "message",
        address: slackAddress(teamId, event.channel, threadId),
        occurredAt,
        messageId: event.ts,
        senderId: event.user,
        direct: channelType === "im",
        text: sessionEligible ? sessionText : event.text,
        botMentioned: mentioned,
        ...(sessionCandidate
          ? { sessionCommandEligible: sessionEligible }
          : {}),
        ...(event.text.startsWith("!memory-correct")
          ? { ownerCorrectionEligible: isPlainSlackCommand(event) }
          : {}),
        ...(owner &&
        channelType === "im" &&
        /^!personality(?:\s|$)/.test(event.text.trim())
          ? { personalityCommandEligible: isPlainSlackCommand(event) }
          : {}),
        ...(/^!memory-(?:accept|reject)\b/.test(event.text)
          ? {
              memoryReviewEligible:
                owner && channelType === "im" && isPlainSlackCommand(event),
            }
          : {}),
        ...(owner &&
        channelType === "im" &&
        /^[!/](approve|resume-stopped)(?:\s|$)/.test(event.text.trim())
          ? { codingCommandEligible: isPlainSlackCommand(event) }
          : {}),
        ...(owner &&
        channelType === "im" &&
        /^!(?:reflection|allow|deny|revoke)(?:\s|$)/.test(event.text.trim())
          ? { reflectionReviewEligible: isPlainSlackCommand(event) }
          : {}),
        ...(owner &&
        channelType === "im" &&
        /^!mcp-(cancel|reconcile)(?:\s|$)/.test(event.text.trim())
          ? { mcpCommandEligible: isPlainSlackCommand(event) }
          : {}),
        ...(owner && channelType === "im" && /^!browser-pin\b/.test(event.text)
          ? { browserPinEligible: isPlainSlackCommand(event) }
          : {}),
        ...(channelType === "im" && /^!artifact-pin\b/.test(event.text)
          ? { artifactPinEligible: isPlainSlackCommand(event) }
          : {}),
        ...(owner && channelType === "im" && event.text === "!memory-backup"
          ? { memoryBackupEligible: isPlainSlackCommand(event) }
          : {}),
        ...(owner &&
        channelType === "im" &&
        /^[!/]deploy-app(?:\s|$)/.test(event.text.trim())
          ? { appDeploymentEligible: isPlainSlackCommand(event) }
          : {}),
        ...(owner &&
        channelType === "im" &&
        /^!forget-confirm(?:\s|$)/.test(event.text.trim())
          ? { forgetCommandEligible: isPlainSlackCommand(event) }
          : {}),
        metadata: {
          ...slackMetadata(event, channelType),
          ...(channelName ? { channelName } : {}),
        },
      },
    ];
  }

  if (event.type === "reaction_added" || event.type === "reaction_removed") {
    if (
      !owner ||
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
  webEmbedOrigins = [],
  artifactOrigin,
  experimentalArtifactEmbed = false,
  privateSearch,
  ingressDiagnostics,
  latency,
  threads,
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
  webEmbedOrigins?: readonly string[];
  artifactOrigin?: string;
  experimentalArtifactEmbed?: boolean;
  privateSearch?: SlackPrivateSearchOptions;
  ingressDiagnostics?: SlackIngressDiagnostics;
  latency?: LatencyDiagnostics;
  threads?: Pick<SlackThreads, "has" | "record">;
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
  const thinkingReactions = new Set<string>();
  const adapter: ChannelAdapter = {
    channel: "slack",
    capabilities: { text: true, reactions: true, threads: true },
    webEmbedOrigins,
    ...(search === undefined
      ? {}
      : { search: search.search, hasSearchToken: search.hasActionToken }),
    ...(contextEnabled ? { context: context.context } : {}),
    audience: context.audience,
    async setTyping(event, active, signal) {
      const { address } = event;
      // Slack's status UI is thread-scoped and can auto-open that thread.
      // Direct pings always use a reaction, including in channels and threads.
      // Plain DMs also use a reaction; never invent a thread for feedback.
      // https://docs.slack.dev/reference/methods/assistant.threads.setStatus/
      if (
        address.channel !== "slack" ||
        address.accountId !== teamId ||
        (!owners.has(event.senderId) && !event.botMentioned && !event.direct) ||
        event.senderId === botUserId ||
        event.metadata?.channelType === "mpim" ||
        (!address.threadId && !event.direct && !event.botMentioned) ||
        signal?.aborted
      )
        return;
      const reaction = event.botMentioned === true || !address.threadId;
      const reactionKey = JSON.stringify([
        address.conversationId,
        event.messageId,
      ]);
      // The durable status target can survive a restart or an ambiguous add.
      // A missing process-local entry must never suppress its cleanup.
      if (reaction && active && thinkingReactions.has(reactionKey)) return;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(abort, 1_000);
      let response: Response | undefined;
      try {
        if (active) latency?.mark(event, "typing_started");
        response = await fetchImpl(
          reaction
            ? `https://slack.com/api/reactions.${active ? "add" : "remove"}`
            : "https://slack.com/api/assistant.threads.setStatus",
          {
            method: "POST",
            redirect: "error",
            credentials: "omit",
            headers: {
              authorization: `Bearer ${botToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(
              reaction
                ? {
                    channel: address.conversationId,
                    timestamp: event.messageId,
                    name: "hourglass_flowing_sand",
                  }
                : {
                    channel_id: address.conversationId,
                    thread_ts: address.threadId,
                    status: active ? "is thinking…" : "",
                  },
            ),
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error("typing_unavailable");
        const result: unknown = await response.json();
        if (
          !isJsonObject(result) ||
          (result.ok !== true &&
            !(
              reaction &&
              result.error === (active ? "already_reacted" : "no_reaction")
            ))
        )
          throw new Error("typing_unavailable");
        if (reaction && active) thinkingReactions.add(reactionKey);
        latency?.mark(event, active ? "typing_accepted" : "typing_cleared");
        // No remote response content, source text or credential reaches history.
      } catch {
        latency?.mark(event, "typing_unavailable");
        throw new Error("typing_unavailable");
      } finally {
        if (reaction && !active) thinkingReactions.delete(reactionKey);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        controller.abort();
        await response?.body?.cancel().catch(() => {});
      }
    },
    async receive(request: Request, intake?: { receivedAt: number }) {
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
        const text = new TextDecoder().decode(rawBody);
        payload = JSON.parse(
          request.headers
            .get("content-type")
            ?.startsWith("application/x-www-form-urlencoded")
            ? (new URLSearchParams(text).get("payload") ?? "")
            : text,
        );
      } catch {
        ingressDiagnostics?.record(request, "payload_invalid");
        return { response: new Response(null, { status: 400 }), events: [] };
      }
      if (!isJsonObject(payload)) {
        ingressDiagnostics?.record(request, "payload_invalid");
        return { response: new Response(null, { status: 400 }), events: [] };
      }

      if (payload.type === "block_actions") {
        const answer = slackQuestionAnswer(
          payload,
          teamId,
          botUserId,
          owners,
          signingSecret,
          intake?.receivedAt ?? now(),
        );
        return {
          response: new Response(null, { status: 200 }),
          events: answer ? [answer] : [],
        };
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
        threads,
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
          if (event.type === "message" && owners.has(event.senderId)) {
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
        const privateReview = message.content.text.startsWith(
          PRIVATE_REFLECTION_REVIEW_PREFIX,
        );
        const embed = message.content.webEmbed;
        const artifact = message.content.artifact;
        if (
          artifact &&
          (!artifactOrigin ||
            !/^[a-f0-9]{32}$/.test(artifact.id) ||
            artifact.url !== `${artifactOrigin}/artifacts/${artifact.id}/` ||
            (artifact.imageUrl &&
              artifact.imageUrl !== `${artifact.url}preview.png`))
        )
          return rejected("artifact_origin_denied");
        if (
          embed &&
          (message.content.plainText ||
            privateReview ||
            message.content.text.startsWith(RIVET_REPLY_PREFIX) ||
            message.content.text.startsWith(PRIVATE_SLACK_HISTORY_PREFIX) ||
            !allowedWebEmbed(embed, webEmbedOrigins))
        )
          return rejected("web_embed_unavailable");
        const text = privateReview
          ? message.content.text
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
          : message.content.text;
        if (Array.from(text).length > SLACK_TEXT_LIMIT) {
          return rejected("message_too_long");
        }
        endpoint = "https://slack.com/api/chat.postMessage";
        successMessageId = "";
        const threadId = message.address.threadId ?? message.content.replyTo;
        body = {
          channel: message.address.conversationId,
          text,
          client_msg_id: message.id,
          ...(!embed &&
          !message.content.plainText &&
          !message.content.question &&
          !privateReview &&
          text.length <= 12_000 &&
          /^\s*`{3,}/m.test(text)
            ? {
                blocks: [{ type: "markdown", text }],
                unfurl_links: false,
                unfurl_media: false,
              }
            : {}),
          ...(embed
            ? {
                blocks: [
                  {
                    type: "video",
                    video_url: embed.url,
                    title_url: embed.url,
                    thumbnail_url: embed.thumbnailUrl,
                    title: { type: "plain_text", text: embed.title },
                    alt_text: embed.title,
                  },
                ],
                unfurl_links: false,
                unfurl_media: false,
              }
            : {}),
          ...(artifact?.imageUrl
            ? {
                blocks: [
                  ...(experimentalArtifactEmbed
                    ? [
                        {
                          type: "video",
                          video_url: artifact.url,
                          title_url: artifact.url,
                          thumbnail_url: artifact.imageUrl,
                          title: { type: "plain_text", text: artifact.title },
                          alt_text: artifact.title,
                        },
                      ]
                    : [
                        {
                          type: "image",
                          image_url: artifact.imageUrl,
                          alt_text: `${artifact.title} — static preview; open the browser link for live detail.`,
                        },
                      ]),
                  {
                    type: "section",
                    text: { type: "plain_text", text: message.content.text },
                    accessory: {
                      type: "button",
                      text: { type: "plain_text", text: "Open shared space" },
                      url: artifact.url,
                      action_id: "artifact_open",
                    },
                  },
                ],
                unfurl_links: false,
                unfurl_media: false,
              }
            : {}),
          ...(!embed && message.content.question && owners.size === 1
            ? {
                blocks: slackQuestionBlocks(
                  message,
                  [...owners][0] as string,
                  signingSecret,
                  now(),
                ),
              }
            : {}),
          ...(message.content.plainText || message.content.question
            ? {
                mrkdwn: false,
                parse: "none",
                unfurl_links: false,
                unfurl_media: false,
              }
            : {}),
          ...(threadId === undefined ? {} : { thread_ts: threadId }),
          ...(message.content.text.startsWith(PRIVATE_SLACK_HISTORY_PREFIX)
            ? { unfurl_links: false, unfurl_media: false }
            : {}),
          ...(privateReview
            ? {
                mrkdwn: false,
                parse: "none",
                link_names: false,
                unfurl_links: false,
                unfurl_media: false,
              }
            : {}),
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
          try {
            threads?.record(
              teamId,
              botUserId,
              nonEmptyString(responsePayload.channel)
                ? responsePayload.channel
                : message.address.conversationId,
              message.address.threadId ??
                message.content.replyTo ??
                responsePayload.ts,
            );
          } catch {
            // Slack already accepted this message. A local write failure must
            // not turn a successful delivery into an uncertain/retryable send.
            console.warn("Could not save Slack thread participation");
          }
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
  if (owners.size > 0)
    adapter.shareHistory = createSlackHistory({
      teamId,
      botUserId,
      botToken,
      ownerUserIds: owners,
      fetch: fetchImpl,
      send: adapter.send,
    });
  return adapter;
}
