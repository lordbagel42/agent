import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type OperationObservation, validateOperation } from "./operations.js";

type PublicationState = "pending" | "saved" | "conflict" | "rejected";

function warning(
  code:
    | "record_failed"
    | "upload_pending"
    | "upload_retained"
    | "storage_failed",
) {
  try {
    console.warn(`operations_${code}`);
  } catch {
    // Logging must not turn an observational failure into an action failure.
  }
}

function canonicalOrigin(value: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    !/^https?:\/\/[^/\\\s?#]+\/?$/i.test(value)
  )
    throw new Error();
  return url.origin;
}

function privateFile(file: string) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (
    stat &&
    (!stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0)
  )
    throw new Error();
}

function prepareFile(file: string) {
  const directory = dirname(file);
  let ancestor = directory;
  while (!lstatSync(ancestor, { throwIfNoEntry: false }))
    ancestor = dirname(ancestor);
  // Check before mkdir, not after creating through a symlinked ancestor.
  if (realpathSync(ancestor) !== ancestor) throw new Error();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    realpathSync(directory) !== directory
  )
    throw new Error();
  for (const suffix of ["", "-journal", "-wal", "-shm"])
    privateFile(`${file}${suffix}`);
  try {
    closeSync(openSync(file, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  privateFile(file);
}

async function savedReceipt(response: Response, id: string): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) return false;
      chunks.push(value);
    }
    const receipt = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return receipt?.id === id && receipt?.saved === true;
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Private evidence, never an action/replay queue. The independent action state
 * must be persisted first: a crash or failed record can leave coverage gaps.
 * start() resumes ONLY publication. Nothing here launches or authorizes work.
 * No pruning; immutable payloads survive retries, rejection and acknowledgement.
 */
export class OperationJournal {
  private db?: DatabaseSync;
  private readonly origin: string;
  private readonly token: string;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private controller?: AbortController;
  private started = false;
  private closed = false;

  constructor(options: { file: string; origin: string; token: string }) {
    try {
      this.origin = canonicalOrigin(options.origin);
      this.token = options.token;
      if (
        typeof this.token !== "string" ||
        this.token.length < 32 ||
        this.token.length > 4096 ||
        !/^[A-Za-z0-9._~+/-]+=*$/.test(this.token)
      )
        throw new Error();
      const file = resolve(options.file);
      prepareFile(file);
      this.db = new DatabaseSync(file);
      this.db.exec(`PRAGMA busy_timeout=100;
        PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;
        CREATE TABLE IF NOT EXISTS operation_destination (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), origin TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operation_journal (
          position INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
          operation_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending', failures INTEGER NOT NULL DEFAULT 0,
          retry_at INTEGER NOT NULL DEFAULT 0, UNIQUE(operation_id,sequence));
        CREATE INDEX IF NOT EXISTS operation_pending ON operation_journal(state,retry_at);`);
      this.db
        .prepare("INSERT OR IGNORE INTO operation_destination VALUES(1,?)")
        .run(this.origin);
      if (
        this.db
          .prepare("SELECT origin FROM operation_destination WHERE singleton=1")
          .get()?.origin !== this.origin
      )
        throw new Error();
      // Persist initial file creation too. Subsequent commits use EXTRA sync.
      const fd = openSync(dirname(file), "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      try {
        this.db?.close();
      } catch {
        /* No raw SQLite or filesystem errors. */
      }
      this.db = undefined;
      throw new Error("Operation journal unavailable");
    }
  }

  /** Synchronous, bounded local storage only. Never fetch or await publication. */
  record(observation: OperationObservation): void {
    const db = this.db;
    if (!db || this.closed) return;
    let transaction = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transaction = true;
      const sequence = Number(
        db
          .prepare(
            "SELECT COALESCE(MAX(sequence),-1)+1 next FROM operation_journal WHERE operation_id=?",
          )
          .get(observation.operationId)?.next,
      );
      const event = validateOperation({
        ...observation,
        id: randomUUID(),
        sequence,
        observedAt: Date.now(),
      });
      db.prepare(
        "INSERT INTO operation_journal(id,operation_id,sequence,payload) VALUES(?,?,?,?)",
      ).run(event.id, event.operationId, event.sequence, JSON.stringify(event));
      db.exec("COMMIT");
    } catch {
      if (transaction) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* Retain previous observations. */
        }
      }
      warning("record_failed");
    }
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.uploadNext()
        .catch(() => {
          warning("storage_failed");
        })
        .finally(() => {
          this.inFlight = undefined;
          this.schedule(1_000);
        });
    }, delay);
    this.timer.unref();
  }

  private async uploadNext(): Promise<void> {
    const db = this.db;
    if (!db) return;
    const row = db
      .prepare(
        "SELECT id,payload,failures FROM operation_journal WHERE state='pending' AND retry_at<=? ORDER BY position LIMIT 1",
      )
      .get(Date.now());
    if (!row) return;
    const state = await this.publish(String(row.id), String(row.payload));
    const failures = Number(row.failures);
    // Only delivery state changes; even a lost ack resends identical bytes/ID.
    db.prepare(
      "UPDATE operation_journal SET state=?,failures=?,retry_at=? WHERE id=? AND state='pending'",
    ).run(
      state,
      failures + (state === "saved" ? 0 : 1),
      state === "pending"
        ? Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(failures, 6))
        : 0,
      String(row.id),
    );
    if (state !== "saved")
      warning(state === "pending" ? "upload_pending" : "upload_retained");
  }

  private async publish(
    id: string,
    payload: string,
  ): Promise<PublicationState> {
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    timeout.unref();
    try {
      const response = await fetch(
        `${this.origin}/api/ingest/operations/${id}`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
          },
          body: payload,
          redirect: "manual",
          signal: controller.signal,
        },
      );
      if (
        !response.redirected &&
        (response.status === 200 || response.status === 201)
      )
        return (await savedReceipt(response, id)) ? "saved" : "pending";
      await response.body?.cancel().catch(() => {});
      if (response.redirected) return "rejected";
      if (response.status === 409) return "conflict";
      return response.status >= 500 || [408, 425, 429].includes(response.status)
        ? "pending"
        : "rejected";
    } catch {
      return "pending";
    } finally {
      clearTimeout(timeout);
      this.controller = undefined;
    }
  }

  /** Abort and settle the one bounded upload; leave pending rows for restart. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.inFlight;
    try {
      this.db?.close();
    } catch {
      warning("storage_failed");
    }
    this.db = undefined;
  }
}
