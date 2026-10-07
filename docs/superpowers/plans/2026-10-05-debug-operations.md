# Debug Operations Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution. Independent Python producers and frontend work may run concurrently with disjoint file ownership.

**Goal:** Let the owner and June inspect every supported June-originated Amp trigger, deployment observations, and related historical failures in the independent debug archive.

**Architecture:** Append immutable, strictly validated metadata events to the existing independent SQLite archive. Source-local durable journals retry publication without retrying the underlying action. Operations is a read-only view; June uses a separate operations-only reader credential, never the viewer credential.

**Tech Stack:** Existing Node 24, TypeScript, SQLite, Hono, Svelte 5/shadcn-svelte, Python standard library, Vitest and unittest.

**Spec:** The owner-approved Operations design in this thread, concretized below.

## Global constraints and approved design

- Work on main; preserve concurrent work. Commit/push reviewed increments, but do not install, restart or deploy live services without operator authorization.
- Keep the debug archive independent of June, Rivet and deployment readiness. Existing captures and passkey authentication remain intact.
- Events carry identifiers, fixed status/reason codes, timestamps, revision/thread/capture links, retry counts and controller state. No task titles, prompts, owner messages, results, raw errors, credentials or logs.
- Sources: controller, deployment, recovery, debugshare, amp-task, coding. Instrument all launch states including unknown/no thread. DEBUG is capture-only, not an Amp launch.
- One operation has an ordered sequence of immutable events. Identical retries are idempotent; conflicting event identity or sequence is rejected. Sequence, not arrival time, selects current state.
- Failure matching is exact source + phase + reason/status, counted by distinct operation, across retained history. It establishes the same symptom, never the same root cause. Recovery receipts and Amp links provide historical context without copying private results.
- Source timestamps and observation timestamps stay separate. Backfilled records with unknown times remain unknown; a returned thread is not a verified fix or current health.
- The controller records current hold, queue, phase, retry and recovery owner observations. A stale observation remains visibly stale; empty history is not healthy.
- Source journal/publication faults never authorize or repeat a deployment/launch. They leave pending uploads or explicit local logging failures. Retention is append-only; deployment does not migrate/delete production data in this thread.
- June gets a discoverable private inspection target and instructions across interaction, execution and automated-event paths. Inspection grants no mutation or competing recovery authority.

## Task 1: Immutable operations archive and APIs

Files: `src/diagnostics/operations.ts`, `store.ts`, `server.ts`, `main.ts`, focused diagnostics tests.

- [x] Add failing tests using out-of-order sequences, conflicting retries, resolved repeat failures and a different phase with the same reason. Assert literal expected operation order/counts.
- [x] Add strict operation schema, operation summary/index/detail types and fixed failure-key calculation.
- [x] Add SQLite event table, idempotent inserts, paginated search, latest controller observation and related failures. Keep archived failures queryable after completion/reconciliation.
- [x] Add bounded authenticated ingest at `PUT /api/ingest/operations/:id`, viewer `GET /api/operations[/:id]`, and separate operations-reader routes. Verify reader cannot read captures, manage passkeys or upload; ingest cannot read.
- [x] Verify with `umask 0022; pnpm exec vitest run src/diagnostics/store.test.ts src/diagnostics/server.test.ts src/diagnostics/operations.test.ts`.

Example contract to exercise:

```ts
store.putOperation({ id: "test:2", operationId: "recovery:17", source: "recovery",
  sequence: 2, observedAt: 2000, occurredAt: 1900, status: "reconciled", failure: false });
store.putOperation({ id: "test:1", operationId: "recovery:17", source: "recovery",
  sequence: 1, observedAt: 1000, occurredAt: 900, status: "pending", failure: true,
  phase: "readiness", reason: "health_failed" });
expect(store.operation("recovery:17")?.operation.latest.status).toBe("reconciled");
```

## Task 2: Durable source reporting

Files: `src/diagnostics/operation-journal.ts`, `src/runtime/coding.ts`, `src/main.ts`; Python `scripts/deploy/operations.py`, `deploy.py`, `debugshare.py` and focused Python tests.

