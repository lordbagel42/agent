import {
  type EvidenceStore,
  type ImportCoverage,
  importHistory,
  type PageFetcher,
} from "../memory/store.js";

export type { ConnectorConfig } from "./common.js";
export { createGmailHistoryFetcher } from "./gmail.js";
export { gmailSourceId, slackSourceId } from "./identity.js";
export { createSlackHistoryFetcher } from "./slack.js";

/** Host-only operator service. No model tools, event dispatch, approvals or sends.
 * Register authenticated selections at boot; callers cannot supply coverage.
 * Each start/resume processes at most one page, never sleeps or spins.
 */
export class HistoryImports {
  private readonly active = new Map<string, AbortController>();
  private readonly selections: Map<
    string,
    { coverage: ImportCoverage; fetchPage: PageFetcher }
  >;

  constructor(
    private readonly store: EvidenceStore,
    selections: Record<
      string,
      { coverage: ImportCoverage; fetchPage: PageFetcher }
    >,
    private readonly now = Date.now,
  ) {
    this.selections = new Map(
      Object.entries(selections).map(([id, s]) => [
        id,
        { coverage: structuredClone(s.coverage), fetchPage: s.fetchPage },
      ]),
    );
  }

  status(id: string) {
    this.selection(id);
    return {
      running: this.active.has(id),
      progress: this.store.importProgress(id),
    };
  }

  cancel(id: string) {
    this.selection(id);
    this.active.get(id)?.abort();
    return this.status(id);
  }

  async start(id: string) {
    const selection = this.selection(id);
    if (this.active.has(id)) throw new Error("Import already running");
    this.store.beginImport(id, selection.coverage);
    const progress = this.store.importProgress(id);
    if (!progress) throw new Error("Missing import progress");
    let notBefore = progress.notBefore;
    for (const [otherId, other] of this.selections) {
      if (
        other.coverage.platform !== selection.coverage.platform ||
        other.coverage.account !== selection.coverage.account
      )
        continue;
      if (this.active.has(otherId))
        throw new Error("Account import already running");
      notBefore = Math.max(
        notBefore,
        this.store.importProgress(otherId)?.notBefore ?? 0,
      );
    }
    const now = this.now();
    if (!progress.complete && now >= progress.notBefore && now < notBefore) {
      this.store.persistPage(
        progress,
        {
          sources: [],
          nextCursor: progress.cursor,
          rateLimited: true,
          retryAfterMs: notBefore - now,
        },
        now,
      );
      return { ...progress, notBefore };
    }
    const controller = new AbortController();
    this.active.set(id, controller);
    try {
      return await importHistory(
        this.store,
        id,
        selection.coverage,
        selection.fetchPage,
        { signal: controller.signal, now: this.now, maxPages: 1 },
      );
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
