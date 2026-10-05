import { createHash } from "node:crypto";
import type { RawAccess } from "rivetkit/db";
import type { DebugSnapshot } from "./session-controls.js";

// Each SQLite operation and base64 RPC stays below native transaction limits.
export const DEBUG_CHUNK_BYTES = 32 * 1024;

export interface DebugBodyRef {
  id: string;
  sessionId: string;
  capturedAt: string;
  snapshotOnly?: boolean;
  sha256: string;
  totalBytes: number;
}

export async function initializeDebugBodies(db: RawAccess) {
  await db.execute(`CREATE TABLE IF NOT EXISTS debug_body_parts (
    sha256 TEXT NOT NULL, part_index INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (sha256, part_index)
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS debug_body_manifests (
    capture_key TEXT PRIMARY KEY, manifest TEXT NOT NULL
  )`);
}

/** Immutable actor-local bodies, outside the state/workflow checkpoint. A
 * manifest is committed last, before any ACK or receipt can reference it.
 * Interrupted writes leave harmless unreferenced parts, never a partial body. */
export class DebugBodies {
  constructor(private readonly db: RawAccess) {}

  async reference(key: string): Promise<DebugBodyRef | undefined> {
    const [row] = await this.db.execute<{ manifest: string }>(
      "SELECT manifest FROM debug_body_manifests WHERE capture_key = ?",
      key,
    );
    return row ? JSON.parse(row.manifest) : undefined;
  }

  async part(sha256: string, index: number): Promise<string | undefined> {
    const [row] = await this.db.execute<{ data: string }>(
      "SELECT data FROM debug_body_parts WHERE sha256 = ? AND part_index = ?",
      sha256,
      index,
    );
    return row?.data;
  }

  async writePart(sha256: string, index: number, data: string) {
    await this.db.execute(
      "INSERT OR IGNORE INTO debug_body_parts (sha256, part_index, data) VALUES (?, ?, ?)",
      sha256,
      index,
      data,
    );
    if ((await this.part(sha256, index)) !== data)
      throw new Error("Debug snapshot part conflict");
  }

  async read(
    ref: Pick<DebugBodyRef, "sha256" | "totalBytes">,
  ): Promise<DebugSnapshot> {
    const parts: Buffer[] = [];
    for (
      let index = 0;
      index < Math.ceil(ref.totalBytes / DEBUG_CHUNK_BYTES);
      index++
    ) {
      const data = await this.part(ref.sha256, index);
      if (data === undefined) throw new Error("Debug snapshot part missing");
      parts.push(Buffer.from(data, "base64"));
    }
    const bytes = Buffer.concat(parts);
    if (
      bytes.length !== ref.totalBytes ||
      createHash("sha256").update(bytes).digest("hex") !== ref.sha256
    )
      throw new Error("Debug snapshot digest mismatch");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }

  async get(key: string): Promise<DebugSnapshot | undefined> {
    const ref = await this.reference(key);
    return ref && this.read(ref);
  }

  async put(key: string, snapshot: DebugSnapshot): Promise<DebugBodyRef> {
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const ref: DebugBodyRef = {
      id: snapshot.id,
      sessionId: snapshot.sessionId,
      capturedAt: snapshot.capturedAt,
      ...(snapshot.snapshotOnly ? { snapshotOnly: true } : {}),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      totalBytes: bytes.length,
    };
    for (let index = 0; index * DEBUG_CHUNK_BYTES < bytes.length; index++)
      await this.writePart(
        ref.sha256,
        index,
        bytes
          .subarray(index * DEBUG_CHUNK_BYTES, (index + 1) * DEBUG_CHUNK_BYTES)
          .toString("base64"),
      );
    await this.db.execute(
      "INSERT OR IGNORE INTO debug_body_manifests (capture_key, manifest) VALUES (?, ?)",
      key,
      JSON.stringify(ref),
    );
    const saved = await this.reference(key);
    if (saved?.sha256 !== ref.sha256 || saved.totalBytes !== ref.totalBytes)
      throw new Error("Debug snapshot manifest conflict");
    return saved;
  }
}
