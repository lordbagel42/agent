import type { UsageSnapshot } from "../models/usage.js";

export const INFERENCE_SPENDING_KNOWLEDGE =
  "Authorized inference: uncapped by owner policy for existing authorized subscription/included model usage, including useful background inference. Do not impose artificial token quotas or model-use USD caps. Missing prices or D3 dollar caps do not block that included inference. This is not a claim that model use costs zero or that a provider has unlimited capacity. Preserve actual rate limits/backoff, bounded concurrency, cancellation, recovery fences and foreground responsiveness. Do useful admitted work, not purposeless busy-loop requests. Do not buy additional quota, enroll a provider or use a paid fallback. Separately metered API billing must not be assumed included/free; surface billing ambiguity before incurring a charge.";

export const EXTERNAL_SPENDING_KNOWLEDGE =
  "Owner-funded external spending: prohibited for now, including Stripe Link. Future owner-funded transactions require Stripe Link AND fresh explicit owner authorization; Link availability or login is not approval. No alternate saved cards, direct charges, purchases, paid tool/compute provisioning, phone charges, top-ups, paid fallback or financial commitments as a workaround. June-earned funds are a possible future policy, not permission to earn, transact or spend now; never relabel owner funds or credits as earnings. Existing credentials, connections, readOnlyHint and tool availability are not proof of price, entitlement or spending authority. Other capability help describing paid execution or operation without confirmation is not spending permission and does not override this prohibition. API-key decision/jury and Jev adapters reject owner-funded or unverified billing before dispatch; this does not attest Codex-backed decision/sentinel or mind routes. An owner_spending_prohibited or billing_unverified denial is a policy/setup result, not a provider answer or charge receipt; do not retry or relabel the route as included. Ask the operator to resolve the exact route's billing evidence, not to add an inference quota.";

export const BUDGET_INSPECTION_KNOWLEDGE =
  "Budget inspection uses the existing analytics action when exposed: it reads bounded token telemetry and explains policy/prerequisites, never reserves money, enables a provider, changes caps, starts a background loop, retries an effect or releases a hold. Source implementation, installed hooks, live readiness and actual workflow proof are distinct. Monetary amounts and remaining budget are unknown, not zero. Token counters, successful answers, failed requests and confirmed_stopped model lifecycle receipts are not charge receipts. Keep known charge, confirmed no-charge, and unknown distinct; an unknown effect retains its original operation identity and any reservation for reconciliation, never a fresh paid attempt after timeout. The host/subsystem that owns the operation owns continuation and settlement; do not duplicate it.";

/** Read-only description of this telemetry path, not an admission implementation.
 * No prices, money totals or entitlements can be derived from token counters.
 * Only fixed protocol labels leave the ledger; models, IDs and bodies stay out.
 */
export function budgetReadinessReport(
  snapshot: Pick<UsageSnapshot, "byProvider" | "total">,
): string {
  const observed = (["codex", "openai", "anthropic"] as const)
    .flatMap((provider) => {
      const group = snapshot.byProvider.find((row) => row.label === provider);
      return group ? [`${provider}: ${group.calls} recorded calls`] : [];
    })
    .join("; ");
  return [
    "Budget readiness (read-only; not an admission or billing receipt).",
    INFERENCE_SPENDING_KNOWLEDGE,
    EXTERNAL_SPENDING_KNOWLEDGE,
    `Observed inference protocols in this usage window: ${observed || "none recorded; this is not proof of no usage"}. Protocol names are not provider/account identities or proof of current configuration, entitlement or included billing.`,
    `Financial outcomes for the ${snapshot.total.calls} recorded calls: unavailable. This ledger cannot classify known charge, confirmed no-charge, and unknown from completion/failure/token counts; it has no billing receipts.`,
    "External-effect budget admission: unavailable in this telemetry path. No durable money reservation/settlement ledger is mounted here. External tool/compute/call/purchase charges, native coding runtimes and external observers are outside this token ledger's coverage. Do not claim global spending enforcement from this report.",
    "External-money caps (per-task, day, month, background), price ceilings, reserved/settled amounts and remaining allowance: unavailable, not zero or unlimited. D3 is currently no owner-funded spending, not a missing numeric amount to invent or request as routine setup.",
    "Prerequisites for a future spending-policy change: owner must explicitly authorize the transaction through Stripe Link; operator must obtain durable-schema approval and integrate operation-bound admission/settlement; F001 live-readiness and F002 intent-fence release evidence must be checked. This usage ledger does not attest those prerequisites. No existing unknown operation may be replayed while they are unresolved.",
    BUDGET_INSPECTION_KNOWLEDGE,
  ].join("\n");
}
