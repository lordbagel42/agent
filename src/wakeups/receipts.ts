import { Effect, Schema } from "effect";
import { decodeStrict, isPattern } from "../effect/schema.js";
import type { Delivery } from "../runtime/delivery.js";
import type { ConversationIngress } from "../runtime/inbox.js";
import type { WakeupState } from "./state.js";

const receiptIds = Schema.Array(
  Schema.String.check(isPattern(/^[a-f0-9]{64}$/)),
).check(Schema.isMaxLength(3));
export const decodeReportRunIds = decodeStrict(receiptIds);

export class ReportReceiptError extends Schema.TaggedError<ReportReceiptError>()(
  "ReportReceiptError",
  { reason: Schema.Literals(["unavailable", "too_large"]) },
) {}

/** Check each projection before its actor RPC, not after a full snapshot. */
export function boundedReportReceipt<T>(receipt: T): T {
  if (Buffer.byteLength(JSON.stringify(receipt)) > 16_384)
    throw new ReportReceiptError({ reason: "too_large" });
  return receipt;
}

const slackTimestamp = Schema.is(
  Schema.String.check(isPattern(/^\d{1,20}\.\d{1,20}$/)),
);

/** Historical effect metadata survives privacy revocation; no content or codes. */
export function reportDeliveries(deliveries: readonly Delivery[]) {
  const text = deliveries.filter(
    (item) => item.message.content.type === "text",
  );
  return boundedReportReceipt({
    observedAt: Date.now(),
    retained: text.length,
    omitted: Math.max(0, text.length - 4),
    deliveries: text.slice(0, 4).map((item, part) => ({
      part,
      phase: item.phase,
      attempts: item.attempts,
      outcomeObservedAt: item.outcomeObservedAt ?? null,
      status: item.result?.status ?? null,
      slackMessageId:
        item.message.address.channel === "slack" &&
        item.result?.status === "sent" &&
        slackTimestamp(item.result.messageId)
          ? item.result.messageId
          : null,
    })),
  });
}

export interface ReportIngressReceipt {
  runId: string;
  inputId: string;
  observedAt: number;
  ingress: ConversationIngress["receipts"][string] | null;
  delivery: ReturnType<typeof reportDeliveries> | null;
  /** Missing evidence is not a failed send or permission to replay. */
  unavailable: "ingress_not_retained" | "activity_not_retained" | null;
}

/** Existing retained runs only. No enrollment, invalidation, save, or queue send. */
export const readMindReportReceipts = Effect.fn("june.wakeup.report_receipts")(
  function* (
    state: WakeupState,
    read: (ids: string[]) => Promise<ReportIngressReceipt[]>,
  ) {
    const job = state.jobs["report:mind"];
    const runs = job?.report
      ? Object.values(state.runs)
          .filter((run) => run.jobId === job.id)
          .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      : [];
    // Copy metadata before yielding: actor state can advance during the RPC.
    const selection = boundedReportReceipt({
      observedAt: Date.now(),
      job: job?.report
        ? {
            id: job.id,
            status: job.status,
            intentVersion: job.intentVersion ?? 0,
            admissionEvidence: job.admissionEvidence ?? null,
            createdAt: job.createdAt,
          }
        : null,
      retainedRuns: runs.length,
      omittedRuns: Math.max(0, runs.length - 3),
      runs: runs.slice(0, 3).map((run) => ({
        id: run.id,
        status: run.status,
        intentVersion: run.intentVersion ?? 0,
        createdAt: run.createdAt,
        eventType: run.event.type,
      })),
    });
    const receipts = selection.runs.length
      ? yield* Effect.tryPromise({
          try: () => read(selection.runs.map((run) => run.id)),
          catch: () => new ReportReceiptError({ reason: "unavailable" }),
        })
      : [];
    return boundedReportReceipt({
      ...selection,
      receipts,
      limitations:
        "Retained evidence only, not a lifetime count or an atomic cross-actor snapshot. Each stage has its own observation time. A sent Slack message ID proves platform acceptance, not report quality, resolution or reading. Missing evidence is unavailable, never permission to replay. These actions do not enroll, invalidate, persist or enqueue; waking an actor can still resume its existing work.",
    });
  },
);

export type MindReportReceipts = Effect.Success<
  ReturnType<typeof readMindReportReceipts>
>;
