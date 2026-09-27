import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createHttpApp } from "../http/app.js";
import { createMemoryRoutes } from "../http/memory.js";
import { createInspectionReader } from "../runtime/inspection.js";
import { readEvidenceBackup } from "./backup.js";
import {
  EvidenceStore,
  type TombstoneExportPage,
  validateEvidenceBackup,
} from "./store.js";

function snapshot(root: string) {
  return ["", ...readdirSync(root, { recursive: true, encoding: "utf8" })]
    .sort()
    .map((name) => {
      const path = join(root, name);
      const stat = lstatSync(path);
      return {
        name,
        mode: stat.mode,
        bytes: stat.isFile() ? readFileSync(path) : null,
      };
    });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "june-restore-test-"));
  const path = join(root, "evidence.sqlite");
  const key = randomBytes(32);
  const store = new EvidenceStore(path, key);
  const backupId = "a".repeat(64);
  store.deleteSource("earlier-secret-id");
  store.appendSource({
    id: "secret-source",
    audiences: ["private"],
    platform: "slack",
    account: "secret-account",
    conversation: "secret-conversation",
    author: "secret-author",
    observedAt: 1,
    sourceUrl: "https://example.invalid/private",
    text: "SECRET BODY",
  });
  store.appendClaim({
    id: "secret-claim",
    entity: "owner",
    text: "SECRET CLAIM",
    audiences: ["private"],
    kind: "evidence",
    dependsOn: ["secret-source"],
    contradicts: [],
    supersedes: [],
  });
  store.backup(backupId);
  store.deleteSource("secret-source");
  const directory = join(root, "backups", backupId);
  const pages: TombstoneExportPage[] = [];
  for (let after = 0; ; ) {
    const page = store.exportTombstones({ after, limit: 1 });
    pages.push(page);
    if (page.nextAfter === null) break;
    after = page.nextAfter;
  }
  return {
    store,
    root,
    key,
    path,
    directory,
    backupId,
    restore: { watermark: 3, pages },
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it("preflights authenticated replay without changing backup or live ledger, and rejects stale/incomplete histories", (t) => {
  const f = fixture();
  t.onTestFinished(f.close);
  const before = snapshot(f.root);
  const realClose = EvidenceStore.prototype.close;
  let replayed = false;
  const close = vi
    .spyOn(EvidenceStore.prototype, "close")
    .mockImplementation(function (this: EvidenceStore) {
      try {
        expect(this).not.toBe(f.store);
        expect(this.source("private", "secret-source")).toBeUndefined();
        expect(this.search("private", "").claims).toEqual([]);
        replayed = true;
      } finally {
        realClose.call(this);
      }
    });
  try {
    expect(validateEvidenceBackup(f.directory, f.key, f.restore)).toEqual({
      status: "validated",
      checkedAt: expect.any(Number),
      storeReplaced: false,
      backupId: f.backupId,
      snapshotWatermark: 1,
      replayedThrough: 3,
    });
    expect(replayed).toBe(true);
  } finally {
    close.mockRestore();
  }
  const otherLedger = new EvidenceStore(":memory:", f.key);
  t.onTestFinished(() => otherLedger.close());
  for (const id of ["earlier-secret-id", "secret-source", "secret-claim"])
    otherLedger.deleteSource(id);
  for (const restore of [
    { watermark: 0, pages: [] },
    { watermark: 3, pages: [otherLedger.exportTombstones()] },
    { watermark: 3, pages: [f.restore.pages[0]] },
    { watermark: 3, pages: [...f.restore.pages].reverse() },
    {
      watermark: 3,
      pages: f.restore.pages.map((p, i) =>
        i === 0 ? { ...p, tombstones: ["different-ledger"] } : p,
      ),
    },
    // A once-complete older export is stale against the trusted current floor.
    {
      watermark: 3,
      pages: [f.store.exportTombstones({ watermark: 1 })],
    },
  ])
    expect(validateEvidenceBackup(f.directory, f.key, restore).status).toBe(
      "rejected",
    );
  expect(snapshot(f.root)).toEqual(before);
  const backupPath = join(f.directory, "evidence.sqlite");
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const sidecar = `${backupPath}${suffix}`;
    writeFileSync(sidecar, "fixture sidecar", { mode: 0o600 });
    const unchanged = snapshot(f.root);
    expect(validateEvidenceBackup(f.directory, f.key, f.restore).status).toBe(
      "rejected",
    );
    expect(snapshot(f.root)).toEqual(unchanged);
    rmSync(sidecar);
  }
  const bytes = readFileSync(backupPath);
  const wal = Buffer.from(bytes);
  wal[18] = 2;
  wal[19] = 2;
  writeFileSync(backupPath, wal);
  const unchanged = snapshot(f.root);
  expect(validateEvidenceBackup(f.directory, f.key, f.restore).status).toBe(
    "rejected",
  );
  expect(snapshot(f.root)).toEqual(unchanged);
  writeFileSync(backupPath, bytes);
});

