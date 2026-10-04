import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { DebugSitePublisher } from "./contracts.js";
import {
  DiagnosticConflictError,
  DiagnosticStorageError,
  DiagnosticStore,
  DiagnosticValidationError,
  MAX_SNAPSHOT_BYTES,
  snapshotIdSchema,
  validateSnapshot,
} from "./store.js";

type Snapshot = Parameters<DebugSitePublisher["publish"]>[0];
const firstId = "10000000-0000-4000-8000-000000000001";
const secondId = "10000000-0000-4000-8000-000000000002";
const thirdId = "10000000-0000-4000-8000-000000000003";
const folders: string[] = [];
const stores: DiagnosticStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function folder() {
  const path = mkdtempSync(join(tmpdir(), "june-diagnostics-"));
  folders.push(path);
  return path;
}

function open(file: string) {
  const store = new DiagnosticStore(file);
  stores.push(store);
  return store;
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: firstId,
    sessionId: "session-archive",
    capturedAt: "2026-10-04T12:00:00.000Z",
    revision: "abc123",
    scope: ["slack:team:private"],
    reason: "A delayed reply ☃",
    data: {
      history: [{ text: "private body", nested: [null, true, { n: 3 }] }],
      arbitrary: { __proto__: null, "odd.key": [1, "two"] },
    },
    exclusions: ["private exclusion body"],
    ...overrides,
  };
}

it("reopens complete historical snapshots and never replaces an existing identity", () => {
  const file = join(folder(), "archive", "snapshots.sqlite");
  const original = snapshot();
  const store = open(file);
  expect(store.put(original)).toBe("created");
  expect(store.put(JSON.parse(JSON.stringify(original)))).toBe("exists");
  store.close();

  const reopened = open(file);
  expect(reopened.get(firstId)).toEqual(original);
  expect(reopened.get(secondId)).toBeUndefined();
  expect(reopened.put(original)).toBe("exists");
  expect(() => reopened.put(snapshot({ data: { replaced: true } }))).toThrow(
    DiagnosticConflictError,
  );
  expect(() => reopened.put(snapshot({ reason: "different" }))).toThrow(
    DiagnosticConflictError,
  );
  const retrieved = reopened.get(firstId);
  if (retrieved) retrieved.reason = "caller mutation";
  expect(reopened.get(firstId)).toEqual(original);
  expect(reopened.list().total).toBe(1);
});

it("orders by capture instant then id, paginates and returns metadata only", () => {
  const store = open(join(folder(), "snapshots.sqlite"));
  const newest = snapshot({
    id: thirdId,
    capturedAt: "2026-10-04T11:00:00.000-02:00",
    reporter: {
      channel: "slack",
      accountId: "team",
      senderId: "owner",
      isOwner: true,
    },
    snapshotOnly: true,
  });
  store.put(snapshot({ id: secondId }));
  store.put(newest);
  store.put(snapshot());
  const page = store.list({ limit: 2 });
  expect(page.items.map((item) => item.id)).toEqual([thirdId, firstId]);
  expect(page.total).toBe(3);
  expect(page.nextOffset).toBe(2);
  const { data: _data, exclusions: _exclusions, ...metadata } = newest;
  expect(page.items[0]).toEqual({
    ...metadata,
    bytes: Buffer.byteLength(JSON.stringify(newest)),
  });
  expect(JSON.stringify(page)).not.toContain("private body");
  expect(JSON.stringify(page)).not.toContain("private exclusion body");
  expect(store.list({ offset: 2, limit: 2 })).toMatchObject({
    items: [{ id: secondId }],
    total: 3,
    nextOffset: null,
  });
  expect(store.list({ offset: 99 })).toEqual({
    items: [],
    total: 3,
    nextOffset: null,
  });
});

it("searches all retained metadata literally, not SQL or private bodies", () => {
  const store = open(join(folder(), "snapshots.sqlite"));
  store.put(snapshot({ reason: "100%_ delayed" }));
  store.put(snapshot({ id: secondId, reason: "other", scope: [] }));
  for (const query of [
    "100%_",
    firstId,
    "SESSION-ARCHIVE",
    "abc123",
    "PRIVATE",
  ])
    expect(store.list({ query }).items.map((item) => item.id)).toContain(
      firstId,
    );
  expect(store.list({ query: "%_" }).total).toBe(1);
  expect(store.list({ query: "' OR 1=1 --" }).total).toBe(0);
  expect(store.list({ query: "private body" }).total).toBe(0);
  expect(store.list({ query: "private exclusion body" }).total).toBe(0);
  expect(store.list({ query: "archive", limit: 1 })).toMatchObject({
    total: 2,
    nextOffset: 1,
  });
  expect(() => store.list({ query: "x".repeat(513) })).toThrow(
    DiagnosticValidationError,
  );
  for (const options of [
    { offset: -1 },
    { offset: 0.5 },
    { limit: 0 },
    { limit: 101 },
    { limit: Number.NaN },
  ])
    expect(() => store.list(options)).toThrow(DiagnosticValidationError);
});

