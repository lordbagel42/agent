import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { SlackIngressDiagnostics } from "../channels/slack-ingress.js";
import type {
  Channel,
  ChannelAdapter,
  ChannelEvent,
  Owner,
} from "../core/contracts.js";
import { routeEvent, type Scope } from "../core/routing.js";

export interface HttpDependencies {
  channels: Partial<Record<Channel, ChannelAdapter>>;
  owner: Owner;
  operatorToken: string;
  slackIngressDiagnostics?: SlackIngressDiagnostics;
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
  const app = new Hono<{ Variables: { slackRequest?: Request } }>();
  app.onError((_error, c) => c.json({ error: "request_failed" }, 500));
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
    const ready = await deps.ready().catch(() => false);
    return c.json({ name: "June", ready }, ready ? 200 : 503);
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
            diagnostics?.record(c.req.raw, "submission_started");
            await deps.submit(scope, event);
            diagnostics?.record(c.req.raw, "submission_succeeded");
          }
        } catch {
          diagnostics?.record(c.req.raw, "submission_failed");
          return c.json({ error: "storage_unavailable" }, 503);
        }
        return response;
      },
    );
  }
  const expected = Buffer.from(`Bearer ${deps.operatorToken}`);
  app.use("/operator/*", async (c, next) => {
    c.header("cache-control", "no-store");
    const supplied = Buffer.from(c.req.header("authorization") ?? "");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
  app.get("/operator/conversation", async () =>
    Response.json(await deps.inspectConversation()),
  );
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
