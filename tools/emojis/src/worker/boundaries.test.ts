import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";
import {
  catalogSources,
  type EmojiLease,
  type IndexStatus,
  resultSchema,
  type SearchHit,
} from "../shared.js";
import worker from "./index.js";
import { drainEmbeddings, sql } from "./store.js";

type SearchResponse = {
  results: SearchHit[];
  mode: string;
  semanticAvailable: boolean;
  degraded?: string;
};

test("local D1: role boundaries, lease fencing, idempotency, alias/removal and signed events", async () => {
  const platform = await getPlatformProxy<Env>({
    persist: false,
    remoteBindings: false,
  });
  try {
    let failAI = false;
    const vectors = new Map<string, number[]>();
    const env: Env = {
      ...platform.env,
      READ_TOKEN: randomUUID(),
      INDEXER_TOKEN: randomUUID(),
      ADMIN_TOKEN: randomUUID(),
      SLACK_SIGNING_SECRET: randomUUID(),
      SLACK_BOT_TOKEN: "unused-local-fixture",
      AI: new Proxy(platform.env.AI, {
        get: (_target, key) =>
          key === "run"
            ? async (_model: string, input: { text: string[] }) => {
                if (failAI) throw new Error("private_provider_failure");
                return { data: input.text.map(() => Array(384).fill(0.5)) };
              }
            : undefined,
      }),
      VECTORS: new Proxy(platform.env.VECTORS, {
        get: (_target, key) => {
          if (key === "upsert")
            return async (rows: { id: string; values: number[] }[]) => {
              for (const row of rows) vectors.set(row.id, row.values);
              return { mutationId: randomUUID() };
            };
          if (key === "deleteByIds")
            return async (ids: string[]) => {
              for (const id of ids) vectors.delete(id);
              return { mutationId: randomUUID() };
            };
          if (key === "query")
            return async () => ({
              matches: [...vectors.keys()].map((id) => ({ id, score: 0.9 })),
              count: vectors.size,
            });
          return undefined;
        },
      }),
    };
    const migration = await readFile(
      new URL("../../migrations/0001_catalog.sql", import.meta.url),
      "utf8",
    );
    await env.DB.batch(
      unstable_splitSqlQuery(migration).map((text) => env.DB.prepare(text)),
    );
    const request = async (path: string, token: string, body?: unknown) =>
      worker.fetch(
        new Request(`https://local.test${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        env,
      );
    assert.equal((await request("/api/status", "wrong")).status, 401);
    assert.equal(
      (await request("/api/search?q=cat", env.ADMIN_TOKEN)).status,
      401,
    );
    assert.equal(
      (await request("/api/jobs/claim", env.READ_TOKEN, {})).status,
      401,
    );
    assert.equal(
      (
        await request("/api/import", env.INDEXER_TOKEN, {
          sources: [],
          results: [],
        })
      ).status,
      401,
    );
    assert.equal((await request("/api/status", env.INDEXER_TOKEN)).status, 401);
    assert.equal((await request("/api/catalog", env.READ_TOKEN)).status, 404);
    const sources = await catalogSources({
      cat: "https://emoji.slack-edge.com/cat.png",
      kitty: "alias:cat",
    });
    const source = sources.find((s) => s.name === "cat");
    assert.ok(source);
    assert.equal(
      (await request("/api/import", env.ADMIN_TOKEN, { sources, results: [] }))
        .status,
      200,
    );
    const claims = await Promise.all([
      request("/api/jobs/claim", env.INDEXER_TOKEN, {}),
      request("/api/jobs/claim", env.INDEXER_TOKEN, {}),
    ]);
    const leases = await Promise.all(
      claims.map((r) => r.json<{ lease: EmojiLease | null }>()),
    );
    const lease = leases.find((v) => v.lease)?.lease;
    assert.ok(lease);
    assert.equal(leases.filter((v) => v.lease).length, 1);
    const result = resultSchema.parse({
      schemaVersion: 1,
      source,
      media: {
        hash: "a".repeat(64),
        mime: "image/png",
        width: 64,
        height: 64,
        frames: 1,
        sampledFrames: [0],
      },
      analysis: {
        summary: "A happy cat",
        description:
          "A small happy cat with a friendly face and cheerful eyes.",
        visibleText: [],
        subjects: ["cat"],
        actions: [],
        colors: [],
        style: [],
        emotions: ["happy"],
        tags: [],
        usageExamples: [],
        interpretation: "",
        uncertainties: [],
        confidence: "high",
        animationDescription: "",
        embeddingText: "happy cat friendly face",
      },
      provenance: {
        provider: "codex",
        model: "fixture",
        promptVersion: "emoji-vision-1",
        indexedAt: new Date().toISOString(),
        durationMs: 1,
      },
    });
    assert.equal(
      (
        await request("/api/jobs/complete", env.INDEXER_TOKEN, {
          leaseId: randomUUID(),
          result,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request("/api/jobs/heartbeat", env.INDEXER_TOKEN, {
          leaseId: lease.id,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/jobs/complete", env.INDEXER_TOKEN, {
          leaseId: lease.id,
          result,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/jobs/complete", env.INDEXER_TOKEN, {
          leaseId: lease.id,
          result,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/jobs/complete", env.INDEXER_TOKEN, {
          leaseId: lease.id,
          result: {
            ...result,
            analysis: { ...result.analysis, summary: "Different" },
          },
        })
      ).status,
      409,
    );
    let search = await (
      await request("/api/search?q=happy&mode=keyword", env.READ_TOKEN)
    ).json<SearchResponse>();
    assert.equal(search.results.length, 2);
    assert.ok(
      search.results.some(
        (r: { name: string; summary: string }) =>
          r.name === "kitty" && r.summary === "A happy cat",
      ),
    );
    failAI = true;
    await assert.rejects(drainEmbeddings(env));
    assert.ok(
      (
        await sql(env, "SELECT count(*) AS n FROM embedding_outbox").first<{
          n: number;
        }>()
      )?.n,
    );
    search = await (
      await request("/api/search?q=cat", env.READ_TOKEN)
    ).json<SearchResponse>();
    assert.equal(search.mode, "keyword");
    assert.equal(search.semanticAvailable, false);
    assert.equal(search.degraded, "semantic_unavailable");
    failAI = false;
    await drainEmbeddings(env);
    assert.ok(vectors.size);
    assert.equal(
      (await request("/api/reindex", env.ADMIN_TOKEN, { name: "cat" })).status,
      200,
    );
    const second = (
      await (
        await request("/api/jobs/claim", env.INDEXER_TOKEN, {})
      ).json<{ lease: EmojiLease | null }>()
    ).lease;
    assert.ok(second);
    const replacement = await catalogSources({
      cat: "https://emoji.slack-edge.com/new.png",
      kitty: "alias:cat",
    });
    assert.equal(
      (
        await request("/api/import", env.ADMIN_TOKEN, {
          sources: replacement,
          results: [],
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/jobs/complete", env.INDEXER_TOKEN, {
          leaseId: second.id,
          result,
        })
      ).status,
      409,
    );
    search = await (
      await request("/api/search?q=happy", env.READ_TOKEN)
    ).json<SearchResponse>();
    assert.equal(search.results.length, 0);
    const third = (
      await (
        await request("/api/jobs/claim", env.INDEXER_TOKEN, {})
      ).json<{ lease: EmojiLease | null }>()
    ).lease;
    assert.ok(third);
    await sql(
      env,
      "UPDATE jobs SET expires_at=0 WHERE lease_id=?",
      third.id,
    ).run();
    assert.equal(
      (
        await (
          await request("/api/jobs/claim", env.INDEXER_TOKEN, {})
        ).json<{ lease: EmojiLease | null }>()
      ).lease,
      null,
    );
    assert.equal(
      (await (await request("/api/status", env.READ_TOKEN)).json<IndexStatus>())
        .counts.unknown,
      1,
    );
    await sql(env, "DELETE FROM sources").run();
    search = await (
      await request("/api/search?q=cat", env.READ_TOKEN)
    ).json<SearchResponse>();
    assert.equal(search.results.length, 0);
    assert.equal(
      (
        await sql(env, "SELECT count(*) AS n FROM documents_fts").first<{
          n: number;
        }>()
      )?.n,
      0,
    );
    const signed = async (
      team: string,
      stamp = String(Math.floor(Date.now() / 1000)),
    ) => {
      const raw = JSON.stringify({
        type: "event_callback",
        team_id: team,
        event: { type: "emoji_changed" },
      });
      const sig = createHmac("sha256", env.SLACK_SIGNING_SECRET)
        .update(`v0:${stamp}:${raw}`)
        .digest("hex");
      return worker.fetch(
        new Request("https://local.test/slack/events", {
          method: "POST",
          headers: {
            "x-slack-request-timestamp": stamp,
            "x-slack-signature": `v0=${sig}`,
          },
          body: raw,
        }),
        env,
      );
    };
    assert.equal((await signed("OTHER")).status, 403);
    assert.equal((await signed("T0266FRGM", "1000000000")).status, 401);
    const before =
      (
        await sql(env, "SELECT dirty FROM sync_state").first<{
          dirty: number;
        }>()
      )?.dirty ?? 0;
    assert.equal((await signed("T0266FRGM")).status, 200);
    assert.equal(
      (
        await sql(env, "SELECT dirty FROM sync_state").first<{
          dirty: number;
        }>()
      )?.dirty,
      before + 1,
    );
  } finally {
    await platform.dispose();
  }
});
