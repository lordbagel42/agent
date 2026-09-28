import { slackCatalog } from "../http.js";
import {
  catalogSources,
  type EmojiResult,
  type EmojiSource,
  SCHEMA_VERSION,
  searchText,
  sha256,
} from "../shared.js";

export const LEASE_MS = 5 * 60_000;
export function sql(
  env: Env,
  text: string,
  ...args: (string | number | null)[]
) {
  return env.DB.prepare(text).bind(...args);
}
export async function validateSource(source: EmojiSource) {
  if (
    source.revision !==
    (await sha256(
      JSON.stringify([
        SCHEMA_VERSION,
        source.name,
        source.source,
        source.canonicalName,
        source.imageUrl,
      ]),
    ))
  )
    throw new Error("invalid_source");
  if (
    source.aliasOf !==
    (source.source.startsWith("alias:") ? source.source.slice(6) : null)
  )
    throw new Error("invalid_source");
  if (
    !source.aliasOf &&
    (source.canonicalName !== source.name || source.imageUrl !== source.source)
  )
    throw new Error("invalid_source");
  if (source.imageUrl && new URL(source.imageUrl).protocol !== "https:")
    throw new Error("invalid_source");
}
export function sourceStatement(
  env: Env,
  s: EmojiSource,
  seen: string | null = null,
) {
  return sql(
    env,
    `INSERT INTO sources(name,revision,canonical_name,image_url,source_json,seen) VALUES(?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,canonical_name=excluded.canonical_name,image_url=excluded.image_url,source_json=excluded.source_json,seen=excluded.seen`,
    s.name,
    s.revision,
    s.canonicalName,
    s.imageUrl,
    JSON.stringify(s),
    seen,
  );
}
export async function resultStatement(
  env: Env,
  result: EmojiResult,
  leaseId: string | null = null,
) {
  const digest = await sha256(JSON.stringify(result));
  return {
    digest,
    statement: sql(
      env,
      `INSERT INTO analyses(name,revision,digest,result_json,search_text,embedding_text)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sources WHERE name=? AND revision=? AND canonical_name=name)
    AND (? IS NULL OR EXISTS(SELECT 1 FROM jobs WHERE lease_id=? AND name=? AND revision=? AND state='completed' AND digest=?))
    ON CONFLICT(name,revision) DO UPDATE SET digest=excluded.digest,result_json=excluded.result_json,search_text=excluded.search_text,embedding_text=excluded.embedding_text WHERE analyses.digest<>excluded.digest`,
      result.source.name,
      result.source.revision,
      digest,
      JSON.stringify(result),
      searchText(result.source.name, result.analysis),
      result.analysis.embeddingText,
      result.source.name,
      result.source.revision,
      leaseId,
      leaseId,
      result.source.name,
      result.source.revision,
      digest,
    ),
  };
}
export async function expire(env: Env) {
  await sql(
    env,
    "UPDATE jobs SET state='unknown',error='lease_expired',updated_at=? WHERE state='running' AND expires_at<=?",
    Date.now(),
    Date.now(),
  ).run();
}
export async function markDirty(env: Env) {
  await sql(env, "UPDATE sync_state SET dirty=dirty+1 WHERE id=1").run();
}
export async function reconcile(env: Env) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const lock = await sql(
    env,
    `UPDATE sync_state SET lock_id=?,lock_until=? WHERE id=1 AND lock_until<? AND (dirty>0 OR last_sync<?) RETURNING dirty`,
    id,
    now + 10 * 60_000,
    now,
    now - 60 * 60_000,
  ).first<{ dirty: number }>();
  if (!lock) return;
  try {
    const sources = await catalogSources(
      await slackCatalog(env.SLACK_BOT_TOKEN),
    );
    // Bound individual D1 batches. The lock is fenced on every write, including removal.
    for (let i = 0; i < sources.length; i += 50) {
      const statements = sources.slice(i, i + 50).map((s) =>
        sql(
          env,
          `INSERT INTO sources(name,revision,canonical_name,image_url,source_json,seen)
        SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sync_state WHERE lock_id=? AND lock_until>?)
        ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,canonical_name=excluded.canonical_name,image_url=excluded.image_url,source_json=excluded.source_json,seen=excluded.seen`,
          s.name,
          s.revision,
          s.canonicalName,
          s.imageUrl,
          JSON.stringify(s),
          id,
          id,
          Date.now(),
        ),
      );
      await env.DB.batch(statements);
    }
    await env.DB.batch([
      sql(
        env,
        `DELETE FROM sources WHERE (seen IS NULL OR seen<>?) AND EXISTS(SELECT 1 FROM sync_state WHERE lock_id=? AND lock_until>?)`,
        id,
        id,
        Date.now(),
      ),
      sql(
        env,
        `UPDATE sync_state SET dirty=max(0,dirty-?),last_sync=?,lock_id=NULL,lock_until=0 WHERE lock_id=? AND lock_until>?`,
        lock.dirty,
        Date.now(),
        id,
        Date.now(),
      ),
    ]);
  } finally {
    await sql(
      env,
      "UPDATE sync_state SET lock_id=NULL,lock_until=0 WHERE lock_id=?",
      id,
    ).run();
  }
}
export async function embed(env: Env, texts: string[]) {
  const response = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
    text: texts,
  });
  if (
    !("data" in response) ||
    !response.data ||
    response.data.length !== texts.length ||
    response.data.some(
      (v) => v.length !== 384 || v.some((n) => !Number.isFinite(n)),
    )
  )
    throw new Error("embedding_unavailable");
  return response.data;
}
export async function drainEmbeddings(env: Env) {
  const rows = (
    await sql(
      env,
      `SELECT o.id,o.operation,d.embedding_text FROM embedding_outbox o LEFT JOIN documents d ON d.vector_id=o.id LIMIT 32`,
    ).all<{ id: string; operation: string; embedding_text: string | null }>()
  ).results;
  const deletions = rows.filter(
    (r) => r.operation === "delete" || !r.embedding_text,
  );
  const upserts = rows.filter(
    (r) => r.operation === "upsert" && r.embedding_text,
  );
  if (deletions.length) {
    await env.VECTORS.deleteByIds(deletions.map((r) => r.id));
    await env.DB.batch(
      deletions.map((r) =>
        sql(
          env,
          "DELETE FROM embedding_outbox WHERE id=? AND operation=? AND NOT EXISTS(SELECT 1 FROM documents WHERE vector_id=?)",
          r.id,
          r.operation,
          r.id,
        ),
      ),
    );
  }
  if (upserts.length) {
    const vectors = await embed(
      env,
      upserts.map((r) => r.embedding_text ?? ""),
    );
    await env.VECTORS.upsert(
      upserts.map((r, i) => ({ id: r.id, values: vectors[i] ?? [] })),
    );
    await env.DB.batch(
      upserts.flatMap((r) => [
        sql(env, "UPDATE documents SET indexed=1 WHERE vector_id=?", r.id),
        sql(
          env,
          "DELETE FROM embedding_outbox WHERE id=? AND operation='upsert' AND EXISTS(SELECT 1 FROM documents WHERE vector_id=?)",
          r.id,
          r.id,
        ),
      ]),
    );
  }
}
