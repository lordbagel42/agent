import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ImportedMemoryExtraction } from "../imports/extraction.js";
import type { HistoryImports } from "../imports/index.js";
import type { ImportCoverage } from "../memory/store.js";

const selectionSchema = z.string().min(1).max(2048);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const importTaskSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("review"),
    /** null discovers configured IDs, never reviews or starts all selections. */
    selection: selectionSchema.nullable(),
  }),
  z.strictObject({
    action: z.literal("start-page"),
    selection: selectionSchema,
    digest: digestSchema,
    expectedPages: z.number().int().nonnegative().safe(),
  }),
  z.strictObject({
    action: z.literal("extract"),
    selection: selectionSchema,
    digest: digestSchema,
  }),
]);
export type ImportTaskCommand = z.infer<typeof importTaskSchema>;

/** Identity/liveness come from the host, not the command or invoking channel.
 * Reuse the SAME stable operationId after interruptions, including host restart.
 */
export type ImportTask = (
  command: ImportTaskCommand,
  operationId: string,
  canStartAction: () => boolean,
  signal?: AbortSignal,
) => Promise<string>;

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bounded(value: unknown) {
  const text = JSON.stringify(value);
  // Fail closed; never issue a digest alongside truncated/unseen coverage.
  if (text.length > 3500) throw new Error("import_task_review_too_large");
  return text;
}

/** Model-selected, configured work only. Existing services own evidence,
 * credentials, page/cooldown state and extraction receipts. This private store
 * contains only hashed invocation bindings and dispatch state, not source data
 * or a second import implementation. Retain it alongside the evidence ledger.
 *
 * A crash/throw after reservation leaves a conservative account-wide page hold
 * (or extraction-wide hold). Replay is inspection-only, never a replacement
 * call. No automatic reconciliation, retries, scheduling or acceptance exists.
 * Aborting the observer after dispatch is NOT proof the underlying work stopped;
 * await the bounded service call rather than racing abort or resetting its state.
 */