it("rejects bad keys, corrupt authentication, invalid schema and a forged manifest watermark without leaking input", (t) => {
  const f = fixture();
  t.onTestFinished(f.close);
  const original = readEvidenceBackup(f.directory);
  const rejected = (key = f.key) => {
    expect(validateEvidenceBackup(f.directory, key, f.restore)).toEqual({
      status: "rejected",
      checkedAt: expect.any(Number),
      storeReplaced: false,
    });
  };
  rejected(randomBytes(32));
  rejected(Buffer.alloc(0));
  const manifestPath = join(f.directory, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({ ...original.manifest, tombstoneWatermark: 2 }),
  );
  rejected();
  writeFileSync(
    manifestPath,
    JSON.stringify({ ...original.manifest, version: 2 }),
  );
  rejected();

  const damaged = Buffer.from(original.payload);
  damaged[12] = (damaged[12] ?? 0) ^ 1;
  const invalidSnapshots = [
    { version: 99, text: "SECRET BODY" },
    // Valid legacy schema and key, but no authenticated ledger identity.
    {
      version: 1,
      sources: [],
      claims: [],
      tombstones: ["earlier-secret-id"],
      imports: [],
    },
  ].map((state) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", f.key, nonce);
    cipher.setAAD(Buffer.from("june-evidence-v1"));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(state)),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  });
  for (const payload of [damaged, ...invalidSnapshots]) {
    const db = new DatabaseSync(join(f.directory, "evidence.sqlite"));
    try {
      db.prepare("UPDATE records SET payload=? WHERE id=1").run(payload);
    } finally {
      db.close();
    }
    // A matching unkeyed hash must not substitute for AES-GCM/schema checks.
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...original.manifest,
        ciphertextBytes: payload.length,
        ciphertextSha256: createHash("sha256").update(payload).digest("hex"),
      }),
    );
    rejected();
  }
});

it("lets June inspect only safe validation metadata and marks it stale after new forgetting", async (t) => {
  const f = fixture();
  t.onTestFinished(f.close);
  const read = createInspectionReader({
    audience: "private",
    memory: { store: f.store },
    selections: {},
  });
  const token = "fixture-only-operator-token-long-enough";
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
    async inspectJob() {},
    async resumeJob() {
      return false;
    },
  });
  app.route(
    "/operator/memory",
    createMemoryRoutes({
      store: f.store,
      audience: () => "private",
      async forget() {
        throw new Error("must not forget");
      },
    }),
  );
  const request = (body: unknown, authorized = true) =>
    app.request("/operator/memory/restore/validate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorized ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  expect((await request({ id: f.backupId }, false)).status).toBe(401);
  expect((await request({ id: f.backupId, watermark: 0 })).status).toBe(400);
  expect((await request({ id: "../arbitrary-file" })).status).toBe(400);
  expect(f.store.restoreValidationStatus()).toBeNull();
  const before = snapshot(f.root);
  const validate = vi.spyOn(f.store, "validateBackup");
  t.onTestFinished(() => validate.mockRestore());
  const response = await request({ id: f.backupId });
  expect(response.headers.get("cache-control")).toBe("no-store");
  const result = await response.json();
  expect(result.status).toBe("validated");
  const report = await read("memory");
  expect(report).toContain('"status":"validated"');
  expect(report).toContain('"storeReplaced":false');
  expect(report).not.toMatch(/SECRET|secret-|june-restore-test/);
  expect(validate).toHaveBeenCalledTimes(1);
  expect(snapshot(f.root)).toEqual(before);
  f.store.deleteSource("another-secret-id");
  expect(f.store.restoreValidationStatus()?.status).toBe("stale");
  expect(await read("memory")).toContain('"status":"stale"');
  expect(f.store.validateBackup("b".repeat(64)).status).toBe("rejected");
  expect(await read("memory")).toContain('"status":"rejected"');
  const success = await (await request({ id: f.backupId })).json();
  expect(success.status).toBe("validated");
  const clock = vi.spyOn(Date, "now").mockReturnValue(success.checkedAt + 1);
  chmodSync(f.root, 0o750);
  try {
    const beforeFailure = snapshot(f.root);
    expect(await (await request({ id: f.backupId })).json()).toEqual({
      status: "rejected",
      storeReplaced: false,
      checkedAt: success.checkedAt + 1,
    });
    expect(await read("memory")).toContain('"status":"rejected"');
    expect(snapshot(f.root)).toEqual(beforeFailure);
  } finally {
    chmodSync(f.root, 0o700);
    clock.mockRestore();
  }
});
