import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Schema } from "effect";
import type {
  Channel,
  MessageEvent,
  ProviderTimingStage,
  SendResult,
} from "../core/contracts.js";
import { correlationId, recordEvent } from "../telemetry/index.js";
import type { DiagnosticLog } from "./diagnostics.js";
import { conversationInputId } from "./inbox.js";
import { latencyQuerySchema, replyLifecycleReport } from "./latency-report.js";

const providerStages = [
  "submitted",
  "terminal",
  "validated",
  "retired",
] as const satisfies readonly ProviderTimingStage[];
type ProviderPhase = "fast" | "deep" | "synthesis";

const stages = [
  "accepted",
  "submission_started",
  "submitted",
  "submission_failed",
  "http_ack",
  "ingress_retry",
  "queued",
  "dequeued",
  "admitted",
  "processing_started",
  "processing_finished",
  "activity_held",
  "deferred",
  "delivery_retry_wait",
  "followup_started",
  "followup_finished",
  "context_started",
  "context_memory_ready",
  "context_platform_ready",
  "context_reads_ready",
  "context_continuity_ready",
  "context_prompt_ready",
  "context_roster_ready",
  "context_ready",
  "fast_started",
  "fast_finished",
  "deep_started",
  "deep_finished",
  "synthesis_started",
  "synthesis_finished",
  "provider_submitted",
  "provider_terminal",
  "provider_validated",
  "provider_retired",
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
  /** Original host receipt, including the authenticated durable intake. */
  receivedAt: number;
  /** App HTTP receipt is the origin of all monotonic ms offsets. */
  appReceivedAt?: number;
  sourceAt?: number;
  intake?: boolean;
  processId?: string;
  processStartedAt?: number;
  revision?: string;
  channel: Channel;
  threaded: boolean;
  probe?: string;
  transportMs?: number;
  observations: {
    stage: LatencyStage;
    ms: number;
    at?: number;
    providerCall?: number;
    providerPhase?: ProviderPhase;
  }[];
  deliveries: {
    kind: ReplyKind;
    status: SendResult["status"];
    ms: number;
    at?: number;
    startedMs?: number;
    retryable?: boolean;
    retryAfterMs?: number;
    /** Same requesting conversation; chosen reply threads also qualify. */
    reply?: boolean;
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

/** Bounded, prompt-free observations with an optional persistent log. No journal steps, replay work,
 * provider retries, URLs, identity IDs, content, errors or credentials retained.
 * Historical traces are read-only: never reconnect clocks or reconstruct on replay. */
export function createLatencyDiagnostics(log?: DiagnosticLog) {
  const startedAt = log?.session.processStartedAt ?? Date.now();
  const salt = randomBytes(32);
  const traces = new Map<
    string,
    {
      start: number;
      trace: LatencyTrace;
      nextProviderCall: number;
      operationId: string;
    }
  >();
  // A catalog assignment can refer to the existing trace without retaining a
  // message body or changing the durable assignment. Neither hash is exported.
  const key = (event: MessageEvent | string) =>
    createHmac("sha256", salt)
      .update(
        typeof event === "string"
          ? event
          : conversationInputId({ type: "event", event }),
      )
      .digest("hex");
  const aliases = new Map<string, { source: string; traceId: string }>();
  const find = (event: MessageEvent | string) => {
    const id = key(event);
    const direct = traces.get(id);
    if (direct) return direct;
    const alias = aliases.get(id);
    const entry = alias && traces.get(alias.source);
    return entry?.trace.id === alias?.traceId ? entry : undefined;
  };
  const mark = (event: MessageEvent | string, stage: LatencyStage) => {
    if (!stages.includes(stage)) return;
    const entry = find(event);
    if (!entry || entry.trace.observations.length >= 128) return;
    recordEvent("june.latency.stage", {
      "june.operation.id": entry.operationId,
      "june.channel": entry.trace.channel,
      "june.phase": stage,
    });
    entry.trace.observations.push({
      stage,
      ms: performance.now() - entry.start,
      at: Date.now(),
    });
    log?.saveTrace(entry.trace);
  };
  return {
    /** Volatile notification identity only; never reconstruct an evicted clock. */
    link(inputId: string, source: MessageEvent) {
      const alias = key(inputId);
      if (aliases.has(alias)) return;
      const id = key(source);
      const entry = traces.get(id);
      if (!entry) return;
      if (aliases.size >= 128) {
        const oldest = aliases.keys().next().value;
        if (oldest !== undefined) aliases.delete(oldest);
      }
      aliases.set(alias, { source: id, traceId: entry.trace.id });
    },
    begin(
      event: MessageEvent,
      arrival: { at: number; monotonic: number; intakeReceivedAt?: number } = {
        at: Date.now(),
        monotonic: performance.now(),
      },
    ) {
      const id = key(event);
      if (traces.has(id)) {
        mark(event, "ingress_retry");
        return; // Callback retries cannot reset either clock.
      }
      if (traces.size >= 128) {
        const oldest = traces.keys().next().value;
        if (oldest !== undefined) traces.delete(oldest);
      }
      const timestamp =
        event.address.channel === "slack"
          ? slackMicros(event.messageId)
          : undefined;
      const probe = latencyProbe(event.text);
      const receivedAt = arrival.intakeReceivedAt ?? arrival.at;
      const sourceAt =
        timestamp === undefined ? undefined : Number(timestamp / 1000n);
      traces.set(id, {
        start: arrival.monotonic,
        nextProviderCall: 0,
        operationId: correlationId(event.id),
        trace: {
          id: randomUUID(),
          receivedAt,
          appReceivedAt: arrival.at,
          intake: arrival.intakeReceivedAt !== undefined,
          ...log?.session,
          channel: event.address.channel,
          threaded: !!event.address.threadId,
          ...(probe ? { probe } : {}),
          ...(sourceAt === undefined
            ? {}
            : { sourceAt, transportMs: receivedAt - sourceAt }),
          observations: [],
          deliveries: [],
        },
      });
      mark(event, "accepted");
    },
    mark,
    /** Create only inside a live provider effect, never while replaying a receipt.
     * Call IDs keep delayed retirement separate from subsequent provider calls. */
    providerTiming(event: MessageEvent, phase: ProviderPhase) {
      const id = key(event);
      const entry = traces.get(id);
      const providerCall = entry ? entry.nextProviderCall++ : undefined;
      return (stage: ProviderTimingStage) => {
        if (
          !providerStages.includes(stage) ||
          !entry ||
          traces.get(id) !== entry ||
          entry.trace.observations.length >= 128
        )
          return;
        recordEvent("june.latency.provider", {
          "june.operation.id": entry.operationId,
          "june.channel": event.address.channel,
          "june.phase": `${phase}.${stage}`,
          ...(providerCall === undefined
            ? {}
            : { "june.attempt": providerCall }),
        });
        entry.trace.observations.push({
          stage: `provider_${stage}`,
          ms: performance.now() - entry.start,
          at: Date.now(),
          providerCall,
          providerPhase: phase,
        });
        log?.saveTrace(entry.trace);
      };
    },
    delivered(
      event: MessageEvent,
      kind: ReplyKind,
      result: SendResult,
      pong: boolean,
      address?: MessageEvent["address"],
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
      const startedMs = entry.trace.observations.findLast(
        (observation) => observation.stage === `${kind}_started`,
      )?.ms;
      const previousMs = entry.trace.deliveries.findLast(
        (delivery) => delivery.kind === kind,
      )?.ms;
      const reply =
        address &&
        address.channel === event.address.channel &&
        address.accountId === event.address.accountId &&
        address.conversationId === event.address.conversationId;
      entry.trace.deliveries.push({
        kind,
        status: result.status,
        ms: performance.now() - entry.start,
        at: Date.now(),
        ...(reply === undefined ? {} : { reply }),
        // A capped/missing start must not reuse an earlier attempt's start.
        ...(startedMs !== undefined && startedMs > (previousMs ?? -Infinity)
          ? { startedMs }
          : {}),
        ...(result.status === "rejected"
          ? {
              retryable: result.retryable,
              ...(Number.isFinite(result.retryAfterMs) &&
              (result.retryAfterMs ?? -1) >= 0
                ? { retryAfterMs: result.retryAfterMs }
                : {}),
            }
          : {}),
        ...(reply !== true || source === undefined || destination === undefined
          ? {}
          : { platformMs: Number(destination - source) / 1000 }),
        ...(entry.trace.probe && kind === "text" ? { pong } : {}),
      });
      log?.saveTrace(entry.trace);
    },
    snapshot() {
      return {
        startedAt,
        traces: [...traces.values()].map(({ trace }) => structuredClone(trace)),
      };
    },
    /** Only the capture's retention-filtered inputs, never the global log.
     * Historical salted lookups cannot be reconstructed after a restart. */
    capture(events: MessageEvent[]) {
      const selected = new Map<string, LatencyTrace & { inputId: string }>();
      for (const event of events) {
        const entry = find(event);
        if (entry)
          selected.set(entry.trace.id, {
            ...structuredClone(entry.trace),
            inputId: conversationInputId({ type: "event", event }),
          });
      }
      return {
        coverage: "current-process" as const,
        traces: [...selected.values()],
      };
    },
    /** Current-process snapshot stays separate so live probes cannot silently
     * adopt a historical run after a restart. Only owner routes may read logs. */
    logs() {
      return log?.snapshot() ?? { unavailable: true };
    },
    /** Called only by the owner-private host action. The requested summary is
     * normal reply content; raw observations remain outside prompts/journals. */
    report(query: string, event: MessageEvent, revision?: string) {
      const probe = latencyProbe(`ping ${query}`);
      if (!Schema.is(latencyQuerySchema)(query))
        return "Use logs, recent, trace:<UUIDv4> or an exact ping UUIDv4 for diagnostics.";
      const traceId = query.startsWith("trace:") ? query.slice(6) : undefined;
      const live = [...traces.entries()]
        .filter(
          ([id, { trace }]) =>
            id !== key(event) &&
            (!probe || trace.probe === probe) &&
            (!traceId || trace.id === traceId),
        )
        .map(([, { trace }]) => trace);
      let retained = live;
      try {
        if (query === "logs")
          return log?.report() ?? "Persistent diagnostic logs are unavailable.";
        if (log) {
          const combined = new Map(
            log
              .traces(probe, find(event)?.trace.id, traceId)
              .map((trace) => [trace.id, trace]),
          );
          // Include in-memory observations even if the persistence write failed.
          for (const trace of live) combined.set(trace.id, trace);
          retained = [...combined.values()].sort(
            (a, b) => a.receivedAt - b.receivedAt,
          );
        }
      } catch {
        return "Persistent diagnostic logs are unavailable; missing data cannot establish success or failure.";
      }
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
          // A repeated start before the first end can belong to a retry or
          // follow-up. Do not present the combined interval as one operation.
          const starts = trace.observations.filter(
            (o) => o.stage === start && b !== undefined && o.ms <= b,
          );
          return a === undefined ||
            b === undefined ||
            b < a ||
            starts.length !== 1
            ? undefined
            : b - a;
        };
        const sent = trace.deliveries.find(
          (d) => d.kind === "text" && d.status === "sent" && d.reply === true,
        );
        const state =
          time("finished") !== undefined && time("released") !== undefined
            ? "released"
            : "incomplete";
        const firstProvider = trace.observations.find(
          (o) => o.providerCall !== undefined,
        );
        const providerTime = (stage: ProviderTimingStage) =>
          firstProvider === undefined
            ? undefined
            : trace.observations.find(
                (o) =>
                  o.providerCall === firstProvider.providerCall &&
                  o.stage === `provider_${stage}`,
              )?.ms;
        const providerSpan = (
          start: ProviderTimingStage,
          end: ProviderTimingStage,
        ) => {
          const a = providerTime(start),
            b = providerTime(end);
          return a === undefined || b === undefined || b < a
            ? undefined
            : b - a;
        };
        const missing = providerStages.filter(
          (stage) => providerTime(stage) === undefined,
        );
        const parallelRoster = time("context_reads_ready") !== undefined;
        return [
          `${new Date(trace.receivedAt).toISOString()} ${trace.channel} ${trace.threaded ? "thread" : "top-level"}; ${state}${trace.probe ? `; probe ${trace.probe}; pong ${sent?.pong === true ? "accepted" : "not confirmed"}` : ""}`,
          replyLifecycleReport(trace),
          ...(trace.processId
            ? [
                `Recorded by process ${trace.processId}, startedAt ${trace.processStartedAt}; revision ${trace.revision ?? "unknown"}.`,
              ]
            : []),
          `Slack reply E2E ${ms(sent?.platformMs)}; app reply acceptance ${ms(sent?.ms)}; HTTP ack ${ms(time("http_ack"))}; typing ack ${ms(time("typing_accepted"))}; textual ack ${ms(time("ack_sent"))}.`,
          `Queue ${ms(span("submission_started", "dequeued"))}; context ${ms(span("context_started", "context_ready"))}; provider fast/deep/synthesis ${ms(span("fast_started", "fast_finished"))}/${ms(span("deep_started", "deep_finished"))}/${ms(span("synthesis_started", "synthesis_finished"))}; send ${ms(span("text_started", "text_sent"))}.`,
          `Context preparation: memory ${ms(span("context_started", "context_memory_ready"))}; platform ${ms(span("context_memory_ready", "context_platform_ready"))}; ${parallelRoster ? `parallel roster wait ${ms(span("context_platform_ready", "context_reads_ready"))}; ` : ""}continuity ${ms(span(parallelRoster ? "context_reads_ready" : "context_platform_ready", "context_continuity_ready"))}; prompt/typing preference ${ms(span("context_continuity_ready", "context_prompt_ready"))}; ${parallelRoster ? "roster merge" : "worker roster"} ${ms(span("context_prompt_ready", "context_roster_ready"))}; host status ${ms(span("context_roster_ready", "context_ready"))}.`,
          `Provider first observed call (${firstProvider?.providerPhase ?? "unobserved"}): submitted→terminal ${ms(providerSpan("submitted", "terminal"))}; validation ${ms(providerSpan("terminal", "validated"))}; answer-ready ${ms(providerTime("validated"))} since arrival; submitted→answer-ready ${ms(providerSpan("submitted", "validated"))}; cleanup ${ms(providerSpan("validated", "retired"))}; missing stages: ${missing.length ? missing.map((stage) => `provider_${stage}`).join(", ") : "none"}.`,
        ].join("\n");
      });
      return [
        header,
        selected.length
          ? `${selected.length} retained sample(s), newest first, excluding this request:`
          : "No matching retained samples. Missing is not proof no reply occurred; do not resend a probe.",
        ...rows,
        "Times are first spans, not additive totals. E2E is never time spent reasoning or inspecting an image. Provider includes process/transport, not TTFT or inference alone; acknowledgments overlap. Follow-ups may arrive after the original turn finishes. Provider retirement can arrive after turn completion; missing stages are unobserved, not zero, and do not prove success or failure. E2E means Slack timestamp delta, not human read time. Model settings and cold-provider state are not measured; do not infer a speedup from one sample.",
        log
          ? "Persistent traces survive process restarts; retention is 30 days / 10,000 traces. Each sample keeps its original process and revision; never merge timings across runs. Retention, write failures or host power loss can leave gaps."
          : "At most 128 volatile traces; restarts/eviction lose data.",
      ].join("\n\n");
    },
  };
}

export type LatencyDiagnostics = ReturnType<typeof createLatencyDiagnostics>;