- [x] Test journal restart/retry with an unavailable collector, idempotent replay, and content-free projection from requests containing private sentinel strings.
- [x] Journal Python dispatcher queued/launch/thread/terminal observations and controller lifecycle, recovery claim/reconciliation, phases and status heartbeat. Use explicit metadata projection, no receipt-protocol changes or action-policy changes.
- [x] Backfill retained controller lifecycle events and current dispatcher receipts, labeling unknown historical timing; never fabricate cleared recovery records.
- [x] Journal approved local/remote Amp coding attempts, thread receipts and verifier/unknown results. Other coding runtimes must not be labeled Amp.
- [x] Bound transport time/response size, refuse redirects, retain pending records across restarts and keep network I/O out of action-critical sections.
- [x] Verify Python producers on temporary databases and fake transport only. Never invoke a real Amp launcher.

## Task 3: Operations UI

Files: `debug-site/src/App.svelte`, `lib/archive.ts`, `lib/components/OperationsView.svelte`, `app.css`, frontend tests and `scripts/preview-debug-site.ts`.

- [x] Add authenticated `/operations` navigation without changing Evidence/Conversation routes. Reuse existing private API epoch invalidation.
- [x] Render a compact controller-state strip, source/search filters, newest-observed operation list, selected timeline and matching past failures. Include direct Amp/capture links, explicit unknowns and observation age.
- [x] Add deterministic synthetic fixtures: resolved repeat failure, current failure/recovery, queued/no-thread task, unknown launch, completed investigation and stale controller.
- [x] Test stale responses/expiry clearing; run frontend formatter, lint, check and build.
- [x] Run the synthetic preview on a thread-owned port, inspect desktop and narrow screenshots, and exercise filters, history navigation, detail pagination and session expiry. Leave a requested preview running.

## Task 4: June access, documentation and delivery

Files: config, core/model inspection schema, runtime inspection/prompt, main wiring, `docs/debug-site.md` and deployment setup docs.

- [x] Add optional source publication and operations-only reader configuration without expanding existing write-only ingest authority.
- [x] Expose owner-private `inspection: { target: "debug-operations", query, operationId, offset }` through existing inspection permissions and bounded metadata responses.
- [x] Update runtime knowledge about sources, activation gates, retries, incomplete backfill, privacy, observation age, failure matching and recovery ownership.
- [x] Test actual inspection output and permission behavior through existing runtime tests.
- [x] Run formatter, linter, typechecker, focused backend/frontend/Python checks, rendered verification and Oracle review. Address material findings.
- [x] Fetch/rebase concurrent main safely, rerun affected checks and prepare an atomic Conventional Commit. Document exact installation prerequisites; record the push receipt separately from live activation in the owning thread.

## Baseline

Initial focused backend tests exposed the existing file-mode fixture assumption under this runner's umask 0077. The unchanged store suite passes with command-local umask 0022; do not alter production permissions or unrelated tests. Frontend baseline passes. Preserve untracked `scripts/deploy/__pycache__/` from other work.

## Review and verification notes

Oracle's follow-up found no blockers after complete-record inspection pagination,
permanent redirect rejection, and explicit future-clock observation warnings.
The real worker inspection workflow consumes detail, matching history and site
deployment metadata in four model turns without expanding its tool budget.
Desktop, narrow and clock-skewed synthetic views were rendered and inspected.

The broader coding/inspection run was not green: 21 failures included polling,
actor-route and shutdown timeouts. A pristine pre-change baseline reproduced the
signed owner-DM event polling failure; its six other selected cases passed. The
matching focused changed-code run passed eleven cases (including new local Amp
observations and both remote Amp outcomes) and reproduced that same baseline
polling failure. This is not evidence that every broad-suite failure is unrelated.
No production timeout, permission or launcher behavior was changed to mask it.

The affected admission test also reproduced its one-second completion timeout
on the pristine baseline. Its completion wait now uses the same bounded
15-second poll as the new producer cases and awaits notification settlement
before teardown. All twelve focused reader/producer cases then passed, including
the blocked-attempt timeline and the real four-turn worker workflow. The existing
long multi-capability inspection test still timed out in the broader run.

Source publication does not activate Operations. The independent updater's
storage-policy fence must remain until a separately authorized reviewed forward
installation and policy rebootstrap; June and each producer need their own
configuration and activation. The later navigation rebuild is separately owned.
