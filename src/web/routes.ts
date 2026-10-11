import { Effect, type Layer, Schema } from "effect";
import {
  type PrivateRouteSecurity,
  privateRoutes,
} from "../console/security.js";
import type { JuneRuntime } from "../effect/runtime.js";
import { buildWebAssets, type WebAssets } from "./build.js";
import { transcriptQuery, WebConversations, WebReadError } from "./slack.js";

export interface WebDependencies {
  runtime: JuneRuntime;
  conversations?: Layer.Layer<WebConversations>;
}

export function createWebRoutes(
  security: PrivateRouteSecurity,
  deps: WebDependencies,
) {
  const app = privateRoutes(security);
  let assets: Promise<WebAssets> | undefined;
  let busy = false;
  app.use("*", async (c, next) => {
    if (
      c.req.header("sec-fetch-site") === "cross-site" ||
      (c.req.header("origin") && c.req.header("origin") !== security.origin)
    )
      return c.json({ error: "access_denied" }, 403);
    await next();
  });
  app.get("/api/status", (c) =>
    c.json({
      available: !!deps.conversations,
      mode: "owner-read-only",
      reason: deps.conversations ? null : "slack_not_configured",
    }),
  );
  app.get("/api/:kind{conversations|transcript}", async (c) => {
    if (!deps.conversations)
      return c.json({ error: "slack_not_configured" }, 503);
    if (busy) {
      c.header("Retry-After", "2");
      return c.json({ error: "busy", retryAfter: 2 }, 429);
    }
    busy = true;
    try {
      const program = Effect.gen(function* () {
        const service = yield* WebConversations;
        if (c.req.param("kind") === "transcript") {
          const query = yield* Schema.decodeUnknownEffect(transcriptQuery)({
            channel: c.req.query("channel"),
            thread: c.req.query("thread") ?? null,
            cursor: c.req.query("cursor") ?? null,
          }).pipe(
            Effect.mapError(
              () => new WebReadError({ code: "invalid_request" }),
            ),
          );
          return yield* service.read(query);
        }
        const raw = c.req.query("before");
        const before = raw === undefined ? null : Number(raw);
        if (before !== null && (!Number.isSafeInteger(before) || before <= 0))
          return yield* new WebReadError({ code: "invalid_request" });
        return yield* service.list(before);
      }).pipe(
        Effect.provide(deps.conversations),
        Effect.map((data) => ({ ok: true as const, data })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );
      const result = await deps.runtime
        .runPromise(program, {
          signal: AbortSignal.any([
            c.req.raw.signal,
            AbortSignal.timeout(30_000),
          ]),
        })
        .catch(() => ({
          ok: false as const,
          error: new WebReadError({ code: "unavailable" }),
        }));
      // A session can expire while Slack is responding. Never return its data.
      if (!(await security.authenticate(c.req.raw)))
        return c.json({ error: "session_expired" }, 401);
      if (result.ok) return c.json(result.data);
      if (result.error.retryAfter)
        c.header("Retry-After", String(result.error.retryAfter));
      return c.json(
        { error: result.error.code, retryAfter: result.error.retryAfter },
        result.error.code === "access_denied"
          ? 403
          : result.error.code === "invalid_request"
            ? 400
            : result.error.code === "rate_limited"
              ? 429
              : 503,
      );
    } finally {
      busy = false;
    }
  });
  app.get("*", async (c) => {
    // Memoize one build, including failure. A failed release does not repeatedly
    // compile on refresh; it returns an honest unavailable state until restart.
    assets ??= deps.runtime.runPromise(buildWebAssets());
    const built = await assets.catch(() => undefined);
    if (!(await security.authenticate(c.req.raw)))
      return c.json({ error: "session_expired" }, 401);
    if (!built)
      return c.text(
        "June web could not be built. The Slack conversation is unchanged; use Slack and ask June to inspect this release.",
        503,
      );
    c.header("Content-Security-Policy", built.policy);
    if (c.req.path === "/app" || c.req.path === "/app/")
      return c.html(built.html);
    // Exact generated allowlist, not a user-controlled filesystem path.
    const file = built.files.get(c.req.path);
    if (!file) return c.notFound();
    c.header("Content-Type", file.type);
    return c.body(new Uint8Array(file.body));
  });
  return app;
}
