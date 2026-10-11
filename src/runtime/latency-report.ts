import { Schema } from "effect";
import { isPattern } from "../effect/schema.js";
import type { LatencyStage, LatencyTrace } from "./latency.js";

export const latencyQuerySchema = Schema.String.check(
  isPattern(
    /^(?:recent|logs|(?:trace:)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/,
  ),
);

const elapsed = (start: number | undefined, end: number | undefined) =>
  start === undefined || end === undefined || end < start
    ? undefined
    : end - start;
const ms = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) || value < 0
    ? "unknown"
    : `${value.toFixed(1)}ms`;
const at = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) || Math.abs(value) > 8.64e15
    ? "unknown"
    : new Date(value).toISOString();

/** Derive explanations only from observed endpoints. Old traces intentionally
 * keep missing clocks, rather than pairing their receipt with a replay origin. */
export function replyLifecycleReport(trace: LatencyTrace): string {
  const stage = (name: LatencyStage) =>
    trace.observations.find((observation) => observation.stage === name);
  const queued = stage("queued");
  const processing = stage("processing_started");
  const finished = stage("processing_finished");
  const sent = trace.deliveries.find(
    (delivery) =>
      delivery.kind === "text" &&
      delivery.status === "sent" &&
      delivery.reply === true,
  );
  const intakeWait = elapsed(trace.receivedAt, trace.appReceivedAt);
  // This residual is not a measured stage, and can include clock disagreement.
  const residual =
    sent?.platformMs === undefined || trace.transportMs === undefined
      ? undefined
      : sent.platformMs - trace.transportMs - sent.ms - (intakeWait ?? 0);
  const clockMismatch = trace.observations.some(
    (observation) =>
      observation.at !== undefined &&
      trace.appReceivedAt !== undefined &&
      Math.abs(observation.at - trace.appReceivedAt - observation.ms) > 1000,
  );
  const notable = trace.observations.filter((observation) =>
    [
      "ingress_retry",
      "deferred",
      "delivery_retry_wait",
      "followup_started",
      "followup_finished",
      "activity_held",
    ].includes(observation.stage),
  );
  return [
    `Trace ${trace.id}; inspect with latency:"trace:${trace.id}".`,
    `Lifecycle UTC: source ${at(trace.sourceAt)}; host receipt ${at(trace.receivedAt)}; app receipt ${at(trace.appReceivedAt)}; queue publication ${at(queued?.at)}; processing start ${at(processing?.at)}; processing end ${at(finished?.at)}; first reply text acceptance ${at(sent?.at)}.`,
    `Before processing: source→host ${ms(trace.transportMs)} (cross-clock); intake→app ${trace.intake ? ms(intakeWait) : trace.appReceivedAt === undefined ? "unknown" : "not buffered"}; queue publication→processing ${ms(elapsed(queued?.ms, processing?.ms))}; app→processing ${ms(processing?.ms)}. Processing window ${ms(elapsed(processing?.ms, finished?.ms))}, not inference time or necessarily final reply completion.`,
    `Unattributed platform/app residual ${residual === undefined ? "unknown" : `${residual.toFixed(1)}ms (signed)`}; this is not a measured wait or a diagnosis${trace.appReceivedAt === undefined ? "; historical intake→app timing is missing" : ""}. Clock alignment is not verified${clockMismatch || (trace.transportMs ?? 0) < 0 || (trace.appReceivedAt !== undefined && trace.appReceivedAt < trace.receivedAt) ? "; clock order/discontinuity detected" : ""}.`,
    `Delivery observations (last five of ${trace.deliveries.length}, in order; not deduplicated reply counts): ${
      trace.deliveries
        .slice(-5)
        .map(
          (delivery) =>
            `${delivery.kind} ${delivery.status} (${delivery.reply === undefined ? "destination unclassified" : delivery.reply ? "requesting conversation" : "elsewhere"}) at ${at(delivery.at)}, app +${ms(delivery.ms)}, transport ${ms(elapsed(delivery.startedMs, delivery.ms))}${delivery.platformMs === undefined ? "" : `, platform delta ${ms(delivery.platformMs)}`}${delivery.retryable === undefined ? "" : `, retryable ${delivery.retryable}`}${delivery.retryAfterMs === undefined ? "" : `, requested backoff ${ms(delivery.retryAfterMs)}`}`,
        )
        .join("; ") || "none observed"
    }.`,
    `Deferrals/retries/follow-ups (last eight): ${
      notable
        .slice(-8)
        .map((observation) => `${observation.stage} app +${ms(observation.ms)}`)
        .join("; ") || "none observed; not proof none occurred"
    }. Intake forwarding attempts and provider-internal waits are not recorded. Sends elsewhere and historical unclassified destinations do not establish ordinary-reply E2E.`,
    ...(trace.observations.length >= 128 || trace.deliveries.length >= 16
      ? ["Observation cap reached; later stages may be missing."]
      : []),
  ].join("\n");
}
