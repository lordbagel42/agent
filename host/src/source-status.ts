/**
 * Optional host-observed issue-source exporter. No agents, snapshots or GitHub API.
 *
 * Install root-owned outside releases on June's host, then explicitly
 * authorize/configure june-issue-sources.service. Publication alone does not
 * activate it. /etc/june-issues/sources.json must be root-owned 0600:
 *   {"origin":"https://debug.raygen.dev",
 *    "tokenFile":"/etc/june-issues/automation-token",
 *    "debugDirectory":"/var/lib/june-debugshare",
 *    "recoveryDatabase":"/var/lib/june-deploy/records/deploy.sqlite"}
 * Use the separate automation token, never ingest/viewer credentials. Paths
 * must be canonical; DEBUGSHARE state belongs to june, recovery state to root.
 * No command, runner, SSH, launch, diagnostic ingest, or issue-completion
 * interface is provided. Only current verified metadata is retried; no receipt
 * is modified or deleted. Ambiguous/malformed sources are skipped, not guessed.
 */
import { createHash } from "node:crypto";
import {
  type Dir,
  existsSync,
  lstatSync,
  opendirSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Duration, Effect } from "effect";
import {
  type Api,
  absolute,
  Client,
  matches,
  parseJson,
  readPrivate,
  SHA,
  sourceValid,
  THREAD,
  UUID,
  validateOrigin,
} from "./issues.js";
import { layer as httpLayer } from "./lib/http.js";
import { asRecord } from "./lib/json.js";
import { runMain } from "./lib/main.js";
import { account } from "./lib/process.js";
import { purePath } from "./lib/py.js";
import { dumps } from "./lib/pyjson.js";

export const CONFIG = "/etc/june-issues/sources.json";
export const ROOT_UID = 0;
export const BATCH_SIZE = 16; // At most this many directory entries and SQLite rows per poll.
export const CACHE_SIZE = 4096;
export const POLL_SECONDS = 15;
export const RECEIPT_LIMIT = 65_536;
export const SOURCE_LIMIT = 1024;
export const PREFIX = "issue-source:recovery:";
export const PHASES = [
  "unavailable",
  "queued",
  "running",
  "unknown",
  "returned",
];

class SourceError extends Error {}

/** `Path.resolve()` (non-strict): resolve the existing prefix, keep the rest. */
function resolvePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path
      ? path
      : join(resolvePath(parent), path.slice(parent.length + 1));
  }
}

export function canonical(value: unknown): string {
  if (!absolute(value) || value.length > 4096)
    throw new SourceError("invalid_source_path");
  const path = purePath(value);
  if (resolvePath(path) !== path) throw new SourceError("invalid_source_path");
  return path;
}

export function validateConfig(config: unknown) {
  const record = asRecord(config);
  if (
    !record ||
    Object.keys(record).sort().join() !==
      "debugDirectory,origin,recoveryDatabase,tokenFile"
  )
    throw new SourceError("invalid_source_config");
  validateOrigin(record.origin);
  for (const name of ["tokenFile", "debugDirectory", "recoveryDatabase"])
    canonical(record[name]);
  return record as {
    origin: string;
    tokenFile: string;
    debugDirectory: string;
    recoveryDatabase: string;
  };
}

