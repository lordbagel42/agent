import { z } from "zod";
import type { ModelSettlement } from "../core/contracts.js";
import type { Transcripts } from "./transcripts.js";

const safetySchema = z.strictObject({
  version: z.literal(1),
  deletionRevision: z.number().int().nonnegative(),
  pending: z.strictObject({ id: z.uuid(), at: z.number().int() }).nullable(),
  settlementUnknown: z.boolean().default(false),
  sync: z.enum(["pending", "conflict"]).nullable().default(null),
  blocked: z
    .enum(["retention_quarantined", "model_settlement_unknown"])
    .nullable(),
});
type State = z.infer<typeof safetySchema>;

/** Host-only safety journal, outside Git. Missing/corrupt recovery state never
 * grants replay authority. A deletion quarantines this whole unprovenanced mind;
 * an operator must reconcile it, not simply advance its deletion watermark. */
export class MindSafety {
  private state: State | undefined;
  private failed = false;
  private ownsPending = false;

  constructor(
    private readonly transcripts: Transcripts,
    private readonly revision: () => number,
  ) {}

  async load(initial?: { fresh: boolean }) {
    try {
      const value = await this.transcripts.readState("safety");
      if (value === undefined && initial) {
        await this.save({
          version: 1,
          deletionRevision: this.revision(),
          pending: null,
          // Restoring Git alone cannot restore deletion or effect receipts.
          settlementUnknown: !initial.fresh,
          sync: null,
          blocked: initial.fresh ? null : "retention_quarantined",
        });
      } else this.state = safetySchema.parse(value);
    } catch {
      this.failed = true;
    }
  }

  private async save(state: State) {
    this.state = state;
    try {
      await this.transcripts.writeState("safety", safetySchema.parse(state));
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  get readable() {
    return (
      !this.failed &&
      !!this.state &&
      this.state.deletionRevision === this.revision() &&
      this.state.blocked !== "retention_quarantined"
    );
  }

  get blocked() {
    if (this.failed || !this.state) return "safety_state_unavailable";
    if (!this.readable) return "retention_quarantined";
    if (
      this.state.settlementUnknown ||
      (this.state.pending && !this.ownsPending)
    )
      return "model_settlement_unknown";
    return (
      this.state.blocked ??
      (this.state.sync === "conflict"
        ? "git_conflict"
        : this.state.sync === "pending"
          ? "git_sync_unresolved"
          : null)
    );
  }

  async isSettled() {
    await this.load();
    return (
      !this.failed &&
      !!this.state &&
      !this.state.pending &&
      !this.state.settlementUnknown &&
      this.state.blocked !== "model_settlement_unknown"
    );
  }

  async begin() {
    if (this.blocked || !this.state) throw new Error("mind_blocked");
    await this.save({
      ...this.state,
      pending: { id: crypto.randomUUID(), at: Date.now() },
    });
    this.ownsPending = true;
  }

  async settle(settlement: ModelSettlement) {
    if (!this.state?.pending) throw new Error("mind_missing_intent");
    await this.save({
      ...this.state,
      pending: settlement === "unknown" ? this.state.pending : null,
      blocked:
        settlement === "unknown"
          ? "model_settlement_unknown"
          : this.state.blocked,
    });
    this.ownsPending = false;
  }

  async block(reason: NonNullable<State["blocked"]>) {
    if (!this.state) throw new Error("mind_state_unavailable");
    await this.save({ ...this.state, blocked: reason });
  }

  /** Write before Git can merge; a crash or failed fetch cannot erase a hold. */
  async syncStarted() {
    if (!this.state) throw new Error("mind_state_unavailable");
    await this.save({ ...this.state, sync: this.state.sync ?? "pending" });
  }

  async syncFinished(state: "synced" | "merged" | "conflict") {
    if (!this.state) throw new Error("mind_state_unavailable");
    await this.save({
      ...this.state,
      sync: state === "conflict" ? "conflict" : null,
    });
  }
}
