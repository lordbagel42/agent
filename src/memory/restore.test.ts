import { createCipheriv, randomBytes } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createInspectionReader } from "../runtime/inspection.js";
import { CuratedPersonalityStore } from "./curated.js";
import {
  EvidenceStore,
  type Source,
  type TombstoneExportPage,
  tombstoneExportMac,
} from "./store.js";

const forgotten: Source = {
  id: "secret-source",
  audiences: ["private"],
  platform: "slack",
  account: "workspace",
  conversation: "dm",
  author: "owner",
  observedAt: 100,
  sourceUrl: "https://example.com/private",
  text: "secret lavender tone",
  correction: { trait: "tone", value: "secret lavender" },
};

it("commits complete retained replay before the first index and keeps every read surface forgotten across reopen", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "june-restore-"));
  const path = join(root, "current.sqlite");
  const snapshot = join(root, "snapshot.sqlite");
  const key = randomBytes(32);
  const curatedKey = randomBytes(32);
  const stores: EvidenceStore[] = [];
  const personalities: CuratedPersonalityStore[] = [];
  t.onTestFinished(() => {
    vi.restoreAllMocks();
    for (const personality of personalities) personality.close();
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const original = new EvidenceStore(path, key);
  stores.push(original);
  original.deleteSource("already-forgotten");
  original.appendSource(forgotten);
  const unrelated = { ...forgotten, id: "unrelated", correction: undefined };
  original.appendSource(unrelated);
  const claim = {
    id: "derived",
    entity: "owner",
    text: "secret hypothesis",
    audiences: ["private"],
    kind: "evidence" as const,
    dependsOn: [forgotten.id],
    contradicts: [],
    supersedes: [],
  };
  original.appendClaim(claim);
  original.appendClaim({
    ...claim,
    id: "related",
    dependsOn: [unrelated.id],
    contradicts: [claim.id],
  });
  original.stageProposals(
    "private",
    [forgotten.id],
    [
      {
        subjectSourceId: forgotten.id,
        text: "secret pending proposal",
        category: "preference",
        citations: [{ sourceId: forgotten.id, quote: forgotten.text }],
        confidence: 0.6,
        validFrom: null,
        validTo: null,
        contradicts: [],
        supersedes: [],
      },
    ],
  );
  const personality = new CuratedPersonalityStore(
    join(root, "curated"),
    curatedKey,
    original,
    { initialize: true },
  );
  personalities.push(personality);
  const revision = personality.ownerRevise(
    {
      id: "private-revision",
      scope: "private",
      trait: "tone",
      value: "secret lavender",
      basis: "owner-correction",
      evidenceIds: [forgotten.id],
      explanation: "private reason",
      confidence: 1,
    },
    original.reflectionEvidence("private", [forgotten.id], 1000),
    200,
    1000,
  );
  expect(personality.effectiveTraits("private", revision)).toEqual({
    tone: "secret lavender",
  });
  personality.close();
  original.close();
  copyFileSync(path, snapshot);
  const current = new EvidenceStore(path, key);
  stores.push(current);
  current.deleteSource(forgotten.id);
  const watermark = current.deletionRevision();
  expect(watermark).toBe(5); // old deletion, original, two claims, pending proposal
  const pages: TombstoneExportPage[] = [];
  let after: number | null = 0;
  do {
    const page: TombstoneExportPage = current.exportTombstones({
      after,
      watermark,
      limit: 2,
    });
    pages.push(page);
    after = page.nextAfter;
  } while (after !== null);
  current.close();

  const observer = new DatabaseSync(snapshot, { readOnly: true });
  t.onTestFinished(() => observer.close());
  const persisted = () =>
    observer.prepare("SELECT payload FROM records WHERE id=1").get()?.payload;
  const beforeReplay = persisted();
  const rebuild = EvidenceStore.prototype.rebuildIndex;
  let consumed = false;
  const firstIndex = vi
    .spyOn(EvidenceStore.prototype, "rebuildIndex")
    .mockImplementation(function (this: EvidenceStore) {
      expect(consumed).toBe(true);
      // A separate connection still sees the old payload until COMMIT.
      expect(persisted()).not.toEqual(beforeReplay);
      expect(this.restoreStatus()).toEqual({
        ready: true,
        replayedThrough: 5,
        deletionWatermark: 5,
      });
      expect(this.isDeleted(forgotten.id)).toBe(true);
      expect(this.proposals("private")).toEqual([]);
      rebuild.call(this);
    });
  function* retainedPages() {
    for (const page of pages) {
      expect(firstIndex).not.toHaveBeenCalled();
      yield page;
    }
    consumed = true;
  }
  const restored = new EvidenceStore(snapshot, key, {
    sources: 3,
    restore: { watermark, pages: retainedPages() },
  });
  stores.push(restored);
  expect(restored.importBudget.sources).toBe(3);
  expect(firstIndex).toHaveBeenCalledTimes(1);
  firstIndex.mockRestore();
  expect(restored.retrieve("private", "")).toEqual({
    sources: [unrelated],
    claims: [],
  });
  expect(restored.source("private", forgotten.id)).toBeUndefined();
  expect(restored.independentEvidence("related", "private")).toEqual([]);
  expect(() =>
    restored.reflectionEvidence("private", [forgotten.id], 1000),
  ).toThrow();
  expect(() => restored.appendSource(forgotten)).toThrow("Tombstoned");
  const reopenedPersonality = new CuratedPersonalityStore(
    join(root, "curated"),
    curatedKey,
    restored,
  );
  personalities.push(reopenedPersonality);
  expect(reopenedPersonality.effectiveTraits("private", revision)).toEqual({});
  expect(reopenedPersonality.effectiveTraits("private")).toEqual({});
  const report = await createInspectionReader({
    audience: "private",
    memory: { store: restored },
    selections: {},
  })("memory");
  expect(report).toContain("Memory readiness: ready");
  expect(report).toContain("complete through watermark 5");
  expect(report).toContain("not proof of current independent retention");
  expect(report).not.toContain("secret");
  restored.deleteSource(unrelated.id);
  restored.close();
  const reopened = new EvidenceStore(snapshot, key);
  stores.push(reopened);
  expect(reopened.restoreStatus()).toEqual({
    ready: true,
    replayedThrough: 5,
    deletionWatermark: 6,
  });
  expect(reopened.search("private", "")).toEqual({ sources: [], claims: [] });
  reopened.close();
  const repeated = new EvidenceStore(snapshot, key, {
    restore: { watermark, pages },
  });
  stores.push(repeated);
  expect(repeated.deletionRevision()).toBe(6);
  expect(repeated.search("private", "")).toEqual({ sources: [], claims: [] });
});

