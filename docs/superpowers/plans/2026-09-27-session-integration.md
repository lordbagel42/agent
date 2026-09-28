# Activity Session Integration Plan

Historical integration design and checklist; not a current activation attestation.

**Goal:** Complete owner-DM activity actors without transferring approval authority or replaying uncertain legacy effects.

**Architecture:** Keep `conversation(scopeKey)` as the durable scope coordinator and catalog. New activity actors own their transcripts, model receipts and outboxes; narrow coordinator actions own workers, proposals, original-event authorization and approval lookup. Drain and archive the legacy lane before assigning an activity turn.

**Tech Stack:** Existing TypeScript, Rivet 2.3.21 workflows, encrypted EvidenceStore, Biome and disposable Vitest/native-engine fixtures.

**Spec:** [Activity sessions](../specs/2026-09-27-activity-sessions-design.md)

## Global constraints

- Three hours is the configurable initial inactivity default. Platform reply placement does not select the activity actor or privacy audience.
- Public and guest behavior is unchanged. Reject enabling the owner-private experiment if another linked adapter can bypass its coordinator.
- This plan grants no permission for live configuration, service or data changes.
- Preserve legacy actor keys, journal step ordering, task/proposal identities, exact approval receipts, deletion fences and late callbacks.
- Unknown sends and incomplete historical effect coverage hold migration. A FIFO token, workflow completion, age, empty marker scan or restart is not enough. No new reconciliation endpoint.
- Keep tests focused on privacy, authority and duplicate effects. Use existing native-engine workflows for ordinary behavior.

## Task 1: Keep catalog authority in its existing actor

**Files:** `src/runtime/scope-catalog.ts`, `src/runtime/registry.ts`.

- [x] Move the stable catalog types and delegated-authority/visible-job validation into a focused scope-catalog module without changing persisted field names, validation or RPC behavior. `ConversationState` continues to contain the same records; this is not a state migration or a copied catalog.
- [x] Extract worker dispatch into the same catalog module, retaining the `dispatch-execution` journal step, original task IDs, deletion checks, roster limits and write-before-submit ordering. Activity forwarding will call this on the stable catalog, not copy its state.
- [x] Run existing execution, coding approval, forgetting and deletion tests before adding activity forwarding.
- [ ] Preserve `ExecutionContext.conversationKey` as the stable origin metadata destination. Record new activity origin/assignment separately in coordinator-owned metadata; do not let the worker choose its return session.

## Task 2: Produce conservative attributed archive turns

**Files:** `src/sessions/producer.ts`, `src/sessions/archive.ts`, `src/runtime/delivery.ts`, focused producer safety tests.

- [x] Project only authenticated original user sources and separately attributed text deliveries. Require exact original source text/author/address/time, complete deletion provenance and persisted receipt observation times.
- [x] Record delivery outcome observation time when the host observes the result; do not fabricate timestamps for older deliveries or change their retry/unknown behavior.
- [x] Omit ephemeral/private tool payloads and explicitly excluded control turns. Preserve non-sensitive receipts; mark incomplete historical data instead of presenting invented precision.
- [x] Build immutable deterministic `SessionArchiveInput` values for the existing deletion-fenced `archiveSessionTurn(input, revision)`. Never treat that acknowledgment as settlement.
- [x] Verify exact replay, missing/foreign/deleted provenance, volatile-output exclusion and unknown delivery attribution. Do not widen the archive's evidence/corroboration role.

The producer is not wired into runtime yet. Its `ArchiveEvidence.contextAvailable`
port must prove audience access and complete transitive deletion validity, not
merely absence of a tombstone. Catalog callbacks must use the current store,
not a captured replacement-store reference. Slack source time is message `ts`, not envelope `event_time`;
same-thread messages in one millisecond cannot substitute for each other.

## Task 3: Durable admission and legacy handoff

**Files:** `src/sessions/migration.ts`, `src/runtime/registry.ts`, `src/runtime/inspection.ts`.

The coordinator persists this transition separately from the activity directory:

```text
legacy -> draining(epoch, barrier, frozen legacy admissions, coverage, holds)
       -> sessions(epoch, evidence-backed certificate)
```

