import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { MessageEvent, SendResult } from "../core/contracts.js";

const stages = [
  "accepted",
  "submission_started",
  "submitted",
  "submission_failed",
  "http_ack",
  "dequeued",
  "admitted",
  "context_started",
  "context_ready",
  "fast_started",
  "fast_finished",
  "deep_started",
  "deep_finished",
  "synthesis_started",
  "synthesis_finished",
  "typing_started",
  "typing_accepted",
  "typing_unavailable",
  "typing_cleared",
  "ack_started",
  "ack_sent",
  "text_started",
  "text_sent",
  "reaction_started",
  "reaction_sent",
  "search_started",
  "search_sent",
  "send_rejected",
  "send_unknown",
  "finished",
  "released",
] as const;
export type LatencyStage = (typeof stages)[number];
export type ReplyKind = "ack" | "text" | "reaction" | "search";

export interface LatencyTrace {
  id: string;
  receivedAt: number;
  channel: "slack" | "whatsapp";
  threaded: boolean;
  probe?: string;
  transportMs?: number;
  observations: { stage: LatencyStage; ms: number }[];
  deliveries: {
    kind: ReplyKind;
    status: SendResult["status"];
    ms: number;
    platformMs?: number;
    pong?: boolean;
  }[];
}

// Used only for measurement; opaque Slack IDs are never rounded or rewritten.
function slackMicros(value: string): bigint | undefined {
  if (!/^\d{1,16}\.\d{6}$/.test(value)) return undefined;
  return BigInt(value.replace(".", ""));
}

export function latencyProbe(text: string): string | undefined {
  return /^ping ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
    .exec(text)?.[1]
    ?.toLowerCase();
}

/** Bounded, volatile, prompt-free observations. No journal steps, replay work,
 * provider retries, URLs, identity IDs, content, errors or credentials retained.
 * Missing/restarted/evicted traces stay missing, never reconstructed on replay. */
export function createLatencyDiagnostics() {
  const startedAt = Date.now();
  const salt = randomBytes(32);
  const traces = new Map<string, { start: number; trace: LatencyTrace }>();
  const key = (event: MessageEvent) =>
    createHmac("sha256", salt)
      .update(
        JSON.stringify([
          event.address.channel,
          event.address.accountId,
          event.id,
        ]),
      )
      .digest("hex");
  const find = (event: MessageEvent) => traces.get(key(event));
  const mark = (event: MessageEvent, stage: LatencyStage) => {
    if (!stages.includes(stage)) return;
    const entry = find(event);
    if (!entry || entry.trace.observations.length >= 128) return;
    entry.trace.observations.push({
      stage,
      ms: performance.now() - entry.start,
    });
  };
  return {
    begin(
      event: MessageEvent,
      arrival = { at: Date.now(), monotonic: performance.now() },
    ) {
      const id = key(event);
      if (traces.has(id)) return; // Callback retries cannot reset the clock.
      if (traces.size >= 128) {
        const oldest = traces.keys().next().value;
        if (oldest !== undefined) traces.delete(oldest);
      }
      const timestamp =
        event.address.channel === "slack"
          ? slackMicros(event.messageId)
          : undefined;
      const probe = latencyProbe(event.text);
      traces.set(id, {
        start: arrival.monotonic,
        trace: {
          id: randomUUID(),
          receivedAt: arrival.at,
          channel: event.address.channel,
          threaded: !!event.address.threadId,
          ...(probe ? { probe } : {}),
          ...(timestamp === undefined
            ? {}
            : { transportMs: arrival.at - Number(timestamp / 1000n) }),
          observations: [],
          deliveries: [],
        },
      });
      mark(event, "accepted");
    },
    mark,
    delivered(
      event: MessageEvent,
      kind: ReplyKind,
      result: SendResult,
      pong: boolean,
    ) {
      mark(
        event,
        result.status === "sent" ? `${kind}_sent` : `send_${result.status}`,
      );
      const entry = find(event);
      if (!entry || entry.trace.deliveries.length >= 16) return;
      const source =
        event.address.channel === "slack"
          ? slackMicros(event.messageId)
          : undefined;
      const destination =
        result.status === "sent" && kind !== "reaction"
          ? slackMicros(result.messageId)
          : undefined;
      entry.trace.deliveries.push({
        kind,
        status: result.status,
        ms: performance.now() - entry.start,
        ...(source === undefined || destination === undefined
          ? {}
          : { platformMs: Number(destination - source) / 1000 }),
        ...(entry.trace.probe && kind === "text" ? { pong } : {}),
      });
    },
    snapshot() {
      return {
        startedAt,
        traces: [...traces.values()].map(({ trace }) => structuredClone(trace)),
      };
    },
  };
}

export type LatencyDiagnostics = ReturnType<typeof createLatencyDiagnostics>;