it("never indexes or partially commits incomplete, stale, reordered or mismatched replay", (t) => {
  const root = mkdtempSync(join(tmpdir(), "june-replay-invalid-"));
  const path = join(root, "snapshot.sqlite");
  const key = randomBytes(32);
  t.onTestFinished(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  const original = new EvidenceStore(path, key);
  original.deleteSource("prior");
  original.appendSource(forgotten);
  original.appendClaim({
    id: "derived",
    entity: "owner",
    text: "secret hypothesis",
    audiences: ["private"],
    kind: "evidence",
    dependsOn: [forgotten.id],
    contradicts: [],
    supersedes: [],
  });
  original.close();
  const before = readFileSync(path);
  const retentionPath = join(root, "retention.sqlite");
  copyFileSync(path, retentionPath);
  const retention = new EvidenceStore(retentionPath, key);
  retention.deleteSource(forgotten.id);
  const first = retention.exportTombstones({ limit: 1 });
  const last = retention.exportTombstones({ after: 1, watermark: 3 });
  const stale = retention.exportTombstones({ watermark: 1 });
  retention.close();
  const otherLedger = new EvidenceStore(join(root, "other.sqlite"), key);
  for (const id of ["prior", forgotten.id, "derived"])
    otherLedger.deleteSource(id);
  const unrelatedLedgerPage = otherLedger.exportTombstones();
  otherLedger.close();
  const rebuild = vi.spyOn(EvidenceStore.prototype, "rebuildIndex");
  for (const restore of [null, false, 0, ""]) {
    expect(
      () => new EvidenceStore(path, key, { restore: restore as never }),
    ).toThrow();
    expect(rebuild).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(before);
  }
  const invalid = [
    [],
    [first],
    [last],
    [last, first],
    [first, first, last],
    [first, { ...last, watermark: 2 }],
    [first, { ...last, after: 2 }],
    [first, { ...last, nextAfter: 3 }],
    [{ ...first, tombstones: ["wrong-ledger-prefix"] }, last],
    [first, { ...last, tombstones: [forgotten.id, forgotten.id] }],
    [first, { ...last, tombstones: [forgotten.id, "omits-derived"] }],
    [{ ...first, tombstones: [], nextAfter: 0 }, last],
    [first, last, { ...last, after: 3, tombstones: [] }],
    [stale],
    [unrelatedLedgerPage],
  ];
  for (const input of invalid) {
    // Valid signatures isolate sequence/prefix/graph validation from MAC checks.
    const pages = input.map((page) => ({
      ...page,
      mac: tombstoneExportMac(key, page).toString("hex"),
    }));
    expect(
      () => new EvidenceStore(path, key, { restore: { watermark: 3, pages } }),
    ).toThrow("could not be authenticated or opened");
    expect(rebuild).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(before);
  }
  for (const tombstones of [
    ["prior", ...Array.from({ length: 100 }, (_, i) => `id-${i}`)],
    [
      "prior",
      ...Array.from({ length: 12 }, (_, i) => `${i}${"界".repeat(2040)}`),
    ],
  ]) {
    const page = {
      ...first,
      tombstones,
      watermark: tombstones.length,
      nextAfter: null,
    };
    page.mac = tombstoneExportMac(key, page).toString("hex");
    expect(
      () =>
        new EvidenceStore(path, key, {
          restore: { watermark: page.watermark, pages: [page] },
        }),
    ).toThrow();
    expect(rebuild).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(before);
  }
  for (const page of [
    { ...last, tombstones: ["tampered-source", "derived"] },
    { ...last, mac: "0".repeat(64) },
    { ...last, mac: tombstoneExportMac(randomBytes(32), last).toString("hex") },
    { ...last, mac: undefined },
  ]) {
    expect(
      () =>
        new EvidenceStore(path, key, {
          restore: { watermark: 3, pages: [first, page] },
        }),
    ).toThrow();
    expect(rebuild).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(before);
  }
  expect(
    () =>
      new EvidenceStore(path, randomBytes(32), {
        restore: { watermark: 3, pages: [first, last] },
      }),
  ).toThrow();
  expect(rebuild).not.toHaveBeenCalled();
  expect(readFileSync(path)).toEqual(before);
  function* interrupted() {
    yield first;
    throw new Error("private retained path must not escape");
  }
  expect(
    () =>
      new EvidenceStore(path, key, {
        restore: { watermark: 3, pages: interrupted() },
      }),
  ).toThrow("could not be authenticated or opened");
  expect(rebuild).not.toHaveBeenCalled();
  expect(readFileSync(path)).toEqual(before);
  rebuild.mockRestore();
  const restored = new EvidenceStore(path, key, {
    restore: { watermark: 3, pages: [first, last] },
  });
  try {
    expect(restored.search("private", "")).toEqual({ sources: [], claims: [] });
  } finally {
    restored.close();
  }

  // An authenticated pre-identity snapshot must not be silently migrated into
  // a new ledger during restore, even when its old prefix happens to match.
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("june-evidence-v1"));
  const encrypted = Buffer.concat([
    cipher.update(
      JSON.stringify({
        version: 1,
        sources: [forgotten],
        claims: [],
        tombstones: ["prior"],
        imports: [],
      }),
      "utf8",
    ),
    cipher.final(),
  ]);
  const db = new DatabaseSync(path);
  db.prepare("UPDATE records SET payload=? WHERE id=1").run(
    Buffer.concat([nonce, cipher.getAuthTag(), encrypted]),
  );
  db.close();
  const legacy = readFileSync(path);
  const legacyIndex = vi.spyOn(EvidenceStore.prototype, "rebuildIndex");
  expect(
    () =>
      new EvidenceStore(path, key, {
        restore: { watermark: 3, pages: [first, last] },
      }),
  ).toThrow();
  expect(legacyIndex).not.toHaveBeenCalled();
  expect(readFileSync(path)).toEqual(legacy);
});

