import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withSpan } from "../telemetry/index.js";

export type UsageStage =
  | "fast"
  | "deep"
  | "synthesis"
  | "execution"
  | "extraction"
  | "reflection";
export type UsageProtocol = "codex" | "openai" | "anthropic";
export interface TokenUsage {
  input: number | null;
  output: number | null;
  cached: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
}
export interface UsageIdentity {
  provider: UsageProtocol;
  model: string;
  stage: UsageStage;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

/** Only numeric usage crosses this boundary. Never persist raw provider envelopes. */
export function tokenUsage(
  protocol: UsageProtocol,
  value: unknown,
): TokenUsage {
  const usage = object(value);
  const cached = count(
    protocol === "anthropic"
      ? usage.cache_read_input_tokens
      : protocol === "codex"
        ? usage.cached_input_tokens
        : object(usage.input_tokens_details).cached_tokens,
  );
  const cacheWrite =
    protocol === "anthropic"
      ? count(usage.cache_creation_input_tokens)
      : protocol === "codex"
        ? count(usage.cache_write_input_tokens)
        : count(object(usage.input_tokens_details).cache_write_tokens);
  let input = count(usage.input_tokens);
  // Anthropic's input_tokens excludes cache reads/writes; Responses and Codex include reads.
  if (protocol === "anthropic" && input !== null)
    input =
      cached !== null && cacheWrite !== null
        ? count(input + cached + cacheWrite)
        : null;
  const output = count(usage.output_tokens);
  const reasoning = count(
    protocol === "codex"
      ? usage.reasoning_output_tokens
      : object(usage.output_tokens_details).reasoning_tokens,
  );
  // Codex emits an all-zero default when no upstream usage was received.
  if (
    protocol === "codex" &&
    input === 0 &&
    output === 0 &&
    !cached &&
    !cacheWrite &&
    !reasoning
  )
    return {
      input: null,
      output: null,
      cached: null,
      cacheWrite: null,
      reasoning: null,
    };
  return {
    input,
    output,
    cached:
      cached !== null && (input === null || cached <= input) ? cached : null,
    cacheWrite:
      cacheWrite !== null && (input === null || cacheWrite <= input)
        ? cacheWrite
        : null,
    reasoning:
      reasoning !== null && (output === null || reasoning <= output)
        ? reasoning
        : null,
  };
}

export interface UsageGroup {
  label: string;
  calls: number;
  measured: number;
  failed: number;
  pending: number;
  input: number | null;
  output: number | null;
  cached: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  inputReports: number;
  outputReports: number;
  cacheReports: number;
  reasoningReports: number;
  duration: number | null;
}
export interface UsageRow extends TokenUsage, UsageIdentity {
  id: string;
  started: number;
  duration: number | null;
  status: "completed" | "failed" | "pending";
}
export interface UsageSnapshot {
  since: number;
  from: number;
  now: number;
  days: number;
  model: string;
  models: string[];
  writeFailures: number;
  total: UsageGroup;
  byModel: UsageGroup[];
  byStage: UsageGroup[];
  byProvider: UsageGroup[];
  timeline: UsageGroup[];
  recent: UsageRow[];
  p50: number | null;
  p95: number | null;
}

const aggregate = `COUNT(*) AS calls,
  COALESCE(SUM(input IS NOT NULL AND output IS NOT NULL), 0) AS measured,
  COALESCE(SUM(status = 'failed'), 0) AS failed, COALESCE(SUM(status = 'pending'), 0) AS pending,
  SUM(input) AS input, SUM(output) AS output, SUM(cached) AS cached,
  SUM(cacheWrite) AS cacheWrite, SUM(reasoning) AS reasoning,
  COUNT(input) AS inputReports, COUNT(output) AS outputReports,
  COUNT(cached) AS cacheReports, COUNT(reasoning) AS reasoningReports,
  AVG(duration) AS duration`;

/** Additive, independent ledger. It never changes or replays conversation journals. */
export class UsageLedger {
  private db: DatabaseSync;
  private writeFailures = 0;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_calls (
        id TEXT PRIMARY KEY, started INTEGER NOT NULL, provider TEXT NOT NULL,
        model TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL,
        duration INTEGER, input INTEGER, output INTEGER, cached INTEGER,
        cacheWrite INTEGER, reasoning INTEGER);
      CREATE INDEX IF NOT EXISTS usage_started ON usage_calls(started);`);
    this.db
      .prepare("INSERT OR IGNORE INTO usage_meta VALUES ('since', ?)")
      .run(Date.now());
  }

  async track<T>(
    identity: UsageIdentity,
    run: (report: (usage: TokenUsage) => void) => Promise<T>,
  ): Promise<T> {
    const id = randomUUID();
    const started = Date.now();
    // Persist intent before a provider can consume tokens. A crash leaves an honest unknown.
    this.db
      .prepare(
        "INSERT INTO usage_calls (id, started, provider, model, stage, status) VALUES (?, ?, ?, ?, ?, 'pending')",
      )
      .run(id, started, identity.provider, identity.model, identity.stage);
    let usage: TokenUsage = {
      input: null,
      output: null,
      cached: null,
      cacheWrite: null,
      reasoning: null,
    };
    let status = "failed";
    try {
      const result = await run((value) => {
        usage = value;
      });
      status = "completed";
      return result;
    } finally {
      try {
        this.db
          .prepare(
            "UPDATE usage_calls SET status = ?, duration = ?, input = ?, output = ?, cached = ?, cacheWrite = ?, reasoning = ? WHERE id = ?",
          )
          .run(
            status,
            Date.now() - started,
            usage.input,
            usage.output,
            usage.cached,
            usage.cacheWrite,
            usage.reasoning,
            id,
          );
      } catch {
        // Never turn successful generation into a retry because telemetry failed.
        this.writeFailures++;
      }
    }
  }

  /** Bounded, aggregate-only owner report; authorization belongs to the caller. */
  report(days: 1 | 7 | 30): string {
    const snapshot = this.snapshot(days);
    const total = snapshot.total;
    const count = (value: number | null) =>
      value === null ? "unknown" : String(value);
    return [
      `June usage: last ${days} days, as of ${new Date(snapshot.now).toISOString()}.`,
      `Ledger tracking began ${new Date(snapshot.since).toISOString()}; only instrumented calls are covered, not whole-account usage.`,
      `Calls: ${total.calls}; measured input/output: ${total.measured}; failed: ${total.failed}; pending: ${total.pending}.`,
      `Reported input tokens: ${count(total.input)} (${total.inputReports}/${total.calls} calls reporting).`,
      `Reported output tokens: ${count(total.output)} (${total.outputReports}/${total.calls} calls reporting).`,
      `Cached input: ${count(total.cached)}; cache writes: ${count(total.cacheWrite)}; reasoning: ${count(total.reasoning)}.`,
      "Missing counters are unknown, not zero; sums cover reported counters only. Cached input and reasoning are subsets, not extra tokens to add to input/output.",
      `Call duration p50/p95: ${count(snapshot.p50)}/${count(snapshot.p95)} ms (includes provider/process overhead, not end-to-end reply latency).`,
      `Ledger write failures this process: ${snapshot.writeFailures}.`,
      "Billing cost, subscription quota, and remaining balance: unavailable. This is token telemetry, not a billing statement.",
    ].join("\n");
  }

  snapshot(days = 7, model = "", now = Date.now()): UsageSnapshot {
    days = [1, 7, 30].includes(days) ? days : 7;
    const from = now - days * 86_400_000;
    const where = "started >= ? AND started <= ? AND (? = '' OR model = ?)";
    const params = [from, now, model, model];
    const groups = (key: string) =>
      this.db
        .prepare(
          `SELECT ${key} AS label, ${aggregate} FROM usage_calls WHERE ${where} GROUP BY ${key} ORDER BY calls DESC`,
        )
        .all(...params) as unknown as UsageGroup[];
    const total = this.db
      .prepare(
        `SELECT 'all' AS label, ${aggregate} FROM usage_calls WHERE ${where}`,
      )
      .get(...params) as unknown as UsageGroup;
    const latencyCount = (
      this.db
        .prepare(`SELECT COUNT(duration) AS n FROM usage_calls WHERE ${where}`)
        .get(...params) as { n: number }
    ).n;
    const percentile = (p: number) =>
      latencyCount
        ? (
            this.db
              .prepare(
                `SELECT duration FROM usage_calls WHERE ${where} AND duration IS NOT NULL ORDER BY duration LIMIT 1 OFFSET ?`,
              )
              .get(...params, Math.max(0, Math.ceil(latencyCount * p) - 1)) as {
              duration: number;
            }
          ).duration
        : null;
    return {
      since: (
        this.db
          .prepare("SELECT value FROM usage_meta WHERE key = 'since'")
          .get() as { value: number }
      ).value,
      from,
      now,
      days,
      model,
      writeFailures: this.writeFailures,
      models: (
        this.db
          .prepare("SELECT DISTINCT model FROM usage_calls ORDER BY model")
          .all() as { model: string }[]
      ).map((row) => row.model),
      total,
      byModel: groups("model"),
      byStage: groups("stage"),
      byProvider: groups("provider"),
      timeline: groups(
        `CAST(started / ${days === 1 ? 3_600_000 : 86_400_000} AS INTEGER)`,
      ),
      recent: this.db
        .prepare(
          `SELECT * FROM usage_calls WHERE ${where} ORDER BY started DESC LIMIT 100`,
        )
        .all(...params) as unknown as UsageRow[],
      p50: percentile(0.5),
      p95: percentile(0.95),
    };
  }
  close() {
    this.db.close();
  }
}

export function observeUsage<T>(
  ledger: UsageLedger | undefined,
  identity: UsageIdentity,
  run: (report: (usage: TokenUsage) => void) => Promise<T>,
): Promise<T> {
  return withSpan(
    "june.model.call",
    {
      "gen_ai.provider.name": identity.provider,
      "gen_ai.request.model": /^[A-Za-z0-9._:/-]{1,128}$/.test(identity.model)
        ? identity.model
        : "other",
      "gen_ai.operation.name": "chat",
      "june.phase": identity.stage,
    },
    async (span) => {
      const observed = (forward: (usage: TokenUsage) => void) =>
        run((usage) => {
          for (const [key, value] of [
            ["input_tokens", usage.input],
            ["output_tokens", usage.output],
            ["cached_tokens", usage.cached],
            ["cache_write_tokens", usage.cacheWrite],
            ["reasoning_tokens", usage.reasoning],
          ] as const) {
            if (count(value) !== null)
              span.setAttribute(`gen_ai.usage.${key}`, value as number);
          }
          forward(usage);
        });
      const result = await (ledger
        ? ledger.track(identity, observed)
        : observed(() => {}));
      span.setAttribute("june.outcome", "completed");
      return result;
    },
  );
}
