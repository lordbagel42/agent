import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";

const revision = z.string().regex(/^[0-9a-f]{40}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const feedSchema = z.strictObject({
  version: z.literal(1),
  repository: z.literal("lordbagel42/agent"),
  branch: z.literal("main"),
  lastHealthyRevision: revision,
  blocked: z.boolean(),
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

/** The principal comes from host authentication, never a model/request field.
 * Call for the private owner conversation only; these are facts, not commands. */
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