it("validates metadata and byte limits without rewriting arbitrary nested data", () => {
  const original = snapshot({
    data: JSON.parse('{"__proto__":{"x":1},"x":[null,0,"☃"]}'),
  });
  expect(validateSnapshot(original)).toEqual(original);
  expect(snapshotIdSchema.safeParse(firstId).success).toBe(true);
  const invalid = [
    { id: "../secret" },
    { id: "10000000-0000-0000-0000-000000000001" },
    { sessionId: "" },
    { capturedAt: "2026-02-30T00:00:00Z" },
    { capturedAt: "yesterday" },
    { revision: 42 },
    { scope: [null] },
    { reason: 42 },
    { reporter: { channel: "slack", accountId: "t", senderId: "s" } },
    { snapshotOnly: "yes" },
    { exclusions: [42] },
    { data: undefined },
  ];
  for (const fields of invalid)
    expect(() => validateSnapshot({ ...snapshot(), ...fields })).toThrow(
      DiagnosticValidationError,
    );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => validateSnapshot(snapshot({ data: cyclic }))).toThrow(
    DiagnosticValidationError,
  );
  const store = open(join(folder(), "snapshots.sqlite"));
  expect(() => store.get("bad-id-private-text")).toThrow(
    DiagnosticValidationError,
  );
  const oversized = snapshot({
    data: "☃".repeat(Math.ceil(MAX_SNAPSHOT_BYTES / 3)),
  });
  expect(() => store.put(oversized)).toThrow(DiagnosticValidationError);
  expect(store.list().total).toBe(0);
});

it("creates private storage and rejects symlinks, hard links and exposed files without chmod", () => {
  const root = folder();
  const privateDirectory = join(root, "archive");
  const file = join(privateDirectory, "snapshots.sqlite");
  open(file).put(snapshot());
  expect(statSync(privateDirectory).mode & 0o777).toBe(0o700);
  expect(statSync(file).mode & 0o777).toBe(0o600);

  const unrelated = join(root, "unrelated");
  writeFileSync(unrelated, "do not modify", { mode: 0o644 });
  const linked = join(root, "symlink.sqlite");
  symlinkSync(unrelated, linked);
  expect(() => open(linked)).toThrow(DiagnosticStorageError);
  const hardlinked = join(root, "hardlink.sqlite");
  linkSync(unrelated, hardlinked);
  expect(() => open(hardlinked)).toThrow(DiagnosticStorageError);
  expect(() => open(unrelated)).toThrow(DiagnosticStorageError);
  expect(statSync(unrelated).mode & 0o777).toBe(0o644);
  expect(readFileSync(unrelated, "utf8")).toBe("do not modify");

  const redirect = join(root, "redirect");
  symlinkSync(privateDirectory, redirect);
  expect(() => open(join(redirect, "new", "snapshots.sqlite"))).toThrow(
    DiagnosticStorageError,
  );
  expect(existsSync(join(privateDirectory, "new"))).toBe(false);
  const publicDirectory = join(root, "public");
  mkdirSync(publicDirectory);
  chmodSync(publicDirectory, 0o755);
  expect(() => open(join(publicDirectory, "snapshots.sqlite"))).toThrow(
    DiagnosticStorageError,
  );
  expect(statSync(publicDirectory).mode & 0o777).toBe(0o755);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const target = join(root, `sidecar${suffix}.sqlite`);
    symlinkSync(unrelated, `${target}${suffix}`);
    expect(() => open(target)).toThrow(DiagnosticStorageError);
  }
});

it("exposes sanitized typed storage failures", () => {
  const root = folder();
  const corrupt = join(root, "private-path-name.sqlite");
  writeFileSync(corrupt, "private-content", { mode: 0o600 });
  try {
    open(corrupt);
    expect.unreachable("corrupt storage was accepted");
  } catch (error) {
    expect(error).toBeInstanceOf(DiagnosticStorageError);
    expect(String(error)).not.toContain("private-path-name");
    expect(String(error)).not.toContain("private-content");
  }
  const store = open(join(root, "closed.sqlite"));
  store.close();
  expect(() => store.list()).toThrow(DiagnosticStorageError);
});
