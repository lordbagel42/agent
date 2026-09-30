import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type SlackIngressObservation,
  slackIngressStages,
} from "../channels/slack-ingress.js";
import { correlationId, recordEvent } from "../telemetry/index.js";
import {
  type SlackMcpOAuthFailure,
  slackOAuthReasons,
  slackOAuthStages,
} from "../tools/slack-mcp-oauth.js";
import type { LatencyTrace } from "./latency.js";

const retentionMs = 30 * 86_400_000;
const lifecycleStages = [
  "process_started",
  "process_stopping",
  "shutdown_http_close_started",
  "shutdown_http_close_returned",
  "shutdown_client_dispose_started",
  "shutdown_client_dispose_returned",
  "shutdown_registry_started",
  "shutdown_registry_returned",
  "shutdown_providers_close_started",
  "shutdown_providers_close_returned",
  "shutdown_resources_close_started",
  "shutdown_resources_close_returned",
  "process_stopped",
  "shutdown_failed",
  "http_listener_failed",
] as const;

interface DiagnosticEvent {
  at: number;
  stage: string;
  requestId?: string;
  processId: string;
  processStartedAt: number;
  revision?: string;
}

/** Redacted operational evidence, not conversation state or a replay source.
 * WAL/NORMAL commits survive application crashes without an fsync per stage.
 * An OS crash/power loss can lose the most recent commits. Never retry an
 * external effect because its diagnostic write failed. */
export class DiagnosticLog {
  readonly session: {
    processId: string;
    processStartedAt: number;
    revision?: string;
  };
  private db: DatabaseSync;
  private writeFailures = 0;
  private writes = 0;

