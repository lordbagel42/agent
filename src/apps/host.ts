import { createHash, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  type AppArtifact,
  appAccessSchema,
  appIdSchema,
  artifactDigest,
  artifactSchema,
  digestSchema,
  MAX_ARTIFACT_BYTES,
} from "./artifact.js";
import { type AppReceipt, appReceiptSchema } from "./client.js";
import {
  appViewerUrl,
  createAppsViewer,
  type ViewerConfig,
  viewerConfigSchema,
} from "./viewer.js";

/** A single dedicated host owns this database and its Rivet namespace/pool.
 * Generated apps must never share June's process, data directory or credentials.
 */
export function createAppsHost(options: {
  database: string;
  controlToken: string;
  viewerToken: string;
  origin: string;
  viewer?: ViewerConfig;
  /** Bind approvals to operator-managed engine, namespace, pool and serving origin. */
  binding: string;
  deploy(artifact: AppArtifact): Promise<{ release: string }>;
  serve(request: Request): Promise<Response>;
  /** Receives only bounded operational metadata, never source or credentials. */
  log?(event: Record<string, string | number>): void;
  ready?(): Promise<boolean>;
}) {
  if (
    options.controlToken.length < 32 ||
    options.viewerToken.length < 32 ||
    options.controlToken === options.viewerToken
  )
    throw new Error("separate_app_credentials_required");
  const viewerConfig = options.viewer
    ? viewerConfigSchema.parse(options.viewer)
    : undefined;
  const binding = viewerConfig
    ? createHash("sha256")
        .update(JSON.stringify([options.binding, viewerConfig]))
        .digest("hex")
    : options.binding;
  const db = new DatabaseSync(options.database);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS apps (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, binding TEXT NOT NULL, artifact TEXT NOT NULL, receipt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS app_publications (app_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL);
    UPDATE apps SET receipt=json_set(receipt, '$.status', 'unknown') WHERE json_extract(receipt, '$.status')='deploying';`);
  const app = new Hono();
  const running = new Set<Promise<void>>();
  const viewers = new Map<string, Set<Promise<Response>>>();
  let draining = false;
  const log = options.log ?? (() => {});
  const authorized = (request: Request, token: string) => {
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  };
  const get = (id: string) => {
    const row = db
      .prepare("SELECT receipt FROM apps WHERE id=? AND binding=?")
      .get(id, binding);
    return row ? appReceiptSchema.parse(JSON.parse(String(row.receipt))) : null;
  };
  const save = (receipt: AppReceipt) => {
    db.prepare("UPDATE apps SET receipt=? WHERE id=?").run(
      JSON.stringify(receipt),
      receipt.id,
    );
  };
  app.onError(() =>
    Response.json({ error: "apps_request_failed" }, { status: 400 }),
  );
  app.get("/health/live", (c) => c.json({ live: true }));
  app.get("/health/ready", async (c) => {
    const ready = !draining && (await options.ready?.()) !== false;
    return c.json({ ready }, ready ? 200 : 503);
  });
  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    // URLs, headers, bodies and raw errors may contain private source or keys.
    // Keep paths to three fixed categories, including for malformed requests.
    log({
      event: "request",
      route: c.req.path.startsWith("/control/")
        ? "control"
        : c.req.path.startsWith("/apps/")
          ? "viewer"
          : "other",
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  });
  app.use("/control/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!authorized(c.req.raw, options.controlToken))
      return c.json({ error: "unauthorized" }, 401);
    if (draining) return c.json({ error: "host_draining" }, 503);
    await next();
  });
  app.use("/control/*", bodyLimit({ maxSize: MAX_ARTIFACT_BYTES + 1024 }));
  app.post("/control/prepare", async (c) => {
    const { artifact, jobId, requestId, access } = z
      .strictObject({
        artifact: artifactSchema,
        jobId: digestSchema,
        requestId: digestSchema,
        access: appAccessSchema.optional(),
      })
      .parse(await c.req.json());
    if (access && !viewerConfig)
      return c.json({ error: "viewer_not_configured" }, 409);
    const digest = artifactDigest(artifact);
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          binding,
          jobId,
          digest,
          requestId,
          ...(access ? [access] : []),
        ]),
      )
      .digest("hex");
    const existing = get(id);
    if (existing) return c.json(existing);
    const receipt: AppReceipt = {
      id,
      appId: artifact.appId,
      jobId,
      digest,
      status: "prepared",
      expiresAt: Date.now() + 600_000,
      release: null,
      url:
        access && viewerConfig
          ? appViewerUrl(viewerConfig, artifact.appId, access)
          : `${options.origin}/apps/${artifact.appId}/`,
      ...(access ? { access } : {}),
    };
    db.prepare("INSERT INTO apps VALUES (?, ?, ?, ?, ?)").run(
      id,
      artifact.appId,
      binding,
      JSON.stringify(artifact),
      JSON.stringify(receipt),
    );
    log({ event: "prepared", receiptId: id, access: access ?? "internal" });
    return c.json(receipt);
  });
  app.get("/control/receipts/:id", (c) =>
    c.json(get(digestSchema.parse(c.req.param("id")))),
  );
  app.get("/control/apps/:appId", (c) => {
    const id = appIdSchema.parse(c.req.param("appId"));
    const row = db
      .prepare(
        "SELECT receipt FROM apps WHERE app_id=? AND binding=? ORDER BY json_extract(receipt, '$.status') IN ('deploying','unknown') DESC, rowid DESC LIMIT 1",
      )
      .get(id, binding);
    return c.json(
      row ? appReceiptSchema.parse(JSON.parse(String(row.receipt))) : null,
    );
  });
  app.post("/control/deploy/:id", (c) => {
    const receipt = get(digestSchema.parse(c.req.param("id")));
    if (!receipt) return c.json(null, 404);
    // Consuming approval and saving unknown intent happen synchronously before
    // any build/provisioning side effect; duplicate calls cannot launch again.
    if (receipt.status !== "prepared") return c.json(receipt);
    if (receipt.expiresAt <= Date.now())
      return c.json({ error: "approval_expired" }, 409);
    // One build at a time bounds the small pilot's subprocess/memory footprint.
    // A rejected request does not consume its prepared approval.
    if (running.size) return c.json({ error: "build_in_progress" }, 409);
    const uncertain = db
      .prepare(
        "SELECT 1 FROM apps WHERE app_id=? AND json_extract(receipt, '$.status') IN ('deploying','unknown') LIMIT 1",
      )
      .get(receipt.appId);
    if (uncertain) return c.json({ error: "app_requires_reconciliation" }, 409);
    const row = db
      .prepare("SELECT artifact FROM apps WHERE id=?")
      .get(receipt.id);
    const artifact = artifactSchema.parse(JSON.parse(String(row?.artifact)));
    if (artifactDigest(artifact) !== receipt.digest)
      throw new Error("artifact_changed");
    receipt.status = "deploying";
    // Fence viewers before calling the engine. Activation order, not the order
    // preparations were inserted, selects the audience for the running app.
    db.exec("BEGIN IMMEDIATE");
    try {
      save(receipt);
      db.prepare(
        "INSERT INTO app_publications VALUES (?, ?) ON CONFLICT(app_id) DO UPDATE SET receipt_id=excluded.receipt_id",
      ).run(receipt.appId, receipt.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    log({ event: "deploy_started", receiptId: receipt.id });
    const operation = Promise.resolve().then(async () => {
      try {
        // The SDK may choose its release only after buffering a slow request.
        // Do not switch code until every pre-fence admission has really settled.
        const active = viewers.get(receipt.appId);
        if (active?.size) {
          log({
            event: "viewer_drain",
            receiptId: receipt.id,
            requests: active.size,
          });
          await Promise.allSettled(active);
        }
        const result = await options.deploy(artifact);
        receipt.release = z.string().min(1).max(256).parse(result.release);
        receipt.status = "deployed";
      } catch (error) {
        // Neither a transport failure nor a thrown build error proves the SDK
        // made no external changes. Do not log generated source or raw errors.
        receipt.status = "unknown";
        const code = appReceiptSchema.shape.failureCode.safeParse(
          error && typeof error === "object" && "code" in error
            ? error.code
            : undefined,
        );
        if (code.success && code.data) receipt.failureCode = code.data;
      }
      save(receipt);
      log({
        event: "deploy_finished",
        receiptId: receipt.id,
        status: receipt.status,
        ...(receipt.failureCode ? { failureCode: receipt.failureCode } : {}),
      });
    });
    running.add(operation);
    void operation.finally(() => running.delete(operation)).catch(() => {});
    return c.json(receipt, 202);
  });
  app.all("/apps/*", async (c) => {
    if (!authorized(c.req.raw, options.viewerToken))
      return c.json({ error: "unauthorized" }, 401);
    // Host/proxy credentials never reach generated application code. Only app
    // content negotiation headers cross this boundary; cookies are unsupported.
    const headers = new Headers();
    for (const name of [
      "accept",
      "accept-language",
      "content-type",
      "range",
      "if-none-match",
    ])
      if (c.req.header(name)) headers.set(name, c.req.header(name) ?? "");
    const request = new Request(c.req.raw, { headers });
    const response = await options.serve(request);
    const outgoing = new Headers(response.headers);
    outgoing.delete("set-cookie");
    outgoing.set("Referrer-Policy", "no-referrer");
    outgoing.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, {
      status: response.status,
      headers: outgoing,
    });
  });
  return {
    app,
    viewer: viewerConfig
      ? createAppsViewer({
          config: viewerConfig,
          publication(appId) {
            if (draining) return null;
            const row = db
              .prepare("SELECT receipt_id FROM app_publications WHERE app_id=?")
              .get(appId);
            const receipt = row ? get(String(row.receipt_id)) : null;
            return receipt?.status === "deployed" ? receipt : null;
          },
          serve(request, appId) {
            const active = viewers.get(appId) ?? new Set<Promise<Response>>();
            // Registration is synchronous with the viewer's publication check.
            const operation = Promise.resolve().then(() =>
              options.serve(request),
            );
            active.add(operation);
            viewers.set(appId, active);
            void operation
              .finally(() => {
                active.delete(operation);
                if (!active.size) viewers.delete(appId);
              })
              .catch(() => {});
            return operation;
          },
          log,
        })
      : undefined,
    async close() {
      draining = true;
      await Promise.allSettled(running);
      db.close();
    },
  };
}
