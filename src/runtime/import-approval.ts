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
  if (coverage.audiences.length !== 1 || running || progress?.complete)
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
  const text = `One-page import proposal at ${new Date().toISOString()}. No import was started.\n${JSON.stringify(review)}\nfrom/to are configured epoch milliseconds [from,to). A page is not complete account history. Review the exact coverage, digest and expectedPages above. Only an explicit human confirmation using the owner bearer credential at the operator endpoint can start at most one page. This proposal is not authorization; June cannot confirm it. Never send credentials in chat. Changed coverage or page progress rejects the confirmation. Further pages need a fresh review and confirmation.`;
  // Never offer an approval when the exact coverage cannot fit in the receipt.
  if (text.length > 3500)
    return "The exact import review is too large for one reply. No approval was proposed and no import was started. Use authenticated GET /operator/imports to review the full coverage before explicitly confirming one page there.";
  return text;
}
