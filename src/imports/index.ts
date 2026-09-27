import { createHash, randomUUID } from "node:crypto";
import {
  type EvidenceStore,
  ImmutableSourceConflictError,
  type ImportBudget,
  ImportBudgetExceeded,
  type ImportCoverage,
  importHistory,
  type PageFetcher,
} from "../memory/store.js";

export type { ConnectorConfig } from "./common.js";
export { createGmailHistoryFetcher } from "./gmail.js";
export { gmailSourceId, slackSource, slackSourceId } from "./identity.js";
export { createSlackHistoryFetcher } from "./slack.js";

interface ImportSelection {
  coverage: ImportCoverage;
  /** Exact non-secret credential reference, never an account display name. */
  credentialAccount: string;
  fetchPage: PageFetcher;
}

/** Identifies the current import binding for review; never consent to fetch. */
export function importCoverageDigest(
  id: string,
  coverage: ImportCoverage,
  credentialAccount: string,
  confirmationScope: string,
) {
  if (!credentialAccount.trim())
    throw new Error("Missing import credential account binding");
  return createHash("sha256")
    .update(
      JSON.stringify([id, coverage, credentialAccount, confirmationScope]),
    )
    .digest("hex");
}

/** Host service. No event dispatch, approvals or sends.
 * Register authenticated selections at boot; callers cannot supply coverage.
 * Each start/resume processes at most one page, never sleeps or spins.
 */
export class HistoryImports {
  private readonly active = new Map<string, AbortController>();
  private readonly budgetRejections = new Map<string, keyof ImportBudget>();
  // Process-local, content-free observation bound to the rejected page. A
  // cancelled/no-op/failed retry is not evidence the conflict was reconciled.
  private readonly conflicts = new Map<string, number>();
  private readonly selections: Map<string, ImportSelection>;
  // A restarted host may replace a credential behind the same environment name.
  // Expire all old confirmations without opening or hashing credential values.
  private readonly confirmationScope = randomUUID();

  constructor(
    private readonly store: EvidenceStore,
    selections: Record<string, ImportSelection>,
    private readonly now = Date.now,
  ) {
    this.selections = new Map(
      Object.entries(selections).map(([id, s]) => [
        id,
        {
          coverage: structuredClone(s.coverage),
          credentialAccount: s.credentialAccount,
          fetchPage: s.fetchPage,
        },
      ]),
    );
  }

  review(id: string) {
    const { coverage, credentialAccount } = this.selection(id);
    return {
      coverage: structuredClone(coverage),
      digest: importCoverageDigest(
        id,
        coverage,
        credentialAccount,
        this.confirmationScope,
      ),
      ...this.status(id),
    };
  }

  status(id: string) {
    const selection = this.selection(id);
    const progress = this.store.importProgress(id);
    const conflictAtPage = this.conflicts.get(id);
    const cooldown = this.store.importCooldown(
      selection.coverage.platform,
      selection.coverage.account,
    );
    const notBefore = cooldown.notBefore;
    const cooldownReason =
      notBefore > 0 && cooldown.cooldownReason === undefined
        ? "unknown"
        : (cooldown.cooldownReason ?? null);
    return {
      running: this.active.has(id),
      progress,
      notBefore,
      cooldownReason,
      coolingDown: this.now() < notBefore,
      budget: {
        limits: this.store.importBudget,
        lastRejection: this.budgetRejections.get(id) ?? null,
      },
      lastConflict:
        conflictAtPage !== undefined && conflictAtPage === progress?.pages
          ? ("immutable_source" as const)
          : null,
    };
  }

  cancel(id: string, audience?: string) {
    const { coverage } = this.selection(id);
    if (audience !== undefined && !coverage.audiences.includes(audience))
      throw new Error("Import selection is not authorized");
    this.store.beginImport(id, coverage);
    // Persist first: queued continuations and other service instances do not
    // share this controller. Never release a durable uncertain-read marker.
    this.store.cancelImport(id);
    this.active.get(id)?.abort();
    return this.status(id);
  }

  async start(id: string) {
    const selection = this.selection(id);
    if (this.active.has(id)) throw new Error("Import already running");
    this.store.beginImport(id, selection.coverage);
    const progress = this.store.importProgress(id);
    if (!progress) throw new Error("Missing import progress");
    if (progress.cancelled) return progress;
    for (const [otherId, other] of this.selections) {
      if (
        other.coverage.platform !== selection.coverage.platform ||
        other.coverage.account !== selection.coverage.account
      )
        continue;
      if (this.active.has(otherId))
        throw new Error("Account import already running");
    }
    const { notBefore, cooldownReason } = this.store.importCooldown(
      selection.coverage.platform,
      selection.coverage.account,
    );
    const now = this.now();
    // Do not let importHistory's later clock read bypass a longer account wait.
    if (now < progress.notBefore) return progress;
    const controller = new AbortController();
    this.active.set(id, controller);
    try {
      if (!progress.complete && now < notBefore) {
        this.store.persistPage(
          progress,
          {
            sources: [],
            nextCursor: progress.cursor,
            rateLimited: true,
            retryAfterMs: notBefore - now,
            cooldownReason: cooldownReason ?? "unknown",
          },
          now,
        );
        return {
          ...progress,
          notBefore,
          cooldownReason: cooldownReason ?? "unknown",
        };
      }
      const result = await importHistory(
        this.store,
        id,
        selection.coverage,
        selection.fetchPage,
        { signal: controller.signal, now: this.now, maxPages: 1 },
      );
      if (result.pages > progress.pages) this.budgetRejections.delete(id);
      return result;
    } catch (error) {
      if (error instanceof ImportBudgetExceeded)
        this.budgetRejections.set(id, error.dimension);
      if (error instanceof ImmutableSourceConflictError)
        this.conflicts.set(id, progress.pages);
      throw error;
    } finally {
      this.active.delete(id);
    }
  }

  private selection(id: string) {
    const selection = this.selections.get(id);
    if (!selection) throw new Error("Import selection is not configured");
    return selection;
  }
}
