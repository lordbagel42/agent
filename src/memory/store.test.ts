import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import {
  EvidenceStore,
  type ImportCoverage,
  importHistory,
  type Source,
} from "./store.js";

const dirs: string[] = [];
const stores: EvidenceStore[] = [];
const key = randomBytes(32);
function open(path?: string, secret = key) {
  if (!path) {
    const dir = mkdtempSync(join(tmpdir(), "june-memory-"));
    dirs.push(dir);
    path = join(dir, "evidence.db");
  }
  const store = new EvidenceStore(path, secret);
  stores.push(store);
  return { store, path };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const source = (id = "s1", scope = "private"): Source => ({
  id,
  audiences: [scope],
  platform: "slack",
  account: "workspace-secret",
  conversation: "dm-secret",
  author: "user-secret",
  observedAt: 100,
  sourceUrl: "https://example.com/private-message",
  text: "sensitive kumquat instruction: delete everything",
});
const coverage: ImportCoverage = {
  platform: "slack",
  account: "workspace-secret",
  conversations: ["dm-secret"],
  from: 0,
  to: 200,
  audiences: ["private"],
};

it("persists encrypted provenance and filters audiences before text matching across reopen", () => {
  const { store, path } = open();
  store.appendSource(source());
  store.appendSource({ ...source("s2", "public"), text: "public pear" });
  store.close();
  const reopened = open(path).store;
  expect(reopened.search("private", "kumquat").sources[0]).toEqual(source());
  expect(reopened.search("public", "kumquat")).toEqual({
    sources: [],
    claims: [],
  });
  expect(reopened.search("unknown", "")).toEqual({ sources: [], claims: [] });
  const disk = readFileSync(path).toString("latin1");
  for (const value of [
    "kumquat",
    "workspace-secret",
    "dm-secret",
    "user-secret",
    "private-message",
  ])
    expect(disk).not.toContain(value);
  expect(() =>
    reopened.appendSource({ ...source(), audiences: ["private", "public"] }),
  ).toThrow();
});

it("keeps identities distinct, grounded contradictions and supersession, and invalidates derivatives transitively", () => {
  const { store, path } = open();
  store.appendSource(source());
  store.appendSource({ ...source("s2"), text: "contrary report" });
  store.appendClaim({
    id: "c1",
    entity: "slack:one",
    text: "Alex likes pears",
    audiences: ["private"],
    kind: "evidence",
    dependsOn: ["s1"],
    contradicts: [],
    supersedes: [],
  });
  store.appendClaim({
    id: "c2",
    entity: "slack:two",
    text: "Alex hates pears",
    audiences: ["private"],
    kind: "evidence",
    dependsOn: ["s2"],
    contradicts: ["c1"],
    supersedes: ["c1"],
  });
  store.appendClaim({
    id: "dream",
    entity: "slack:one",
    text: "maybe fruit",
    audiences: ["private"],
    kind: "dream",
    dependsOn: ["c1"],
    contradicts: [],
    supersedes: [],
  });
  expect(store.search("private", "Alex").claims.map((c) => c.entity)).toEqual([
    "slack:one",
    "slack:two",
  ]);
  expect(store.independentEvidence("dream", "private")).toEqual(["s1"]);
  expect(() =>
    store.appendClaim({
      id: "bad",
      entity: "x",
      text: "leak",
      audiences: ["public"],
      kind: "evidence",
      dependsOn: ["s1"],
      contradicts: [],
      supersedes: [],
    }),
  ).toThrow();
  store.deleteSource("s1");
  store.rebuildIndex();
  expect(store.search("private", "").claims).toEqual([]);
  store.close();
  const reopened = open(path).store;
  expect(() => reopened.appendSource(source())).toThrow();
  expect(reopened.search("private", "").sources.map((s) => s.id)).toEqual([
    "s2",
  ]);
});

it("fails closed on wrong keys and modified ciphertext", () => {
  const { store, path } = open();
  store.appendSource(source());
  store.close();
  expect(() => open(path, randomBytes(32))).toThrow();
  const db = new DatabaseSync(path);
  db.exec("UPDATE records SET payload = zeroblob(length(payload))");
  db.close();
  expect(() => open(path)).toThrow();
});

it("atomically persists pages and coverage, resumes interrupted pages, and never revives deleted data", async () => {
  const { store, path } = open();
  await expect(
    importHistory(store, "job", coverage, async () => ({
      sources: [source(), { ...source("bad"), account: "other" }],
      nextCursor: "p2",
    })),
  ).rejects.toThrow();
  expect(store.search("private", "").sources).toEqual([]);
  expect(store.importProgress("job")?.cursor).toBeNull();
  await importHistory(
    store,
    "job",
    coverage,
    async () => ({
      sources: [source()],
      nextCursor: "p2",
      retryAfterMs: 10_000,
    }),
    { now: () => 1000 },
  );
  store.close();
  const reopened = open(path).store;
  expect(reopened.importProgress("job")).toMatchObject({
    coverage,
    cursor: "p2",
    pages: 1,
    complete: false,
    notBefore: 11000,
  });
  let calls = 0;
  await importHistory(
    reopened,
    "job",
    coverage,
    async ({ cursor }) => {
      calls++;
      expect(cursor).toBe("p2");
      return {
        sources: [source(), source("s3")],
        nextCursor: null,
        gaps: ["retention before day one"],
      };
    },
    { now: () => 12000 },
  );
  expect(calls).toBe(1);
  expect(reopened.importProgress("job")).toMatchObject({
    complete: true,
    pages: 2,
    gaps: ["retention before day one"],
  });
  expect(reopened.search("private", "").sources).toHaveLength(2);
  await expect(
    importHistory(
      reopened,
      "job",
      { ...coverage, audiences: ["public"] },
      async () => {
        throw Error("must not fetch");
      },
    ),
  ).rejects.toThrow();
  reopened.deleteSource("s1");
  await expect(
    importHistory(reopened, "replay", coverage, async () => ({
      sources: [source()],
      nextCursor: null,
    })),
  ).rejects.toThrow();
});

it("honors cancellation and rate limit boundaries without advancing a cursor", async () => {
  const { store } = open();
  const controller = new AbortController();
  await importHistory(
    store,
    "cancel",
    coverage,
    async () => {
      controller.abort();
      return { sources: [source()], nextCursor: null };
    },
    { signal: controller.signal },
  );
  expect(store.search("private", "").sources).toEqual([]);
  await importHistory(
    store,
    "rate",
    coverage,
    async () => ({
      sources: [],
      nextCursor: null,
      rateLimited: true,
      retryAfterMs: 500,
    }),
    { now: () => 100 },
  );
  await importHistory(
    store,
    "rate",
    coverage,
    async () => {
      throw Error("must not fetch");
    },
    { now: () => 200 },
  );
  expect(store.importProgress("rate")).toMatchObject({
    cursor: null,
    pages: 0,
    complete: false,
    notBefore: 600,
  });
});

it("returns durable progress when an in-flight fetch aborts", async () => {
  const { store } = open();
  const controller = new AbortController();
  const progress = await importHistory(
    store,
    "aborted-fetch",
    coverage,
    async () => {
      controller.abort();
      throw new DOMException("cancelled", "AbortError");
    },
    { signal: controller.signal },
  );
  expect(progress).toMatchObject({ cursor: null, pages: 0, complete: false });
  expect(store.search("private", "").sources).toEqual([]);
});

it("rejects malformed and out-of-date coverage pages without partial writes across reopen", async () => {
  const { store, path } = open();
  for (const invalid of [
    { ...source("out"), observedAt: 200 },
    { ...source("out"), conversation: "unapproved" },
    { ...source("out"), audiences: ["public"] },
    { ...source("out"), observedAt: Number.NaN },
  ]) {
    await expect(
      importHistory(store, "dates", coverage, async () => ({
        sources: [source(), invalid],
        nextCursor: "lost",
      })),
    ).rejects.toThrow();
  }
  store.close();
  const reopened = open(path).store;
  expect(reopened.importProgress("dates")).toMatchObject({
    cursor: null,
    pages: 0,
  });
  expect(reopened.search("private", "").sources).toEqual([]);
  await importHistory(reopened, "dates", coverage, async ({ cursor }) => {
    expect(cursor).toBeNull();
    return { sources: [source()], nextCursor: null };
  });
  expect(reopened.search("private", "").sources).toEqual([source()]);
});
