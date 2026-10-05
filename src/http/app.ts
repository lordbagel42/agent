import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SpanStatusCode } from "@opentelemetry/api";
import { type Handler, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { BrowserCompanion } from "../browser/companion.js";
import { createBrowserLiveView } from "../browser/live-view.js";
import type { SlackIngressDiagnostics } from "../channels/slack-ingress.js";
import type { WorktreeDiffSummary } from "../coding/worktree.js";
import {
  type ConnectionDependencies,
  createConnectionRoutes,
} from "../console/connections.js";
import {
  type ConsoleDependencies,
  type ConsoleSnapshot,
  createConsoleRoutes,
} from "../console/routes.js";
import { contentSecurityPolicy } from "../console/security.js";
import {
  createConsoleLoginLinks,
  createConsoleSessionBridge,
} from "../console/session.js";
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
import { OpaqueActionLinks } from "../links/opaque.js";
import { createActionLinkRoutes } from "../links/routes.js";
import { debugShareResolutionSchema } from "../runtime/debug-dispatch.js";
import type { LatencyDiagnostics } from "../runtime/latency.js";
import type { Lifecycle } from "../runtime/lifecycle.js";
import { sessionCommand } from "../runtime/session-controls.js";
import {
  type Telemetry,
  telemetryQuerySchema,
  withSpan,
} from "../telemetry/index.js";
import type { CapabilityBroker } from "../tools/broker.js";
import { createCapabilityRoutes } from "../tools/routes.js";
import {
  createGitHubWebhooks,
  type GitHubWebhooks,
} from "../wakeups/github.js";
import {
  createWakeupWebhooks,
  type WakeupWebhooks,
} from "../wakeups/webhooks.js";

export interface HttpDependencies {
  channels: Partial<Record<Channel, ChannelAdapter>>;
  owner: Owner;
  operatorToken: string;
  capabilities?: CapabilityBroker;
  browserCompanion?: BrowserCompanion;
  browserViewShutdown?: AbortSignal;
  revision?: string;
  lifecycle?: Lifecycle;
  deployment?: {
    token: string;
    intakeToken?: string;
    supported: boolean;
    read?: ReturnType<typeof createDeploymentReader>;
  };
  slackIngressDiagnostics?: SlackIngressDiagnostics;
  latency?: LatencyDiagnostics;
  telemetry?: Telemetry;
  sandboxes?: () => Promise<unknown>;
  wakeups?: WakeupWebhooks & { inspect(): Promise<unknown> };
  github?: GitHubWebhooks;
  console?: {
    origin: string;
    loginLinks?: ReturnType<typeof createConsoleLoginLinks>;
    inspect(): Promise<ConsoleSnapshot>;
    usage?: ConsoleDependencies["usage"];
    connections?: ConnectionDependencies;
  };
  submit(scope: Scope, event: ChannelEvent, receivedAt?: number): Promise<void>;
  ready(): Promise<boolean>;
  inspectConversation(): Promise<unknown>;
  inspectJob(id: string): Promise<unknown | undefined>;
  inspectJobDiff?(id: string): Promise<WorktreeDiffSummary | null>;
  resumeJob(id: string, commandId: string): Promise<boolean>;
  cancelJob?(id: string): Promise<boolean>;
  resolveDebugShare?(id: string): Promise<boolean>;
}

type HttpEnvironment = {
  Variables: {
    slackRequest?: Request;
    intake?: { receivedAt: number };
    arrival: { at: number; monotonic: number };
  };
};

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
  if (
    deps.deployment?.intakeToken !== undefined &&
    (deps.deployment.intakeToken.length < 32 ||
      deps.deployment.intakeToken === deps.deployment.token ||
      deps.deployment.intakeToken === deps.operatorToken)
  )
    throw new Error("Intake requires a separate credential");
  if (
    Object.values(deps.wakeups?.sources ?? {}).some(
      (key) => key === deps.operatorToken || key === deps.deployment?.token,
    )
  )
    throw new Error("Event webhooks require separate signing credentials");
  if (
    deps.github &&
    [
      deps.operatorToken,
      deps.deployment?.token,
      ...Object.values(deps.wakeups?.sources ?? {}),
    ].includes(deps.github.secret)
  )
    throw new Error("GitHub requires a separate signing credential");
  const app = new Hono<HttpEnvironment>();
  app.onError((_error, c) => c.json({ error: "request_failed" }, 500));
  app.use("*", (c, next) =>
    withSpan(
      "june.http.request",
      {
        "http.request.method": c.req.method,
      },
      async (span) => {
        await next();
        // The matched host-owned template, never a request path, query or header.
        span.setAttribute("http.route", c.req.routePath || "unmatched");
        span.setAttribute("http.response.status_code", c.res.status);
        if (c.res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      },
    ),
  );
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
      // Capture before fencing: after drain succeeds no turn remains active.
      // The independent responder sends these notices, never the drained app.
      const conversations = lifecycle.conversations;
      const targets = new Map<
        string,
        { accountId: string; channel: string; thread_ts?: string }
      >();
      for (const identity of deps.owner.identities) {
        if (identity.channel !== "slack") continue;
        // Reuse the active unthreaded owner DM when known, avoiding a second
        // notice addressed to the same DM via its user ID.
        const dm = conversations.find(
          (entry) =>
            entry.direct &&
            entry.senderId === identity.senderId &&
            entry.address.channel === "slack" &&
            entry.address.accountId === identity.accountId &&
            !entry.address.threadId,
        );
        const target = {
          accountId: identity.accountId,
          channel: dm?.address.conversationId ?? identity.senderId,
        };
        targets.set(JSON.stringify(target), target);
      }
      for (const { address } of conversations) {
        if (address.channel !== "slack") continue;
        const target = {
          accountId: address.accountId,
          channel: address.conversationId,
          ...(address.threadId ? { thread_ts: address.threadId } : {}),
        };
        targets.set(JSON.stringify(target), target);
      }
      const drained = await lifecycle.drain();
      return c.json(
        {
          revision: deps.revision,
          drained,
          ...(drained && c.req.query("swapNotice") === "1"
            ? { swapTargets: [...targets.values()].slice(0, 100) }
            : {}),
        },
        drained ? 200 : 409,
      );
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
  if (deps.sandboxes) {
    const read = deps.sandboxes;
    // A one-purpose credential; possession never authorizes /operator routes.
    const snapshotToken = Buffer.from(
      `Bearer ${createHmac("sha256", deps.operatorToken).update("june:sandboxes:read:v1").digest("base64url")}`,
    );
    app.get("/sandboxes/snapshot", async (c) => {
      c.header("cache-control", "no-store");
      const supplied = Buffer.from(c.req.header("authorization") ?? "");
      if (
        supplied.length !== snapshotToken.length ||
        !timingSafeEqual(supplied, snapshotToken)
      )
        return c.json({ error: "unauthorized" }, 401);
      return c.json(await read());
    });
  }
  const loginLinks = deps.console
    ? (deps.console.loginLinks ?? createConsoleLoginLinks(deps.console.origin))
    : undefined;
  const actionLinks =
    deps.console && deps.capabilities
      ? new OpaqueActionLinks(deps.capabilities)
      : undefined;
  if (deps.console) {
    const security = {
      origin: deps.console.origin,
      csrfSecret: randomBytes(32).toString("base64url"),
      signInPath: "/console/session/login",
      signOutPath: "/console/session/logout",
      authenticate,
    };
    const sessions = createConsoleSessionBridge(
      security,
      "/console",
      loginLinks ? { links: loginLinks, token: deps.operatorToken } : undefined,
    );
    app.get("/:id{[A-Za-z0-9_-]{24}}", (c) => {
      c.header("Cache-Control", "no-store, private");
      c.header("Referrer-Policy", "no-referrer");
      c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
      return c.redirect(`/console/session/link/${c.req.param("id")}`, 303);
    });
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
          c.header("Content-Security-Policy", contentSecurityPolicy(nonce));
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
    // Session routes must precede console authentication. Cookies never authorize
    // Bearer-only operator endpoints; action forms additionally require a proof.
    app.route("/console/session", sessions.routes);
    if (deps.browserCompanion)
      app.route(
        "/console/browser",
        createBrowserLiveView(
          { ...security, authenticate: sessions.authenticate },
          deps.browserCompanion,
          deps.browserViewShutdown,
        ),
      );
    if (actionLinks)
      app.route(
        "/console/action-links",
        createActionLinkRoutes({
          security: { ...security, authenticate: sessions.authenticate },
          console: {
            path: "/console",
            connectionsAvailable: !!deps.console.connections,
          },
          links: actionLinks,
          resolveAction: async (principal, grantId, token) =>
            actionLinks.resolveAction(principal, grantId, token),
        }),
      );
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
        connections: deps.console.connections?.store,
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
  // GitHub has its own bounded raw-body limit. Keep it behind lifecycle
  // admission but ahead of the smaller generic request limit.
  if (deps.github)
    app.route("/webhooks/github", createGitHubWebhooks(deps.github));
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
        ...(deps.lifecycle?.failure ? { failure: deps.lifecycle.failure } : {}),
      },
      ready ? 200 : 503,
    );
  });
  if (deps.wakeups)
    app.route("/webhooks/events", createWakeupWebhooks(deps.wakeups));
  for (const [channel, adapter] of Object.entries(deps.channels)) {
    if (channel === "agent") continue;
    const receive: Handler<HttpEnvironment> = async (c) => {
      const diagnostics =
        channel === "slack" ? deps.slackIngressDiagnostics : undefined;
      const original = c.get("slackRequest");
      // Hono replaces raw for a lengthless body. Preserve correlation across
      // that replacement without retaining any body, headers or platform IDs.
      if (diagnostics && original) diagnostics.associate(original, c.req.raw);
      const intake = c.get("intake");
      const { response, events } = await adapter.receive(c.req.raw, intake);
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
          if (intake) await deps.submit(scope, event, intake.receivedAt);
          else if (
            event.type === "message" &&
            sessionCommand(event)?.kind === "ping"
          )
            await deps.submit(scope, event, c.get("arrival").at);
          else await deps.submit(scope, event);
          diagnostics?.record(c.req.raw, "submission_succeeded");
          if (event.type === "message") deps.latency?.mark(event, "submitted");
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
    };
    app.on(
      channel === "whatsapp" ? ["GET", "POST"] : ["POST"],
      `/webhooks/${channel}`,
      receive,
    );
    if (channel === "slack" && deps.deployment?.intakeToken) {
      const credential = Buffer.from(deps.deployment.intakeToken);
      // Private replay is behind lifecycle/body limits but before operator auth.
      // The shared adapter still requires a fresh Slack HMAC. This header never
      // authenticates the public webhook or bypasses its timestamp validation.
      app.post("/operator/deployment/slack", async (c, next) => {
        c.header("Cache-Control", "no-store");
        const supplied = Buffer.from(c.req.header("x-june-intake-token") ?? "");
        if (
          supplied.length !== credential.length ||
          !timingSafeEqual(supplied, credential)
        )
          return c.json({ error: "unauthorized" }, 401);
        if (c.req.header("x-june-revision") !== deps.revision)
          return c.json({ error: "revision_mismatch" }, 409);
        const received = c.req.header("x-june-received-at") ?? "";
        const at = Number(received);
        if (
          !/^\d+$/.test(received) ||
          !Number.isSafeInteger(at) ||
          at > Date.now() + 60_000
        )
          return c.json({ error: "invalid_received_at" }, 400);
        c.set("intake", { receivedAt: at });
        c.set("arrival", { at, monotonic: performance.now() });
        c.set("slackRequest", c.req.raw);
        deps.slackIngressDiagnostics?.record(c.req.raw, "arrival");
        return receive(c, next);
      });
    }
  }
  app.use("/operator/*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (!(await authenticate(c.req.raw))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
  if (deps.browserCompanion) {
    const browser = deps.browserCompanion;
    app.post("/operator/browser/:id/reconcile", async (c) => {
      const id = z.uuid().safeParse(c.req.param("id"));
      const body = z
        .strictObject({ confirmedStopped: z.literal(true) })
        .safeParse(await c.req.json().catch(() => null));
      if (!id.success || !body.success)
        return c.json({ error: "confirm_browser_and_codex_stopped" }, 400);
      return (await browser.reconcile(id.data, true))
        ? c.json({ reconciled: true, replayed: false })
        : c.json({ error: "browser_not_reconcilable" }, 409);
    });
  }
  if (deps.capabilities) {
    app.route(
      "/operator/capabilities",
      createCapabilityRoutes({
        broker: deps.capabilities,
        owner: deps.owner.id,
        operatorToken: deps.operatorToken,
        consoleOrigin: deps.console?.origin,
        actionLinks,
      }),
    );
  }
  if (loginLinks) {
    app.post("/operator/console/login-links", (c) => {
      const link = loginLinks.issue();
      return link
        ? c.json(link, 201)
        : c.json({ error: "login_link_capacity" }, 429);
    });
  }
  if (deps.deployment?.read) {
    app.route(
      "/operator/deployment",
      createDeploymentRoutes({ read: deps.deployment.read, authenticate }),
    );
  }
  app.get("/operator/conversation", async () =>
    Response.json(await deps.inspectConversation()),
  );
  if (deps.telemetry) {
    const telemetry = deps.telemetry;
    app.post(
      "/operator/telemetry/query",
      bodyLimit({ maxSize: 8192 }),
      async (c) => {
        const query = telemetryQuerySchema.safeParse(
          await c.req.json().catch(() => null),
        );
        if (!query.success)
          return c.json({ error: "invalid_telemetry_query" }, 400);
        return c.json(telemetry.query(query.data));
      },
    );
  }
  if (deps.wakeups) {
    const wakeups = deps.wakeups;
    app.get("/operator/wakeups", async (c) => c.json(await wakeups.inspect()));
  }
  if (deps.latency) {
    const latency = deps.latency;
    app.get("/operator/latency", (c) =>
      c.json({ revision: deps.revision, ...latency.snapshot() }),
    );
    app.get("/operator/logs", (c) => {
      try {
        return c.json(latency.logs());
      } catch {
        return c.json({ error: "diagnostic_logs_unavailable" }, 503);
      }
    });
  }
  if (deps.slackIngressDiagnostics) {
    const diagnostics = deps.slackIngressDiagnostics;
    app.get("/operator/ingress/slack", (c) => c.json(diagnostics.snapshot()));
  }
  if (deps.resolveDebugShare) {
    const resolve = deps.resolveDebugShare;
    app.post("/operator/debug-shares/resolve", async (c) => {
      const input = debugShareResolutionSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!input.success)
        return c.json({ error: "explicit_resolution_required" }, 400);
      return (await resolve(input.data.id))
        ? c.json({ id: input.data.id, resolved: true })
        : c.json({ error: "debugshare_not_found" }, 404);
    });
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
  if (deps.inspectJobDiff) {
    const inspect = deps.inspectJobDiff;
    app.get("/operator/jobs/:id/diff", async (c) => {
      const id = c.req.param("id");
      if (!/^[a-f0-9]{64}$/.test(id) || c.req.url.includes("?"))
        return c.json({ error: "job_id_only" }, 400);
      const summary = await inspect(id);
      return summary
        ? c.json(summary)
        : c.json({ error: "diff_unavailable" }, 409);
    });
  }
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