- [x] Persist prospective canonical identities, recoverable bodies and immutable first host receipt time for owner messages and worker/coding/wakeup notifications. Preserve existing IDs/Slack aliases and reject tombstoned or stale notification provenance before retention. Recover the save/publication gap without refreshing receipts; forgetting removes pending bodies but keeps content-free deduplication.
- [x] Assign an immutable legacy/session lane before acknowledging input. Existing direct-queue callbacks and old pending messages without host receipt times remain explicitly legacy; do not manufacture historical receipt or effect coverage.
- [x] Fence new legacy admission under the existing receive serializer, repair saved legacy publication gaps, then enqueue one stable barrier. New input waits durably without blocking ingress on the whole drain.
- [x] Add a post-receive workflow version branch for routing control. Old iterations retain their original journal path; no retroactive effect invocation or successful receipt is manufactured.
- [x] Require the exact barrier, all frozen admissions, complete historical effect coverage, no live/uncertain effects or pending retries, and acknowledged archival coverage before declaring handoff drained. Missing historical coverage remains held. Re-published legacy admissions behind the token still prevent activation.
- [x] Expose bounded hold reasons through owner-private operations inspection. Keep inspection read-only; it cannot clear, retry or reclassify an effect.

Prospective admission alone is not a migration certificate. It does not change
session routing or certify existing model/web invocations or delivery outcomes.
The native-engine crash fixture covers both human and completion admission saved
before queue publication. Deletion checks cover stale transitive report context
and a callback admitted between frozen forget targets and ledger tombstoning;
cleanup matches those callbacks to the frozen jobs/workers/origins, preserving
unrelated fresh work. Legacy `##` callbacks are acknowledged without retaining or
publishing the excluded input.

The host-injected `sessionHandoff` path freezes admission, repairs legacy queue
publication, and consumes the exact durable barrier. It is not exposed by main or
production config; session-lane bodies remain pending until catalog/actor routing
is integrated below. Deactivation cannot route those bodies back through legacy.
Creation-only lineage comes from `onCreate`, never static state defaults or
`onWake`: Rivet 2.3.21 can reconstruct default state for an existing actor's empty
snapshot. Missing lineage remains held, including after new turns finish.
The gate currently admits only fully covered, archived turns without recorded
conversation model/web invocations or untracked app/social approvals. All existing
model/web markers remain held even when labelled settled: HTTP local timeouts and
hot Codex answers before retirement do not provide a generic provider settlement
receipt. No reconciliation action or provider contract is invented here. These
checks are not an activation claim; activity routing still needs wiring below.

Legacy archival uses saved admission order/time and immutable ledger projections.
Because old turns lack a retention classification, payloads are omitted and the
archive marked incomplete; this is not a recovered transcript. Missing first
receipt times remain held. Only dependency-free omitted-content projections may
refresh their revision fence after deletion, immediately before the synchronous
ledger write. Native fixtures reproduce save/publication gaps, lost archive ACKs,
deletion during projection persistence, and handoff while a direct legacy input
waits for priority. Lane ownership now precedes that wait, and record-event plus
wakeup claim/discard revalidate it rather than trusting a cached workflow result.

No-model `!allow` commands can deliver through the independent social outbox.
They record a write-ahead coverage hold before dispatch; the
existing interruption fixture reproduces an unknown recipient send alongside a
successful owner acknowledgment and requires the hold to survive serialization.

## Task 4: Distinct activity actors and late results

**Files:** `src/sessions/runtime.ts`, `src/runtime/registry.ts`, `src/runtime/prompt.ts`, `src/main.ts`, `src/config.ts`, `src/channels/slack-context.ts`.

- [x] Add prospective per-call model handles with independent answer and settlement promises. Preserve early replies and compose all native calls through the login/MCP wrappers. Timeouts, unsupported providers and uncorrelated/interrupted Codex calls remain unknown; these receipts never certify historical invocations or tool/delivery outcomes.
- [ ] Drive the existing `receiveSessionInput`, `nextSessionInput`, `settleSessionInput`, `acknowledgeSessionArchive` and `sealIdleSession` transitions. Save assignment before enqueue and deduplicate in both actors.
- [ ] Activity actors perform interaction, clarification, delegation and synthesis only. Use the shared worker runner and narrow stable-catalog actions rather than copying jobs or approvals into activity state.
- [ ] Persist admitted original-event provenance and exact delivery references in the catalog for worker authority and future approvals. An activity acknowledgment must match its assigned event/session/sequence.
- [ ] Archive each completed turn and repair write/save gaps idempotently. Delay exact forgetting preview issuance until its origin archive is stable; exclude the preview/control turn payload itself so presentation cannot silently expand the preview's deletion set. Never weaken fingerprint comparison.
- [ ] Keep fresh provider input free of old raw history, including same-surface Slack loading. Selective typed recall remains available. Omit a continuity note unless its current provenance-backed open commitments can be established within 1,000 characters.
- [ ] Route stable notifications once through the coordinator, retaining original worker/task and permitted reply address. Notification-only sessions seal after archive/settlement and do not reset human inactivity.
- [ ] Schedule durable idle sealing. Archive failure keeps input held; summary failure does not block searchable transcript or a new reply. Deactivation preserves established routing and historical lookup.