  constructor(path: string, revision?: string) {
    path = resolve(path);
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(directory);
    if (
      !metadata.isDirectory() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o077) !== 0 ||
      realpathSync(directory) !== directory
    )
      throw new Error("Diagnostics require a private canonical directory");
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
      PRAGMA journal_size_limit = 4194304;
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY, at INTEGER NOT NULL, probe TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS traces_at ON traces(at);
      CREATE INDEX IF NOT EXISTS traces_probe ON traces(probe);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_at ON events(at);`);
      this.prune();
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.session = {
      processId: randomUUID(),
      processStartedAt: Date.now(),
      ...(revision && /^[a-f0-9]{40}$/.test(revision) ? { revision } : {}),
    };
    this.lifecycle("process_started");
  }

  private prune() {
    const cutoff = Date.now() - retentionMs;
    this.db.prepare("DELETE FROM traces WHERE at < ?").run(cutoff);
    this.db.prepare("DELETE FROM events WHERE at < ?").run(cutoff);
    this.db.exec(`DELETE FROM traces WHERE rowid IN
        (SELECT rowid FROM traces ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET 10000);
      DELETE FROM events WHERE id IN
        (SELECT id FROM events ORDER BY id DESC LIMIT -1 OFFSET 20000);`);
  }

  private write(run: () => void) {
    try {
      run();
      // Bound retention maintenance; at most 128 newly inserted rows of slack.
      if (++this.writes % 128 === 0) this.prune();
    } catch {
      if (this.writeFailures++ === 0)
        console.error(
          "June diagnostic persistence failed; logs may be incomplete.",
        );
    }
  }

  saveTrace(trace: LatencyTrace) {
    this.write(() => {
      this.db
        .prepare(`INSERT INTO traces (id, at, probe, data) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
        .run(
          trace.id,
          trace.receivedAt,
          trace.probe ?? null,
          JSON.stringify(trace),
        );
    });
  }

  private event(event: Pick<DiagnosticEvent, "at" | "stage" | "requestId">) {
    this.write(() => {
      this.db
        .prepare("INSERT INTO events (at, data) VALUES (?, ?)")
        .run(event.at, JSON.stringify({ ...event, ...this.session }));
    });
  }

  ingress(observation: SlackIngressObservation) {
    if (!slackIngressStages.includes(observation.stage)) return;
    recordEvent("june.slack.ingress", {
      "june.channel": "slack",
      "june.phase": observation.stage,
      ...(observation.requestId
        ? { "june.operation.id": correlationId(observation.requestId) }
        : {}),
    });
    this.event({
      at: observation.at,
      stage: `slack.${observation.stage}`,
      requestId: observation.requestId,
    });
  }

  lifecycle(stage: (typeof lifecycleStages)[number]) {
    if (lifecycleStages.includes(stage)) {
      recordEvent("june.lifecycle", { "june.phase": stage });
      this.event({ at: Date.now(), stage });
    }
  }

  slackOAuth(failure: SlackMcpOAuthFailure) {
    if (
      !slackOAuthStages.includes(failure.stage) ||
      !slackOAuthReasons.includes(failure.reason)
    )
      return;
    recordEvent("june.slack.oauth", {
      "june.channel": "slack",
      "june.phase": failure.stage,
      "june.outcome": failure.reason,
    });
    this.event({
      at: Date.now(),
      stage: `slack_oauth.${failure.stage}.${failure.reason}`,
    });
  }

  traces(probe?: string, excludeId = ""): LatencyTrace[] {
    const rows = this.db
      .prepare(`SELECT data FROM traces WHERE at >= ? AND id != ?
        AND (? IS NULL OR probe = ?) ORDER BY at DESC, rowid DESC LIMIT 128`)
      .all(
        Date.now() - retentionMs,
        excludeId,
        probe ?? null,
        probe ?? null,
      ) as {
      data: string;
    }[];
    return rows.map((row) => JSON.parse(row.data) as LatencyTrace).reverse();
  }

  snapshot() {
    const events = this.db
      .prepare(
        "SELECT data FROM events WHERE at >= ? ORDER BY id DESC LIMIT 100",
      )
      .all(Date.now() - retentionMs) as { data: string }[];
    return {
      ...this.session,
      retentionDays: 30,
      traceLimit: 10000,
      eventLimit: 20000,
      writeFailures: this.writeFailures,
      traces: this.traces(),
      events: events.map((row) => JSON.parse(row.data) as DiagnosticEvent),
    };
  }

  report() {
    const snapshot = this.snapshot();
    // Keep failures visible even when the owner's request itself adds ingress
    // events. Read retained rows, not the mixed snapshot's 100-event window.
    const oauth = this.db
      .prepare(
        `SELECT data FROM events WHERE at >= ?
        AND json_extract(data, '$.stage') GLOB 'slack_oauth.*'
        ORDER BY id DESC LIMIT 3`,
      )
      .all(Date.now() - retentionMs) as { data: string }[];
    const events = [
      ...oauth.map((row) => JSON.parse(row.data) as DiagnosticEvent),
      ...snapshot.events.filter(
        (event) => !event.stage.startsWith("slack_oauth."),
      ),
    ].slice(0, 12);
    return [
      `Persistent diagnostic log, as of ${new Date().toISOString()}. Retention: 30 days, capped at 10,000 traces / 20,000 events (pruned every 128 writes).`,
      `Write failures this process: ${snapshot.writeFailures}; missing records are unknown, not proof no work occurred.`,
      "Shutdown phase returns record control flow only, not durable settlement.",
      "Latest OAuth failures (up to 3), then lifecycle/Slack ingress events (12 total; no contents or credentials). OAuth labels identify the failed check, not whether Slack issued a token; never replay a consumed confirmation:",
      ...events.map(
        (event) =>
          `${new Date(event.at).toISOString()} ${event.stage}; process ${event.processId}; revision ${event.revision ?? "unknown"}`,
      ),
      'For persisted timings, use latency: "recent" or an exact ping UUIDv4. Logs are private to the owner; never relay them to another user or a shared channel.',
    ].join("\n");
  }

  close() {
    this.db.close();
  }
}
