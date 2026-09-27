# Activity Session Integration Plan

> **For agentic workers:** Use superpowers:executing-plans in the existing isolated session worktree. Bounded producer and catalog refactoring can run concurrently with disjoint write ownership; routing integration remains with the session owner.

**Goal:** Complete the approved owner-DM activity actors without transferring approval authority or replaying uncertain legacy effects.

**Architecture:** Keep `conversation(scopeKey)` as the durable scope coordinator and catalog. New activity actors own their transcripts, model receipts and outboxes; narrow coordinator actions own workers, proposals, original-event authorization and approval lookup. Drain and archive the legacy lane before assigning an activity turn.

**Tech Stack:** Existing TypeScript, Rivet 2.3.21 workflows, encrypted EvidenceStore, Biome and disposable Vitest/native-engine fixtures.

**Spec:** `docs/superpowers/specs/2026-09-27-activity-sessions-design.md`

## Global constraints

- Three hours is the configurable initial inactivity default. Platform reply placement does not select the activity actor or privacy audience.
- Public and guest behavior is unchanged. Reject enabling the owner-private experiment if another linked adapter can bypass its coordinator.
- No live config, service or data changes. Publish tested, stronger-reviewed increments against fresh main without freezing concurrent publishers.
- Preserve legacy actor keys, journal step ordering, task/proposal identities, exact approval receipts, deletion fences and late callbacks.
- Unknown sends and incomplete historical effect coverage hold migration. A FIFO token, workflow completion, age, empty marker scan or restart is not enough. No new reconciliation endpoint.
- Keep tests focused on privacy, authority and duplicate effects. Use existing native-engine workflows for ordinary behavior.

## Task 1: Keep catalog authority in its existing actor

**Files:** `src/runtime/scope-catalog.ts`, `src/runtime/registry.ts`.

- [x] Move the stable catalog types and delegated-authority/visible-job validation into a focused scope-catalog module without changing persisted field names, validation or RPC behavior. `ConversationState` continues to contain the same records; this is not a state migration or a copied catalog.
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
merely absence of a tombstone. Oracle's initial review found a canonical Slack
identity/time mismatch and a captured replacement-store reference in the catalog
refactor. Both were reproduced in focused regressions, fixed and cleared by the
follow-up review. Slack source time is message `ts`, not envelope `event_time`;
same-thread messages in one millisecond cannot substitute for each other.

## Task 3: Durable admission and legacy handoff

**Files:** `src/sessions/migration.ts`, `src/runtime/registry.ts`, `src/runtime/inspection.ts`.

The coordinator persists this transition separately from the activity directory:

```text
legacy -> draining(epoch, barrier, frozen legacy admissions, coverage, holds)
       -> sessions(epoch, evidence-backed certificate)
```

- [ ] Persist canonical identities, recoverable bodies, first host receipt time and immutable lane before acknowledging every new input, including worker/coding/wakeup notifications. Adopt legacy IDs and Slack aliases; consult tombstones before admitting duplicates.
- [ ] Fence new legacy admission under the existing receive serializer, repair saved legacy publication gaps, then enqueue one stable barrier. New input waits durably without blocking ingress on the whole drain.
- [ ] Add a post-receive workflow version branch for routing control. Old iterations retain their original journal path; no retroactive effect invocation or successful receipt is manufactured.
- [ ] Require the exact barrier, all frozen admissions, complete historical effect coverage, no live/uncertain effects or pending retries, and acknowledged archival coverage before activation. Missing historical coverage remains held. Re-published legacy admissions behind the token still prevent activation.
- [ ] Expose bounded hold reasons through owner-private inspection. Keep inspection read-only; it cannot clear, retry or reclassify an effect.

## Task 4: Distinct activity actors and late results

**Files:** `src/sessions/runtime.ts`, `src/runtime/registry.ts`, `src/runtime/prompt.ts`, `src/main.ts`, `src/config.ts`, `src/channels/slack-context.ts`.

- [ ] Drive the existing `receiveSessionInput`, `nextSessionInput`, `settleSessionInput`, `acknowledgeSessionArchive` and `sealIdleSession` transitions. Save assignment before enqueue and deduplicate in both actors.
- [ ] Activity actors perform interaction, clarification, delegation and synthesis only. Use the shared worker runner and narrow stable-catalog actions rather than copying jobs or approvals into activity state.
- [ ] Persist admitted original-event provenance and exact delivery references in the catalog for worker authority and future approvals. An activity acknowledgment must match its assigned event/session/sequence.
- [ ] Archive each completed turn and repair write/save gaps idempotently. Delay exact forgetting preview issuance until its origin archive is stable; exclude the preview/control turn payload itself so presentation cannot silently expand the preview's deletion set. Never weaken fingerprint comparison.
- [ ] Keep fresh provider input free of old raw history, including same-surface Slack loading. Selective typed recall remains available. Omit a continuity note unless its current provenance-backed open commitments can be established within 1,000 characters.
- [ ] Route stable notifications once through the coordinator, retaining original worker/task and permitted reply address. Notification-only sessions seal after archive/settlement and do not reset human inactivity.
- [ ] Schedule durable idle sealing. Archive failure keeps input held; summary failure does not block searchable transcript or a new reply. Deactivation preserves established routing and historical lookup.

## Task 5: Integrated evidence and publication

- [ ] Exercise actual provider requests across the three-hour boundary, old-thread placement, backlog/clock rollback, duplicate/lost-ACK recovery, archive/seal interruption and held legacy effects.
- [ ] Verify a worker outlives its activity actor, one late completion is routed, and a new-session approval resolves the old exact proposal. Exercise deletion during recall/delivery plus authenticated restore.
- [ ] Run formatter, lint, typecheck, relevant existing suites and required stronger review. Reconcile fresh main and push normally.
- [ ] Report published revision, held limitations and deployment/activation evidence separately. Do not call prerequisites alone a completed session rollout.
