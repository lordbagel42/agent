import { createHash } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { ChannelEvent, MessageEvent } from "../core/contracts.js";
import {
  fenceWakeup,
  inspectWakeupIntent,
  wakeupStopReceipt,
} from "../intent/wakeups.js";

const name = z.string().min(1).max(100);
// Plain unions emit provider-supported anyOf; literal tags still disambiguate.
export const triggerSchema = z.union([
  z.strictObject({
    kind: z.literal("at"),
    at: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({ kind: z.literal("cron"), expression: name, timezone: name }),
  z.strictObject({
    kind: z.literal("event"),
    source: name,
    type: name,
    filters: z
      .array(
        z.strictObject({
          path: z
            .string()
            .regex(/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+){0,4}$/)
            .max(100),
          value: z.union([
            z.string().max(256),
            z.number().finite(),
            z.boolean(),
            z.null(),
          ]),
        }),
      )
      .max(8),
  }),
]);
export const wakeupActionSchema = z.union([
  z.strictObject({
    action: z.literal("create"),
    name,
    instruction: z.string().trim().min(1).max(2000),
    trigger: triggerSchema,
    once: z.boolean(),
  }),
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({
    action: z.enum(["inspect", "pause", "resume", "cancel"]),
    id: z.string().min(1).max(256),
  }),
]);
export type WakeupAction = z.infer<typeof wakeupActionSchema>;
export const eventSchema = z
  .strictObject({
    id: z.string().min(1).max(256),
    source: name,
    type: name,
    occurredAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
    data: z.record(z.string(), z.unknown()),
  })
  .refine((event) => Buffer.byteLength(JSON.stringify(event)) <= 16_384);
export type WakeupEvent = z.infer<typeof eventSchema>;

/** Preserve platform identity/ordering; only wakeup envelopes use whole ms. */
export function nativeChannelEvent(event: ChannelEvent): WakeupEvent {
  return {
    id: `${event.address.accountId}:${event.id}`,
    source: event.address.channel,
    type: event.type,
    occurredAt: Math.trunc(event.occurredAt),
    data: {
      address: event.address,
      messageId: event.messageId,
      ...(event.type === "message"
        ? {
            senderId: event.senderId,
            text: event.text.slice(0, 3500),
            direct: event.direct,
          }
        : event.type === "reaction"
          ? {
              senderId: event.senderId,
              emoji: event.emoji,
              removed: event.removed,
            }
          : { status: event.status }),
    },
  };
}

export interface WakeupJob {
  id: string;
  /** Only the host can create decision subscriptions. Absent means notification. */
  mode?: "decision";
  /** Conversation provenance; legacy direct jobs used id for both identities. */
  originEventId?: string;
  /** Host-authenticated JSON scope key, including the requester for guest scopes. */
  audience?: string;
  name: string;
  instruction: string;
  trigger: z.infer<typeof triggerSchema>;
  once: boolean;
  source: MessageEvent;
  /** Transitive evidence used by the turn that registered this job. */
  evidenceIds: string[];
  createdAt: number;
  updatedAt: number;
  status: "active" | "paused" | "cancelled" | "completed";
  /** Additive cancellation generation; old jobs and runs read as generation 0. */
  intentVersion?: number;
  /** Monotone, content-free evidence. Missing means legacy history unavailable. */
  admissionEvidence?: "never_admitted" | "may_have_started";
  nextAt?: number;
  coalesced: number;
}
export interface WakeupRun {
  id: string;
  jobId: string;
  /** Frozen at enqueue. Never inferred from the job after pause/resume. */
  intentVersion?: number;
  event: WakeupEvent;
  /** Producer scope supplied out of band by the host, never from event.data. */
  audience?: string;
  /** Host-only trigger ancestry. Absent means payload retention is untracked. */
  contextSourceIds?: string[];
  createdAt: number;
  status:
    | "pending"
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "unknown"
    | "cancelled";
}
export interface WakeupState {
  jobs: Record<string, WakeupJob>;
  runs: Record<string, WakeupRun>;
  seen: Record<string, number>;
  deploymentCursor?: number;
  deploymentIssue?: "feed_unavailable" | "feed_gap";
}
export interface WakeupContext {
  runId: string;
  jobId: string;
  mode?: "decision";
  originEventId?: string;
  instruction: string;
  event: WakeupEvent;
}
export const initialState = (): WakeupState => ({
  jobs: {},
  runs: {},
  seen: {},
});
export const pending = (run: WakeupRun) =>
  ["pending", "queued", "running"].includes(run.status);

function nextCron(
  trigger: Extract<WakeupJob["trigger"], { kind: "cron" }>,
  after: number,
) {
  if (
    trigger.expression.trim().split(/\s+/).length !== 5 ||
    /[H?]/.test(trigger.expression)
  )
    throw new Error("Use a deterministic five-field cron expression");
  new Intl.DateTimeFormat("en", { timeZone: trigger.timezone }).format(after);
  return CronExpressionParser.parse(trigger.expression, {
    currentDate: new Date(after),
    tz: trigger.timezone,
  })
    .next()
    .getTime();
}

/** The runtime verifies caller admission and saved-job scope before calling this. */
export function applyAction(
  state: WakeupState,
  input: unknown,
  source: MessageEvent,
  commandId: string,
  now: number,
  sources: readonly string[],
  evidenceIds: string[] = [],
  originEventId?: string,
  audience?: string,
): string {
  const action = wakeupActionSchema.parse(input);
  if (action.action === "list") {
    return JSON.stringify({
      sources,
      deploymentIssue: state.deploymentIssue ?? null,
      jobs: Object.values(state.jobs).map(
        ({ id, name, mode, status, nextAt, coalesced }) => ({
          id,
          name,
          mode: mode ?? "notification",
          status,
          nextAt,
          coalesced,
        }),
      ),
    });
  }
  if (action.action === "create") {
    if (Object.hasOwn(state.jobs, commandId))
      return `Wakeup ${commandId} already recorded (${state.jobs[commandId]?.status}).`;
    if (Object.keys(state.jobs).length >= 100)
      throw new Error(
        "Wakeup storage full; retained terminal jobs expire after seven days",
      );
    const { trigger } = action;
    let nextAt: number | undefined;
    if (trigger.kind === "event") {
      if (!sources.includes(trigger.source))
        throw new Error(
          "Event source is not connected; list wakeups to discover sources",
        );
    } else {
      nextAt =
        trigger.kind === "at" ? Date.parse(trigger.at) : nextCron(trigger, now);
      if (!Number.isFinite(nextAt) || nextAt <= now)
        throw new Error("Schedule must be in the future");
    }
    const { threadId: _thread, ...address } = source.address;
    state.jobs[commandId] = {
      id: commandId,
      ...(originEventId ? { originEventId } : {}),
      ...(audience !== undefined ? { audience } : {}),
      name: action.name,
      instruction: action.instruction,
      trigger,
      once: action.once || trigger.kind === "at",
      source: { ...source, address },
      evidenceIds: [...new Set(evidenceIds)],
      createdAt: now,
      updatedAt: now,
      status: "active",
      intentVersion: 0,
      admissionEvidence: "never_admitted",
      nextAt,
      coalesced: 0,
    };
    return `Wakeup ${commandId} saved: ${action.name}. ${trigger.kind === "event" ? `Watching ${trigger.source}/${trigger.type} from now.` : `Next: ${new Date(nextAt as number).toISOString()}${trigger.kind === "cron" ? ` (${trigger.timezone}, ${trigger.expression})` : ""}.`} ${state.jobs[commandId].once ? "One time." : "Repeating."} This is a notification-only job; replies stay in the original Slack conversation and thread. List, inspect, pause, resume, or cancel from that same sender/conversation/thread scope.`;
  }
  const job = Object.hasOwn(state.jobs, action.id)
    ? state.jobs[action.id]
    : undefined;
  if (!job) throw new Error("Wakeup not found");
  if (action.action === "inspect") {
    const { source: _source, ...view } = job;
    return JSON.stringify({
      job: view,
      intent: inspectWakeupIntent(state, job),
      stop: wakeupStopReceipt(state, job),
      effectReceipts:
        "Retained run status is not a provider-effect receipt. Model, tool and delivery owners retain their own receipts; sent effects cannot be undone. Running consumers are not yet acknowledged fenced.",
      recentRuns: Object.values(state.runs)
        .filter((run) => run.jobId === job.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 3)
        .map(({ event, ...run }) => ({
          ...run,
          event: {
            id: event.id,
            source: event.source,
            type: event.type,
            occurredAt: event.occurredAt,
            untrustedDataPreview: JSON.stringify(event.data).slice(0, 1500),
          },
        })),
      deploymentIssue: state.deploymentIssue ?? null,
    });
  }
  if (action.action === "resume") {
    if (job.status !== "paused")
      throw new Error(
        "Only paused wakeups can resume; create a new one for a completed or cancelled job",
      );
    if (job.trigger.kind === "cron") job.nextAt = nextCron(job.trigger, now);
    fenceWakeup(job);
    // Paused event watches do not backfill old source events.
    job.status = "active";
  } else {
    if (action.action === "pause" && !["active", "paused"].includes(job.status))
      throw new Error(
        "Only active wakeups can pause; create a new one for a completed or cancelled job",
      );
    fenceWakeup(job);
    job.status = action.action === "pause" ? "paused" : "cancelled";
    for (const run of Object.values(state.runs))
      if (run.jobId === job.id && ["pending", "queued"].includes(run.status))
        run.status = "cancelled";
  }
  job.updatedAt = now;
  const stop = wakeupStopReceipt(state, job);
  return `Wakeup ${job.id}: ${job.status}. Intent version ${job.intentVersion ?? 0}. ${action.action === "resume" ? "New runs use this generation; cancelled runs are not resumed. Existing missed-run behavior is unchanged." : `Stop receipt: fenced=${stop.fenced}, settled=${stop.settled}. Unclaimed runs from the invalidated generation are blocked. Previously admitted work may still execute or send. Live-consumer fencing and effect settlement are not acknowledged by this wakeup owner. Unknown outcomes are not retried; previously sent effects cannot be undone. Inspect for retained runs and unavailable evidence.`}`;
}

function enqueue(
  state: WakeupState,
  job: WakeupJob,
  event: WakeupEvent,
  now: number,
  contextSourceIds?: string[],
  audience?: string,
) {
  const id = createHash("sha256")
    .update(JSON.stringify([job.id, event.source, event.id]))
    .digest("hex");
  if (Object.hasOwn(state.runs, id)) return;
  if (
    job.mode !== "decision" &&
    Object.values(state.runs).some(
      (run) => run.jobId === job.id && pending(run),
    )
  ) {
    job.coalesced++;
    return;
  }
  state.runs[id] = {
    id,
    jobId: job.id,
    intentVersion: job.intentVersion ?? 0,
    event,
    ...(audience !== undefined ? { audience } : {}),
    ...(contextSourceIds
      ? { contextSourceIds: [...new Set(contextSourceIds)] }
      : {}),
    createdAt: now,
    status: "pending",
  };
  if (job.once) {
    job.status = "completed";
    job.updatedAt = now;
  }
}

/**
 * Only configured deployment/GitHub/webhook feeds retain shared delivery; the
 * runtime separately enforces source enrollment. All other sources (including
 * future native platforms) fail closed without host-authenticated scope. Even
 * a shared feed can be narrowed by an explicit audience. Filters grant nothing.
 */
export function eventAudienceMatches(
  job: WakeupJob,
  event: WakeupEvent,
  audience?: string,
) {
  if (audience !== undefined)
    return (
      typeof audience === "string" &&
      audience.length > 0 &&
      job.audience === audience
    );
  return (
    event.source === "deployment" ||
    event.source === "github" ||
    event.source.startsWith("webhook.")
  );
}

/** Durable acceptance and dispatch intent are saved together by the actor. */
export function acceptEvent(
  state: WakeupState,
  input: unknown,
  now: number,
  contextSourceIds?: string[],
  audience?: string,
) {
  const event = eventSchema.parse(input);
  const key = createHash("sha256")
    .update(JSON.stringify([event.source, event.id]))
    .digest("hex");
  if (Object.hasOwn(state.seen, key))
    return { accepted: true, duplicate: true };
  const matches = Object.values(state.jobs).filter((job) => {
    const trigger = job.trigger;
    if (
      job.status !== "active" ||
      trigger.kind !== "event" ||
      ((job.mode !== "decision" || event.source === "deployment") &&
        event.occurredAt < job.updatedAt) ||
      trigger.source !== event.source ||
      (trigger.type !== "*" && trigger.type !== event.type) ||
      !eventAudienceMatches(job, event, audience)
    )
      return false;
    return trigger.filters.every(({ path, value }) => {
      let found: unknown = event.data;
      for (const part of path.split(".")) {
        if (!found || typeof found !== "object" || !Object.hasOwn(found, part))
          return false;
        found = (found as Record<string, unknown>)[part];
      }
      return found === value;
    });
  });
  // A requested notification takes precedence only in the same recipient scope.
  // Another person's watch must not suppress the owner's decision subscription.
  const admitted = matches.filter(
    (job) =>
      job.mode !== "decision" ||
      !matches.some(
        (requested) =>
          requested.mode !== "decision" &&
          requested.source.senderId === job.source.senderId &&
          JSON.stringify(requested.source.address) ===
            JSON.stringify(job.source.address),
      ),
  );
  if (
    admitted.some((job) => job.mode === "decision") &&
    Object.values(state.runs).filter(
      (run) => pending(run) && state.jobs[run.jobId]?.mode === "decision",
    ).length >= 100
  )
    throw new Error("event_decision_capacity");
  prune(state, now);
  // Bounded replay protection must not let a noisy source stop all timers.
  if (Object.keys(state.seen).length >= 4096) {
    const oldest = Object.entries(state.seen).sort((a, b) => a[1] - b[1])[0];
    if (oldest) delete state.seen[oldest[0]];
  }
  state.seen[key] = now;
  for (const job of admitted)
    enqueue(state, job, event, now, contextSourceIds, audience);
  return { accepted: true, duplicate: false };
}

export function tick(state: WakeupState, now: number) {
  prune(state, now);
  for (const job of Object.values(state.jobs)) {
    if (
      job.status !== "active" ||
      job.nextAt === undefined ||
      job.nextAt > now ||
      job.trigger.kind === "event"
    )
      continue;
    const scheduledAt = job.nextAt;
    enqueue(
      state,
      job,
      {
        id: `${job.id}:${scheduledAt}`,
        source: "schedule",
        type: job.trigger.kind,
        occurredAt: scheduledAt,
        data: { scheduledAt, observedAt: now },
      },
      now,
      [], // Intrinsic clock metadata has no retained-content dependencies.
    );
    if (job.trigger.kind === "cron" && !job.once)
      job.nextAt = nextCron(job.trigger, now);
    else delete job.nextAt;
  }
}

function prune(state: WakeupState, now: number) {
  const cutoff = now - 7 * 86_400_000;
  // Authenticated webhook timestamps prevent replay beyond this retention window.
  for (const [key, at] of Object.entries(state.seen))
    if (at < cutoff) delete state.seen[key];
  const terminal = Object.values(state.runs)
    .filter((run) => !pending(run))
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const [index, run] of terminal.entries())
    if (index >= 100 || run.createdAt < cutoff) delete state.runs[run.id];
  for (const job of Object.values(state.jobs))
    if (
      job.mode !== "decision" &&
      ["cancelled", "completed"].includes(job.status) &&
      job.updatedAt < cutoff &&
      !Object.values(state.runs).some(
        (run) => run.jobId === job.id && pending(run),
      )
    )
      delete state.jobs[job.id];
}
