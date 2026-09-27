import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const evidenceBackupManifestSchema = z.strictObject({
  version: z.literal(1),
  format: z.literal("june-evidence-v1"),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative().safe(),
  ciphertextBytes: z.number().int().min(28).safe(),
  ciphertextSha256: z.string().regex(/^[a-f0-9]{64}$/),
  tombstoneWatermark: z.number().int().nonnegative().safe(),
});
export type EvidenceBackupManifest = z.infer<
  typeof evidenceBackupManifestSchema
>;

function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (
    realpathSync(path) !== resolve(path) ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("Private backup storage required");
}

function manifestAt(path: string): EvidenceBackupManifest {
  privatePath(path, false);
  if (lstatSync(path).size > 4096) throw new Error("Invalid backup manifest");
  return evidenceBackupManifestSchema.parse(
    JSON.parse(readFileSync(path, "utf8")),
  );
}

/** Trusted local filesystem API. Hashes detect mismatch, not authenticity.
 * The ledger key and schema must still authenticate payload before restoration.
 * Never return payload to a model, HTTP response, journal, or log.
 */
export function readEvidenceBackup(directory: string): {
  manifest: EvidenceBackupManifest;
  payload: Buffer;
} {
  try {
    privatePath(directory, true);
    const manifest = manifestAt(join(directory, "manifest.json"));
    const path = join(directory, "evidence.sqlite");
    privatePath(path, false);
    // Even a read-only WAL connection can create shared-memory sidecars.
    // Reject recovery inputs before opening SQLite, without modifying them.
    if (
      ["-journal", "-wal", "-shm"].some((suffix) =>
        lstatSync(`${path}${suffix}`, { throwIfNoEntry: false }),
      )
    )
      throw new Error("Closed rollback-journal backup required");
    const fd = openSync(path, "r");
    try {
      const header = Buffer.alloc(20);
      if (
        readSync(fd, header, 0, header.length, 0) !== header.length ||
        !header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) ||
        header[18] !== 1 ||
        header[19] !== 1
      )
        throw new Error("Closed rollback-journal backup required");
    } finally {
      closeSync(fd);
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare("SELECT payload FROM records WHERE id=1").get();
      if (!row || !(row.payload instanceof Uint8Array)) throw new Error();
      const payload = Buffer.from(row.payload);
      if (
        payload.length !== manifest.ciphertextBytes ||
        createHash("sha256").update(payload).digest("hex") !==
          manifest.ciphertextSha256
      )
        throw new Error();
      return { manifest, payload };
    } finally {
      db.close();
    }
  } catch {
    throw new Error("Memory backup could not be read");
  }
}

export function latestEvidenceBackup(
  root: string,
): EvidenceBackupManifest | null {
  if (!existsSync(root)) return null;
  privatePath(root, true);
  const path = join(root, "latest.json");
  return existsSync(path) ? manifestAt(path) : null;
}

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Copies the existing authenticated ciphertext; no decryption or new cipher. */
export function writeEvidenceBackup(
  root: string,
  manifest: EvidenceBackupManifest,
  payload: Uint8Array,
): void {
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  privatePath(root, true);
  const directory = join(root, manifest.id);
  mkdirSync(directory, { mode: 0o700 }); // Exclusive: never replace an artifact.
  const path = join(directory, "evidence.sqlite");
  closeSync(openSync(path, "wx", 0o600));
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE records (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL)",
    );
    db.prepare("INSERT INTO records(id,payload) VALUES(1,?)").run(payload);
  } finally {
    db.close();
  }
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest), {
    mode: 0o600,
    flag: "wx",
    flush: true,
  });
}

export function recordLatestEvidenceBackup(
  root: string,
  manifest: EvidenceBackupManifest,
): void {
  privatePath(root, true);
  // Also required on retries: readable bytes may survive an interrupted flush.
  const directory = join(root, manifest.id);
  syncPath(join(directory, "evidence.sqlite"));
  syncPath(join(directory, "manifest.json"));
  syncPath(directory);
  syncPath(root);
  syncPath(dirname(root));
  const temporary = join(root, `.latest-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(manifest), {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    renameSync(temporary, join(root, "latest.json"));
    syncPath(root);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
