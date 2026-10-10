import { randomUUID } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MessageEvent } from "../core/contracts.js";
import type { Delivery } from "../runtime/delivery.js";
import type { EffectSink } from "./contracts.js";

export interface SentinelReceipt {
  id: string;
  fingerprint: string;
  source: {
    scope: string;
    senderId: string;
    address: MessageEvent["address"];
    eventId: string;
  };
  sink: EffectSink;
  action: unknown;
  reason: string;
  createdAt: number;
  state: "withheld" | "released" | "consumed";
  releaseUntil?: number;
  notifyAt?: number;
  delivery?: Delivery;
}

/** Private host ledger, separate from conversation retention. Exact withheld
 * actions survive restart; no benign inputs or verdicts are persisted. */
export class SentinelStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (
      realpathSync(directory) !== directory ||
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("sentinel_private_storage_required");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const file = lstatSync(path + suffix, { throwIfNoEntry: false });
      if (
        file &&
        (!file.isFile() ||
          file.nlink !== 1 ||
          file.uid !== process.getuid?.() ||
          (file.mode & 0o077) !== 0)
      )
        throw new Error("sentinel_private_storage_required");
    }
    try {
      closeSync(openSync(path, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=100;
      CREATE TABLE IF NOT EXISTS sentinel_receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sentinel_fingerprint ON sentinel_receipts(fingerprint, state);`);
  }

  held(
    fingerprint: string,
    since = Number.MAX_SAFE_INTEGER,
  ): SentinelReceipt | undefined {
    const row = this.db
      .prepare(
        "SELECT value FROM sentinel_receipts WHERE fingerprint=? AND (state IN ('withheld','released') OR json_extract(value,'$.createdAt')>=?) ORDER BY rowid DESC LIMIT 1",
      )
      .get(fingerprint, since);
    return row ? JSON.parse(String(row.value)) : undefined;
  }

  save(receipt: SentinelReceipt) {
    this.db
      .prepare(
        "INSERT INTO sentinel_receipts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,value=excluded.value",
      )
      .run(
        receipt.id,
        receipt.fingerprint,
        receipt.state,
        JSON.stringify(receipt),
      );
  }

  create(
    input: Omit<SentinelReceipt, "id" | "state" | "createdAt">,
    delivery: (id: string) => Delivery | undefined,
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.held(input.fingerprint);
      if (existing) {
        this.db.exec("COMMIT");
        return existing;
      }
      const receipt: SentinelReceipt = {
        ...input,
        id: randomUUID(),
        state: "withheld",
        createdAt: Date.now(),
      };
      receipt.delivery = delivery(receipt.id);
      this.save(receipt);
      this.db.exec("COMMIT");
      return receipt;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveDelivery(receipt: SentinelReceipt, claim = false) {
    // A slow send cannot overwrite a concurrent owner release or consumption.
    const delivery = receipt.delivery;
    if (
      !claim &&
      delivery?.phase === "settled" &&
      delivery.result?.status === "rejected" &&
      delivery.result.retryable &&
      delivery.attempts < 3
    ) {
      delivery.phase = "ready";
      receipt.notifyAt =
        Date.now() + Math.max(1000, delivery.result.retryAfterMs ?? 1000);
    }
    const result = this.db
      .prepare(
        "UPDATE sentinel_receipts SET value=json_set(value,'$.delivery',json(?),'$.notifyAt',?) WHERE id=? AND (?=0 OR (json_extract(value,'$.delivery.phase')='ready' AND coalesce(json_extract(value,'$.delivery.attempts'),0)=?))",
      )
      .run(
        JSON.stringify(delivery),
        receipt.notifyAt ?? 0,
        receipt.id,
        claim ? 1 : 0,
        (delivery?.attempts ?? 0) - 1,
      );
    if (!result.changes) throw new Error("sentinel_notification_claimed");
  }

  release(id: string) {
    const row = this.db
      .prepare("SELECT value FROM sentinel_receipts WHERE id=?")
      .get(id);
    if (!row) return false;
    const receipt = JSON.parse(String(row.value)) as SentinelReceipt;
    if (receipt.state === "consumed") return false;
    // Repeating the same command cannot renew the original release window.
    if (receipt.state === "released")
      return (receipt.releaseUntil ?? 0) > Date.now();
    return (
      this.db
        .prepare(
          "UPDATE sentinel_receipts SET state='released',value=json_set(value,'$.state','released','$.releaseUntil',?) WHERE id=? AND state='withheld'",
        )
        .run(Date.now() + 10 * 60_000, id).changes === 1
    );
  }

  consume(receipt: SentinelReceipt) {
    if (
      receipt.state !== "released" ||
      (receipt.releaseUntil ?? 0) <= Date.now()
    )
      return false;
    return (
      this.db
        .prepare(
          "UPDATE sentinel_receipts SET state='consumed',value=json_set(value,'$.state','consumed') WHERE id=? AND state='released'",
        )
        .run(receipt.id).changes === 1
    );
  }

  list(source?: { scope: string; senderId: string }): SentinelReceipt[] {
    return this.db
      .prepare(
        "SELECT value FROM sentinel_receipts WHERE (? IS NULL OR (json_extract(value,'$.source.scope')=? AND json_extract(value,'$.source.senderId')=?)) ORDER BY rowid DESC LIMIT 100",
      )
      .all(
        source?.scope ?? null,
        source?.scope ?? null,
        source?.senderId ?? null,
      )
      .map((row) => JSON.parse(String(row.value)));
  }

  pendingNotifications(): SentinelReceipt[] {
    return this.db
      .prepare(
        "SELECT value FROM sentinel_receipts WHERE json_extract(value,'$.delivery.phase') IN ('ready','sending') ORDER BY rowid",
      )
      .all()
      .map((row) => JSON.parse(String(row.value)));
  }

  close() {
    this.db.close();
  }
}
