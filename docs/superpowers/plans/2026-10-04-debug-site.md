# Standalone June Debug implementation plan

**Goal:** A private, information-dense shadcn-svelte website for DEBUG captures that
remains usable when June, her console, and Rivet are unavailable.

**Architecture:** A separately started, separately installed Node/Hono service
owns an immutable SQLite snapshot archive and serves a built Svelte application.
June uploads captures with a write-only credential. A different viewer credential
creates a browser session on the debug origin. Neither reads nor sign-in contact
June. Separate-host deployment is supported; colocated deployments still share
host/network failure modes. Live installation is not authorized by this task.

**Design:** Trace-first, dark neutral, dense rows and hairline separators, a recent
capture sidebar, compact metadata, and a timeline with a selected-row inspector.
Messages, model request, delivery evidence, exclusions and complete raw JSON are
accessible without claiming omitted evidence exists. No main-console navigation.
The Painter comparison informed the layout, not its synthetic claims or schema.

## Contracts

- `GET /api/session` returns `{ authenticated: boolean }`.
- `POST /api/session` accepts `{ token: string }` from the configured same origin.
- `POST /api/logout` revokes the current browser session.
- `GET /api/snapshots?q=&offset=` returns `DiagnosticIndex` from
  `src/diagnostics/contracts.ts`; search covers the retained archive.
- `GET /api/snapshots/:id` returns the stored `DebugSnapshot`.
- `GET /api/snapshots/:id/download` downloads the same JSON.
- `PUT /api/ingest/:id` accepts a snapshot with the independent upload Bearer
  token. Identical repetition succeeds; conflicting contents fail with 409.
- `/` and `/s/:id` serve the UI. An ID is a lookup key, never authorization.
- All private responses are no-store and no-referrer. Snapshot text is never HTML.
- The read UI has no replay, investigate, delete or permission-changing controls.

## Work and verification

- [x] Add the bounded archive and upload client, with focused red/green tests for
  durable restart, immutable identity, search/pagination and upload rejection.
- [x] Build the standalone Svelte/shadcn UI and its production asset bundle.
  Keep the existing console unchanged and use no third-party runtime assets.
- [x] Add independent Hono authentication/API and a self-contained server bundle.
  Verify credential separation, anonymous denial, CSRF, private headers, escaped
  payloads, invalid IDs, body size limits, and safe download behavior.
- [x] Connect DEBUG/DEBUGSHARE to a durable publication outbox. Mirror failures
  must not suppress the original receipt, block unrelated commands, or dispatch
  Amp for DEBUG. Retry the same immutable snapshot, not a new capture. Link only
  on owner-private delivery, never treat an unconfirmed upload as available.
- [x] Update runtime instructions in the shared prompt path and agent-callable
  debug receipt inspection with site URLs/publication state. Add opt-in config.
- [x] Provide a synthetic-only preview, install/run documentation and an
  independent systemd example with no PartOf/Requires dependency on June.
- [x] Run formatter, linter, root and Svelte typechecks, focused tests, production
  build and real-browser desktop/narrow Chromium workflow checks. Inspect captures.
- [x] Run Oracle review and address material findings. Final follow-up found no
  blockers in deletion provenance, interrupted child cleanup or retry fencing.
- [x] Prepare the verified increment for normal publication to main. Live service
  installation, production secrets and DNS remain separately authorized work.

The outage check must read a captured snapshot through a fresh independent server
after the publisher has stopped. Tests and previews use synthetic data only.

## Verification outcome

- Formatter, root lint/typecheck, Svelte check (zero warnings) and production build
  passed. Frontend tests: 10/10. Focused runtime/archive/activity run: 106/107.
- The existing DEBUGSHARE idle-deadline test failed its asleep assertion; this
  failure also reproduced on the untouched baseline. A separate broader inspection
  test timed out at 90 seconds on both this work and the baseline. Neither is
  treated as a passing check or fixed as part of this feature.
- Executed the copied production bundle without the checkout, node_modules or June:
  uploaded synthetic evidence, restarted the independent process, signed in afresh
  and exported identical JSON. Anonymous reads remained denied.
- Browser checks covered filters, exact payload selection, the final archive page,
  late JSON matches beyond the first page, all-record export, login rejection,
  logout, session revocation, missing captures, connection failure and recovery.
  Reviewed desktop/narrow and error-state screenshots using synthetic data.
- Fresh capture checks reproduced and then excluded deleted, context-dependent,
  legacy, incomplete-platform and explicitly forgotten evidence, while retaining
  independently valid records. Duplicate wake callbacks produce one retry chain.

Live service installation and end-to-end production DEBUG activation are not part
of this verification; they require an authorized independent deployment.
