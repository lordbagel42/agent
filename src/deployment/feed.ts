import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";
import type { CompanionReply } from "../core/contracts.js";

const revision = z.string().regex(/^[0-9a-f]{40}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const feedSchema = z.strictObject({
  version: z.literal(1),
  repository: z.literal("lordbagel42/agent"),
  branch: z.literal("main"),
  lastHealthyRevision: revision,
  controllerRevision: revision.nullable().optional(),
  blocked: z.boolean(),
  lastStageRecovery: z
    .strictObject({ at: timestamp, removed: timestamp.positive() })
    .optional(),
  events: z
    .array(
      z.strictObject({
        sequence: timestamp,
        revision,
        status: z.enum([
          "received",
          "preparing",
          "activating",
          "healthy",
          "failed",
          "rolled_back",
          "superseded",
          "deferred",
          "blocked",
          "fetch_failed",
          "reconciled",
        ]),
        at: timestamp,
        committedAt: timestamp.nullable(),
        elapsedMs: timestamp.nullable(),
        reason: z
          .enum([
            "preflight_failed",
            "health_failed",
            "drain_busy",
            "insufficient_disk",
            "resume_failed",
            "current_unhealthy",
            "candidate_not_drained",
            "unsafe_rollback",
            "rollback_unhealthy",
            "activation_unknown",
            "non_fast_forward",
            "fetch_failed",
          ])
          .nullable(),
      }),
    )
    .max(100),
});

export type DeploymentFeed = z.infer<typeof feedSchema>;

const reasons: Record<
  NonNullable<DeploymentFeed["events"][number]["reason"]>,
  string
> = {
  preflight_failed:
    "Preparation/preflight failed; the feed does not identify the failing operation. Owner/operator diagnosis required; this tool cannot retry.",
  health_failed:
    "Candidate failed readiness/identity checks. Inspect later rollback/block events; do not claim it is live.",
  drain_busy:
    "In-flight work could not be safely drained. Controller defers; inspect again later.",
  insufficient_disk:
    "Insufficient host disk capacity. Operator must restore capacity; controller retries without a new commit.",
  resume_failed: "Admission could not be resumed. Operator recovery required.",
  current_unhealthy:
    "Current service identity/readiness is unverified. Operator inspection required.",
  candidate_not_drained:
    "Failed candidate could not be safely drained. Operator recovery required; no forced restart.",
  unsafe_rollback:
    "Rollback compatibility is not established. Operator forward recovery required; never restore old conversation data.",
  rollback_unhealthy:
    "Rollback did not establish a healthy service. Operator recovery required.",
  activation_unknown:
    "An activation may be incomplete. Operator must establish actual service state and reconcile; no automatic retry.",
  non_fast_forward:
    "Main moved backwards or diverged. Owner/operator must resolve trusted branch history.",
  fetch_failed:
    "Controller could not fetch trusted main. Operator should inspect repository connectivity/access.",
};

function phaseLatency(events: DeploymentFeed["events"], revision?: string) {
  const matching = events.filter(
    (event) => event.revision === revision && event.status !== "fetch_failed",
  );
  // A new preparing event starts a retry. Never borrow an endpoint from an
  // earlier attempt; received only belongs here when immediately preceding it.
  let start = matching.findLastIndex(
    (event) => event.status === "received" || event.status === "preparing",
  );
  if (
    matching[start]?.status === "preparing" &&
    matching[start - 1]?.status === "received"
  )
    start--;
  const attempt = matching.slice(Math.max(0, start));
  const order = {
    received: 0,
    preparing: 1,
    activating: 2,
    healthy: 3,
    failed: 3,
    rolled_back: 4,
    deferred: 5,
    superseded: 5,
    blocked: 5,
    reconciled: 6,
    fetch_failed: 7,
  };
  // Do not sort by wall time or clamp clock regressions to zero. Status order
  // also prevents a late healthy/reconciled event from completing an interruption.
  const ordered = attempt.every((event, index) => {
    const previous = attempt[index - 1];
    return (
      !previous ||
      (event.sequence > previous.sequence &&
        event.at >= previous.at &&
        order[event.status] > order[previous.status])
    );
  });
  const phases = [
    ["queue", "received", "preparing"],
    ["prepare+drain", "preparing", "activating"],
    ["activation-to-healthy", "activating", "healthy"],
    ["rollback", "failed", "rolled_back"],
  ] as const;
  const timings = phases.map(([label, from, to]) => {
    const index = attempt.findIndex((event) => event.status === from);
    const began = attempt[index];
    const ended = attempt[index + 1];
    const known =
      ordered &&
      began &&
      ended?.status === to &&
      (to !== "rolled_back" ||
        (began.reason === "health_failed" && ended.reason === "health_failed"));
    return `${label}: ${known ? `${ended.at - began.at} ms` : "unknown"}`;
  });
  return `Phase latency for ${revision ?? "unknown revision"} (latest visible attempt, wall-clock intervals): ${timings.join("; ")}. Unknown means missing, incomplete, interrupted or out-of-order evidence, not zero or success. Separate build/drain timings are unavailable; durations do not establish current health.`;
}

/** No controller mutations: main is already watched under installed policy.
 * The conversation journal records this bounded inspection receipt. */
export function createReleaseTool(options: {
  read: () => Promise<DeploymentFeed>;
  runningRevision: string | undefined;
}) {
  return async (
    request: NonNullable<CompanionReply["release"]>,
  ): Promise<string> => {
    const observedAt = new Date().toISOString();
    const running =
      options.runningRevision ?? "unknown (no immutable release identity)";
    const lines = [
      `Deployment inspection: ${request.revision ?? "recent controller events"}.`,
      `Running revision: ${running} (loaded process identity, observed ${observedAt}; not a fresh independent controller health attestation).`,
      "Policy: independent controller follows trusted lordbagel42/agent main. This tool cannot push, approve, deploy, retry, reconcile, or change policy.",
      "Controller installation is separate: pushing app main does not install controller changes. App revisions, candidate events, and lastHealthyRevision do not identify the installed controller.",
    ];
    if (request.revision)
      lines.push(
        `Exact revision matches running process: ${options.runningRevision ? (request.revision === options.runningRevision ? "yes" : "no") : "unknown"}. This compares exact identities, not commit ancestry or current health.`,
      );
    const feed = await options.read().catch(() => undefined);
    lines.push(
      `Installed controller revision: ${feed?.controllerRevision ?? "unknown (no verified installation provenance available)"}. This is the controller's last published startup installation observation, not a fresh liveness or current installed-files check.`,
    );
    if (!feed)
      return [
        ...lines,
        "Controller feed unavailable. Progress, phase latency, checks, blockers, staging recovery, and historical healthy observations are unknown; no deployment action was taken.",
      ].join("\n\n");
    const bounded = feed.events.slice(-100);
    const events = request.revision
      ? bounded.filter((event) => event.revision === request.revision)
      : bounded;
    // Fetch failures describe controller observation, not candidate lifecycle.
    // Match the controller's Store.status lookup.
    const latest = events.findLast((event) => event.status !== "fetch_failed");
    if (request.revision) {
      const healthy = events.findLast(
        (event) => event.status === "healthy" || event.status === "reconciled",
      );
      lines.push(
        healthy
          ? `Controller verified this revision healthy at ${new Date(healthy.at).toISOString()} (event ${healthy.sequence}, ${healthy.status}). Historical evidence that it was live then, not proof it is running or healthy now.`
          : "No healthy/reconciled observation for this revision in the bounded feed; whether it previously became live is unknown, not disproven.",
      );
    }
    const blocker = bounded.findLast((event) => event.status === "blocked");
    lines.push(
      `Controller blocked: ${feed.blocked ? "yes" : "no (as last published; not a liveness guarantee)"}.${feed.blocked ? ` ${blocker?.reason ? `${blocker.reason}: ${reasons[blocker.reason]}` : "Reason is outside the bounded feed; operator inspection required."}` : ""}`,
      `Historical last healthy revision: ${feed.lastHealthyRevision} (not proof of the current deployment).`,
      feed.lastStageRecovery
        ? `Staging recovery: controller recorded removal of ${feed.lastStageRecovery.removed} abandoned stage(s) at ${new Date(feed.lastStageRecovery.at).toISOString()}. Global historical receipt, not associated with any revision or activation. Remaining stages and later cleanup are unknown; this is not proof all stages are clean.`
        : "Staging recovery: unknown (no confirmed-removal receipt in this feed). Superseded status does not prove cleanup; missing evidence is not failure or proof that stages remain.",
      latest
        ? `Last recorded candidate status: ${latest.status} at ${new Date(latest.at).toISOString()}.`
        : "Candidate lifecycle status unknown in the last 100 controller events. Not known queued, checked, or authorized; owner must verify the exact revision was published to trusted main. Old evidence may have aged out; fetch failures are controller observations only.",
      phaseLatency(events, request.revision ?? latest?.revision),
      "Superseded means skipped before activation in that attempt, not a deployment failure or proof of the active release or stage cleanup.",
      "Checks: controller runs frozen install, formatting, types, routing/delivery tests, immutable artifact verification, drain, and readiness/process identity gates. This feed exposes stage outcomes only, not individual check logs; missing results are unknown, never passed.",
      ...events
        .slice(-3)
        .map(
          (event) =>
            `${event.sequence}: ${event.revision} — ${event.status} at ${new Date(event.at).toISOString()}${event.reason ? `; ${event.reason}: ${reasons[event.reason]}` : ""}`,
        ),
    );
    return lines.join("\n\n");
  };
}

/** The principal comes from host authentication, never a model/request field.
 * Call only for the verified owner, including channels; these are facts, not commands. */
export function createDeploymentReader(options: {
  file: string;
  ownerId: string;
  trustedUid?: number;
}) {
  return async (principal: string, after = 0): Promise<DeploymentFeed> => {
    if (principal !== options.ownerId) throw new Error("deployment_denied");
    if (!Number.isSafeInteger(after) || after < 0)
      throw new Error("invalid_cursor");
    try {
      if ((await realpath(options.file)) !== options.file) throw new Error();
      const file = await open(
        options.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.uid !== (options.trustedUid ?? 0) ||
          stat.nlink !== 1 ||
          (stat.mode & 0o027) !== 0 ||
          stat.size > 65_536
        )
          throw new Error();
        const feed = feedSchema.parse(JSON.parse(await file.readFile("utf8")));
        if (
          feed.events.some(
            (event, index) =>
              index > 0 &&
              event.sequence <= (feed.events[index - 1]?.sequence ?? 0),
          )
        )
          throw new Error();
        return {
          ...feed,
          events: feed.events.filter((event) => event.sequence > after),
        };
      } finally {
        await file.close();
      }
    } catch {
      throw new Error("deployment_feed_unavailable");
    }
  };
}

/** Mount privately, e.g. /operator/deployment. Deliberately no mutations. */
export function createDeploymentRoutes(options: {
  read: ReturnType<typeof createDeploymentReader>;
  authenticate(request: Request): Promise<string | undefined>;
}) {
  const app = new Hono();
  app.get("/events", async (c) => {
    c.header("Cache-Control", "no-store, private");
    const principal = await options.authenticate(c.req.raw);
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    const raw = c.req.query("after") ?? "0";
    if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      return c.json({ error: "invalid_cursor" }, 400);
    try {
      return c.json(await options.read(principal, Number(raw)));
    } catch {
      return c.json({ error: "deployment_feed_unavailable" }, 503);
    }
  });
  return app;
}
