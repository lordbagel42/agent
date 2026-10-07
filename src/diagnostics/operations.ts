import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const operationIdSchema = z
  .string()
  .max(200)
  .regex(/^[a-zA-Z0-9:_-]+$/);
const code = z
  .string()
  .max(80)
  .regex(/^[a-z][a-z0-9_-]*$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const thread = z
  .string()
  .regex(/^T-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
export const operationSourceSchema = z.enum([
  "controller",
  "deployment",
  "recovery",
  "debugshare",
  "amp-task",
  "coding",
]);
export const MAX_OPERATION_BYTES = 16_384;

/** Fixed metadata only. No generic payload, text, prompt, result or error field. */
export const operationEventSchema = z
  .strictObject({
    id: operationIdSchema,
    operationId: operationIdSchema,
    source: operationSourceSchema,
    sequence: time,
    observedAt: time,
    occurredAt: time.nullable(),
    status: z.enum([
      "queued",
      "dispatching",
      "running",
      "completed",
      "unknown",
      "failed",
      "blocked",
      "healthy",
      "reconciled",
      "received",
      "preparing",
      "activating",
      "rolled_back",
      "superseded",
      "deferred",
      "fetch_failed",
      "pending",
      "spawned",
      "claimed",
      "idle",
      "awaiting_approval",
      "needs_review",
    ]),
    failure: z.boolean(),
    phase: code.optional(),
    reason: code.optional(),
    revision: revision.optional(),
    threadId: thread.optional(),
    snapshotId: z.uuid().optional(),
    attempt: time.optional(),
    retryAt: time.optional(),
    relatedOperationId: operationIdSchema.optional(),
    controller: z
      .strictObject({
        activeRevision: revision.nullable(),
        observedRevision: revision.nullable(),
        targetRevision: revision.nullable(),
        controllerRevision: revision.nullable(),
        blocked: z.boolean(),
        operatorHold: z.boolean(),
        phase: code.nullable(),
        recoveryIncident: operationIdSchema.nullable(),
        recoveryThreadId: thread.nullable(),
        recoveryOwner: thread.nullable(),
        retryAttempts: time.nullable(),
        retryAt: time.nullable(),
        queuedRevisions: z.array(revision).max(50),
        omittedQueueCount: time,
      })
      .optional(),
  })
  .refine(
    (event) =>
      event.operationId.startsWith(`${event.source}:`) &&
      (event.controller === undefined || event.source === "controller"),
  );

export type OperationEvent = z.infer<typeof operationEventSchema>;
export type OperationObservation = Omit<
  OperationEvent,
  "id" | "sequence" | "observedAt"
>;
export interface OperationSummary {
  latest: OperationEvent;
  firstObservedAt: number;
  lastObservedAt: number;
  eventCount: number;
  failure: OperationEvent | null;
  failureKey: string | null;
  matchingFailures: number;
}
export interface OperationIndex {
  items: OperationSummary[];
  total: number;
  nextOffset: number | null;
  controller: OperationEvent | null;
}
export interface OperationDetail {
  operation: OperationSummary;
  events: OperationEvent[];
  totalEvents: number;
  nextOffset: number | null;
  related: OperationSummary[];
}
export const operationQuerySchema = z.strictObject({
  query: z.string().max(512).trim().default(""),
  source: operationSourceSchema.optional(),
  sources: z.array(operationSourceSchema).min(1).max(6).optional(),
  failuresOnly: z.boolean().default(false),
  failureKey: z.string().max(250).optional(),
  offset: time.default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
export type OperationQuery = z.input<typeof operationQuerySchema>;

export class OperationValidationError extends Error {
  constructor() {
    super("Invalid operation metadata");
  }
}
export class OperationConflictError extends Error {
  constructor() {
    super("Operation identity conflict");
  }
}
export function validateOperation(value: unknown): OperationEvent {
  const parsed = operationEventSchema.safeParse(value);
  if (
    !parsed.success ||
    Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_OPERATION_BYTES
  )
    throw new OperationValidationError();
  return parsed.data;
}
export function failureKey(event: OperationEvent): string | null {
  return event.failure
    ? `${event.source}:${event.phase ?? "unknown"}:${event.reason ?? event.status}`
    : null;
}
export function initializeOperations(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS operation_events (
    id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, source TEXT NOT NULL,
    sequence INTEGER NOT NULL, observed_at INTEGER NOT NULL, failure_key TEXT,
    search TEXT NOT NULL, event TEXT NOT NULL, UNIQUE(operation_id, sequence));
    CREATE INDEX IF NOT EXISTS operation_failures ON operation_events(failure_key, operation_id);
    CREATE INDEX IF NOT EXISTS operation_observed ON operation_events(observed_at DESC);
    CREATE INDEX IF NOT EXISTS operation_sources ON operation_events(source, observed_at DESC);`);
}
export function putOperation(
  db: DatabaseSync,
  event: OperationEvent,
): "created" | "exists" {
  const json = JSON.stringify(event);
  const existing = db
    .prepare(
      "SELECT event FROM operation_events WHERE id=? OR (operation_id=? AND sequence=?)",
    )
    .all(event.id, event.operationId, event.sequence);
  if (existing.length) {
    if (existing.length !== 1 || existing[0]?.event !== json)
      throw new OperationConflictError();
    return "exists";
  }
  db.prepare("INSERT INTO operation_events VALUES(?,?,?,?,?,?,?,?)").run(
    event.id,
    event.operationId,
    event.source,
    event.sequence,
    event.observedAt,
    failureKey(event),
    [
      event.operationId,
      event.source,
      event.status,
      event.phase,
      event.reason,
      event.revision,
      event.threadId,
      event.snapshotId,
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase(),
    json,
  );
  return "created";
}
function decode(
  row: Record<string, unknown> | undefined,
): OperationEvent | null {
  return row ? (JSON.parse(row.event as string) as OperationEvent) : null;
}
function summary(db: DatabaseSync, id: string): OperationSummary | undefined {
  const latest = decode(
    db
      .prepare(
        "SELECT event FROM operation_events WHERE operation_id=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(id),
  );
  if (!latest) return;
  const failure = decode(
    db
      .prepare(
        "SELECT event FROM operation_events WHERE operation_id=? AND failure_key IS NOT NULL ORDER BY sequence DESC LIMIT 1",
      )
      .get(id),
  );
  const stats = db
    .prepare(
      "SELECT MIN(observed_at) first, MAX(observed_at) last, COUNT(*) count FROM operation_events WHERE operation_id=?",
    )
    .get(id);
  const key = failure && failureKey(failure);
  return {
    latest,
    firstObservedAt: Number(stats?.first),
    lastObservedAt: Number(stats?.last),
    eventCount: Number(stats?.count),
    failure,
    failureKey: key,
    matchingFailures: key
      ? Number(
          db
            .prepare(
              "SELECT COUNT(DISTINCT operation_id) count FROM operation_events WHERE failure_key=?",
            )
            .get(key)?.count,
        )
      : 0,
  };
}
export function listOperations(
  db: DatabaseSync,
  options: OperationQuery = {},
): OperationIndex {
  const parsed = operationQuerySchema.safeParse(options);
  if (!parsed.success) throw new OperationValidationError();
  const {
    query,
    source,
    sources,
    failuresOnly,
    failureKey: key,
    offset,
    limit,
  } = parsed.data;
  // Search ALL historical events: completion must not hide the earlier failure.
  const where = `source!='controller' AND (?='' OR source=?) AND instr(search,?)>0
    AND (?='' OR operation_id IN (SELECT operation_id FROM operation_events WHERE failure_key=?))
    AND (?=0 OR operation_id IN (SELECT operation_id FROM operation_events WHERE failure_key IS NOT NULL))
    ${sources ? `AND source IN (${sources.map(() => "?").join(",")})` : ""}`;
  const args = [
    source ?? "",
    source ?? "",
    query.toLowerCase(),
    key ?? "",
    key ?? "",
    Number(failuresOnly),
    ...(sources ?? []),
  ];
  const total = Number(
    db
      .prepare(
        `SELECT COUNT(DISTINCT operation_id) count FROM operation_events WHERE ${where}`,
      )
      .get(...args)?.count,
  );
  const ids = db
    .prepare(`SELECT operation_id, MAX(observed_at) last FROM operation_events WHERE ${where}
    GROUP BY operation_id ORDER BY last DESC,operation_id ASC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);
  const items = ids
    .map((row) => summary(db, row.operation_id as string))
    .filter((item): item is OperationSummary => !!item);
  return {
    items,
    total,
    nextOffset: offset + items.length < total ? offset + items.length : null,
    controller: decode(
      db
        .prepare(
          "SELECT event FROM operation_events WHERE source='controller' ORDER BY sequence DESC LIMIT 1",
        )
        .get(),
    ),
  };
}
export function getOperation(
  db: DatabaseSync,
  id: string,
  offset = 0,
): OperationDetail | undefined {
  if (
    !operationIdSchema.safeParse(id).success ||
    !time.safeParse(offset).success
  )
    throw new OperationValidationError();
  const operation = summary(db, id);
  if (!operation) return;
  const events = db
    .prepare(
      "SELECT event FROM operation_events WHERE operation_id=? ORDER BY sequence DESC LIMIT 100 OFFSET ?",
    )
    .all(id, offset)
    .map((row) => decode(row) as OperationEvent);
  const related = operation.failureKey
    ? db
        .prepare(`SELECT operation_id, MAX(observed_at) last
    FROM operation_events WHERE failure_key=? AND operation_id!=? GROUP BY operation_id
    ORDER BY last DESC,operation_id ASC LIMIT 10`)
        .all(operation.failureKey, id)
        .map((row) => summary(db, row.operation_id as string))
        .filter((item): item is OperationSummary => !!item)
    : [];
  return {
    operation,
    events,
    totalEvents: operation.eventCount,
    nextOffset:
      offset + events.length < operation.eventCount
        ? offset + events.length
        : null,
    related,
  };
}
