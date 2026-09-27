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
reflectionPriority(request, now): number

new DecisionExecutor(capacity, timeoutMs)
executor.evaluate(input, decide, signal?): Promise<Decision>
executor.evaluateSettled(input, decide, signal?): Promise<Decision>
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

`createReflectionActor(deps, lifecycle?)` in `../runtime/reflection.ts` returns a mountable
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
request({evidenceIds, mode: "idle" | "deep", kind?: "reflection" | "curiosity"}):
  Promise<{status: "queued" | "duplicate" | "unavailable"}>
enqueue({scope, evidenceIds, kind: "reflection" | "curiosity",
         mode: "interaction" | "idle" | "deep"}): Promise<{id, accepted}>
cancel(id): Promise<boolean>
occupancy(id: string, active: boolean): Promise<void>
trigger({id, type: "interaction" | "idle", liveActive}): Promise<void>
status(): Promise<{reflection, invocations, decisionOutcomes, candidateIds, liveActive, activeTurnIds, epoch}>
isSettled(): Promise<boolean>
listCandidates(scope): Promise<{status, checkedAt, ids, truncated}>
candidate(id): Promise<ReflectionCandidate | null>
rejectCandidate(scope, opaqueId): Promise<boolean>
reconcile(requestId, confirmedStopped): Promise<boolean>
```

June uses `reflectionRequest` with `kind: "curiosity"` in an enabled
owner-private turn to evaluate 1–20 currently permitted retained source IDs.
Omitted kind defaults to `reflection` for older replies. The host fixes the
audience and uses the same scheduler, delays, quiet hours, capacity, attempt
limits and cross-kind evidence-set dedupe. A duplicate preserves the original
kind and mode. Curiosity currently uses **existing evidence only**: no public
search is performed, and there is no query, URL fetch, private account crawl,
tool execution or new permission grant. Existing public search remains a
separate capability, not a fallback for missing evidence.

`decisionOutcomes` records only validated `yes`/`no`/`abstain` judgments after
current evidence and execution checks. Missing entries (including older state)
are unknown/not evaluated; a settled invocation alone is not success. `abstain`
may come from host/provider validation or timeout; it does not establish a
successful model evaluation. These are historical judgments, not new observations, current authorization or proof
that a candidate exists. Later deletion/interaction can invalidate a candidate;
use its revalidated read path, never this metadata, to consume it.

These are trusted host APIs, not public authorization endpoints. Authenticate
the operator before forwarding them, especially `reconcile`. Status includes
request scope/source IDs but no model text. Only `candidate` releases a model
rationale, after current evidence checks. For forgetting, use status source IDs
to cancel all dependent requests; cancellation removes their staged candidates.
Actor storage, engine inspection and backups must remain private. Deletion of
the memory store alone does not erase a candidate from actor storage/backups.

- The host passes the shared process lifecycle fence. Each reflection step
  reacquires admission outside the journal and holds it through raw provider
  settlement and the final state flush. Drain pauses new steps, not durable
  pending requests; timeout resumes admission without cancelling or releasing
  active work. `isSettled()` is the host's additional read-only check under that
  fence: local workers, live occupancy, running/cancelling requests and any
  started/uncertain invocation prevent certification. It never reconciles or
  retries unknown work. Forced workflow aborts and persistence failures poison
  process drain; provider cancellation alone is not settlement. Automatic
  deployment with reflection remains unsupported until the complete lifecycle,
  recovery and transport behavior is proven. No feature is enabled by this wiring.

`listCandidates` accepts only the exact owner's private scope. It checks up to
twenty same-scope/current-epoch candidates, revalidates all request evidence and
returns at most ten opaque `reflectionCandidateId(rawId)` SHA256 tokens, not the
internal IDs (which embed source IDs). `truncated` reports possible omissions;
`status` distinguishes `ready`, `live`, `quiet` and `changed` during the read.
The exact authenticated `!reflection list` ordinary message calls it only at send,
without inference, retention, extraction or enqueue. Errors report unavailable,
never an empty success. It leaves occupancy and ordinary preemption unchanged.

Settled publications retain their original generation epoch and an immutable
`publication: {version: 1, expiresAt}` ceiling across later interactions. The
ceiling covers every original input, including uncited evidence, at execution
and final validation. Reads cannot expose a publication before its flush ACK;
late preempted generation never publishes. Retention is bounded to 50 bodies
and 256 KiB of serialized UTF-8, evicting expired and oldest bodies without
removing request, invocation or rejection receipts. Candidate format migration
drops legacy bodies with no provable original expiry cap; only verifiable,
settled capped records survive, and migration can only shorten their cap.
Retention does not reauthorize effects: `candidate()` and the current command
list still require the original epoch, no live work and non-quiet time.

- Before live model work, await `occupancy(turnAttemptId, true)` with a stable,
  owner-wide unique turn/attempt ID. The owner actor derives occupancy from
  durable active IDs, so overlapping conversation actors never read/modify/write
  an absolute count. A first start resets idle age, advances the interaction
  epoch, invalidates candidate effects and aborts background work while retaining
  bounded published bodies. Duplicate starts are
  inert. After the actual provider/worker settles, await `occupancy(id, false)`
  with the same ID. Duplicate or unmatched finishes cannot release another
  turn; finished IDs remain tombstoned and cannot reopen on replay, even if the
  finish arrived before the start. A new deliberate attempt needs a new ID.
  Unknown-after-crash turns remain active until authenticated reconciliation
  confirms the old provider/worker stopped and releases that exact ID. Use
  `status().activeTurnIds` for inspection; there is no automatic lease expiry.
- `trigger` remains a legacy/operator API. Its absolute `liveActive` is a
  separate hold added to ID-based occupancy; a legacy zero cannot clear tracked
  turns. Do not report the same turn through both APIs. Legacy interaction
  events still reset idle age/epoch and invalidate candidate effects; idle events do
  not. Duplicate event IDs are inert. Older persisted absolute occupancy is
  retained as a legacy hold when first using the ID-based action; clear it only
  after confirming the old live work stopped.
- Enqueue source IDs produced by trusted interaction/memory ingestion. Immediate
  reflection waits for no live work; idle/deep modes additionally wait their
  delay after both enqueue and the most recent interaction. Idle hooks/timers
  do not invent evidence, recursively enqueue dreams or repeatedly message the
  owner. Domain dedupe covers all modes and kinds. Keep request/finished-turn
  tombstones and trigger dedupe IDs when designing retention/compaction.
- Eligible requests are ranked by `reflectionPriority`: an enqueue stimulates
  a drive to 1, decaying with the existing `decayDrive` and a one-hour half-life.
  Newer requests therefore rank ahead of older ones; equal scores preserve
  enqueue order. Scores are computed live from persisted `createdAt`, including
  for legacy requests, with no model-controlled value or timestamp. Duplicate
  requests, retries and inspection do not refresh stimulation. A backwards
  clock cannot increase priority above 1 or waive an idle/cooldown deadline.
  This is recency preference, not starvation-free scheduling or authority.
  June's owner-private `inspection: "reflection"` reports at most ten pending
  scores with this fixed reason, without request/evidence IDs or private text.
  Pending scores are not eligibility claims; all existing admission gates apply.
- Calls are deliberately serial even if the policy allows more background
  capacity. Live work preempts them and the domain reserves live capacity.
  Inject a provider that awaits actual settlement, **not**
  `DecisionExecutor.evaluate` or another early-return wrapper. Main uses the
  shared executor's `evaluateSettled` so reflection and explicit jury calls
  consume the same slots without releasing durable claims early. Cancellation/timeout
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
  staging/reads. Background reflection never sends automatically. An exact
  owner-private `!reflection propose <candidate-id> <user-id> <text>` previews
  one frozen recipient/message using the existing social permission ledger.
  Only the owner's private `!allow <proposal-id>` authorizes delivery; `!deny`
  and `!revoke` invalidate approval. The proposal/outbox identity is bound to
  account + candidate, not the approval turn. Accepted or unknown sends are not
  repeated after restart or repeated approval. Candidate reads grant nothing.
  The outbox checks current approval/deletion and the actor's candidate,
  evidence, epoch, quiet hours and live activity after persistence, immediately
  before transport dispatch. Temporary quiet/live holds retain approved ready
  work without consuming transport attempts; another explicit `!allow` can
  resume it. Approval-message identities are consumed durably: replay of a held
  or interrupted command cannot resume delivery without a new owner message.
  No automatic retry timer is installed. New interactions, rejected
  candidates, stale/deleted evidence and revoked grants fail closed.
- Owner-private `!reflection reject <64hex>` revokes exactly the candidate
  identified by its opaque list/inspection ID. Rejection persists a content-free
  tombstone before success and repeated rejection remains successful across
  restart. It deletes only that candidate, without cancelling the request,
  changing occupancy or invalidating other candidates. Missing or foreign-scope
  candidates are not rejected. Revocation returns no rationale and still works
  when evidence is deleted or quiet hours prevent inspection. Retain rejection
  tombstones through compaction; later incorporation/delivery must resolve the
  current candidate again, never use an earlier inspection as authority.
  A mounted proposal bridge must inject synchronous, idempotent
  `rejectProposals(scope, opaqueId)` to durably reject that candidate's pending
  derivatives and prevent restaging. This runs before candidate removal/actor
  persistence, including on duplicate rejection; failure cannot acknowledge
  success. Earlier accepted changes are not retroactively erased.
- Each settled attempt finishes with no claimed new evidence; model output
  cannot reset habituation. Fresh trusted ingestion should enqueue a new ID
  set. Domain attempts/no-new-evidence bounds stop each request. A retrieval
  rejection cancels work; failures after admission consume the attempt without
  persisting exception text.

### Deep-mode alternative-response simulation

June requests `reflectionRequest: { evidenceIds, mode: "deep" }` in an
owner-private conversation when `reflectionRequestAvailable` is advertised,
with empty reply text and no other actions. IDs must identify existing retained
sources; the host binds the scope. The queued/duplicate receipt is not a
completed simulation. Deep mode keeps the existing idle delay, quiet hours,
capacity, timeout, cancellation, provenance rechecks and canonical evidence-set
dedupe; changing mode cannot retry a previously consumed evidence set.

Each admitted attempt's single decision call receives host-owned `simulateResponses: true`.
A successful `yes` decision requires `alternativeResponses`, an array of 1–3
nonblank strings of at most 2000 characters each. Invalid or missing alternatives
abstain and consume the attempt; no repair call is added. Existing attempt and
no-new-evidence bounds still apply, as do the normal 4000-character rationale,
original evidence-ID validation, input/output byte budgets and token limit.
Ordinary decisions reject this extra field.

The resulting candidate is always `kind: "proposal", hypothesisOnly: true`,
including deep curiosity requests citing original episodes. Its
`decision.alternativeResponses` are hypothetical replies, **not events that
happened, independent evidence, permission changes or messages to send**. Only
the original evidence IDs ground its rationale. No source/claim ingestion,
interruption candidate or outbound send is created, and simulation never resets
the no-new-evidence counter. Authorized candidate inspection must retain the
hypothetical label; metadata polling never includes alternatives. Forgotten
sources invalidate reads just as for other reflection candidates.

The same deep decision may return `skillChange: { proposedBehavior, rationale,
evidenceIds }`, or `null` when no useful behavior improvement is supported. June
generates this optional proposal herself; no owner-authored JSON command or
second model call is needed. Behavior is limited to 1200 characters, rationale
to 2000, and normalized proposal JSON to 8000 UTF-8 bytes. Extra fields (including
code, instructions, permissions, IDs and approvals) are rejected. Citations must
be current original non-dream evidence also cited by the decision, not simulated
alternatives. Citation checks establish provenance, not semantic truth.

After the existing post-generation evidence, epoch, live and quiet checks, the
host attaches `candidate.skillChange` with a stable host-owned `id`, content and
provenance `digest`, `createdAt`, and `hypothesisOnly: true`. Its digest binds the
exact decision, source candidate/epoch and **all** original request evidence IDs,
not just the proposed rationale's citations. `candidate.requestId` resolves that
full training set in the existing request ledger. One candidate has one immutable
proposal; request dedupe and settled publication prevent replay from restaging it.
It shares candidate expiry, deletion checks and count/byte retention bounds.
Authorized `candidate(id, scope)` retains the original epoch/live/quiet eligibility
gates. `inspectCandidate(scope, id)` exposes retained historical proposals through
the shared review DTO and 24KB budget; its reference digest includes the exact
skill data. Historical review still requires current full-input provenance,
settled publication, expiry and rejection checks, but grants no effect authority.
This is inert review data only: no code, instructions, skills, personality or
permissions are modified, and no coding job, promotion or installation is
authorized. Evaluation and any separately approved coding are later capabilities.

### Private interruption previews

In an owner-private Slack turn, June can emit
`social: {kind: "interruption_proposal", candidateId, userId, text}` with empty
reply text and no other directives. After inference settles, the actor revalidates
the immutable publication, all original evidence and rejection status, and checks
live work, quiet hours, deletion revision and the operation's current epoch
immediately before synchronously staging an inert draft. It never changes the
candidate's creation epoch or publication. A retained draft with an old creation
epoch is explicitly **not currently send-eligible**; approval alone cannot send it.

In the owner's Slack DM, send the literal message
`!reflection propose <candidate-id> <Slack-user-id> <message>` (not a Slack slash command).
It stages one pending outreach proposal from a current, non-dream-only interruption
candidate. Use the opaque 64-character ID returned by `!reflection list` and
review provenance with `!reflection inspect <candidate-id>`. The host consumes
this exact command without inference, evidence ingestion, or extraction. Unlike
inert model staging, this path also requires the original creation epoch to remain
current. Neither path approves a candidate or refreshes its send eligibility.

The preview quotes the exact frozen recipient/message privately in the current
conversation. It sends no separate notification or outreach, grants no tools,
and copies no candidate rationale into the social ledger. Candidate provenance
includes all original request evidence IDs, not just cited evidence. Repeating
the command retains the first recipient/message, including across restart.
Missing/expired publications, stale evidence, quiet/live, wrong-scope, rejected,
or forgotten candidates cannot produce a preview. Preview text is sent ephemerally,
not copied into conversation history. Forgetting revokes and redacts staged text.
Candidate rejection synchronously revokes pending or approved copies and stores
a content-free restaging tombstone before acknowledging success. That tombstone
survives restart, including rejection before any draft exists.

Candidate-linked `!allow` uses only the guarded candidate outbox; it cannot fall
through to ordinary outreach. The command must be a fresh plain owner-private
message. Dispatch requires the original candidate epoch, current publication and
all evidence, approval, non-quiet time and no live activity. Temporary holds need
a new `!allow` message to resume; replay never resumes them automatically.
`!deny` and `!revoke` close the proposal. Pending proposals expire after 24 hours.
Inspection and staging are never permission to send, and approval cannot revive
an old-epoch candidate.

Verification: `pnpm exec vitest run src/runtime/reflection.test.ts
src/reflection/domain.test.ts` exercises the real disposable engine plus domain
rules. The runtime test protects audience/deletion checks, duplicate admission,
cancellation settlement, candidate-read privacy, overlapping live turn IDs and
duplicate/unmatched finishes. No paid provider or live channel is required.
RivetKit 2.3.21 still emits the repository's documented native
`transaction_closed` shutdown diagnostic; passing checks are not a claim of
production engine readiness.

### Exact private candidate inspection

After `!reflection list`, send June `!reflection inspect <64hex>` with the full
opaque candidate ID in an authenticated owner-private conversation. The host
handles this exact command without inference, memory ingestion/extraction or
automatic reflection enqueue. Ordinary conversation still invalidates candidates;
inspection does not weaken live-work preemption or approve any later action.

`inspectCandidate(scope, id)` returns one exact generated decision/rationale and
current provenance metadata for **all** source inputs, marking which IDs the
decision cited. It binds the configured owner-private scope and rechecks source
authorization, deletion, freshness, candidate epoch/presence, live occupancy and
quiet hours on every read. The DTO has a 24,000-byte UTF-8 JSON ceiling: oversized
results are unavailable, never silently clipped. Source bodies are not separately
returned; the exact generated rationale may itself quote its support.
The rationale and any simulations remain generated hypotheses, never independent
evidence, even when `hypothesisOnly` is false (that flag describes the support).

The private reply is constructed only inside the existing delivery callback.
Retries re-read current evidence; interrupted sends remain unknown, not repeated.
Conversation history/outbox retain only a content-free receipt, not the rationale
or provenance payload. Reflection actor storage still contains the candidate;
inspection is not physical deletion of it, backups, or already delivered replies.
Slack sends the report as literal text without link/media unfurls and excludes
June-authored review reports from automatic platform context. This command does
not supply the inspected body to June's model; a model-readable continuation is
a separate capability, not implied by listing or inspecting through a command.

Trusted host integrations can call `candidate(alias, ownerPrivateScope)` for the
full current candidate. Omitting the scope preserves the operator's legacy
internal-ID lookup. Neither read is approval, a durable reservation, nor a later
send/staging grant: consumers must recheck authority and eligibility at their
effect boundary. `src/runtime/reflection-inspection.test.ts` exercises the private
June command, no-retention boundary, read races and invalidated send retries.

### Separate held-out skill evaluation

When `skillEvaluationRequestAvailable` is advertised on an owner-private inbound
turn, June can request `skillEvaluationRequest: {candidateId, heldOutEvidenceIds}`
with empty text and no other action. `candidateId` is the exact 64-hex reflection
alias, not a skill ID, behavior body or model-selected digest. Select 2–5 distinct
original retained sources disjoint from **every** original generation input,
including uncited inputs. Identical training/held-out text and duplicate case
text are rejected; this is not proof of statistical independence or that the
provider has never encountered the material.

The host resolves the existing immutable `skillChange`, releases only the
requesting inference's settled occupancy, and stages one request per candidate.
The actor API `requestSkillEvaluation(input, expectedDeletionRevision)` requires
the originating turn's frozen ledger revision. It rechecks that revision before
retrieval and immediately before enqueue, so deletion of originating input or
context blocks staging even when all candidate evidence is still current.
MCP result-only synthesis does not advertise this action.
Choosing a different held-out set cannot retry it. The existing reflection
workflow owns idle delay, quiet hours, live preemption, capacity, cooldown,
habituation and durable admission. It calls the shared settlement-aware
`deps.decide` once per case, sequentially, without another scheduler or pool.
Training generation never receives these held-outs. Evaluation sees the exact
proposed behavior and one case, not training bodies or previous case judgments.
Cases without a supported baseline and desired outcome must abstain.

The existing request carries `skillEvaluation`: exact candidate alias, skill
ID/digest, source request ID, held-out IDs, and per-case phases and decisions.
It never changes the published candidate body. Results share the publication's
expiry and retained-body budget; retirement removes decision bodies while
preserving dedupe and unknown-work markers. Per-case `started` markers are
flushed before dispatch, results after actual settlement. Interrupted work
becomes uncertain and never replays remaining cases, even after reconciliation.
Failures, negative judgments and abstentions remain distinguishable.

`skillEvaluation(alias, ownerPrivateScope)` returns
`{candidate, receipt, evidenceIds, eligible, checkedAt}` or `null`, after checking
all original and held-out provenance. `evidenceIds` contains their complete
union. Historical receipt visibility is not current action eligibility:
`eligible` additionally requires a settled all-yes result, no live work and
non-quiet time. Consumers must recheck at their own effect boundary. No result
installs a skill, promotes a proposal, approves coding, grants permissions, or
establishes an executed behavioral improvement. Private review is effect-free.

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
- June's owner-private `jury` directive returns a bounded advisory report:
  every first-pass answer, critic and synthesis are separate, followed by
  explicit abstention and mechanical dissent references. Failed synthesis does
  not erase votes. Labels and rationale excerpts are individually bounded and
  quoted so all sections fit within 4,096 characters, even for eight jurors;
  citation counts are shown without a source-ID list or evidence records.
  The report enters existing deletion-protected private history, so June can
  read it on a follow-up without another provider call or a new result store.
  Reports are historical proposals, never fresh evidence or permission; missing
  votes in older synthesis-only reports remain unknown, not unanimous.
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

## Owner-private held-out personality preview

When reflection and curated memory are configured and their existing startup
gates are enabled, June can request `personalityEvaluate` with an exact pending
global proposal `candidateId` and `heldOutSourceIds` (1–4 distinct original
interaction IDs). Leave text empty and other actions unset. This is available
only on owner-private inbound turns, not guest/channel turns, worker results,
web/MCP synthesis, or prompts without a verified Slack `im` surface.

`createPersonalityPreview` in `../runtime/personality-evaluation-preview.ts`
reads the proposal and current global profile, rejects a stale target version,
and requires held-out IDs disjoint from the proposal's original support IDs.
Its host-only `personality.evaluationCandidate(id)` reader checks the actor's
accepted/rejected decision ledger atomically with the current profile and
curated payload; a stored payload marked pending alone is not sufficient.
Sources must remain authorized, fresh, not forgotten or opted out, and no more
than 4,000 characters each. It does not truncate or use claims/dreams as original
interactions. Each interaction gets the same fixed suitability rubric via the
existing tool-free reflection provider, with one shared provider slot and a
30-second per-call deadline. Cancelled/uncooperative calls retain their slot
until actual settlement. No retries or background jobs are created.

The service exports `snapshot`, `isCurrent`, `evaluate(snapshot, signal?, side?)`
and `preview`; comparison callers can reuse the same snapshot and executor for
`"current"` and `"candidate"`. Revalidate with `isCurrent` before releasing any
evaluation output. Snapshots and raw decisions are volatile owner-private data;
never journal evidence text or provider rationale. The June path returns only
IDs, yes/no/abstain outcomes, timestamp, target version and SHA-256 profile
digests over canonical `{version,style}`. The candidate uses target version + 1.
It rechecks the profile, proposal and all evidence before every provider call
and before releasing the result; changes discard the result.

This judges a style record against selected interactions; it does **not**
generate candidate replies, send messages to another recipient, mutate a
profile, accept a proposal, or create a promotion receipt. Only the ordinary
private owner reply carries the metadata report. Source-ID disjointness is not
proof of statistical independence or that a provider has never seen the text.
Judgments are advisory, not calibrated scores; abstention means unknown. Verify
offline with `src/runtime/personality-evaluation-preview.test.ts` and the
existing evaluator tests, using fake providers and disposable stores/engine.

## Candidate versus current personality

In an owner-private conversation, ask June to compare a pending personality
candidate with the current profile and provide 1–4 original held-out source IDs.
The `personalityEvaluate` action with `mode: "compare"` uses the same snapshot,
fixed suitability rubric and reflection evaluator for both profiles. It excludes
the candidate's supporting sources. This evaluates style suitability, not
generated replies or measured behavior; it does not promote either profile.

The host reports exact SHA-256 profile digests (canonical `{version, style}`),
the expected current version, paired yes/no/abstain outcomes, a trusted receipt
ID and explicit limitations. Candidate-only/current-only suitability, both,
neither and unknown are distinct. Any abstention makes that pair unknown and the
receipt incomplete, never a win or a negative vote. The evaluator sees no prior
answers; both passes share the preview service's settlement-aware limiter.

`CuratedPersonalityStore.recordEvaluation` is a trusted host-only write after
comparison and context revalidation. `readEvaluation(scope, evaluationId, now)`
returns only live, same-scope metadata receipts. A receipt binds the candidate
ID, current version, both profile digests, and the exact ordered held-out
evidence digest. It expires within 15 minutes (earlier if the candidate or a
source expires); source forgetting or candidate invalidation makes it
unavailable. No interaction text, profile values, model rationale or confidence
is persisted in a receipt. At most 100 unexpired receipts are retained in the
latest encrypted curated snapshot; older encrypted history follows the store's
existing retention/backup limitations. Approval must independently recheck the
live profile digests, the personality actor's terminal decision ledger, and owner
authorization. Curated staging status is not approval status. Neither a receipt
nor a favorable judgment grants publication authority.

After reviewing the exact proposed style and a complete comparison, the owner
can publish that candidate to **all conversations** with a fresh plain-text
command in an authenticated owner-private DM:

```text
!personality approve {"proposalId":"ID","expectedVersion":VERSION,"evaluationId":"RECEIPT_UUID","candidateDigest":"SHA256_FROM_COMPARISON","publish":true}
```

The existing approval path resolves the host-created receipt, revalidates its
supporting and held-out evidence, and compares both live profile digests before
atomically recording the revision and terminal acceptance. A missing, incomplete,
expired, mismatched or stale evaluation cannot publish anything. Forgetting can
change effective style without advancing the version; the current-profile digest
detects that too. Repeating acceptance cannot append another revision, and
rollback never revives evaluation authority. No winning score is required;
judgments remain advisory. Preview-only results have no approval receipt. Direct
owner-authored `!personality revise` remains a separate explicit manual edit,
not evidence that a staged candidate was evaluated. Private support and rationale
are never declassified by this command.

Staged approval requires an available configured reflection comparison provider.
Curated-memory-only configurations can still stage suggestions, but cannot approve
them until comparison is available; explicit manual owner edits remain available.
