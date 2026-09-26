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

## Rivet actor factory

`createReflectionActor(deps)` in `../runtime/reflection.ts` returns a mountable
Rivet actor definition. Mount it once and use key `[ownerId]`, not one actor per
audience. The separate `reflection-v1` workflow serializes admissions and uses
Rivet's journaled queue timeout for durable wakeups. It does not modify or mount
itself in the conversation registry. Future changes to journal operation order
must use Rivet workflow version gates or a deliberate migration; do not rename
the workflow to retry already-started calls.

Dependencies are `ownerId`, domain `policy`, raw `decide: DecisionFunction`,
`retrieve({ownerId, scope, evidenceIds}, signal)`, and positive millisecond
`idleMs`, `deepMs`, `pollMs`, `timeoutMs` (at most one day; deep >= idle).
`pollMs` controls eligibility-check granularity, not model call frequency;
use a production value such as 60 seconds, not the test fixture's 20ms.

`retrieve` returns `{authorized:boolean,evidence:Evidence[]}`. It must check
the current trusted owner/audience mapping, immutable source versions and
deletion tombstones, not reuse the enqueue-time snapshot. Canonical host scopes
are `JSON.stringify(routeEvent(...).key)`; owner imports use
`JSON.stringify(["private", owner.id])`. Adapt the memory store's
`reflectionEvidence(scope, evidenceIds, evidenceMaxAgeMs)` after checking owner
authorization; return `{authorized:false,evidence:[]}` on rejection. The memory
bridge accepts only original sources (currently at most 20 IDs / 64K), never
derived claims or dreams as independent evidence. The runtime rejects partial,
duplicate, stale, future, expired, deleted or wrong-scope evidence. Retrieval
runs at admission, after the intent flush immediately before the model, after
the model, and on every candidate read. No raw evidence enters state or journal.

Host actions:

```ts
enqueue({scope, evidenceIds, kind: "reflection" | "curiosity",
         mode: "interaction" | "idle" | "deep"}): Promise<{id, accepted}>
cancel(id): Promise<boolean>
trigger({id, type: "interaction" | "idle", liveActive}): Promise<void>
status(): Promise<{reflection, invocations, candidateIds, liveActive, epoch}>
candidate(id): Promise<ReflectionCandidate | null>
reconcile(requestId, confirmedStopped): Promise<boolean>
```

These are trusted host APIs, not public authorization endpoints. Authenticate
the operator before forwarding them, especially `reconcile`. Status includes
request scope/source IDs but no model text. Only `candidate` releases a model
rationale, after current evidence checks. For forgetting, use status source IDs
to cancel all dependent requests; cancellation removes their staged candidates.
Actor storage, engine inspection and backups must remain private. Deletion of
the memory store alone does not erase a candidate from actor storage/backups.

- Before live model work, call `trigger` with `type: "interaction"`, a stable
  ingress-derived event ID, and total owner-wide live occupancy. This resets
  idle age, invalidates prior candidates and aborts active background work.
  After the work settles, call `type: "idle"` with a distinct stable completion
  ID and the remaining occupancy. Duplicate IDs are inert. Serialize occupancy
  updates through the host; a stale zero must not overwrite a newer live count.
  Recover lost live-completion hooks explicitly after confirming worker exit.
- Enqueue source IDs produced by trusted interaction/memory ingestion. Immediate
  reflection waits for no live work; idle/deep modes additionally wait their
  delay after both enqueue and the most recent interaction. Idle hooks/timers
  do not invent evidence, recursively enqueue dreams or repeatedly message the
  owner. Domain dedupe covers all modes and kinds. Keep tombstones and trigger
  dedupe IDs when designing retention/compaction.
- Calls are deliberately serial even if the policy allows more background
  capacity. Live work preempts them and the domain reserves live capacity.
  Inject the raw provider, **not** `DecisionExecutor.evaluate` or another wrapper
  that returns before the underlying provider settles. Cancellation/timeout
  signals are cooperative; an ignoring provider holds its claim and blocks
  further background work, but does not block the separate live actor. The
  workflow abort signal also cancels on shutdown; there is no second scheduler
  or global timer/controller collection to dispose. Provider transports must
  honor that signal or the host must terminate their worker.
- Admission, attempt and a `started` invocation marker are explicitly flushed
  before a model call. Candidate plus settlement are flushed together before
  the workflow step completes. On interrupted-step replay, a persisted started
  marker becomes `uncertain`; no automatic retry or lease-based capacity release
  occurs. `reconcile(id,true)` cancels the held request only after an operator
  verifies the old provider/worker stopped. It never clears dedupe or retries.
  This chooses missed work over duplicate effects at ambiguous crash boundaries.
- A decision is only a proposal, never a memory/personality write or permission
  grant. Dream-only support is marked `hypothesisOnly` and cannot yield an
  interruption candidate. At most one interruption candidate is staged per
  interaction epoch, across scopes; quiet hours and live occupancy also gate
  staging/reads. There is **no outbound send**. Any later delivery must use the
  candidate ID as its own durable dedupe key and recheck audience, attention,
  quiet hours and approval. Repeated candidate reads are not new send grants.
- Each settled attempt finishes with no claimed new evidence; model output
  cannot reset habituation. Fresh trusted ingestion should enqueue a new ID
  set. Domain attempts/no-new-evidence bounds stop each request. A retrieval
  rejection cancels work; failures after admission consume the attempt without
  persisting exception text.

Verification: `pnpm exec vitest run src/runtime/reflection.test.ts
src/reflection/domain.test.ts` exercises the real disposable engine plus domain
rules. The runtime test protects audience/deletion checks, duplicate admission,
cancellation settlement and candidate-read privacy. No paid provider or live
channel is required. RivetKit 2.3.21 still emits the repository's documented
native `transaction_closed` shutdown diagnostic; passing checks are not a claim
of production engine readiness.

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
