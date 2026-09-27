import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type EvidenceStore,
  extractMemory,
  type ImportCoverage,
  type Source,
} from "../memory/store.js";

/** Operator-only one-shot extraction, separate from page fetching and the live
 * inbox. No scheduler, acceptance, tools, or retries. Ledger intent survives a
 * crash; unknown attempts require investigation, never a replacement call. */
export class ImportedMemoryExtraction {
  private readonly active = new Map<string, AbortController>();
  private readonly selections: Record<string, ImportCoverage>;
  private readonly binding: string;

  constructor(
    private readonly store: EvidenceStore,
    selections: Record<string, ImportCoverage>,
    private readonly audience: string,
    binding: object,
    private readonly extract: Parameters<typeof extractMemory>[3],
  ) {
    this.selections = structuredClone(selections);
    this.binding = JSON.stringify(binding);
  }

  review(id: string) {
    const coverage = Object.hasOwn(this.selections, id)
      ? this.selections[id]
      : undefined;
    if (!coverage?.audiences.includes(this.audience))
      throw new Error("Import selection is not authorized");
    const progress = this.store.importProgress(id);
    if (progress && !isDeepStrictEqual(progress.coverage, coverage))
      throw new Error("Import coverage changed");
    const attempts = this.store.importExtractions(this.audience);
    const attempted = new Set(attempts.flatMap((e) => e.sourceIds));
    const membership = new Set(progress?.sourceIds ?? []);
    const eligible = this.store
      .search(this.audience, "")
      .sources.filter(
        (s) =>
          membership.has(s.id) &&
          !attempted.has(s.id) &&
          !(s.platform === "slack" && s.text.startsWith("##")),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    const batch: Source[] = [];
    let oversized = 0;
    for (const source of eligible) {
      if (JSON.stringify([source]).length > 64_000) {
        oversized++;
        continue;
      }
      if (
        batch.length < 20 &&
        JSON.stringify([...batch, source]).length <= 64_000
      )
        batch.push(source);
    }
    const sourceIds = batch.map((s) => s.id);
    const contextClaimIds = this.store
      .retrieve(this.audience, "", {
        claimsOnly: true,
        limit: 20,
        maxCharacters: 16000,
      })
      .claims.map((c) => c.id);
    const blocked =
      this.active.size > 0 || attempts.some((e) => e.status === "started");
    return {
      coverage: structuredClone(coverage),
      model: JSON.parse(this.binding) as object,
      sourceIds,
      contextClaimIds,
      digest:
        sourceIds.length && !blocked
          ? createHash("sha256")
              .update(
                JSON.stringify([
                  id,
                  coverage,
                  this.audience,
                  sourceIds,
                  contextClaimIds,
                  this.binding,
                ]),
              )
              .digest("hex")
          : null,
      eligible: eligible.length,
      oversized,
      untrackedPages: (progress?.pages ?? 0) - (progress?.trackedPages ?? 0),
      blocked,
      attempts: attempts
        .filter((e) => e.importId === id)
        .map((e) => ({
          ...e,
          // A saved intent with no local handle is unknown, not resumable work.
          status:
            e.status === "started" && !this.active.has(e.id)
              ? "uncertain"
              : e.status,
          running: this.active.has(e.id),
        })),
    };
  }

  async start(id: string, digest: string) {
    const review = this.review(id);
    if (!review.digest || digest !== review.digest)
      throw new Error("Import extraction review changed");
    this.store.beginImportExtraction({
      id: digest,
      importId: id,
      audience: this.audience,
      sourceIds: review.sourceIds,
      contextClaimIds: review.contextClaimIds,
      status: "started",
      proposalIds: [],
    });
    const controller = new AbortController();
    this.active.set(digest, controller);
    try {
      await extractMemory(
        this.store,
        this.audience,
        review.sourceIds,
        this.extract,
        controller.signal,
        digest,
      );
    } catch {
      // Even a timeout/parse failure may have spent money. Do not log provider
      // errors or retry. A durable cancel/delete always wins over completion.
      this.store.stopImportExtraction(digest, "uncertain");
    } finally {
      this.active.delete(digest);
    }
    return this.review(id);
  }

  cancel(id: string, digest: string) {
    const attempt = this.review(id).attempts.find((e) => e.id === digest);
    if (!attempt) throw new Error("Missing import extraction");
    this.store.stopImportExtraction(digest, "cancelled");
    this.active.get(digest)?.abort();
    return this.review(id);
  }
}
