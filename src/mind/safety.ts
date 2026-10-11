import { Effect, Schema } from "effect";
import type { ModelSettlement } from "../core/contracts.js";
import { decodeStrict, Int, Uuid, withDefault } from "../effect/schema.js";
import { MindStateError, type Transcripts } from "./transcripts.js";

const Safety = Schema.Struct({
  version: Schema.Literal(1),
  deletionRevision: Int({ minimum: 0 }),
  pending: Schema.NullOr(Schema.Struct({ id: Uuid, at: Int() })),
  settlementUnknown: Schema.Boolean.pipe(withDefault(false)),
  sync: Schema.NullOr(Schema.Literals(["pending", "conflict"])).pipe(
    withDefault(null),
  ),
  blocked: Schema.NullOr(
    Schema.Literals(["retention_quarantined", "model_settlement_unknown"]),
  ),
});
type State = typeof Safety.Type;
const decodeSafety = decodeStrict(Safety);

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

  readonly load = Effect.fnUntraced(function* (
    this: MindSafety,
    initial?: { fresh: boolean },
  ) {
    yield* Effect.gen({ self: this }, function* () {
      const value = yield* this.transcripts.readState("safety");
      if (value === undefined && initial) {
        yield* this.save({
          version: 1,
          deletionRevision: this.revision(),
          pending: null,
          // Restoring Git alone cannot restore deletion or effect receipts.
          settlementUnknown: !initial.fresh,
          sync: null,
          blocked: initial.fresh ? null : "retention_quarantined",
        });
      } else this.state = decodeSafety(value);
    }).pipe(
      Effect.catchCause(() =>
        Effect.sync(() => {
          this.failed = true;
        }),
      ),
    );
  });

  private readonly save = Effect.fn("june.mind.safety.save")(function* (
    this: MindSafety,
    state: State,
  ) {
    this.state = state;
    yield* Effect.suspend(() =>
      this.transcripts.writeState("safety", decodeSafety(state)),
    ).pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          this.failed = true;
        }),
      ),
    );
  });

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

  readonly isSettled = Effect.fnUntraced(function* (this: MindSafety) {
    yield* this.load();
    return (
      !this.failed &&
      !!this.state &&
      !this.state.pending &&
      !this.state.settlementUnknown &&
      this.state.blocked !== "model_settlement_unknown"
    );
  });

  readonly begin = Effect.fnUntraced(function* (this: MindSafety) {
    if (this.blocked || !this.state)
      return yield* new MindStateError({ reason: "mind_blocked" });
    yield* this.save({
      ...this.state,
      pending: { id: crypto.randomUUID(), at: Date.now() },
    });
    this.ownsPending = true;
  });

  readonly settle = Effect.fnUntraced(function* (
    this: MindSafety,
    settlement: ModelSettlement,
  ) {
    if (!this.state?.pending)
      return yield* new MindStateError({ reason: "mind_missing_intent" });
    yield* this.save({
      ...this.state,
      pending: settlement === "unknown" ? this.state.pending : null,
      blocked:
        settlement === "unknown"
          ? "model_settlement_unknown"
          : this.state.blocked,
    });
    this.ownsPending = false;
  });

  readonly block = Effect.fnUntraced(function* (
    this: MindSafety,
    reason: NonNullable<State["blocked"]>,
  ) {
    if (!this.state)
      return yield* new MindStateError({ reason: "mind_state_unavailable" });
    yield* this.save({ ...this.state, blocked: reason });
  });

  /** Write before Git can merge; a crash or failed fetch cannot erase a hold. */
  readonly syncStarted = Effect.fnUntraced(function* (this: MindSafety) {
    if (!this.state)
      return yield* new MindStateError({ reason: "mind_state_unavailable" });
    yield* this.save({ ...this.state, sync: this.state.sync ?? "pending" });
  });

  readonly syncFinished = Effect.fnUntraced(function* (
    this: MindSafety,
    state: "synced" | "merged" | "conflict",
  ) {
    if (!this.state)
      return yield* new MindStateError({ reason: "mind_state_unavailable" });
    yield* this.save({
      ...this.state,
      sync: state === "conflict" ? "conflict" : null,
    });
  });
}
