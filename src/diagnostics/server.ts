import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createDebugAuth } from "./auth.js";
import type { DebugSiteDeploymentStatus } from "./deployment.js";
import { createIssueApi } from "./issue-api.js";
import {
  type IssueIndex,
  type IssueTracker,
  issueActions,
  issueSourceSchema,
} from "./issue-tracker.js";
import {
  MAX_OPERATION_BYTES,
  OperationConflictError,
  OperationValidationError,
  operationQuerySchema,
  validateOperation,
} from "./operations.js";
import {
  DiagnosticConflictError,
  type DiagnosticStore,
  DiagnosticValidationError,
  MAX_SNAPSHOT_BYTES,
  snapshotIdSchema,
  validateSnapshot,
} from "./store.js";

const hash = (value: string) => createHash("sha256").update(value).digest();

/** A separate process: no callbacks, clients, sessions or readiness from June. */
export function createDebugSite(options: {
  origin: string;
  viewerToken: string;
  ingestToken: string;
  operationsToken?: string;
  store: DiagnosticStore;
  assets: string;
  revision?: string;
  deployment?: () => Promise<DebugSiteDeploymentStatus | null>;
  issues?: { token: string; operatorToken?: string; tracker: IssueTracker };
  now?: () => number;
}) {
  const origin = new URL(options.origin);
  const tokens = [
    options.viewerToken,
    options.ingestToken,
    ...(options.operationsToken === undefined ? [] : [options.operationsToken]),
    ...(options.issues ? [options.issues.token] : []),
    ...(options.issues?.operatorToken ? [options.issues.operatorToken] : []),
  ];
  if (
    origin.origin !== options.origin ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      )) ||
    new Set(tokens).size !== tokens.length ||
    tokens.some(
      (token) =>
        token.length < 32 ||
        token.length > 4096 ||
        !/^[A-Za-z0-9._~+/-]+=*$/.test(token),
    )
  )
    throw new Error("Invalid debug site configuration");
  const app = new Hono();
  const ingest = hash(options.ingestToken);
  const matches = (value: unknown, expected: Buffer) =>
    typeof value === "string" &&
    value.length <= 4096 &&
    timingSafeEqual(hash(value), expected);
  const bearer = (request: Request) =>
    /^Bearer (.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store, private");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof OperationValidationError)
      return c.json({ error: "invalid_operation" }, 400);
    if (error instanceof OperationConflictError)
      return c.json({ error: "operation_conflict" }, 409);
    if (error instanceof DiagnosticConflictError)
      return c.json({ error: "snapshot_conflict" }, 409);
    if (error instanceof DiagnosticValidationError)
      return c.json(
        { error: error.code },
        error.code === "snapshot_too_large" ? 413 : 400,
      );
    return c.json({ error: "archive_unavailable" }, 503);
  });
  app.notFound((c) => c.json({ error: "not_found" }, 404));

  const issueIndex = (source?: string): IssueIndex =>
    options.issues?.tracker.index(source) ?? {
      enabled: false,
      items: [],
      total: 0,
      pending: [],
    };
  if (options.issues) {
    const api = createIssueApi({ origin: options.origin, ...options.issues });
    for (const path of [
      "/api/issue-tools",
      "/api/issue-sources",
      "/api/issue-jobs/*",
      "/api/issue-reconciliation/*",
      "/mcp/issues",
    ])
      app.all(path, (c) => api.fetch(c.req.raw));
  }
  app.use("/api/ingest/*", async (c, next) => {
    if (!matches(bearer(c.req.raw), ingest))
      return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  // June may read issue metadata with her ingest credential, never archive bodies.
  app.get("/api/ingest/issues", (c) => c.json(issueIndex()));
  app.put(
    "/api/ingest/operations/:id",
    bodyLimit({
      maxSize: MAX_OPERATION_BYTES,
      onError: (c) => c.json({ error: "operation_too_large" }, 413),
    }),
    async (c) => {
      if (c.req.header("content-type")?.split(";")[0] !== "application/json")
        return c.json({ error: "json_required" }, 415);
      const event = validateOperation(await c.req.json().catch(() => null));
      if (event.id !== c.req.param("id"))
        return c.json({ error: "identity_mismatch" }, 400);
      const result = options.store.putOperation(event);
      return c.json(
        { id: event.id, saved: true },
        result === "created" ? 201 : 200,
      );
    },
  );
  app.put(
    "/api/ingest/:id",
    bodyLimit({
      maxSize: MAX_SNAPSHOT_BYTES,
      onError: (c) => c.json({ error: "snapshot_too_large" }, 413),
    }),
    async (c) => {
      if (c.req.header("content-type")?.split(";")[0] !== "application/json")
        return c.json({ error: "json_required" }, 415);
      const snapshot = validateSnapshot(await c.req.json().catch(() => null));
      if (snapshot.id !== c.req.param("id"))
        return c.json({ error: "identity_mismatch" }, 400);
      const phase = c.req.header("x-june-investigation-phase");
      const observation =
        phase && !snapshot.snapshotOnly
          ? issueSourceSchema.safeParse({
              source: `debug:${snapshot.id}`,
              phase,
              threadId: c.req.header("x-june-investigation-thread"),
            })
          : undefined;
      if (observation && !observation.success)
        return c.json({ error: "invalid_investigation_metadata" }, 400);
      const result = options.store.put(snapshot);
      options.issues?.tracker.track({
        action: "track",
        source: `debug:${snapshot.id}`,
        snapshotOnly: snapshot.snapshotOnly === true,
        ...(/^[0-9a-f]{40}$/.test(snapshot.revision)
          ? { revision: snapshot.revision }
          : {}),
      });
      if (observation?.success)
        await options.issues?.tracker.sourceReceipt(observation.data);
      return c.json(
        { id: snapshot.id, saved: true },
        result === "created" ? 201 : 200,
      );
    },
  );

  const registerOperations = (path: string) => {
    app.get(path, (c) => {
      const failuresOnly = c.req.query("failuresOnly");
      if (
        failuresOnly !== undefined &&
        failuresOnly !== "true" &&
        failuresOnly !== "false"
      )
        throw new OperationValidationError();
      const query = operationQuerySchema.safeParse({
        query: c.req.query("q") ?? "",
        source: c.req.query("source") || undefined,
        sources: c.req.query("sources")?.split(","),
        failuresOnly: failuresOnly === "true",
        failureKey: c.req.query("failureKey") || undefined,
        offset: Number(c.req.query("offset") ?? 0),
        limit: Number(c.req.query("limit") ?? 50),
      });
      if (!query.success) throw new OperationValidationError();
      return c.json(options.store.operations(query.data));
    });
    app.get(`${path}/:id`, (c) => {
      const detail = options.store.operation(
        c.req.param("id") ?? "",
        Number(c.req.query("offset") ?? 0),
      );
      return detail ? c.json(detail) : c.notFound();
    });
  };
  // This credential reads ONLY content-free operations. It never becomes a
  // browser session and does not share the viewer or write-only ingest token.
  const operationsReader = options.operationsToken
    ? hash(options.operationsToken)
    : undefined;
  app.use("/api/operations-read*", async (c, next) => {
    if (!operationsReader || !matches(bearer(c.req.raw), operationsReader))
      return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  registerOperations("/api/operations-read");
  app.route("/api", createDebugAuth(options));
  registerOperations("/api/operations");
  app.get("/api/issues", (c) => {
    const query = issueActions.inspect.parse({
      action: "inspect",
      source: c.req.query("source"),
    });
    return c.json(issueIndex(query.source));
  });
  app.get("/api/snapshots", (c) =>
    c.json(
      options.store.list({
        query: c.req.query("q") ?? "",
        offset: Number(c.req.query("offset") ?? 0),
      }),
    ),
  );
  app.get("/api/snapshots/:id/:download?", (c) => {
    if (c.req.param("download") && c.req.param("download") !== "download")
      return c.notFound();
    const snapshot = options.store.get(c.req.param("id"));
    if (!snapshot) return c.notFound();
    if (c.req.param("download"))
      c.header(
        "Content-Disposition",
        `attachment; filename="june-debug-${snapshot.id}.json"`,
      );
    return c.json(snapshot);
  });
  app.get("/health", async (c) => {
    options.store.list({ limit: 1 });
    const html = await readFile(join(options.assets, "index.html"), "utf8");
    for (const match of html.matchAll(
      /(?:src|href)="\/assets\/([A-Za-z0-9_-]+\.(?:js|css))"/g,
    ))
      if (match[1]) await readFile(join(options.assets, "assets", match[1]));
    return c.json({
      ready: true,
      revision: options.revision ?? "development",
      deployment: (await options.deployment?.()) ?? null,
    });
  });
  app.get("/assets/:file", async (c) => {
    const file = c.req.param("file");
    if (!/^[A-Za-z0-9_-]+\.(js|css)$/.test(file)) return c.notFound();
    const bytes = await readFile(join(options.assets, "assets", file)).catch(
      () => undefined,
    );
    if (!bytes) return c.notFound();
    c.header(
      "Content-Type",
      file.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : "text/css; charset=utf-8",
    );
    return c.body(bytes);
  });
  app.get("/", async (c) =>
    c.html(await readFile(join(options.assets, "index.html"), "utf8")),
  );
  app.get("/operations", async (c) =>
    c.html(await readFile(join(options.assets, "index.html"), "utf8")),
  );
  app.get("/issues", async (c) =>
    c.html(await readFile(join(options.assets, "index.html"), "utf8")),
  );
  app.get("/s/:id/:page?", async (c) => {
    if (
      !snapshotIdSchema.safeParse(c.req.param("id")).success ||
      (c.req.param("page") && c.req.param("page") !== "conversation")
    )
      return c.notFound();
    return c.html(await readFile(join(options.assets, "index.html"), "utf8"));
  });
  return app;
}