export function createImportTask(options: {
  owner: string;
  path: string;
  selections: Record<string, ImportCoverage>;
  imports: Pick<HistoryImports, "review" | "start">;
  extraction?: Pick<ImportedMemoryExtraction, "review" | "start">;
}): ImportTask {
  if (!options.path?.trim() || options.path === ":memory:" || !options.owner)
    throw new Error("import_task_storage_required");
  const { owner, path, imports, extraction } = options;
  const selections = new Map(
    Object.entries(structuredClone(options.selections)),
  );
  const extractionLane = hash([owner, "extract"]);
  const pageLane = (coverage: ImportCoverage) =>
    hash([owner, "start-page", coverage.platform, coverage.account]);
  const open = () => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS import_task_invocations (
          id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, lane TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending','returned','not-started')));
        CREATE INDEX IF NOT EXISTS import_task_pending ON import_task_invocations(lane,state);`);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  };
  const snapshot = (id: string, db: DatabaseSync) => {
    const coverage = selections.get(id);
    if (!coverage) throw new Error("import_task_selection_unavailable");
    let current: ReturnType<HistoryImports["review"]>;
    let batch: ReturnType<ImportedMemoryExtraction["review"]> | undefined;
    try {
      current = imports.review(id);
      batch = extraction?.review(id);
    } catch {
      throw new Error("import_task_review_unavailable");
    }
    if (
      !isDeepStrictEqual(current.coverage, coverage) ||
      (current.progress &&
        !isDeepStrictEqual(current.progress.coverage, coverage)) ||
      (batch && !isDeepStrictEqual(batch.coverage, coverage))
    )
      throw new Error("import_task_coverage_changed");
    const pending = (lane: string) =>
      !!db
        .prepare(
          "SELECT 1 FROM import_task_invocations WHERE lane=? AND state='pending' LIMIT 1",
        )
        .get(lane);
    const pageUnsettled = pending(pageLane(coverage));
    const extractionUnsettled = pending(extractionLane);
    const progress = current.progress;
    return {
      action: "review" as const,
      selection: id,
      coverage,
      digest: current.digest,
      expectedPages: progress?.pages ?? 0,
      maxPages: 1,
      page: {
        canStart:
          !pageUnsettled &&
          !current.running &&
          !current.coolingDown &&
          !progress?.cancelled &&
          !progress?.complete &&
          !current.budget.lastRejection &&
          !current.lastConflict,
        unsettled: pageUnsettled,
        running: current.running,
        started: progress !== undefined,
        pages: progress?.pages ?? 0,
        trackedPages: progress?.trackedPages ?? 0,
        complete: progress?.complete ?? false,
        cancelled: progress?.cancelled ?? false,
        notBefore: current.notBefore,
        cooldownReason: current.cooldownReason,
        coolingDown: current.coolingDown,
        gapCount: progress?.gaps.length ?? 0,
        budget: current.budget,
        lastConflict: current.lastConflict,
      },
      extraction: batch
        ? {
            digest: extractionUnsettled ? null : batch.digest,
            batch: batch.sourceIds.length,
            contextClaims: batch.contextClaimIds.length,
            maxSources: 20,
            maxSourceCharacters: 64_000,
            eligible: batch.eligible,
            oversized: batch.oversized,
            overflow: batch.overflow,
            untrackedPages: batch.untrackedPages,
            blocked: extractionUnsettled || batch.blocked,
            unsettled: extractionUnsettled,
            admission: {
              ...batch.admission,
              // The service's legacy reason denotes a decision gate, not a new
              // requirement for per-batch human approval through this interface.
              reason:
                batch.admission.reason === "approval-required"
                  ? "decision-required"
                  : batch.admission.reason,
            },
            attempts: {
              total: batch.attempts.length,
              staged: batch.attempts.filter((a) => a.status === "staged")
                .length,
              uncertain: batch.attempts.filter((a) => a.status === "uncertain")
                .length,
              cancelled: batch.attempts.filter((a) => a.status === "cancelled")
                .length,
            },
          }
        : null,
      note: "Exact configured coverage [from,to) in epoch milliseconds; audiences are unchanged retention audiences, not the invoking channel. Complete means selected traversal exhausted, not gap-free account history. No credentials, bodies, cursors, source IDs or proposal text returned. One page or one extraction batch per decision; no automatic retry or acceptance.",
    };
  };

  return async (input, operationId, canStartAction, signal) => {
    const command = importTaskSchema.parse(input);
    if (command.action === "review" && command.selection === null)
      return bounded({
        action: "review",
        selections: [...selections.keys()],
        note: "Configured IDs only, not verified access. Review an exact selection before deciding one page or extraction batch. Authentication/enrollment remain separate host controls.",
      });
    const id = command.selection;
    if (id === null || !selections.has(id))
      throw new Error("import_task_selection_unavailable");
    const db = open();
    let key = "";
    const receipt = (
      state: "returned" | "unknown" | "not-started",
      replayed: boolean,
    ) =>
      bounded({
        action: command.action,
        selection: id,
        operation: { state, replayed },
        note:
          state === "unknown"
            ? "Dispatch is pending or unknown, not proof of failure or stoppage. Do not retry with this or a new operation ID. Inspect/reconcile through the authenticated operator; no automatic recovery."
            : "Recorded dispatch state, not fresh provider verification or proof of a page/proposal. Replay runs nothing. Review current metadata separately; no automatic continuation, retry or acceptance.",
      });
    try {
      if (command.action === "review") return bounded(snapshot(id, db));
      if (
        typeof operationId !== "string" ||
        !operationId.length ||
        operationId.length > 512 ||
        [...operationId].some((c) => c.charCodeAt(0) < 32) ||
        typeof canStartAction !== "function"
      )
        throw new Error("import_task_context_required");
      key = hash([owner, operationId]);
      const fingerprint = hash(command);
      // Serialize distinct model decisions as well as identical operation IDs.
      // Commit the reservation BEFORE dispatch into either existing service.
      db.exec("BEGIN IMMEDIATE");
      try {
        const saved = db
          .prepare(
            "SELECT fingerprint,state FROM import_task_invocations WHERE id=?",
          )
          .get(key);
        if (saved) {
          if (saved.fingerprint !== fingerprint)
            throw new Error("import_task_operation_mismatch");
          return receipt(
            saved.state === "returned" || saved.state === "not-started"
              ? saved.state
              : "unknown",
            true,
          );
        }
        if (signal?.aborted || !canStartAction())
          throw new Error("import_task_not_current");
        const reviewed = snapshot(id, db);
        bounded(reviewed);
        if (command.action === "start-page") {
          if (
            command.digest !== reviewed.digest ||
            command.expectedPages !== reviewed.expectedPages
          )
            throw new Error("import_task_review_changed");
          if (!reviewed.page.canStart)
            throw new Error("import_task_page_unavailable");
        } else {
          if (command.digest !== reviewed.extraction?.digest)
            throw new Error("import_task_review_changed");
          if (!extraction || reviewed.extraction.blocked)
            throw new Error("import_task_extraction_unavailable");
        }
        db.prepare(
          "INSERT INTO import_task_invocations(id,fingerprint,lane,state) VALUES(?,?,?,'pending')",
        ).run(
          key,
          fingerprint,
          command.action === "start-page"
            ? pageLane(reviewed.coverage)
            : extractionLane,
        );
        db.exec("COMMIT");
      } finally {
        if (db.isTransaction) db.exec("ROLLBACK");
      }
    } finally {
      db.close();
    }

    const settle = (state: "returned" | "not-started") => {
      const db = open();
      try {
        db.prepare(
          "UPDATE import_task_invocations SET state=? WHERE id=? AND state='pending'",
        ).run(state, key);
      } finally {
        db.close();
      }
      return receipt(state, false);
    };
    try {
      // The check is adjacent to dispatch, with no intervening async work.
      if (signal?.aborted || !canStartAction()) return settle("not-started");
      if (command.action === "start-page") await imports.start(id);
      else if (command.action === "extract" && extraction)
        await extraction.start(id, command.digest);
      return settle("returned");
    } catch {
      // Keep the pending fence even if the underlying call or settlement write
      // failed. Never expose provider diagnostics or manufacture another start.
      return receipt("unknown", false);
    }
  };
}
