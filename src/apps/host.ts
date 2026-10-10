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
import { type AppReceipt, appReceiptSchema, BUILD_FAILURES } from "./client.js";
import { SIGNATURE_WINDOW_MS, verifyControl } from "./signature.js";
import {
  appViewerUrl,
  createAppsViewer,
  type ViewerConfig,
  viewerConfigSchema,
} from "./viewer.js";

const scopeSchema = digestSchema;
const ownerSchema = z.strictObject({
  scope: scopeSchema,
  privileged: z.boolean(),
});

/** A single dedicated host owns this database and its Rivet namespace/pool.
 * Generated apps must never share June's process, data directory or credentials.
 */
export function createAppsHost(options: {
  database: string;
  /** base64url Ed25519 public keys whose signatures may use /control. */
  juneKeys: readonly string[];
  viewerToken: string;
  origin: string;
  viewer?: ViewerConfig;
  revision?: string;
  /** Bind approvals to operator-managed engine, namespace, pool and serving origin. */
  binding: string;
  deploy(artifact: AppArtifact): Promise<{ release: string }>;
  serve(request: Request): Promise<Response>;
  /** Receives only bounded operational metadata, never source or credentials. */
  log?(event: Record<string, string | number>): void;
  ready?(): Promise<boolean>;
}) {
  if (options.viewerToken.length < 32)
    throw new Error("viewer_credential_required");
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
    CREATE TABLE IF NOT EXISTS receipt_scopes (id TEXT PRIMARY KEY, scope TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS app_owners (app_id TEXT PRIMARY KEY, scope TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS control_nonces (signature TEXT PRIMARY KEY, at INTEGER NOT NULL);
    UPDATE apps SET receipt=json_set(receipt, '$.status', 'unknown') WHERE json_extract(receipt, '$.status')='deploying';`);
  const app = new Hono();
  const running = new Set<Promise<void>>();
  const viewers = new Map<string, Set<Promise<Response>>>();
  let draining = false;
  const log = options.log ?? (() => {});
  const ready = async () => !draining && (await options.ready?.()) !== false;
  const bearer = (request: Request, token: string) => {
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  };
  // Legacy rows that no longer parse (e.g. retired app ID shapes) read as
  // absent instead of failing every list that could see them.
  const parseReceipt = (row: Record<string, unknown> | undefined) => {
    const parsed = row
      ? appReceiptSchema.safeParse(JSON.parse(String(row.receipt)))
      : undefined;
    return parsed?.success ? parsed.data : null;
  };
  const get = (id: string) =>
    parseReceipt(
      db
        .prepare("SELECT receipt FROM apps WHERE id=? AND binding=?")
        .get(id, binding),
    );
  const save = (receipt: AppReceipt) => {
    db.prepare("UPDATE apps SET receipt=? WHERE id=?").run(
      JSON.stringify(receipt),
      receipt.id,
    );
  };
  const scopeOf = (id: string) =>
    db.prepare("SELECT scope FROM receipt_scopes WHERE id=?").get(id)?.scope as
      | string
      | undefined;
  const ownerOf = (appId: string) =>
    db.prepare("SELECT scope FROM app_owners WHERE app_id=?").get(appId)
      ?.scope as string | undefined;
  const publication = (appId: string) => {
    const row = db
      .prepare("SELECT receipt_id FROM app_publications WHERE app_id=?")
      .get(appId);
    return row ? get(String(row.receipt_id)) : null;
  };
  // Latest receipts visible to the caller: its own, or all for the owner DM.
  const latest = (appId: string, scope: string, privileged: boolean) => {
    const row = db
      .prepare(
        "SELECT a.receipt FROM apps a LEFT JOIN receipt_scopes s ON s.id=a.id WHERE a.app_id=? AND a.binding=? AND (s.scope=? OR ?) ORDER BY json_extract(a.receipt, '$.status') IN ('deploying','unknown') DESC, a.rowid DESC LIMIT 1",
      )
      .get(appId, binding, scope, privileged ? 1 : 0);
    return parseReceipt(row);
  };
  const appState = (appId: string, scope: string, privileged: boolean) => ({
    appId,
    publication: publication(appId),
    latest: latest(appId, scope, privileged),
    owned: ownerOf(appId) === scope,
  });
  const readerOf = (url: string) => {
    const query = new URL(url).searchParams;
    return ownerSchema.parse({
      scope: query.get("scope"),
      privileged: query.get("privileged") === "1",
    });
  };
  app.onError(() =>
    Response.json({ error: "apps_request_failed" }, { status: 400 }),
  );
  app.get("/health/live", (c) => c.json({ live: true }));
  app.get("/health/ready", async (c) => {
    const ok = await ready();
    return c.json({ ready: ok }, ok ? 200 : 503);
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
  // June's control API: Ed25519 signatures over method, path, time and body,
  // each usable once. No bearer credential exists to be copied or leaked.
  const control = new Hono().basePath("/control");
  control.use("*", bodyLimit({ maxSize: MAX_ARTIFACT_BYTES + 4096 }));
  control.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const url = new URL(c.req.url);
    const signed = await verifyControl(
      c.req.header("authorization"),
      c.req.method,
      `${url.pathname}${url.search}`,
      () => (c.req.method === "GET" ? Promise.resolve("") : c.req.text()),
      options.juneKeys,
    );
    if (!signed) return c.json({ error: "unauthorized" }, 401);
    db.prepare("DELETE FROM control_nonces WHERE at < ?").run(
      Date.now() - 2 * SIGNATURE_WINDOW_MS,
    );
    if (
      db
        .prepare(
          "INSERT INTO control_nonces VALUES (?, ?) ON CONFLICT DO NOTHING",
        )
        .run(signed.nonce, signed.at).changes !== 1
    )
      return c.json({ error: "replayed_signature" }, 401);
    if (draining) return c.json({ error: "host_draining" }, 503);
    await next();
  });
  control.post("/prepare", async (c) => {
    const { artifact, jobId, requestId, access, scope, title } = z
      .strictObject({
        artifact: artifactSchema,
        jobId: digestSchema.nullable(),
        requestId: digestSchema,
        access: appAccessSchema.optional(),
        scope: scopeSchema,
        title: z.string().trim().max(120).nullable().optional(),
      })
      .parse(JSON.parse(await c.req.text()));
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
          scope,
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
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      release: null,
      url:
        access && viewerConfig
          ? appViewerUrl(viewerConfig, artifact.appId, access)
          : `${options.origin}/apps/${artifact.appId}/`,
      ...(access ? { access } : {}),
      ...(title ? { title } : {}),
    };
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO apps VALUES (?, ?, ?, ?, ?)").run(
        id,
        artifact.appId,
        binding,
        JSON.stringify(artifact),
        JSON.stringify(receipt),
      );
      db.prepare("INSERT INTO receipt_scopes VALUES (?, ?)").run(id, scope);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    log({ event: "prepared", receiptId: id, access: access ?? "internal" });
    return c.json(receipt);
  });
  control.get("/receipts/:id", (c) =>
    c.json(get(digestSchema.parse(c.req.param("id")))),
  );
  control.get("/apps", (c) => {
    const { scope, privileged } = readerOf(c.req.url);
    const ids = db
      .prepare(
        "SELECT app_id FROM app_owners WHERE scope=? OR ? UNION SELECT a.app_id FROM apps a JOIN receipt_scopes s ON s.id=a.id WHERE a.binding=? AND (s.scope=? OR ?) ORDER BY 1 LIMIT 200",
      )
      .all(scope, privileged ? 1 : 0, binding, scope, privileged ? 1 : 0)
      .map((row) => String(row.app_id));
    return c.json({ apps: ids.map((id) => appState(id, scope, privileged)) });
  });
  control.get("/apps/:appId", (c) => {
    const { scope, privileged } = readerOf(c.req.url);
    return c.json(
      appState(appIdSchema.parse(c.req.param("appId")), scope, privileged),
    );
  });
  control.post("/unpublish/:appId", async (c) => {
    const appId = appIdSchema.parse(c.req.param("appId"));
    const { scope, privileged } = ownerSchema.parse(
      JSON.parse(await c.req.text()),
    );
    const owner = ownerOf(appId);
    if (!owner) return c.json({ error: "app_not_found" }, 404);
    if (owner !== scope && !privileged)
      return c.json({ error: "app_owned_by_other_conversation" }, 403);
    // Closing the pointer stops viewing at once; the engine keeps the release.
    db.prepare("DELETE FROM app_publications WHERE app_id=?").run(appId);
    log({ event: "unpublished" });
    return c.json(appState(appId, scope, privileged));
  });
  control.post("/deploy/:id", async (c) => {
    const { scope, privileged } = ownerSchema.parse(
      JSON.parse(await c.req.text()),
    );
    const receipt = get(digestSchema.parse(c.req.param("id")));
    if (!receipt) return c.json({ error: "receipt_not_found" }, 404);
    // An approval binds the conversation that prepared it; legacy receipts
    // without a recorded scope need the owner's private conversation.
    if (scopeOf(receipt.id) !== scope && !privileged)
      return c.json({ error: "receipt_from_other_conversation" }, 403);
    // Consuming approval and saving unknown intent happen synchronously before
    // any build/provisioning side effect; duplicate calls cannot launch again.
    if (receipt.status !== "prepared") return c.json(receipt);
    if (receipt.expiresAt <= Date.now())
      return c.json({ error: "approval_expired" }, 409);
    const owner = ownerOf(receipt.appId);
    if (owner && owner !== scope && !privileged)
      return c.json({ error: "app_owned_by_other_conversation" }, 403);
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
    const previous = db
      .prepare("SELECT receipt_id FROM app_publications WHERE app_id=?")
      .get(receipt.appId)?.receipt_id as string | undefined;
    receipt.status = "deploying";
    // Fence viewers before calling the engine. Activation order, not the order
    // preparations were inserted, selects the audience for the running app.
    db.exec("BEGIN IMMEDIATE");
    try {
      save(receipt);
      db.prepare(
        "INSERT INTO app_publications VALUES (?, ?) ON CONFLICT(app_id) DO UPDATE SET receipt_id=excluded.receipt_id",
      ).run(receipt.appId, receipt.id);
      db.prepare(
        "INSERT INTO app_owners VALUES (?, ?) ON CONFLICT(app_id) DO NOTHING",
      ).run(receipt.appId, scope);
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
        // Vetted validation/build codes are raised in the SDK's local build VM
        // before anything reaches the engine: the old release still serves.
        // Any other failure may have changed the engine and stays unknown.
        // Do not log generated source or raw errors.
        const code = appReceiptSchema.shape.failureCode.safeParse(
          error && typeof error === "object" && "code" in error
            ? error.code
            : undefined,
        );
        if (code.success && code.data && BUILD_FAILURES.includes(code.data)) {
          receipt.status = "failed";
          receipt.failureCode = code.data;
        } else receipt.status = "unknown";
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        save(receipt);
        if (receipt.status === "failed") {
          // Reopen the previous release, unless a newer deploy took over.
          if (previous && get(previous)?.status === "deployed")
            db.prepare(
              "UPDATE app_publications SET receipt_id=? WHERE app_id=? AND receipt_id=?",
            ).run(previous, receipt.appId, receipt.id);
          else
            db.prepare(
              "DELETE FROM app_publications WHERE app_id=? AND receipt_id=?",
            ).run(receipt.appId, receipt.id);
        }
        db.exec("COMMIT");
      } catch {
        db.exec("ROLLBACK");
        // Stored state stays "deploying" and becomes "unknown" on restart.
        log({ event: "deploy_record_failed", receiptId: receipt.id });
      }
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
  control.all("*", (c) => c.json({ error: "not_found" }, 404));
  control.onError(() =>
    Response.json({ error: "apps_request_failed" }, { status: 400 }),
  );
  app.route("/", control);
  // Loopback-only credential viewer for operator smoke checks.
  app.all("/apps/*", async (c) => {
    if (!bearer(c.req.raw, options.viewerToken))
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
  // The public apex exposes the signed control API and a bounded readiness
  // summary only; liveness internals stay on the loopback listener.
  const apex = new Hono();
  apex.get("/health", async (c) =>
    c.json(
      { ready: await ready(), revision: options.revision ?? null },
      { headers: { "Cache-Control": "no-store" } },
    ),
  );
  apex.route("/", control);
  return {
    app,
    viewer: viewerConfig
      ? createAppsViewer({
          config: viewerConfig,
          apex,
          publication(appId) {
            if (draining) return null;
            const receipt = publication(appId);
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