export function privatePath(
  path: string,
  owner: number,
  directory = false,
): string {
  const canonicalPath = canonical(path);
  const info = lstatSync(canonicalPath);
  if (
    info.uid !== owner ||
    info.mode & 0o077 ||
    (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
  )
    throw new SourceError("unsafe_source_path");
  return canonicalPath;
}

export interface SourceMetadata {
  readonly source: string;
  readonly phase: string;
  readonly threadId?: string;
  readonly revision?: string;
}

export function metadata(value: unknown): SourceMetadata {
  const record = asRecord(value);
  if (
    !record ||
    Object.keys(record).some(
      (key) => !["source", "phase", "threadId", "revision"].includes(key),
    ) ||
    !sourceValid(record.source) ||
    !PHASES.includes(record.phase as string) ||
    (Object.hasOwn(record, "threadId") && !matches(THREAD, record.threadId)) ||
    (Object.hasOwn(record, "revision") && !matches(SHA, record.revision)) ||
    (record.phase === "returned" && !Object.hasOwn(record, "threadId"))
  )
    throw new SourceError("invalid_source_metadata");
  return record as unknown as SourceMetadata;
}

const RECEIPT_KEYS = [
  "id",
  "kind",
  "status",
  "threadId",
  "retryAt",
  "revision",
  "resolved",
];

export function debugMetadata(
  directory: string,
  name: string,
  owner: number,
): SourceMetadata | null {
  const identity = name.endsWith(".receipt.json")
    ? name.slice(0, -".receipt.json".length)
    : name;
  if (!name.endsWith(".receipt.json") || !matches(UUID, identity)) return null;
  // Reject ordinary task filenames before even reading their receipts/results.
  const task = join(directory, `${identity}.task.json`);
  if (existsSync(task) || isLink(task)) return null;
  const value = asRecord(
    parseJson(
      readPrivate(join(directory, name), { owner, limit: RECEIPT_LIMIT }),
    ),
  );
  if (
    !value ||
    value.id !== identity ||
    (value.kind !== undefined &&
      value.kind !== null &&
      value.kind !== "debugshare") ||
    Object.keys(value).some((key) => !RECEIPT_KEYS.includes(key)) ||
    (Object.hasOwn(value, "resolved") && value.resolved !== true) ||
    !["queued", "running", "completed", "unknown"].includes(
      value.status as string,
    )
  )
    return null;
  if (value.kind === undefined || value.kind === null)
    privatePath(join(directory, `${identity}.json`), owner); // Never open a snapshot.
  // Resolution attestations belong to June's notification path. They neither
  // publish code nor close issues, and never leave this host via this exporter.
  let phase = value.status as string;
  if (phase === "completed")
    phase = Object.hasOwn(value, "threadId") ? "returned" : "unknown";
  const result: Record<string, unknown> = {
    source: `debug:${identity}`,
    phase,
  };
  for (const key of ["threadId", "revision"])
    if (Object.hasOwn(value, key)) result[key] = value[key];
  return metadata(result);
}

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

export class Exporter {
  readonly config: ReturnType<typeof validateConfig>;
  entries: Dir | null = null;
  recoveryCursor = "";
  readonly acknowledged = new Map<
    string,
    readonly [string, string, string | null]
  >();

  constructor(
    config: unknown,
    readonly api: Api,
    readonly debugOwner: number,
    readonly recoveryOwner = ROOT_UID,
  ) {
    this.config = validateConfig(config);
  }

  close(): void {
    if (this.entries !== null) {
      this.entries.closeSync();
      this.entries = null;
    }
  }

  debugBatch(): SourceMetadata[] {
    const batch: SourceMetadata[] = [];
    try {
      const directory = privatePath(
        this.config.debugDirectory,
        this.debugOwner,
        true,
      );
      this.entries ??= opendirSync(directory);
      for (let index = 0; index < BATCH_SIZE; index++) {
        const entry = this.entries.readSync();
        if (entry === null) {
          this.close();
          break;
        }
        try {
          const value = debugMetadata(directory, entry.name, this.debugOwner);
          if (value !== null) batch.push(value);
        } catch {
          // One invalid/private receipt must not block others.
        }
      }
    } catch {
      this.close();
    }
    return batch;
  }

  recoveryBatch(): SourceMetadata[] {
    const batch: SourceMetadata[] = [];
    try {
      const database = privatePath(
        this.config.recoveryDatabase,
        this.recoveryOwner,
      );
      privatePath(dirname(database), this.recoveryOwner, true);
      const db = new DatabaseSync(database, { readOnly: true, timeout: 100 });
      let rows: Array<{ key: string; value: string | null }>;
      try {
        db.exec("PRAGMA query_only=ON");
        db.exec("PRAGMA trusted_schema=OFF");
        rows = db
          .prepare(
            "SELECT key, CASE WHEN length(CAST(value AS BLOB))<=? THEN value END AS value " +
              "FROM state WHERE key>=? AND key<? AND key>? " +
              "AND length(key)<=80 ORDER BY key LIMIT ?",
          )
          .all(
            SOURCE_LIMIT,
            PREFIX,
            "issue-source:recovery;",
            this.recoveryCursor,
            BATCH_SIZE,
          ) as Array<{ key: string; value: string | null }>;
      } finally {
        // Close even the read-only connection before ANY HTTP attempt.
        db.close();
      }
      this.recoveryCursor =
        rows.length === BATCH_SIZE ? (rows.at(-1)?.key ?? "") : "";
      for (const { key, value: raw } of rows) {
        try {
          const value = raw !== null ? metadata(parseJson(raw)) : null;
          if (value !== null && key === `issue-source:${value.source}`)
            batch.push(value);
        } catch {
          // Skip malformed records.
        }
      }
    } catch {
      this.recoveryCursor = "";
    }
    return batch;
  }

  pollOnce() {
    const self = this;
    return Effect.gen(function* () {
      // Fresh bounded pages, not a stale retry queue. The API enforces monotonic
      // state across exporter restarts, cache eviction and response loss.
      const batch = [...self.debugBatch(), ...self.recoveryBatch()];
      for (const value of batch) {
        const { source, phase } = value;
        const fingerprint = createHash("sha256")
          .update(dumps(value, { sortKeys: true }))
          .digest("hex");
        const previous = self.acknowledged.get(source);
        if (previous) {
          const [digest, previousPhase, thread] = previous;
          if (
            digest === fingerprint ||
            PHASES.indexOf(previousPhase) > PHASES.indexOf(phase) ||
            (thread !== null && value.threadId !== thread)
          ) {
            self.acknowledged.delete(source);
            self.acknowledged.set(source, previous);
            continue;
          }
        }
        // Metadata POST is idempotent; nothing launches or closes.
        const response = yield* self
          .api("/api/issue-sources", value)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (!response || response.ok === false) continue;
        self.acknowledged.delete(source);
        self.acknowledged.set(source, [
          fingerprint,
          phase,
          value.threadId ?? null,
        ]);
        while (self.acknowledged.size > CACHE_SIZE) {
          const oldest = self.acknowledged.keys().next().value;
          if (oldest === undefined) break;
          self.acknowledged.delete(oldest);
        }
      }
    });
  }
}

export const main = Effect.gen(function* () {
  process.umask(0o077);
  if (process.geteuid?.() !== ROOT_UID)
    throw new SourceError("source_root_required");
  const config = validateConfig(
    parseJson(readPrivate(CONFIG, { limit: 4096 })),
  );
  const client = new Client(config);
  const exporter = new Exporter(
    config,
    (path, payload) =>
      client.post(path, payload).pipe(Effect.provide(httpLayer)),
    account("june").uid,
  );
  yield* Effect.gen(function* () {
    for (;;) {
      yield* exporter.pollOnce();
      yield* Effect.sleep(Duration.seconds(POLL_SECONDS));
    }
  }).pipe(Effect.ensuring(Effect.sync(() => exporter.close())));
});

// No credentials, responses or private filenames in logs.
export const run = () =>
  runMain(main, { message: "june_issue_sources_unavailable" });
