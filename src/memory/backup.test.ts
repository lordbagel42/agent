import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createHttpApp } from "../http/app.js";
import { createMemoryRoutes } from "../http/memory.js";
import { writeEvidenceBackup } from "./backup.js";
import { EvidenceStore, readEvidenceBackup } from "./store.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) };
});

it("backs up only authenticated ciphertext, preserves tombstones, and never overwrites a retry", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "june-backup-"));
  const key = randomBytes(32);
  const path = join(directory, "evidence.sqlite");
  const store = new EvidenceStore(path, key);
  t.onTestFinished(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const source = {
    id: "SECRET-kept",
    audiences: ["private"],
    platform: "slack",
    account: "SECRET-account",
    conversation: "SECRET-conversation",
    author: "SECRET-author",
    observedAt: 10,
    sourceUrl: "https://example.invalid/SECRET",
    text: "SECRET-evidence",
  };
  store.appendSource(source);
  store.appendSource({ ...source, id: "SECRET-forgotten" });
  store.appendClaim({
    id: "SECRET-derived",
    audiences: ["private"],
    entity: "SECRET-entity",
    text: "SECRET-claim",
    kind: "evidence",
    dependsOn: ["SECRET-forgotten"],
    contradicts: [],
    supersedes: [],
  });
  store.deleteSource("SECRET-forgotten");
  const root = join(directory, "backups");
  expect(store.backupStatus().latest).toBeNull();
  expect(existsSync(root)).toBe(false);
  const token = "fixture-only-backup-operator-token";
  const app = createHttpApp({
    owner: { id: "owner", identities: [] },
    channels: {},
    operatorToken: token,
    async submit() {},
    async ready() {
      return true;
    },
    async inspectConversation() {
      return {};
    },
    async inspectJob() {
      return undefined;
    },
    async resumeJob() {
      return false;
    },
  });
  app.route(
    "/operator/memory",
    createMemoryRoutes({
      store,
      audience: () => "private",
      async forget() {},
    }),
  );
  const id = "a".repeat(64);
  const request = (input: unknown, authorized = true) =>
    app.request("/operator/memory/backup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorized ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(input),
    });
  expect((await app.request("/operator/memory/backup")).status).toBe(401);
  expect((await request({ id, confirmed: true }, false)).status).toBe(401);
  expect((await request({ id, confirmed: false })).status).toBe(400);
  expect(
    (await request({ id, confirmed: true, directory: "/tmp/escape" })).status,
  ).toBe(400);
  expect((await request({ id: "../escape", confirmed: true })).status).toBe(
    400,
  );
  expect(existsSync(root)).toBe(false);
  const response = await request({ id, confirmed: true });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const { manifest } = await response.json();
  expect(manifest.tombstoneWatermark).toBe(2);
  const backupDirectory = join(root, id);
  const backupPath = join(backupDirectory, "evidence.sqlite");
  const { payload } = readEvidenceBackup(backupDirectory);
  const live = new DatabaseSync(path, { readOnly: true });
  expect(payload).toEqual(
    Buffer.from(
      live.prepare("SELECT payload FROM records WHERE id=1").get()
        ?.payload as Uint8Array,
    ),
  );
  live.close();
  for (const file of [
    backupPath,
    join(backupDirectory, "manifest.json"),
    join(root, "latest.json"),
  ]) {
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file).toString("latin1")).not.toContain("SECRET");
    expect(readFileSync(file).includes(key)).toBe(false);
  }
  expect(statSync(backupDirectory).mode & 0o777).toBe(0o700);
  const reopened = new EvidenceStore(backupPath, key);
  expect(reopened.source("private", source.id)).toEqual(source);
  expect(reopened.isDeleted("SECRET-forgotten")).toBe(true);
  expect(reopened.isDeleted("SECRET-derived")).toBe(true);
  expect(reopened.deletionRevision()).toBe(2);
  reopened.close();
  expect(() => new EvidenceStore(backupPath, randomBytes(32))).toThrow();
  const restarted = new EvidenceStore(path, key);
  expect(restarted.backupStatus().latest).toEqual(manifest);
  restarted.close();
  store.deleteSource(source.id);
  vi.mocked(fsyncSync).mockImplementationOnce(() => {
    throw new Error("fixture flush failure");
  });
  expect(() => store.backup(id)).toThrow("no new backup confirmed");
  vi.mocked(fsyncSync).mockClear();
  expect(store.backup(id)).toEqual(manifest);
  // Artifact files, artifact directory, backup root and parent precede receipt.
  expect(fsyncSync).toHaveBeenCalledTimes(6);
  expect(readEvidenceBackup(backupDirectory).payload).toEqual(payload);
  expect(store.backupStatus()).toMatchObject({
    latest: manifest,
    tombstoneWatermark: 3,
    independentRetentionVerified: false,
  });
  writeFileSync(
    join(backupDirectory, "manifest.json"),
    JSON.stringify({ ...manifest, tombstoneWatermark: 3 }),
  );
  expect(() => store.backup(id)).toThrow("no new backup confirmed");
  expect(() => store.backupStatus()).toThrow("status unavailable");
  writeFileSync(
    join(backupDirectory, "manifest.json"),
    JSON.stringify(manifest),
  );
  const altered = new DatabaseSync(backupPath);
  altered.exec("UPDATE records SET payload=zeroblob(length(payload))");
  altered.close();
  expect(() => readEvidenceBackup(backupDirectory)).toThrow(
    "could not be read",
  );
  expect(() => store.backup(id)).toThrow("no new backup confirmed");
  expect(store.isDeleted(source.id)).toBe(true);
});

