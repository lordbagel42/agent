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
    /** Called only by the owner-private host action. The requested summary is
     * normal reply content; raw observations remain volatile and prompt-free. */
    report(query: string, event: MessageEvent, revision?: string) {
      const probe = latencyProbe(`ping ${query}`);
      if (query !== "recent" && !probe)
        return "Use recent or an exact ping UUIDv4 for latency diagnostics.";
      const retained = [...traces.entries()]
        .filter(
          ([id, { trace }]) =>
            id !== key(event) && (!probe || trace.probe === probe),
        )
        .map(([, { trace }]) => trace);
      const header = `Latency diagnostics — revision ${revision ?? "unknown"}; process startedAt ${startedAt}.`;
      if (probe && retained.length > 1)
        return `${header}\nMultiple retained messages used that probe UUID. The measurement is ambiguous; do not resend it.`;
      const selected = retained.slice(-5).reverse();
      const ms = (value: number | undefined) =>
        value === undefined ? "unobserved" : `${value.toFixed(1)}ms`;
      const rows = selected.map((trace) => {
        const time = (stage: LatencyStage) =>
          trace.observations.find((o) => o.stage === stage)?.ms;
        const span = (start: LatencyStage, end: LatencyStage) => {
          const a = time(start),
            b = time(end);
          return a === undefined || b === undefined ? undefined : b - a;
        };
        const sent = trace.deliveries.find(
          (d) => d.kind === "text" && d.status === "sent",
        );
        const state =
          time("finished") !== undefined && time("released") !== undefined
            ? "released"
            : "incomplete";
        return [
          `${new Date(trace.receivedAt).toISOString()} ${trace.channel} ${trace.threaded ? "thread" : "top-level"}; ${state}${trace.probe ? `; probe ${trace.probe}; pong ${sent?.pong === true ? "accepted" : "not confirmed"}` : ""}`,
          `Slack E2E ${ms(sent?.platformMs)}; host text ${ms(time("text_sent"))}; HTTP ack ${ms(time("http_ack"))}; typing ack ${ms(time("typing_accepted"))}; textual ack ${ms(time("ack_sent"))}.`,
          `Queue ${ms(span("submission_started", "dequeued"))}; context ${ms(span("context_started", "context_ready"))}; provider fast/deep/synthesis ${ms(span("fast_started", "fast_finished"))}/${ms(span("deep_started", "deep_finished"))}/${ms(span("synthesis_started", "synthesis_finished"))}; send ${ms(span("text_started", "text_sent"))}.`,
        ].join("\n");
      });
      return [
        header,
        selected.length
          ? `${selected.length} retained sample(s), newest first, excluding this request:`
          : "No matching retained samples. Missing is not proof no reply occurred; do not resend a probe.",
        ...rows,
        "Times are first spans, not additive totals. Provider includes process/transport, not TTFT or inference alone; acknowledgments overlap. E2E means Slack timestamp delta, not human read time. At most 128 volatile traces; restarts/eviction lose data. Model settings and cold-provider state are not measured; do not infer a speedup from one sample.",
      ].join("\n\n");
    },
  };
}

export type LatencyDiagnostics = ReturnType<typeof createLatencyDiagnostics>;
