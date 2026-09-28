# Session Archive Implementation Plan

Historical storage design and implementation checklist; not a runtime activation claim.

**Goal:** Retain attributed activity transcripts in the encrypted evidence ledger without making June's replies original human evidence or weakening forgetting.

**Architecture:** Session archives are a separate collection in the existing authenticated snapshot. Each committed turn keeps an immutable, content-free receipt even when deletion removes its payload. Existing source/claim indexes and independent-evidence traversal do not include archive records.

**Tech Stack:** Existing TypeScript, Zod, encrypted SQLite snapshot, Vitest and Biome; no new dependency or encryption format.

**Spec:** [Activity sessions](../specs/2026-09-27-activity-sessions-design.md)

## Global constraints

- This slice does not enable actor rotation, migrate legacy conversation history or wire a model capability.
- Audience is authenticated host input, never a session ID or model-selected scope.
- Archive user text only with its retained original source; assistant text remains explicitly attributed and carries delivery status.
- Omitted volatile/private tool output has an enum reason, not a retained payload.
- Complete `sourceIds` and `contextSourceIds` are deletion dependencies, not additional corroboration.
- New writes compare the captured deletion revision inside the existing synchronous transaction.
- Forgetting removes affected payloads, including later archive turns depending on earlier turns; signed tombstones include their stable IDs.
- Restore replay completes before any archive projection. No backup transport or cryptographic changes.
- Preserve landed reflection proposal/rejection fields and the curated-personality contracts.
- Update exact forget-preview identity to include archive dependants. Until the runtime displays archive counts, previews that would remove archive payloads must not be confirmable through the old interface.
- Keep focused durable tests for privacy, restore and duplicate writes only; use existing suites for regression checks.

## Task 1: Archive records and transactional admission

**Files:** `src/sessions/archive.ts`, `src/memory/store.ts`, `src/sessions/archive.test.ts`, and the independent snapshot-size fixture in `src/memory/store.test.ts`.

**Interfaces:**

```ts
// New trusted-host EvidenceStore methods; not standalone model authorization.
archiveSessionTurn(input: SessionArchiveInput, expectedDeletionRevision: number): number;
retrieveSession(audience: string, sessionId: string, options?: {
  afterSequence?: number; limit?: number; maxCharacters?: number;
}): SessionArchivePage;
searchSessions(audience: string, query: string, options?: {
  observedFrom?: number; observedTo?: number; limit?: number;
}): SessionArchiveSearch;
```

- [x] Define strict role/content/delivery schemas in `src/sessions/archive.ts`. Derive namespaced turn IDs from session and event IDs; use mandatory dependency arrays and content-free receipts with optional retained data.
- [x] Add a default-empty archive collection to the encrypted state schema and new-store initialization. Keep the `june-evidence-v1` format and authenticated parser.
- [x] Implement immutable replay and contiguous turn admission in `archiveSessionTurn`. Reject altered receipt/data, reused events in another session of the same audience, sequence gaps, foreign dependencies, opted-out sources, tombstones and stale deletion revisions. A replay of a deleted receipt acknowledges prior coverage without restoring its data.
- [x] Keep user text equal to its original authorized source, with the original author. Assistant entries require explicit `sent`, `rejected`, `unknown` or `not_sent`; platform acceptance is not a read receipt.
- [x] Test replay/reopen, conflicting writes, stale revision, cross-session duplicate admission and original-source enforcement against disposable encrypted stores.

## Task 2: Forgetting, restore and bounded archive reads

**Files:** the same files; no registry/provider/main edits.

- [x] Extend `removeEvidence`'s fixed point over archive dependencies. Preserve turn receipts/sequence coverage; remove payloads and add stable turn IDs to tombstones.
- [x] Include authorized archive dependants in exact forgetting counts/fingerprint. Reject hidden spillover and keep previews with archive payloads unconfirmable until the caller explicitly requests the new archive-aware preview contract.
- [x] Leave source/claim retrieval and `independentEvidence` unchanged. Archive IDs cannot become source/claim aliases or grounding originals.
- [x] Filter archive audience and retained dependencies before matching text, time windows, counting or pagination. Missing/foreign sessions have identical empty results.
- [x] Return complete entries within the requested character budget; report whole-record omissions and a sequence continuation instead of clipping a purported quotation. Session metadata includes archived-through coverage even after payload deletion.
- [x] Verify private/public isolation, assistant non-corroboration, transitive deletion, exact-preview invalidation and tombstone replay through an actual encrypted snapshot restore. Verify omitted-content entries cannot contain text.

## Verification boundary

Use focused archive checks and existing store/restore/forgetting tests to verify
foreign proposal dependencies and remaining-budget pagination. Run formatter,
lint and typecheck for code changes and review the exact diff. Storage checks
alone do not establish archive production, migration or actor-routing activation.