it("rejects nonprivate or redirected backup storage without following model paths", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "june-backup-boundary-"));
  const store = new EvidenceStore(
    join(directory, "evidence.sqlite"),
    randomBytes(32),
  );
  t.onTestFinished(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const id = "b".repeat(64);
  chmodSync(directory, 0o755);
  expect(() => store.backup(id)).toThrow();
  chmodSync(directory, 0o700);
  symlinkSync(directory, join(directory, "backups"));
  expect(() => store.backup(id)).toThrow();
  expect(existsSync(join(directory, id))).toBe(false);
});

it("rejects an authenticated artifact with a missing or different ledger identity even under the same key", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "june-backup-identity-"));
  const key = randomBytes(32);
  const store = new EvidenceStore(join(directory, "evidence.sqlite"), key);
  const otherPath = join(directory, "unrelated.sqlite");
  const other = new EvidenceStore(otherPath, key);
  t.onTestFinished(() => {
    store.close();
    other.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const id = "c".repeat(64);
  const manifest = store.backup(id);
  const artifact = join(directory, "backups", id);
  const substitute = () => {
    const source = new DatabaseSync(otherPath, { readOnly: true });
    const payload = source
      .prepare("SELECT payload FROM records WHERE id=1")
      .get()?.payload;
    source.close();
    if (!(payload instanceof Uint8Array))
      throw new Error("Missing fixture payload");
    const target = new DatabaseSync(join(artifact, "evidence.sqlite"));
    target.prepare("UPDATE records SET payload=? WHERE id=1").run(payload);
    target.close();
    writeFileSync(
      join(artifact, "manifest.json"),
      JSON.stringify({
        ...manifest,
        ciphertextBytes: payload.byteLength,
        ciphertextSha256: createHash("sha256").update(payload).digest("hex"),
      }),
    );
  };
  substitute();
  expect(() => store.backup(id)).toThrow("no new backup confirmed");
  expect(() => store.backupStatus()).toThrow("status unavailable");
  // Build an authentic legacy snapshot using the production writer, not a test cipher.
  (other as unknown as { write(state: unknown): void }).write({
    version: 1,
    sources: [],
    claims: [],
    tombstones: [],
    imports: [],
    proposals: [],
    extractions: [],
  });
  substitute();
  expect(() => store.backup(id)).toThrow("no new backup confirmed");
  expect(() => store.backupStatus()).toThrow("status unavailable");
  expect(() => other.backup("d".repeat(64))).toThrow("no new backup confirmed");
});

it("reads only closed rollback-journal snapshots without changing candidate files", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "june-backup-sqlite-"));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  // The reader checks the container, not encryption; use opaque fixture bytes.
  const payload = Buffer.alloc(32, 7);
  const id = "e".repeat(64);
  const root = join(directory, "backups");
  writeEvidenceBackup(
    root,
    {
      version: 1,
      format: "june-evidence-v1",
      id,
      createdAt: 1,
      ciphertextBytes: payload.length,
      ciphertextSha256: createHash("sha256").update(payload).digest("hex"),
      tombstoneWatermark: 0,
    },
    payload,
  );
  const artifact = join(root, id);
  const path = join(artifact, "evidence.sqlite");
  expect(readEvidenceBackup(artifact).payload).toEqual(payload);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.close();
  const before = readFileSync(path);
  const files = readdirSync(artifact);
  expect(before[18]).toBe(2);
  expect(() => readEvidenceBackup(artifact)).toThrow("could not be read");
  expect(readFileSync(path)).toEqual(before);
  expect(readdirSync(artifact)).toEqual(files);
  const rollback = new DatabaseSync(path);
  rollback.exec("PRAGMA journal_mode=DELETE");
  rollback.close();
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const sidecar = `${path}${suffix}`;
    writeFileSync(sidecar, Buffer.alloc(0), { mode: 0o600 });
    const before = readFileSync(path);
    expect(() => readEvidenceBackup(artifact)).toThrow("could not be read");
    expect(readFileSync(path)).toEqual(before);
    expect(readFileSync(sidecar)).toEqual(Buffer.alloc(0));
    rmSync(sidecar);
  }
  expect(readEvidenceBackup(artifact).payload).toEqual(payload);
});