The new activity actor is implemented but not registered or routed in production.
It owns local history, inference receipts and the outbox; its catalog port keeps
assignment, dispatch authority and acknowledgment on the stable coordinator.
Native-engine fixtures cover early delivery before retirement, immutable archive
replay, catalog commit/lost-ACK repair, deletion during inference and multipart
unknown/rejected prefixes. Untouched multipart tails are withheld without a send;
unknown inference or delivery still blocks release. Cold-process recovery and the real catalog/control integration
remain unverified; this increment is not session activation.

`ModelProvider.beginReply` prepares settlement evidence for the activity actor;
only the unregistered activity actor consumes it to release turns yet. Terminal
protocol envelopes confirm HTTP inference stopped. Hot Codex also requires a correlated successful
terminal turn and local retirement/process closure. Killing an unresolved local
process, receiving an interrupted status or fulfilling an answer is insufficient.
Fixtures exercise delayed retirement, caught synthesis failures and a completed
notification whose turn ID disagrees with the start response; the latter was
reproduced as a false confirmation before adding explicit start correlation.

### Control integration boundary

Keep deterministic command execution and special private send callbacks in the
stable conversation workflow. Persist the exact activity assignment and control
classification first. Ordinary inputs branch before legacy history processing;
assigned controls skip history, automatic ingestion/extraction and reflection
enqueue, while retaining their original catalog records and intentional changes.
Do not reclassify an assigned control as legacy or copy the approval catalog.

Add a discriminated receipt-only activity path alongside ordinary interaction.
Persist control outcomes before publishing that handoff, even after event.done.
The activity may archive and acknowledge the exact receipts; it cannot repeat a
command, call inference or send the control output. Include separate social
outbox uncertainty; a successful owner acknowledgment alone cannot release the
assignment. Preserve the no-model/private-only rules for worker completions too.

Forget previews wait for their original dispatch turn's durable archive before
computing and binding the fingerprint. Worker dispatch must not wait for that
preview result. The presentation and confirmation turns omit payloads and
dependency edges, and the stable catalog indexes the actual sent preview under
its existing event:text key before another confirmation can be admitted. Keep
both fingerprint rechecks and the existing self-deletion receipt exception;
never infer delivery from a completed job or manufacture a replacement receipt.

Publication, archive-write and catalog-ACK gaps each replay their exact saved
record. Historical ACK repair precedes current-provenance checks and grants no
new effect permission. Commit settlement, archive watermark and historical ACK
without yielding between state transitions, persist, then publish successor work.
The unregistered activity actor now has the receipt-only variant. It validates
the full archive identity and omitted-content/dependency fence before persistence,
replays immutable receipts across deletion and lost ACKs, and holds unknown
effects, unknown sends or incomplete coverage. It never infers, applies worker
actions, sends, or adds these receipts to model history. Native-engine fixtures
cover these boundaries. Stable catalog publication,
control execution routing, exact delivery indexing and cold-process recovery are
still outstanding, not a new human approval gate or an activation claim.

## Task 5: Integrated evidence

- [ ] Exercise actual provider requests across the three-hour boundary, old-thread placement, backlog/clock rollback, duplicate/lost-ACK recovery, archive/seal interruption and held legacy effects.
- [ ] Verify a worker outlives its activity actor, one late completion is routed, and a new-session approval resolves the old exact proposal. Exercise deletion during recall/delivery plus authenticated restore.
- [ ] Run formatter, lint, typecheck, relevant existing suites and review the exact diff.
- [ ] Report published revision, held limitations and deployment/activation evidence separately. Do not call prerequisites alone a completed session rollout.
