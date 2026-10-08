import { isDeepStrictEqual } from "node:util";
import type { HistoryImports } from "../imports/index.js";
import type { ImportCoverage } from "../memory/store.js";

/** Formats a review, never calls a mutating service or supplies credentials.
 * The authenticated operator API rechecks digest and expectedPages on POST.
 */
export function proposeImportApproval(
  selection: string,
  coverage: ImportCoverage,
  digest: string,
  {
    running,
    progress,
  }: Pick<ReturnType<HistoryImports["status"]>, "running" | "progress">,
): string {
  if (progress && !isDeepStrictEqual(progress.coverage, coverage))
    throw new Error("Import coverage changed");
  if (
    coverage.audiences.length !== 1 ||
    running ||
    progress?.cancelled ||
    progress?.complete
  )
    return "A one-page import approval is unavailable for this selection. Inspect its current coverage and progress; no import was started.";

  const expectedPages = progress?.pages ?? 0;
  const review = {
    selection,
    coverage: {
      platform: coverage.platform,
      account: coverage.account,
      conversations: coverage.conversations,
      from: coverage.from,
      to: coverage.to,
    },
    retentionAudience: "authenticated owner-private only",
    digest,
    expectedPages,
    maxPages: 1,
    confirmation: {
      method: "POST",
      path: `/operator/imports/${encodeURIComponent(selection)}/start`,
      body: { confirmed: true, digest, expectedPages },
    },
  };
  const text = `One-page import review at ${new Date().toISOString()}. No import was started.\n${JSON.stringify(review)}\nfrom/to are configured epoch milliseconds [from,to). A page is not complete account history. When importCancel task controls are exposed, June can review the exact selection and decide one start-page using its current digest and expectedPages, without human confirmation. The operator confirmation payload above is an alternative authenticated route, not a task prerequisite; never send credentials in chat. Preserve the configured retention audience. Changed coverage, credential account, page progress or host restart requires a fresh review; matching display names do not establish account identity. Further pages need a new bounded decision, never automatic continuation or retry. Unknown outcomes require operator reconciliation.`;
  // Never offer an approval when the exact coverage cannot fit in the receipt.
  if (text.length > 3500)
    return "The exact import review is too large for one reply. No import was started. Use authenticated GET /operator/imports for the full review; do not infer missing coverage or execute from a partial review.";
  return text;
}
