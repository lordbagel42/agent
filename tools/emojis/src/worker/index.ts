import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { boundedJson, securityHeaders } from "../http.js";
import {
  ftsQuery,
  type IndexStatus,
  nameSchema,
  resultSchema,
  type SearchHit,
  sha256,
  sourceSchema,
  WORKSPACE_ID,
} from "../shared.js";
import {
  drainEmbeddings,
  embed,
  expire,
  LEASE_MS,
  markDirty,
  reconcile,
  resultStatement,
  sourceStatement,
  sql,
  validateSource,
} from "./store.js";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: securityHeaders });
async function equal(a: string, b: string) {
  const hash = async (s: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return timingSafeEqual(
    new Uint8Array(await hash(a)),
    new Uint8Array(await hash(b)),
  );
}
async function auth(
  request: Request,
  env: Env,
  roles: ("READ_TOKEN" | "ADMIN_TOKEN" | "INDEXER_TOKEN")[],
) {
  const secrets = [env.READ_TOKEN, env.INDEXER_TOKEN, env.ADMIN_TOKEN];
  if (
    secrets.some((s) => !s || s.length < 32 || s.length > 512) ||
    new Set(secrets).size !== 3
  )
    throw new HttpError(503, "auth_unconfigured");
  const token =
    request.headers.get("Authorization")?.match(/^Bearer (.{1,512})$/)?.[1] ??
    "";
  const checks = await Promise.all(
    roles.map((role) => equal(token, env[role])),
  );
  if (!checks.some(Boolean)) throw new HttpError(401, "unauthorized");
}
async function body(request: Request) {
  try {
    return await boundedJson(new Response(request.body), 512 * 1024);
  } catch {
    throw new HttpError(400, "invalid_body");
  }
}
async function slack(request: Request, env: Env) {
  const stamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  if (
    !/^\d{10}$/.test(stamp) ||
    Math.abs(Date.now() / 1000 - Number(stamp)) > 300 ||
    !/^v0=[a-f0-9]{64}$/.test(signature) ||
    !env.SLACK_SIGNING_SECRET
  )
    throw new HttpError(401, "invalid_signature");
  // Read bytes with a hard bound, preserving the exact signed body.
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > 64 * 1024) throw new HttpError(413, "body_too_large");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  const prefix = new TextEncoder().encode(`v0:${stamp}:`);
  const signed = new Uint8Array(prefix.length + size);
  signed.set(prefix);
  signed.set(bytes, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sig = Uint8Array.from(signature.slice(3).match(/../g) ?? [], (s) =>
    Number.parseInt(s, 16),
  );
  if (!(await crypto.subtle.verify("HMAC", key, sig, signed)))
    throw new HttpError(401, "invalid_signature");
  const data = z
    .object({
      type: z.string(),
      team_id: z.string().optional(),
      challenge: z.string().max(1000).optional(),
      event: z.object({ type: z.string() }).passthrough().optional(),
    })
    .parse(
      JSON.parse(
        new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      ),
    );
  // Slack URL-verification has no team_id; its signature proves app ownership.
  if (data.type === "url_verification" && data.challenge)
    return json({ challenge: data.challenge });
  if (data.team_id !== WORKSPACE_ID)
    throw new HttpError(403, "wrong_workspace");
  if (data.type === "event_callback" && data.event?.type === "emoji_changed")
    await markDirty(env);
  return json({ ok: true });
}
type DocumentRow = {
  name: string;
  revision: string;
  vector_id: string;
  source_json: string;
  result_json: string | null;
};
function hit(
  row: DocumentRow,
  score: number,
  match: SearchHit["match"],
): SearchHit {
  const source = sourceSchema.parse(JSON.parse(row.source_json));
  const result = row.result_json
    ? resultSchema.parse(JSON.parse(row.result_json))
    : null;
  return {
    name: row.name,
    shortcode: `:${row.name}:`,
    canonicalName: source.canonicalName,
    imageUrl: source.imageUrl,
    summary: result?.analysis.summary ?? row.name,
    description: result?.analysis.description ?? "Not yet analyzed.",
    score,
    match,
  };
}
async function semanticQuery(
  request: Request,
  env: Env,
  q: string,
  ctx?: Pick<ExecutionContext, "waitUntil">,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    // Cache only query vectors, never catalog/results. This key is not a public route.
    const key = new Request(
      new URL(`/_embeddings/bge-small-v1/${await sha256(q)}`, request.url),
    );
    const cache = typeof caches === "undefined" ? undefined : caches.default;
    const cached = await cache?.match(key);
    let vector: number[] | undefined;
    if (cached)
      vector = z
        .array(z.number().finite())
        .length(384)
        .parse(await cached.json());
    else {
      [vector] = await embed(env, [q]);
      if (vector && cache)
        await cache.put(
          key,
          Response.json(vector, {
            headers: { "Cache-Control": "max-age=3600" },
          }),
        );
    }
    if (!vector) return null;
    return await env.VECTORS.query(vector, {
      topK: 50,
      returnMetadata: "none",
    });
  })().catch(() => null);
  // Let a slow first embedding warm the private cache, without holding up search.
  ctx?.waitUntil(work.then(() => {}));
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 150);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function search(
  request: Request,
  env: Env,
  ctx?: Pick<ExecutionContext, "waitUntil">,
) {
  const started = performance.now();
  const url = new URL(request.url);
  const q = z.string().trim().min(1).max(300).parse(url.searchParams.get("q"));
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .parse(url.searchParams.get("limit") ?? 12);
  const mode = z
    .enum(["hybrid", "keyword"])
    .parse(url.searchParams.get("mode") ?? "hybrid");
  const semantic =
    mode === "hybrid"
      ? semanticQuery(request, env, q, ctx)
      : Promise.resolve(null);
  const query = ftsQuery(q);
  const exact = q.replace(/^:|:$/g, "");
  const keyword = await sql(
    env,
    query
      ? `SELECT d.* FROM documents_fts f JOIN documents d ON d.name=f.name WHERE documents_fts MATCH ? ORDER BY bm25(documents_fts) LIMIT 50`
      : `SELECT * FROM documents WHERE name=? LIMIT 50`,
    query || exact,
  ).all<DocumentRow>();
  const ranked = new Map<
    string,
    { row: DocumentRow; score: number; match: SearchHit["match"] }
  >();
  keyword.results.forEach((row, i) => {
    ranked.set(row.name, { row, score: 1 / (60 + i), match: "keyword" });
  });
  const exactRow = await sql(
    env,
    "SELECT * FROM documents WHERE name=?",
    exact,
  ).first<DocumentRow>();
  if (exactRow)
    ranked.set(exactRow.name, { row: exactRow, score: 1, match: "exact" });
  let semanticAvailable = false;
  if (mode === "hybrid")
    try {
      const matches = await semantic;
      if (!matches) throw new Error("semantic_unavailable");
      if (matches.matches.length) {
        const rows = await sql(
          env,
          `SELECT * FROM documents WHERE vector_id IN (${matches.matches.map(() => "?").join(",")})`,
          ...matches.matches.map((m) => m.id),
        ).all<DocumentRow>();
        const current = new Map(rows.results.map((r) => [r.vector_id, r]));
        matches.matches.forEach((m, i) => {
          const row = current.get(m.id);
          if (!row) return;
          const old = ranked.get(row.name);
          ranked.set(row.name, {
            row,
            score: (old?.score ?? 0) + 1 / (60 + i),
            match: old?.match ?? "semantic",
          });
        });
      }
      semanticAvailable = true;
    } catch {
      /* Deliberate keyword fallback; never leak provider errors. */
    }
  // Revalidate even keyword candidates after the asynchronous provider call.
  const candidates = [...ranked.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 100);
  const current = candidates.length
    ? (
        await sql(
          env,
          `SELECT vector_id FROM documents WHERE vector_id IN (${candidates.map(() => "?").join(",")})`,
          ...candidates.map((c) => c.row.vector_id),
        ).all<{ vector_id: string }>()
      ).results
    : [];
  const valid = new Set(current.map((r) => r.vector_id));
  return json({
    results: candidates
      .filter((c) => valid.has(c.row.vector_id))
      .slice(0, limit)
      .map((c) => hit(c.row, c.score, c.match)),
    mode: semanticAvailable ? "hybrid" : "keyword",
    durationMs: Math.round(performance.now() - started),
    semanticAvailable,
    ...(mode === "hybrid" && !semanticAvailable
      ? { degraded: "semantic_unavailable" }
      : {}),
  });
}
async function status(env: Env) {
  await expire(env);
  const groups = (
    await sql(env, "SELECT state,count(*) AS n FROM jobs GROUP BY state").all<{
      state: string;
      n: number;
    }>()
  ).results;
  const counts: IndexStatus["counts"] = {
    total: 0,
    aliases: 0,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    unknown: 0,
  };
  for (const state of [
    "pending",
    "running",
    "completed",
    "failed",
    "unknown",
  ] as const)
    counts[state] = groups.find((r) => r.state === state)?.n ?? 0;
  counts.total =
    (await sql(env, "SELECT count(*) AS n FROM sources").first<{ n: number }>())
      ?.n ?? 0;
  counts.aliases =
    (
      await sql(
        env,
        "SELECT count(*) AS n FROM sources WHERE json_extract(source_json,'$.aliasOf') IS NOT NULL",
      ).first<{ n: number }>()
    )?.n ?? 0;
  const recent = (
    await sql(
      env,
      `SELECT s.name,coalesce(j.state,'alias') AS state,json_extract(d.result_json,'$.analysis.summary') AS summary,s.image_url AS imageUrl,j.error FROM sources s LEFT JOIN jobs j ON j.name=s.name LEFT JOIN documents d ON d.name=s.name ORDER BY j.updated_at DESC LIMIT 12`,
    ).all<IndexStatus["recent"][number]>()
  ).results;
  const completed =
    (
      await sql(
        env,
        "SELECT count(*) AS n FROM jobs WHERE state='completed' AND updated_at>?",
        Date.now() - 60_000,
      ).first<{ n: number }>()
    )?.n ?? 0;
  const result: IndexStatus = {
    mode: "cloud",
    state: counts.running
      ? "running"
      : counts.unknown || counts.failed
        ? "blocked"
        : "idle",
    updatedAt: new Date().toISOString(),
    counts,
    concurrency: counts.running,
    targetConcurrency: 0,
    completedPerMinute: completed,
    availableMemoryMb: null,
    reason: counts.unknown
      ? "Explicit reindex required for uncertain jobs"
      : null,
    recent,
  };
  return json(result);
}
async function route(
  request: Request,
  env: Env,
  ctx?: Pick<ExecutionContext, "waitUntil">,
) {
  const path = new URL(request.url).pathname;
  if (path === "/slack/events" && request.method === "POST")
    return slack(request, env);
  if (!path.startsWith("/api/")) {
    if (
      ![
        "/",
        "/index.html",
        "/app.js",
        "/style.css",
        "/styles.css",
        "/favicon.ico",
      ].includes(path)
    )
      throw new HttpError(404, "not_found");
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(securityHeaders)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  }
  if (path === "/api/status" && request.method === "GET") {
    await auth(request, env, ["READ_TOKEN", "ADMIN_TOKEN"]);
    return status(env);
  }
  if (path === "/api/search" && request.method === "GET") {
    await auth(request, env, ["READ_TOKEN"]);
    return search(request, env, ctx);
  }
  if (request.method !== "POST") throw new HttpError(404, "not_found");
  if (path.startsWith("/api/jobs/")) {
    await auth(request, env, ["INDEXER_TOKEN"]);
    await expire(env);
    if (path === "/api/jobs/claim") {
      if (request.body)
        z.object({})
          .strict()
          .parse(await body(request));
      const id = crypto.randomUUID();
      const expiresAt = Date.now() + LEASE_MS;
      const job = await sql(
        env,
        `UPDATE jobs SET state='running',lease_id=?,expires_at=?,updated_at=?,error=NULL WHERE name=(SELECT j.name FROM jobs j JOIN sources s ON s.name=j.name AND s.revision=j.revision WHERE j.state='pending' ORDER BY j.updated_at,j.name LIMIT 1) AND state='pending' RETURNING name,revision`,
        id,
        expiresAt,
        Date.now(),
      ).first<{ name: string; revision: string }>();
      if (!job) return json({ lease: null });
      const row = await sql(
        env,
        "SELECT source_json FROM sources WHERE name=? AND revision=?",
        job.name,
        job.revision,
      ).first<{ source_json: string }>();
      return json({
        lease: row
          ? { id, source: JSON.parse(row.source_json), expiresAt }
          : null,
      });
    }
    const input = await body(request);
    if (path === "/api/jobs/heartbeat") {
      const { leaseId } = z.object({ leaseId: z.uuid() }).strict().parse(input);
      const expiresAt = Date.now() + LEASE_MS;
      const row = await sql(
        env,
        "UPDATE jobs SET expires_at=?,updated_at=? WHERE lease_id=? AND state='running' AND expires_at>? RETURNING name",
        expiresAt,
        Date.now(),
        leaseId,
        Date.now(),
      ).first();
      if (!row) throw new HttpError(409, "stale_lease");
      return json({ expiresAt });
    }
    if (path === "/api/jobs/complete") {
      const { leaseId, result } = z
        .object({ leaseId: z.uuid(), result: resultSchema })
        .strict()
        .parse(input);
      await validateSource(result.source);
      const { digest, statement } = await resultStatement(env, result, leaseId);
      const outcomes = await env.DB.batch([
        sql(
          env,
          `UPDATE jobs SET state='completed',digest=?,updated_at=? WHERE lease_id=? AND name=? AND revision=? AND ((state='running' AND expires_at>?) OR (state='completed' AND digest=?)) RETURNING name`,
          digest,
          Date.now(),
          leaseId,
          result.source.name,
          result.source.revision,
          Date.now(),
          digest,
        ),
        statement,
      ]);
      if (!outcomes[0]?.results.length) throw new HttpError(409, "stale_lease");
      return json({ ok: true });
    }
    if (path === "/api/jobs/fail") {
      const { leaseId, code, uncertain } = z
        .object({
          leaseId: z.uuid(),
          code: z.string().regex(/^[a-z0-9_]{1,64}$/),
          uncertain: z.boolean(),
        })
        .strict()
        .parse(input);
      const row = await sql(
        env,
        "UPDATE jobs SET state=?,error=?,updated_at=? WHERE lease_id=? AND state='running' AND expires_at>? RETURNING name",
        uncertain ? "unknown" : "failed",
        code,
        Date.now(),
        leaseId,
        Date.now(),
      ).first();
      if (!row) throw new HttpError(409, "stale_lease");
      return json({ ok: true });
    }
    throw new HttpError(404, "not_found");
  }
  await auth(request, env, ["ADMIN_TOKEN"]);
  if (path === "/api/sync") {
    if (request.body)
      z.object({})
        .strict()
        .parse(await body(request));
    await markDirty(env);
    return json({ ok: true }, 202);
  }
  if (path === "/api/reindex") {
    const { name } = z
      .object({ name: nameSchema })
      .strict()
      .parse(await body(request));
    const row = await sql(
      env,
      `UPDATE jobs SET state='pending',lease_id=NULL,expires_at=NULL,digest=NULL,error=NULL,updated_at=? WHERE name=(SELECT canonical_name FROM sources WHERE name=?) RETURNING name`,
      Date.now(),
      name,
    ).first();
    if (!row) throw new HttpError(404, "not_found");
    return json({ ok: true });
  }
  if (path === "/api/import") {
    const input = z
      .object({
        sources: z.array(sourceSchema).max(50),
        results: z.array(resultSchema).max(20),
      })
      .strict()
      .parse(await body(request));
    await Promise.all(
      [...input.sources, ...input.results.map((r) => r.source)].map(
        validateSource,
      ),
    );
    // Imported results carry their source, so result-only batches are useful and bounded.
    const sources = new Map(
      [...input.sources, ...input.results.map((r) => r.source)].map((s) => [
        s.name,
        s,
      ]),
    );
    const statements = [...sources.values()].map((s) =>
      sourceStatement(env, s),
    );
    for (const result of input.results) {
      if (result.source.canonicalName !== result.source.name)
        throw new HttpError(400, "canonical_result_required");
      const { statement } = await resultStatement(env, result);
      statements.push(statement);
      statements.push(
        sql(
          env,
          "UPDATE jobs SET state='completed',lease_id=NULL,digest=NULL,updated_at=? WHERE name=? AND revision=?",
          Date.now(),
          result.source.name,
          result.source.revision,
        ),
      );
    }
    if (statements.length) await env.DB.batch(statements);
    return json({
      ok: true,
      sources: sources.size,
      results: input.results.length,
    });
  }
  throw new HttpError(404, "not_found");
}
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx?: Pick<ExecutionContext, "waitUntil">,
  ) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      return json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : error instanceof z.ZodError ||
                  error instanceof SyntaxError ||
                  (error instanceof Error && error.message === "invalid_source")
                ? "invalid_request"
                : "service_unavailable",
        },
        error instanceof HttpError
          ? error.status
          : error instanceof z.ZodError ||
              error instanceof SyntaxError ||
              (error instanceof Error && error.message === "invalid_source")
            ? 400
            : 503,
      );
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await expire(env);
        for (const [stage, operation] of [
          ["reconcile", reconcile],
          ["embeddings", drainEmbeddings],
        ] as const) {
          try {
            await operation(env);
          } catch (error) {
            // Never log provider payloads, SQL, catalogue content or credentials.
            const message = error instanceof Error ? error.message : "";
            const code = /^slack_http_\d{3}$/.test(message)
              ? message
              : [
                    "slack_missing_scope",
                    "slack_invalid_auth",
                    "slack_token_expired",
                    "slack_ratelimited",
                    "slack_request_failed",
                    "slack_workspace_mismatch",
                    "embedding_unavailable",
                    "response_too_large",
                  ].includes(message)
                ? message
                : error instanceof z.ZodError
                  ? "invalid_schema"
                  : message.startsWith("D1_")
                    ? "database_error"
                    : "operation_failed";
            console.error(
              JSON.stringify({
                stage,
                code,
                locations:
                  error instanceof Error
                    ? error.stack?.match(/\bindex\.js:\d+:\d+/g)?.slice(0, 4)
                    : undefined,
              }),
            );
          }
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
