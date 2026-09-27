import { randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { SlackIngressDiagnostics } from "../channels/slack-ingress.js";
import {
  type ConnectionDependencies,
  createConnectionRoutes,
} from "../console/connections.js";
import {
  type ConsoleDependencies,
  type ConsoleSnapshot,
  createConsoleRoutes,
} from "../console/routes.js";
import { createConsoleSessionBridge } from "../console/session.js";
import { messagePage } from "../console/view.js";
import type {
  Channel,
  ChannelAdapter,
  ChannelEvent,
  Owner,
} from "../core/contracts.js";
import { routeEvent, type Scope } from "../core/routing.js";
import {
  type createDeploymentReader,
  createDeploymentRoutes,
} from "../deployment/feed.js";
import type { LatencyDiagnostics } from "../runtime/latency.js";
import type { Lifecycle } from "../runtime/lifecycle.js";

export interface HttpDependencies {
  channels: Partial<Record<Channel, ChannelAdapter>>;
  owner: Owner;
  operatorToken: string;
  revision?: string;
  lifecycle?: Lifecycle;
  deployment?: {
    token: string;
    supported: boolean;
    read?: ReturnType<typeof createDeploymentReader>;
  };
  slackIngressDiagnostics?: SlackIngressDiagnostics;
  latency?: LatencyDiagnostics;
  console?: {
    origin: string;
    inspect(): Promise<ConsoleSnapshot>;
    usage?: ConsoleDependencies["usage"];
    connections?: ConnectionDependencies;
  };
  submit(scope: Scope, event: ChannelEvent): Promise<void>;
  ready(): Promise<boolean>;
  inspectConversation(): Promise<unknown>;
  inspectJob(id: string): Promise<unknown | undefined>;
  resumeJob(id: string, commandId: string): Promise<boolean>;
  cancelJob?(id: string): Promise<boolean>;
}

export function createHttpApp(deps: HttpDependencies) {
  if (deps.operatorToken.length < 32)
    throw new Error("Operator token must contain at least 32 characters");
  if (
    deps.deployment &&
    (!deps.lifecycle ||
      !deps.revision ||
      deps.deployment.token.length < 32 ||
      deps.deployment.token === deps.operatorToken)
  )
    throw new Error("Deployment requires a distinct credential and release");
  const app = new Hono<{
    Variables: {
      slackRequest?: Request;
      arrival: { at: number; monotonic: number };
    };
  }>();
  app.onError((_error, c) => c.json({ error: "request_failed" }, 500));
  app.use("/webhooks/*", async (c, next) => {
    c.set("arrival", { at: Date.now(), monotonic: performance.now() });
    await next();
  });
  // Include operator writers, imports and actor-backed console reads. Only
  // health and the separately authenticated drain/resume endpoint bypass this.
  app.use("*", async (c, next) => {
    if (
      !deps.lifecycle ||
      c.req.path === "/health" ||
      c.req.path === "/operator/deployment/drain"
    )
      return next();
    const release = deps.lifecycle.tryEnter();
    if (!release) {
      c.header("Retry-After", "5");
      return c.json({ error: "admission_paused" }, 503);
    }
    try {
      await next();
    } finally {
      release();
    }
  });
  if (deps.deployment && deps.lifecycle) {
    const deployment = deps.deployment;
    const lifecycle = deps.lifecycle;
    const credential = Buffer.from(`Bearer ${deployment.token}`);
    app.on(["POST", "DELETE"], "/operator/deployment/drain", async (c) => {
      c.header("Cache-Control", "no-store");
      const supplied = Buffer.from(c.req.header("authorization") ?? "");
      if (
        supplied.length !== credential.length ||
        !timingSafeEqual(supplied, credential)
      )
        return c.json({ error: "unauthorized" }, 401);
      if (c.req.method === "DELETE") {
        lifecycle.resume();
        return c.json({ revision: deps.revision, drained: false });
      }
      if (!deployment.supported)
        return c.json({ error: "drain_unsupported_configuration" }, 409);
      const drained = await lifecycle.drain();
      return c.json({ revision: deps.revision, drained }, drained ? 200 : 409);
    });
  }
  const expected = Buffer.from(`Bearer ${deps.operatorToken}`);
  const authenticate = async (request: Request) => {
    const supplied = Buffer.from(request.headers.get("authorization") ?? "");
    return supplied.length === expected.length &&
      timingSafeEqual(supplied, expected)
      ? deps.owner.id
      : undefined;
  };
  if (deps.console) {
    const security = {
      origin: deps.console.origin,
      csrfSecret: randomBytes(32).toString("base64url"),
      authenticate,
    };
    const sessions = createConsoleSessionBridge(security, "/console");
    let windowStart = 0;
    let loginAttempts = 0;
    app.use("/console/session/login", async (c, next) => {
      if (c.req.method === "POST") {
        if (Date.now() - windowStart >= 60_000) {
          windowStart = Date.now();
          loginAttempts = 0;
        }
        if (++loginAttempts > 10) {
          const nonce = randomBytes(18).toString("base64url");
          c.header("Cache-Control", "no-store, private");
          c.header("Referrer-Policy", "no-referrer");
          c.header("X-Content-Type-Options", "nosniff");
          c.header("X-Frame-Options", "DENY");
          c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
          c.header(
            "Content-Security-Policy",
            `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
          );
          c.header("Retry-After", "60");
          return c.html(
            messagePage(
              nonce,
              "Too many sign-in attempts",
              "Wait one minute, then return to the private sign-in page. No new session was created.",
              429,
            ),
            429,
          );
        }
      }
      await next();
    });
    // Session routes must precede console authentication. Cookies authorize only
    // this read-only surface, never the Bearer-only operator mutation endpoints.
    app.route("/console/session", sessions.routes);
    if (deps.console.connections)
      app.route(
        "/console/connections",
        createConnectionRoutes(
          { ...security, authenticate: sessions.authenticate },
          deps.console.connections,
        ),
      );
    app.route(
      "/console",
      createConsoleRoutes({
        security: { ...security, authenticate: sessions.authenticate },
        inspect: deps.console.inspect,
        usage: deps.console.usage,
        connectionsAvailable: !!deps.console.connections,
        // No action inspection/confirmation callbacks until domain guarantees exist.
      }),
    );
  }
  app.use("/webhooks/slack", async (c, next) => {
    if (c.req.method === "POST" && deps.slackIngressDiagnostics) {
      c.set("slackRequest", c.req.raw);
      deps.slackIngressDiagnostics.record(c.req.raw, "arrival");
    }
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 1_048_576,
      onError: (c) => {
        const original = c.get("slackRequest");
        if (original)
          deps.slackIngressDiagnostics?.record(original, "body_too_large");
        return c.json({ error: "body_too_large" }, 413);
      },
    }),
  );
  app.get("/health", async (c) => {
    const ready =
      (deps.lifecycle?.ready ?? true) &&
      (await deps.ready().catch(() => false));
    return c.json(
      {
        name: "June",
        ready,
        ...(deps.revision ? { revision: deps.revision } : {}),
      },
      ready ? 200 : 503,
    );
  });
  for (const [channel, adapter] of Object.entries(deps.channels)) {
    app.on(
      channel === "whatsapp" ? ["GET", "POST"] : ["POST"],
      `/webhooks/${channel}`,
      async (c) => {
        const diagnostics =
          channel === "slack" ? deps.slackIngressDiagnostics : undefined;
        const original = c.get("slackRequest");
        // Hono replaces raw for a lengthless body. Preserve correlation across
        // that replacement without retaining any body, headers or platform IDs.
        if (diagnostics && original) diagnostics.associate(original, c.req.raw);
        const { response, events } = await adapter.receive(c.req.raw);
        if (!response.ok) return response;
        try {
          for (const event of events) {
            const scope = routeEvent(event, deps.owner);
            diagnostics?.record(
              c.req.raw,
              scope ? "owner_accepted" : "owner_filtered",
            );
            if (!scope) continue;
            if (event.type === "message") {
              deps.latency?.begin(event, c.get("arrival"));
              deps.latency?.mark(event, "submission_started");
            }
            diagnostics?.record(c.req.raw, "submission_started");
            await deps.submit(scope, event);
            diagnostics?.record(c.req.raw, "submission_succeeded");
            if (event.type === "message")
              deps.latency?.mark(event, "submitted");
          }
        } catch {
          diagnostics?.record(c.req.raw, "submission_failed");
          for (const event of events)
            if (event.type === "message")
              deps.latency?.mark(event, "submission_failed");
          return c.json({ error: "storage_unavailable" }, 503);
        }
        for (const event of events)
          if (event.type === "message") deps.latency?.mark(event, "http_ack");
        return response;
      },
    );
  }
  app.use("/operator/*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (!(await authenticate(c.req.raw))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
  if (deps.deployment?.read) {
    app.route(
      "/operator/deployment",
      createDeploymentRoutes({ read: deps.deployment.read, authenticate }),
    );
  }
  app.get("/operator/conversation", async () =>
    Response.json(await deps.inspectConversation()),
  );
  if (deps.latency) {
    const latency = deps.latency;
    app.get("/operator/latency", (c) =>
      c.json({ revision: deps.revision, ...latency.snapshot() }),
    );
  }
  if (deps.slackIngressDiagnostics) {
    const diagnostics = deps.slackIngressDiagnostics;
    app.get("/operator/ingress/slack", (c) => c.json(diagnostics.snapshot()));
  }
  app.get("/operator/jobs/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]{64}$/.test(id))
      return c.json({ error: "invalid_job_id" }, 400);
    const job = await deps.inspectJob(id);
    return job === undefined
      ? c.json({ error: "not_found" }, 404)
      : Response.json(job);
  });
  app.post("/operator/jobs/:id/resume", async (c) => {
    const id = c.req.param("id");
    const input = await c.req.json().catch(() => null);
    if (
      !/^[a-f0-9]{64}$/.test(id) ||
      !z.strictObject({ confirmedStopped: z.literal(true) }).safeParse(input)
        .success
    ) {
      return c.json({ error: "confirm_previous_worker_stopped" }, 400);
    }
    const commandId = z.uuid().safeParse(c.req.header("idempotency-key"));
    if (!commandId.success)
      return c.json({ error: "uuid_idempotency_key_required" }, 400);
    return (await deps.resumeJob(id, commandId.data))
      ? c.json({ queued: true }, 202)
      : c.json({ error: "job_not_resumable" }, 409);
  });
  if (deps.cancelJob) {
    const cancel = deps.cancelJob;
    app.post("/operator/jobs/:id/cancel", async (c) => {
      const id = c.req.param("id");
      if (!/^[a-f0-9]{64}$/.test(id))
        return c.json({ error: "invalid_job_id" }, 400);
      return (await cancel(id))
        ? c.json({ cancellationRequested: true }, 202)
        : c.json({ error: "not_found" }, 404);
    });
  }
  return app;
}