it("rejects suppressed persistence and journal conversion without indexing or changing the snapshot", (t) => {
  const root = mkdtempSync(join(tmpdir(), "june-replay-sqlite-"));
  const path = join(root, "snapshot.sqlite");
  const key = randomBytes(32);
  t.onTestFinished(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  const original = new EvidenceStore(path, key);
  original.appendSource(forgotten);
  original.close();
  const retentionPath = join(root, "retention.sqlite");
  copyFileSync(path, retentionPath);
  const retention = new EvidenceStore(retentionPath, key);
  retention.deleteSource(forgotten.id);
  const pages = [retention.exportTombstones()];
  retention.close();
  const db = new DatabaseSync(path);
  const payload = Buffer.from(
    db.prepare("SELECT payload FROM records WHERE id=1").get()
      ?.payload as Uint8Array,
  ).toString("hex");
  db.exec(
    "CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)",
  );
  db.close();
  const index = vi.spyOn(EvidenceStore.prototype, "rebuildIndex");
  for (const trigger of [
    "BEFORE UPDATE ON records BEGIN SELECT RAISE(IGNORE); END",
    `AFTER UPDATE ON records BEGIN UPDATE records SET payload=x'${payload}' WHERE id=1; END`,
    "BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    "AFTER UPDATE ON records BEGIN INSERT INTO child VALUES(1); END",
  ]) {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TRIGGER block_replay ${trigger}`);
    db.close();
    const before = readFileSync(path);
    expect(
      () => new EvidenceStore(path, key, { restore: { watermark: 1, pages } }),
    ).toThrow("could not be authenticated or opened");
    expect(index).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(before);
    const cleanup = new DatabaseSync(path);
    cleanup.exec("DROP TRIGGER block_replay");
    cleanup.close();
  }
  const recovered = new EvidenceStore(path, key, {
    restore: { watermark: 1, pages },
  });
  expect(recovered.source("private", forgotten.id)).toBeUndefined();
  recovered.close();
  index.mockClear();
  const alias = join(root, "alias.sqlite");
  symlinkSync(path, alias);
  writeFileSync(`${path}-journal`, "");
  const aliasBefore = readFileSync(path);
  expect(
    () => new EvidenceStore(alias, key, { restore: { watermark: 1, pages } }),
  ).toThrow("could not be authenticated or opened");
  expect(index).not.toHaveBeenCalled();
  expect(readFileSync(path)).toEqual(aliasBefore);
  rmSync(`${path}-journal`);
  const wal = new DatabaseSync(path);
  wal.exec("PRAGMA journal_mode=WAL");
  wal.close();
  const before = readFileSync(path);
  expect(
    () => new EvidenceStore(path, key, { restore: { watermark: 1, pages } }),
  ).toThrow("could not be authenticated or opened");
  expect(index).not.toHaveBeenCalled();
  expect(readFileSync(path)).toEqual(before);
  index.mockRestore();

  const emptyPath = join(root, "empty.sqlite");
  const empty = new EvidenceStore(emptyPath, key);
  const emptyPage = empty.exportTombstones();
  empty.close();
  expect(
    () =>
      new EvidenceStore(emptyPath, key, {
        restore: { watermark: 0, pages: [] },
      }),
  ).toThrow();
  const zero = new EvidenceStore(emptyPath, key, {
    restore: { watermark: 0, pages: [emptyPage] },
  });
  try {
    expect(zero.restoreStatus()).toEqual({
      ready: true,
      replayedThrough: 0,
      deletionWatermark: 0,
    });
  } finally {
    zero.close();
  }
});
