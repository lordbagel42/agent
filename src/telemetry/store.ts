import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { TelemetryQuery } from "./index.js";

export const retention = { days: 30, spans: 100_000, events: 50_000 };
const retentionMs = retention.days * 86_400_000;
export interface Row {
  traceId?: string;
  spanId?: string;
  name: string;
  at: number;
  status: "ok" | "error" | "unfinished";
  durationMs?: number;
  [key: string]: unknown;
}

/** Observational evidence only, never a replay queue. WAL/NORMAL survives a
 * process crash; power loss can lose recent commits. Failures are counted, not
 * propagated into application work. */
export class Store {
  private db?: DatabaseSync;
  failures = 0;
  private timer?: ReturnType<typeof setInterval>;
  constructor(path: string) {
    try {
      path = resolve(path);
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const dir = lstatSync(directory);
      if (
        !dir.isDirectory() ||
        dir.uid !== process.getuid?.() ||
        (dir.mode & 0o077) !== 0 ||
        realpathSync(directory) !== directory
      )
        throw new Error("Unsafe telemetry directory");
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      for (const file of [
        path,
        `${path}-wal`,
        `${path}-shm`,
        `${path}-journal`,
      ]) {
        try {
          const stat = lstatSync(file);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            stat.uid !== process.getuid?.() ||
            (stat.mode & 0o077) !== 0
          )
            throw new Error("Unsafe telemetry file");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      this.db = new DatabaseSync(path);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
        PRAGMA busy_timeout=20; PRAGMA journal_size_limit=4194304;
        CREATE TABLE IF NOT EXISTS spans (
          id INTEGER PRIMARY KEY AUTOINCREMENT, span_id TEXT UNIQUE NOT NULL,
          trace_id TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL,
          status TEXT NOT NULL, duration REAL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS spans_at ON spans(at);
        CREATE INDEX IF NOT EXISTS spans_trace ON spans(trace_id,id);
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, trace_id TEXT, name TEXT NOT NULL,
          at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_at ON events(at);
        CREATE INDEX IF NOT EXISTS events_trace ON events(trace_id,id);`);
      this.prune();
      this.timer = setInterval(() => this.prune(), 60_000);
      this.timer.unref();
    } catch {
      this.failures++;
      try {
        this.db?.close();
      } catch {
        /* no application side effects */
      }
      this.db = undefined;
    }
  }
  get available() {
    return this.db !== undefined;
  }
  private attempt<T>(run: (db: DatabaseSync) => T): T | undefined {
    if (!this.db) return undefined;
    try {
      return run(this.db);
    } catch {
      this.failures++;
      return undefined;
    }
  }
  private prune() {
    this.attempt((db) => {
      for (const table of ["spans", "events"] as const) {
        db.prepare(`DELETE FROM ${table} WHERE at < ?`).run(
          Date.now() - retentionMs,
        );
        db.exec(
          `DELETE FROM ${table} WHERE id <= (SELECT MAX(id) - ${retention[table]} FROM ${table})`,
        );
      }
    });
  }
  span(row: Row, ended: boolean) {
    this.attempt((db) => {
      if (ended) {
        // Never resurrect rows already removed by retention.
        db.prepare(
          "UPDATE spans SET status=?, duration=?, data=? WHERE span_id=?",
        ).run(
          row.status,
          row.durationMs ?? null,
          JSON.stringify(row),
          row.spanId ?? "",
        );
      } else {
        db.prepare(
          "INSERT INTO spans(span_id,trace_id,name,at,status,data) VALUES(?,?,?,?,?,?)",
        ).run(
          row.spanId ?? "",
          row.traceId ?? "",
          row.name,
          row.at,
          row.status,
          JSON.stringify(row),
        );
        db.exec(
          `DELETE FROM spans WHERE id <= (SELECT MAX(id) - ${retention.spans} FROM spans)`,
        );
      }
    });
  }
  event(row: Row) {
    this.attempt((db) => {
      db.prepare(
        "INSERT INTO events(trace_id,name,at,status,data) VALUES(?,?,?,?,?)",
      ).run(
        row.traceId ?? null,
        row.name,
        row.at,
        row.status,
        JSON.stringify(row),
      );
      db.exec(
        `DELETE FROM events WHERE id <= (SELECT MAX(id) - ${retention.events} FROM events)`,
      );
    });
  }
  query(input: TelemetryQuery) {
    return (
      this.attempt((db) => {
        const table = input.view === "logs" ? "events" : "spans";
        const where = ["at >= ?"];
        const values: SQLInputValue[] = [
          Math.max(input.since ?? 0, Date.now() - retentionMs),
        ];
        for (const [key, column] of [
          ["until", "at <="],
          ["before", "id <"],
          ["traceId", "trace_id ="],
          ["name", "name ="],
          ["status", "status ="],
        ] as const) {
          if (input[key] !== undefined) {
            where.push(`${column} ?`);
            values.push(input[key]);
          }
        }
        const clause = where.join(" AND ");
        if (input.view === "metrics") {
          return {
            source: "aggregates_over_retained_spans",
            groups: db
              .prepare(
                `SELECT name, status, COUNT(*) AS count, AVG(duration) AS meanDurationMs, MAX(duration) AS maxDurationMs, SUM(duration) AS totalDurationMs FROM spans WHERE ${clause} GROUP BY name,status ORDER BY name,status LIMIT 150`,
              )
              .all(...values),
          };
        }
        const rows = db
          .prepare(
            `SELECT id,data FROM ${table} WHERE ${clause} ORDER BY id DESC LIMIT ?`,
          )
          .all(...values, (input.limit ?? 25) + 1) as {
          id: number;
          data: string;
        }[];
        const page: typeof rows = [];
        let bytes = 0;
        for (const row of rows.slice(0, input.limit ?? 25)) {
          const size = Buffer.byteLength(row.data);
          // Bound model/MCP payloads without losing access to later records.
          if (page.length && bytes + size > 48 * 1024) break;
          page.push(row);
          bytes += size;
        }
        return {
          rows: page.map(({ id, data }) => ({ id, ...JSON.parse(data) })),
          nextBefore: rows.length > page.length ? page.at(-1)?.id : null,
        };
      }) ?? { unavailable: true, rows: [], nextBefore: null }
    );
  }
  close() {
    clearInterval(this.timer);
    this.attempt((db) => db.close());
    this.db = undefined;
  }
}
