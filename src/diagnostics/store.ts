import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  DebugSitePublisher,
  DiagnosticIndex,
  DiagnosticSummary,
} from "./contracts.js";

type DebugSnapshot = Parameters<DebugSitePublisher["publish"]>[0];
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const snapshotIdSchema = z.uuid();

const identifier = z.string().min(1).max(2048);
const metadataSchema = z.object({
  id: snapshotIdSchema,
  sessionId: identifier,
  capturedAt: z.iso.datetime({ offset: true }),
  revision: identifier,
  scope: z.array(identifier).max(256),
  reason: z.string().max(16_384),
  reporter: z
    .object({
      channel: z.literal("slack"),
      accountId: identifier,
      senderId: identifier,
      isOwner: z.boolean(),
    })
    .optional(),
  snapshotOnly: z.boolean().optional(),
});
const snapshotSchema = metadataSchema.extend({
  data: z.unknown(),
  exclusions: z.array(z.string().max(16_384)).max(1024),
});
const listSchema = z.object({
  query: z.string().max(512).trim().default(""),
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .default(0),
  limit: z.number().int().min(1).max(100).default(50),
});

export class DiagnosticValidationError extends Error {
  constructor(
    readonly code:
      | "invalid_snapshot"
      | "snapshot_too_large"
      | "invalid_id"
      | "invalid_query",
  ) {
    super(`Invalid diagnostic input (${code})`);
    this.name = "DiagnosticValidationError";
  }
}

export class DiagnosticConflictError extends Error {
  constructor() {
    super("Diagnostic snapshot identity conflict");
    this.name = "DiagnosticConflictError";
  }
}

export class DiagnosticStorageError extends Error {
  constructor() {
    super("Diagnostic storage unavailable");
    this.name = "DiagnosticStorageError";
  }
}

function serializeSnapshot(value: unknown) {
  try {
    const json = JSON.stringify(value);
    if (json === undefined)
      throw new DiagnosticValidationError("invalid_snapshot");
    const bytes = Buffer.byteLength(json);
    if (bytes > MAX_SNAPSHOT_BYTES)
      throw new DiagnosticValidationError("snapshot_too_large");
    const snapshot: unknown = JSON.parse(json);
    if (!snapshotSchema.safeParse(snapshot).success)
      throw new DiagnosticValidationError("invalid_snapshot");
    // Preserve the original JSON, including arbitrary data and future fields.
    // Schema parsing is validation only, not a stripping/normalizing transform.
    return { snapshot: snapshot as DebugSnapshot, json, bytes };
  } catch (error) {
    if (error instanceof DiagnosticValidationError) throw error;
    throw new DiagnosticValidationError("invalid_snapshot");
  }
}

/** HTTP ingress must also bound the raw request body before parsing JSON. */
export function validateSnapshot(value: unknown): DebugSnapshot {
  return serializeSnapshot(value).snapshot;
}

function privateFile(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (
    stat &&
    (!stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0)
  )
    throw new DiagnosticStorageError();
}

function prepareFile(file: string) {
  const directory = dirname(file);
  let ancestor = directory;
  while (!lstatSync(ancestor, { throwIfNoEntry: false }))
    ancestor = dirname(ancestor);
  // Check before mkdir: do not create anything through a symlinked ancestor.
  if (realpathSync(ancestor) !== ancestor) throw new DiagnosticStorageError();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    realpathSync(directory) !== directory
  )
    throw new DiagnosticStorageError();
  for (const suffix of ["", "-journal", "-wal", "-shm"])
    privateFile(`${file}${suffix}`);
  try {
    closeSync(openSync(file, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  privateFile(file);
}

/** Independent, append-only archive. No runtime, actor or investigator startup. */
export class DiagnosticStore {
  private db?: DatabaseSync;

  constructor(file: string) {
    try {
      file = resolve(file);
      prepareFile(file);
      this.db = new DatabaseSync(file);
      // EXTRA also syncs journal removal; an acknowledged insert is durable.
      this.db.exec(`PRAGMA busy_timeout=1000;
        PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;
        CREATE TABLE IF NOT EXISTS snapshots (
          id TEXT PRIMARY KEY, captured_at INTEGER NOT NULL,
          search TEXT NOT NULL, metadata TEXT NOT NULL,
          bytes INTEGER NOT NULL, snapshot TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS snapshots_capture ON snapshots(captured_at DESC, id ASC);`);
    } catch {
      try {
        this.db?.close();
      } catch {
        // Never expose paths or SQLite diagnostics to an HTTP caller.
      }
      this.db = undefined;
      throw new DiagnosticStorageError();
    }
  }

  private access<T>(run: (db: DatabaseSync) => T): T {
    try {
      if (!this.db) throw new DiagnosticStorageError();
      return run(this.db);
    } catch (error) {
      if (error instanceof DiagnosticConflictError) throw error;
      throw new DiagnosticStorageError();
    }
  }

  put(value: DebugSnapshot): "created" | "exists" {
    const { snapshot, json, bytes } = serializeSnapshot(value);
    const metadata = metadataSchema.parse(snapshot);
    const search = [
      snapshot.id,
      snapshot.reason,
      snapshot.sessionId,
      snapshot.revision,
      ...snapshot.scope,
    ]
      .join("\n")
      .toLowerCase();
    return this.access((db) => {
      const result = db
        .prepare(`INSERT INTO snapshots
        (id,captured_at,search,metadata,bytes,snapshot) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO NOTHING`)
        .run(
          snapshot.id,
          Date.parse(snapshot.capturedAt),
          search,
          JSON.stringify(metadata),
          bytes,
          json,
        );
      if (result.changes) return "created";
      const existing = db
        .prepare("SELECT snapshot FROM snapshots WHERE id=?")
        .get(snapshot.id);
      if (existing?.snapshot !== json) throw new DiagnosticConflictError();
      return "exists";
    });
  }

  get(id: string): DebugSnapshot | undefined {
    if (!snapshotIdSchema.safeParse(id).success)
      throw new DiagnosticValidationError("invalid_id");
    return this.access((db) => {
      const row = db
        .prepare("SELECT snapshot FROM snapshots WHERE id=?")
        .get(id);
      return row
        ? (JSON.parse(row.snapshot as string) as DebugSnapshot)
        : undefined;
    });
  }

  list(
    options: { query?: string; offset?: number; limit?: number } = {},
  ): DiagnosticIndex {
    const parsed = listSchema.safeParse(options);
    if (!parsed.success) throw new DiagnosticValidationError("invalid_query");
    const { query, offset, limit } = parsed.data;
    return this.access((db) => {
      const term = query.toLowerCase();
      const total = Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM snapshots WHERE instr(search, ?) > 0",
          )
          .get(term)?.count,
      );
      const rows = db
        .prepare(`SELECT metadata,bytes FROM snapshots
        WHERE instr(search, ?) > 0 ORDER BY captured_at DESC,id ASC LIMIT ? OFFSET ?`)
        .all(term, limit, offset);
      const items = rows.map(
        (row) =>
          ({
            ...JSON.parse(row.metadata as string),
            bytes: Number(row.bytes),
          }) as DiagnosticSummary,
      );
      return {
        items,
        total,
        nextOffset:
          offset + items.length < total ? offset + items.length : null,
      };
    });
  }

  close(): void {
    if (!this.db) return;
    this.access((db) => db.close());
    this.db = undefined;
  }
}
