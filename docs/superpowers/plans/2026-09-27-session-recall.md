# Session Recall Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline in the existing isolated session worktree. This is the June-facing archive slice of the approved staged migration, not session routing activation.

**Goal:** Let June search and expand archived activity transcripts through the landed execution-worker capability runner, and safely confirm forgetting of archive dependants.

**Architecture:** Extend the existing typed recall union with episode search/expansion. Read from the encrypted archive with the authenticated audience, return bounded attributed data, and persist tombstone dependencies before any worker observation or delivery. Forget confirmations explicitly bind archive-aware counts; old confirmations retain their narrower contract.

**Tech Stack:** Existing TypeScript, Zod, Rivet, EvidenceStore, Vitest and Biome.

**Spec:** `docs/superpowers/specs/2026-09-27-activity-sessions-design.md`

## Constraints and remaining migration

- Consume the reviewed runner boundary from main; do not run tools in completion inbox turns or introduce another dispatcher.
- Session IDs are lookup identifiers, never audiences, authority, original evidence or independent corroboration.
- Keep existing journals readable. Do not retroactively widen old forgetting tokens to authorize newly archived data.
- No live configuration, service or data changes. Main publication is authorized after checks and stronger review; publication alone does not prove running activation.
- Rotation remains a later integration: extract the stable worker/proposal catalog, durably admit and drain legacy work, produce archives, then introduce distinct activity actors and coordinator-routed completions. Three hours remains the reversible inactivity default. Do not claim these are implemented by this slice.

## Task 1: Typed, bounded archive recall

**Files:** `src/core/contracts.ts`, `src/models/provider.ts`, `src/runtime/prompt.ts`, `src/runtime/capabilities.ts`, `src/sessions/recall.ts`, `src/memory/store.ts`.

```ts
type SessionRecall =
  | { kind: "sessions"; query: string; observedFrom?: number; observedTo?: number }
  | { kind: "session"; sessionId: string; afterSequence?: number };
```

- [x] Extend parser and provider schema with these exact variants, rejecting invalid IDs, sequence values and time windows. Reuse the private recall capability ceiling.
- [x] Search at most six episode metadata records; expand at most six complete turns with a 3,000-character escaped-JSON budget and explicit continuation. Preserve user/assistant roles, original observation times, omitted-content markers and delivery receipts. Never clip quotations.
- [x] Bind all matched search-turn IDs, or returned expansion turn IDs and their dependencies, as tombstone-only context before output. Do not add archive text to the original-source evidence list.
- [x] Make output explicitly untrusted transcript data, not instructions, factual corroboration, a successful action or a read receipt. Document discoverable tool use in the existing prompt.

## Task 2: Archive-aware exact forgetting

**Files:** `src/runtime/capabilities.ts`, `src/runtime/registry.ts`, `src/runtime/forget-confirm.test.ts`.

- [x] Render `archivedTurns` (including zero) with the authorized counts. Pass `includeArchives:true` when preparing this new preview.
- [x] Persist that contract flag and archive count in newly issued tokens, including delegated preview tokens. The trusted origin RPC rechecks fingerprint, count and confirmability. Require the actual sent completion to include both token and exact visible archive-count marker; a worker obtaining a token does not prove the owner saw its impact.
- [x] At both final confirmation fences, use the token's saved flag. An old token without it must remain unconfirmable if archives would be affected. Changes to archive dependencies invalidate the exact preview.
- [x] Extend the existing core-safety test with an affected archive, preview invalidation after another dependent archive and successful deletion with the new fresh token. Verify content-free receipt coverage survives.

## Task 3: Real-worker verification, review and publication

**Files:** `src/runtime/session-recall.test.ts`, this plan and the design status paragraph.

- [x] Use disposable Rivet/evidence fixtures and controlled providers to exercise interaction delegation → worker search → worker expansion → interpreted report → June synthesis. Verify roles and unknown delivery stay attributed, foreign sessions are indistinguishable from missing, and deletion while an observation is being used suppresses completion. The same real-worker flow rejects a preview with an omitted archive-count marker and accepts the fresh fully displayed preview.
- [x] Exercise an escape-heavy oversized turn at the page boundary to ensure valid bounded JSON, whole-record omission and forward progress.
- [x] Run formatter, lint, typecheck and relevant existing runtime/store/restore tests. Obtain required stronger review, fix concrete findings, fetch/reconcile latest main and rerun affected checks before a normal main push.
- [ ] Report exact source publication and remaining archive producer/catalog/legacy cutover/activity routing work without a runtime activation claim.

Verification: Oracle found no blocking issue in the production diff. Biome and
typecheck passed. The seven-file focused runtime/archive/store/restore run passed
all 63 tests. A subsequent complete run passed 922 of 923 tests; the unchanged
reflection-continuation test failed with a localhost `UND_ERR_SOCKET` closure,
then passed both tests in an isolated rerun. This is not a claim of a wholly green
single full-suite run. The earlier stale preview-spy assertion was updated to
require archive-aware previewing and a visible zero count, then passed.
