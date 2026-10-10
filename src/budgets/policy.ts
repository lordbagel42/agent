/** Host-only classification of the exact provider/account/action path. Never
 * accept this from model/tool arguments, descriptions, readOnlyHint, connection
 * presence or an unverified claim of free credits. Unknown billing fails closed.
 */
export type SpendingClass =
  | "included-inference"
  | "verified-no-charge"
  | "owner-funded"
  | "unknown";

export type SpendingAdmission =
  | { allowed: true }
  | {
      allowed: false;
      code: "owner_spending_prohibited" | "billing_unverified";
      reason: string;
    };

/** Current owner policy, not a budget balance or authority to run an action.
 * This synchronous check grants no account/source access and writes no state.
 * An adapter must establish its classification and retain its own live fences.
 */
export function spendingAdmission(
  classification: SpendingClass,
): SpendingAdmission {
  if (
    classification === "included-inference" ||
    classification === "verified-no-charge"
  )
    return { allowed: true };
  if (classification === "owner-funded")
    return {
      allowed: false,
      code: "owner_spending_prohibited",
      reason:
        "Owner-funded spending is prohibited now, including Stripe Link. A future transaction requires a changed owner policy, Stripe Link and fresh explicit authorization; login, available funds or credits are not approval. No alternate payment route, paid fallback or retry is permitted.",
    };
  return {
    allowed: false,
    code: "billing_unverified",
    reason:
      "The host has not established that this exact action/provider/account is included inference or otherwise non-spending. Resolve billing ambiguity before dispatch; credentials, protocol, read-only labels and missing prices do not prove no charge. Do not fall back to a paid route or buy quota.",
  };
}
