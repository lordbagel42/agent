import type { WakeupJob, WakeupRun, WakeupState } from "../wakeups/state.js";

/** The wakeup actor remains the only durable owner. Missing versions are legacy 0. */
export function wakeupIntent(job: WakeupJob) {
  return { id: `wakeup:${job.id}`, version: job.intentVersion ?? 0 };
}

export function currentWakeupRun(job: WakeupJob, run: WakeupRun) {
  return (
    run.jobId === job.id &&
    (run.intentVersion ?? 0) === (job.intentVersion ?? 0) &&
    !["paused", "cancelled"].includes(job.status) &&
    ["pending", "queued", "running"].includes(run.status)
  );
}

/** Invalidate the old generation once; resume never rehabilitates its runs. */
export function fenceWakeup(job: WakeupJob) {
  if (["paused", "cancelled"].includes(job.status)) {
    // A legacy stop did not record its boundary. Materialize it before resume.
    job.intentVersion ??= 1;
    return;
  }
  const version = (job.intentVersion ?? 0) + 1;
  if (!Number.isSafeInteger(version))
    throw new Error("Wakeup version exhausted");
  job.intentVersion = version;
}

/** No live-consumer acknowledgement exists yet. Aggregate run completion and
 * pruning must never turn unavailable effect evidence into a positive receipt. */
export function wakeupStopReceipt(state: WakeupState, job: WakeupJob) {
  const runs = Object.values(state.runs).filter((run) => run.jobId === job.id);
  const stopped = ["paused", "cancelled", "completed"].includes(job.status);
  const fenced =
    stopped &&
    job.admissionEvidence === "never_admitted" &&
    runs.every((run) => run.status === "cancelled");
  return { fenced, settled: fenced };
}

/** Owner-specific metadata, NOT a complete K2 IntentSnapshot or effect ledger. */
export function inspectWakeupIntent(state: WakeupState, job: WakeupJob) {
  const stop = wakeupStopReceipt(state, job);
  return {
    reference: wakeupIntent(job),
    state:
      job.status === "active" ||
      Object.values(state.runs).some((run) => currentWakeupRun(job, run))
        ? ("current" as const)
        : stop.settled
          ? ("stopped" as const)
          : ("stopping" as const),
    admissionEvidence: job.admissionEvidence ?? "legacy_history_unavailable",
    settlementEvidence: stop.settled
      ? "nothing_admitted"
      : "consumer_settlement_unavailable",
  };
}
