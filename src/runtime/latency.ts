import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type {
  MessageEvent,
  ProviderTimingStage,
  SendResult,
} from "../core/contracts.js";
import { correlationId, recordEvent } from "../telemetry/index.js";
import type { DiagnosticLog } from "./diagnostics.js";
import { conversationInputId } from "./inbox.js";

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
  "dequeued",
  "admitted",
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
  receivedAt: number;
  processId?: string;
  processStartedAt?: number;
  revision?: string;
  channel: "slack" | "whatsapp" | "agent";
  threaded: boolean;
  probe?: string;
  transportMs?: number;
  observations: {
    stage: LatencyStage;
    ms: number;
    providerCall?: number;
    providerPhase?: ProviderPhase;
  }[];
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

/** Bounded, prompt-free observations with an optional persistent log. No journal steps, replay work,
 * provider retries, URLs, identity IDs, content, errors or credentials retained.
 * Historical traces are read-only: never reconnect clocks or reconstruct on replay. */
export function createLatencyDiagnostics(log?: DiagnosticLog) {
  const startedAt = log?.session.processStartedAt ?? Date.now();
  const salt = randomBytes(32);
  const traces = new Map<
    string,
    { start: number; trace: LatencyTrace; nextProviderCall: number }
  >();
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
    recordEvent("june.latency.stage", {
      "june.operation.id": correlationId(event.id),
      "june.channel": event.address.channel,
      "june.phase": stage,
    });
    entry.trace.observations.push({
      stage,
      ms: performance.now() - entry.start,
    });
    log?.saveTrace(entry.trace);
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
        nextProviderCall: 0,
        trace: {
          id: randomUUID(),
          receivedAt: arrival.at,
          ...log?.session,
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
          "june.operation.id": correlationId(event.id),
          "june.channel": event.address.channel,
          "june.phase": `${phase}.${stage}`,
          ...(providerCall === undefined
            ? {}
            : { "june.attempt": providerCall }),
        });
        entry.trace.observations.push({
          stage: `provider_${stage}`,
          ms: performance.now() - entry.start,
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
      if (query !== "recent" && query !== "logs" && !probe)
        return "Use logs, recent or an exact ping UUIDv4 for diagnostics.";
      const live = [...traces.entries()]
        .filter(
          ([id, { trace }]) =>
            id !== key(event) && (!probe || trace.probe === probe),
        )
        .map(([, { trace }]) => trace);
      let retained = live;
      try {
        if (query === "logs")
          return log?.report() ?? "Persistent diagnostic logs are unavailable.";
        if (log) {
          const combined = new Map(
            log
              .traces(probe, find(event)?.trace.id)
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
          return a === undefined || b === undefined ? undefined : b - a;
        };
        const sent = trace.deliveries.find(
          (d) => d.kind === "text" && d.status === "sent",
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
          ...(trace.processId
            ? [
                `Recorded by process ${trace.processId}, startedAt ${trace.processStartedAt}; revision ${trace.revision ?? "unknown"}.`,
              ]
            : []),
          `Slack E2E ${ms(sent?.platformMs)}; host text ${ms(time("text_sent"))}; HTTP ack ${ms(time("http_ack"))}; typing ack ${ms(time("typing_accepted"))}; textual ack ${ms(time("ack_sent"))}.`,
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
        "Times are first spans, not additive totals. Provider includes process/transport, not TTFT or inference alone; acknowledgments overlap. Provider retirement can arrive after turn completion; missing stages are unobserved, not zero, and do not prove success or failure. E2E means Slack timestamp delta, not human read time. Model settings and cold-provider state are not measured; do not infer a speedup from one sample.",
        log
          ? "Persistent traces survive process restarts; retention is 30 days / 10,000 traces. Each sample keeps its original process and revision; never merge timings across runs. Retention, write failures or host power loss can leave gaps."
          : "At most 128 volatile traces; restarts/eviction lose data.",
      ].join("\n\n");
    },
  };
}

export type LatencyDiagnostics = ReturnType<typeof createLatencyDiagnostics>;
