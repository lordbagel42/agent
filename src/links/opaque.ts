import type { CapabilityBroker, Receipt, ToolAction } from "../tools/broker.js";

/** Route GET only to inspect; route authenticated, CSRF-protected POST to redeem.
 * Do not log tokens/URLs. Return Cache-Control: no-store and Referrer-Policy: no-referrer.
 * The host resupplies the exact payload on redemption; it is not stored in SQLite.
 */
export class OpaqueActionLinks {
  readonly #reviewed = new Map<
    string,
    { grantId: string; action: ToolAction; expiresAt: number }
  >();
  constructor(private readonly broker: CapabilityBroker) {}
  issue(owner: string, grantId: string, expiresAt: number): string {
    return this.broker.issueLink(owner, grantId, expiresAt);
  }
  /** Owner-only HTTP issuance. Keep at most 32 bounded payloads in memory, never
   * SQLite. A restart loses review details; reissuing cannot revive an old token. */
  issueReviewed(
    owner: string,
    grantId: string,
    input: unknown,
    expiresAt: number,
  ): string | undefined {
    const action = this.broker.propose(input);
    if (!this.broker.matchesGrant(owner, grantId, action))
      throw new Error("capability_denied");
    for (const [token, entry] of this.#reviewed)
      if (entry.expiresAt <= Date.now()) this.#reviewed.delete(token);
    if (this.#reviewed.size >= 32) return;
    const token = this.issue(owner, grantId, expiresAt);
    try {
      // An operator link may only review grants addressed to the owner.
      this.inspect(owner, token);
    } catch (error) {
      this.revoke(owner, token);
      throw error;
    }
    this.#reviewed.set(token, { grantId, action, expiresAt });
    return token;
  }
  resolveAction(owner: string, grantId: string, token: string) {
    const entry = this.#reviewed.get(token);
    if (!entry) return;
    if (entry.expiresAt <= Date.now()) {
      this.#reviewed.delete(token);
      return;
    }
    if (
      entry.grantId !== grantId ||
      !this.broker.matchesGrant(owner, grantId, entry.action)
    )
      return;
    // Return a normalized copy so consumers cannot alter the reviewed payload.
    return this.broker.propose(entry.action);
  }
  inspect(audience: string, token: string) {
    return this.broker.inspectLink(audience, token);
  }
  revoke(owner: string, token: string): void {
    this.broker.revokeLink(owner, token);
    this.#reviewed.delete(token);
  }
  redeem(audience: string, token: string, action: unknown): Promise<Receipt> {
    const link = this.inspect(audience, token);
    return this.broker.execute(audience, link.grantId, action, token);
  }
}
