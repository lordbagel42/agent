# Reflection decision domain

Import from `./index.js`. No persistence, background loop, messaging, coding,
permission grant, or provider SDK lives here. Rivet owns durable scheduling.

## Entry points

```ts
initialState(): ReflectionState
requestKey(input: RequestInput): string
enqueue(state, input, now): { state, id, accepted }
claim(state, id, now, policy, evidence, liveActive): ClaimResult
cancel(state, id): ReflectionState
finish(state, id, attempt, now, newEvidence, policy): ReflectionState
isQuiet(now, quiet): boolean
decayDrive({ value, updatedAt }, now, halfLifeMs): Drive

new DecisionExecutor(capacity, timeoutMs)
executor.evaluate(input, decide, signal?): Promise<Decision>
typedEvaluator(decide: DecisionFunction): DecisionFunction
validateDecision(value: unknown, input): Decision
runJury(input, executor, providers, signal?): Promise<JuryResult>

initialPersonality(): PersonalityState
proposeRevision(value: unknown, evidence, now, maxAgeMs):
  { ok: true, proposal } | { ok: false, reason }
revisePersonality(state, proposal, evidence, now, maxAgeMs): PersonalityState
revertPersonality(state, id, currentHeadId, explanation, now): PersonalityState
```

All state transitions return JSON-serializable records, leave inputs unchanged,
and use caller-supplied timestamps. Persist the complete returned state. Treat
records as immutable; they can share unchanged subtrees. `claim` returns either
an `attempt` or a denial `reason`. `finish` ignores stale/duplicate attempts.

## Rivet integration outline

Use the existing registry's journaled `loop.step` and explicit persistence
pattern. The following is an outline inside an owning workflow, not another
scheduler. `input`, `policy`, `decide`, and the single shared process-local
`executor` are supplied by the host. Store the evaluation receipt under the
request ID and attempt, then apply `finish` in a separate journaled step.

```ts
const admitted = await loop.step("admit-reflection", async (step) => {
  const result = claim(
    step.state.reflection, id, now, policy, scopedEvidence, liveActive,
  );
  step.state.reflection = result.state;
  await step.vars.persist();
  return { attempt: result.attempt ?? null, reason: result.reason ?? null };
});
if (admitted.attempt === null) return; // Rivet decides whether/when to wake again.

const decision = await loop.step("evaluate-reflection", async () =>
  executor.evaluate(input, typedEvaluator(decide), abortController.signal),
);
// Journal the result. Recheck cancellation and evidence invalidation before
// accepting a proposal. Never interpret decision.confidence as permission.
// For normally settled calls, finish with independently ingested evidence:
// state.reflection = finish(state.reflection, id, admitted.attempt,
//                          completedAt, trustedNewEvidence, policy);
// Persist again. Any owner-facing interruption needs the host's separate
// privacy, quiet-hours, attention and approval/delivery checks.
```

Serialize all admissions sharing capacity through one owning actor. Never merge
claims computed from the same old snapshot. Persist cancellation and abort the
local signal. A cancelling request occupies capacity until `finish` acknowledges
settlement. On process loss, reconcile journal/worker termination before freeing
running claims; there is deliberately no automatic lease-expiry retry here.

## Semantics and limits

- Scope is an opaque, trusted owner/audience key. Dedupe is the canonical JSON
  tuple of scope and sorted unique evidence IDs, across both request kinds.
  Cancelled/stopped keys stay deduplicated; genuinely new evidence yields a new
  key. The host owns retention/compaction without losing dedupe tombstones.
- Evidence IDs identify immutable source versions. The memory layer supplies
  provenance, expiry and deletion flags; scope is checked again here. Reusing an
  ID for changed content is unsupported. New IDs from generated dreams do not
  reset habituation. `finish` must receive independently ingested evidence, not
  IDs suggested by a model. Citation validation cannot establish factual truth
  or semantic support by itself.
- Capacity is `min(total - liveReserve, total - liveActive)`. Same-scope claims
  are serialized, cooldown is scope-wide, and repeated no-new-evidence passes
  stop. Hard per-request attempt limits also stop productive loops. Drives decay
  exponentially by half-life; the host decides which drive to stimulate or use
  to order eligible work. They do not bypass admission or authorize action.
- Quiet hours block admission conservatively. They use IANA local wall-clock
  minutes with inclusive start/exclusive end, including both repeated DST
  hours. Equal endpoints disable quiet hours. Invalid zones/policies throw.
  Long-running work does not automatically abort at the next quiet boundary;
  recheck before any host-side interruption. Durable wake times belong to Rivet.
- One shared `DecisionExecutor` bounds provider calls, not just requests. Size
  it from the background allocation; jury fan-out consumes those same slots.
  Excess calls explicitly abstain rather than creating an unbounded queue.
  Cancellation/timeout returns promptly, but an uncooperative provider retains
  its slot until its underlying promise settles. Do not create replacement
  executors to evade that bound. The host must track actual provider settlement
  or confirm worker termination before releasing a durable cancelling claim.
  This is cooperative cancellation, not a sandbox or distributed rate limiter.
- Jury first passes get independent copies of identical scoped evidence and
  no prior votes. Distinct provider sessions must be supplied by the host; this
  module cannot prevent a provider closure from sharing its own hidden state.
  Critic and synthesis get the full prior ledger. The immutable-by-convention
  result retains every vote, including abstentions and mechanically derived
  dissent, even if synthesis disagrees or fails. Journal individual evaluations
  separately if per-juror crash recovery is required; `runJury` is one bounded
  convenience pass, not a workflow engine.
- Personality is a narrow curated style surface (verbosity, tone, humor,
  interests). Its charter has no patch path. Owner corrections require matching
  trusted correction provenance and outrank inference. Revisions are append-only
  snapshots; rollback appends an inverse of the current head. Owner authorization
  for revision/rollback stays outside this module. Confidence is recorded only.
  Traits retain evidence scope; never inject private-scoped traits or historical
  revisions into public prompts. Memory integration must invalidate derived
  revisions on forgetting and handle durable storage/history retention.
- Evaluations validate freshness at their supplied snapshot time. Revalidate
  evidence at proposal acceptance, after long calls, on replay and on deletion.
  Provider exceptions/malformed decisions become explicit abstentions. There is
  no Jev network implementation or claimed calibration; inject a real supported
  typed-decision function through `typedEvaluator`.
