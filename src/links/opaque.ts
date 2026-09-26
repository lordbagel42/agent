import type { CapabilityBroker, Receipt } from "../tools/broker.js";

/** Route GET only to inspect; route authenticated, CSRF-protected POST to redeem.
 * Do not log tokens/URLs. Return Cache-Control: no-store and Referrer-Policy: no-referrer.
 * The action payload must be resupplied on POST; it is deliberately not stored in SQLite.
 */
export class OpaqueActionLinks {
  constructor(private readonly broker: CapabilityBroker) {}
  issue(owner: string, grantId: string, expiresAt: number): string {
    return this.broker.issueLink(owner, grantId, expiresAt);
  }
  inspect(audience: string, token: string) {
    return this.broker.inspectLink(audience, token);
  }
  revoke(owner: string, token: string): void {
    this.broker.revokeLink(owner, token);
  }
  redeem(audience: string, token: string, action: unknown): Promise<Receipt> {
    const link = this.inspect(audience, token);
    return this.broker.execute(audience, link.grantId, action, token);
  }
}
