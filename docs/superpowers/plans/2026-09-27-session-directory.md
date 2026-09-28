# Session Directory Implementation Plan

Historical routing-state design and implementation checklist; not an activation claim.

**Goal:** Build the durable control-state transitions that assign each incoming event to exactly one activity session, without changing live routing yet.

**Architecture:** A scope coordinator will own this serializable state. Pure synchronous transitions separate first receipt, assignment, turn settlement and archive acknowledgment so the Rivet host can persist before dispatching. The existing delegated capability runner and reusable workers retain their identities and authority.

**Tech Stack:** TypeScript, Node 24, existing Vitest and Biome; no new dependency.

**Spec:** [Activity sessions](../specs/2026-09-27-activity-sessions-design.md)

## Global Constraints

- Three-hour idle is a configurable implementation default, not a new permission boundary.
- Human first-receipt time determines grouping; replay, completion, inspection and background work cannot refresh it.
- Scope/privacy audience and worker identity do not change when the session changes.
- Never retire a session while a dispatched turn is unsettled or its completed transcript is not acknowledged as archived.
- Persist a routing decision before enqueue; persist completion/archive receipts before admitting a new session.
- Use existing uncertain-invocation rules. This module cannot decide that an unknown external operation settled.
- No shared runtime, provider, config or memory-store edits in this slice.
- Keep tests limited to duplicate-effect prevention and admission/archive invariants.
- A passing module check is not June-facing integration or production activation.

## Delivery boundary

This plan covers the routing-state prerequisite, not the whole session feature.
Archive storage/recall and live actor wiring consume these transitions after the
delegation runner lands. Publishing this inactive prerequisite does not enable
session rotation, alter prompts or migrate data. The full feature still requires
the spec's actual provider-request, recall, migration and cross-session-authority
checks before completion can be claimed.

## Task 1: Durable event assignment and session retirement

**Files:**
- Create `src/sessions/state.ts`: serializable directory and synchronous transitions.
- Create `src/sessions/state.test.ts`: focused duplicate/admission regressions.
- Update the activity-session spec's status to distinguish approved direction from implemented behavior.

**Interfaces:**

```ts
type SessionInputKind = "message" | "notification";
type SessionReceipt = {
  id: string;
  kind: SessionInputKind;
  receivedAt: number;
} & (
  | { status: "pending" }
  | { status: "assigned" | "settled"; sessionId: string; sequence: number }
);
interface ActivitySession {
  id: string;
  openedAt: number;
  lastHumanAt?: number;
  completedThrough: number;
  archivedThrough: number;
  status: "open" | "sealed";
}
interface SessionDirectory {
  scopeKey: string[];
  idleMs: number;
  receipts: Record<string, SessionReceipt>;
  sessions: Record<string, ActivitySession>;
  pending: string[];
  activeSessionId?: string;
  inFlight?: string;
  receivedThrough: number;
}
type NextSessionInput =
  | { kind: "idle" }
  | { kind: "archive"; sessionId: string; through: number }
  | { kind: "dispatch"; receipt: SessionReceipt & { sessionId: string; sequence: number } };

// All calls are trusted-host operations, not model-callable authorization APIs.
initialSessionDirectory(scopeKey: readonly string[], idleMs?: number): SessionDirectory;
receiveSessionInput(state: SessionDirectory, id: string, kind: SessionInputKind, now: number): SessionReceipt;
nextSessionInput(state: SessionDirectory): NextSessionInput;
settleSessionInput(state: SessionDirectory, id: string, sessionId: string): void;
acknowledgeSessionArchive(state: SessionDirectory, sessionId: string, through: number): void;
sealIdleSession(state: SessionDirectory, now: number): boolean;
sessionActorKey(scopeKey: readonly string[], sessionId: string): string[];
```

- [x] Add focused tests that fail without the directory implementation. Use host event IDs as 64-character hex hashes, asymmetric times and distinct session contents. Check assignment identity, not merely call completion.
- [x] Cover receipt replay before assignment, after settlement and after rotation: original time, kind, assignment and pending count stay unchanged. Duplicate events must not extend the old session's lifetime.
- [x] Cover dispatch replay after serializing/deserializing directory state: the same event/session/sequence is returned until an explicit matching settlement. Another receipt cannot overtake live work, and wrong-session settlement must fail without mutation.
- [x] Implement first receipt with `Math.max(now, state.receivedThrough)`, preserving the original receipt on duplicate. Validate host IDs, input kind and finite safe integer times before mutation. A duplicate must not apply a new timestamp or payload kind.
- [x] Assign only the oldest pending receipt. Derive an opaque stable session ID from the scope and its first receipt; hash the scope into a separate key segment to avoid raw JSON in native Rivet keys. A session ID is not a memory audience.
- [x] Reuse an open session below the human idle threshold. At or above the threshold, require both settlement and archive watermark before sealing and assigning the next receipt to a new session. Use saved receipt times so processing delays do not split a queued conversation.
- [x] Record settlement only for the current receipt and exact session. Repeated settlement is idempotent. Sequence numbers advance once; earlier archive acknowledgments cannot move the watermark backwards or beyond completed turns.
- [x] Seal an idle session only when no live receipt or pending same-period message would be excluded. Notification-only sessions can retire after settlement and archive; notifications never advance `lastHumanAt`.
- [x] Exercise just-below/exact idle gaps, unarchived retirement, stale timers with queued human messages, notifications across the human idle boundary and clock rollback. Keep ordinary clock/budget cases in one focused invariant test rather than a large suite.
- [x] Verify stable scope/key identity and distinct safe actor keys across rotation. Do not add owner authorization to these functions; the authenticated runtime owns that check.

## Verification boundary

Run `pnpm exec vitest run src/sessions/state.test.ts` and relevant existing
execution/routing checks, plus formatter, lint and typecheck for code changes.
Review state mutations for duplicate assignment, rejected-input atomicity,
persisted-before-dispatch requirements and notification-before-human retirement.
A session ID must never substitute for authenticated authority. Passing directory
checks does not establish runtime integration or authorize service changes.
