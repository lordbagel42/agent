# Dashboard Rewrite Implementation Plan

**Goal:** Replace June's confirmation-heavy dashboard with a coherent private
control panel and automatic short-link/OAuth continuation.

**Architecture:** Preserve server-rendered Hono routes and existing security and
provider contracts. Use narrowly scoped nonce-authorized browser enhancement for
mechanical continuation, retaining forms as a no-JavaScript fallback. Provider
state, owner/session validation, CSRF, expiry and atomic redemption stay mandatory.

**Tech Stack:** TypeScript, Hono, native HTML/CSS, Vitest, Playwright.

**Spec:** Owner-approved direction in
https://ampcode.com/threads/T-01a0e842-8a4b-75ab-9cc6-6902b9deed39 and `PRODUCT.md`.

## Global constraints

- Claude CLI implements using Opus 5.5 at max effort; Amp integrates and verifies.
- No live service/configuration changes or deployment. Only synthetic fixtures.
- Keep tests few: prioritize authentication, privacy and once-only exchange.
- Preserve meaningful action approval and all existing tool-permission gates.
- Update June's actual runtime instructions alongside changed login behavior.

## Tasks

- [x] Inspect current desktop/mobile rendering using a synthetic Hono fixture.
- [x] Rewrite the shared shell in `src/console/view.ts` and task hierarchy in
  `routes.ts`, `connections.ts`, and `usage.ts`; keep every existing route and
  host capability accessible, with clear current navigation and recovery.
- [x] Automate sign-in in `session.ts` without consuming links on GET/HEAD.
  Redirect token login directly to the validated return route. Keep ordinary
  preview/prefetch requests non-consuming and support no-JavaScript fallback.
- [x] Simplify `connection-oauth.ts`: leave once consent is initiated, establish
  a same-origin document on return, and automatically submit an authenticated,
  signed finish POST. Bind pending completion to the initiating browser and
  provider state; consume once before exchange. Handle cancellation, expiration,
  missing sessions and ambiguous completion without loops or automatic retries.
- [x] Change `security.ts` only as needed for narrowly scoped nonce scripts;
  never permit unsafe-inline, third-party scripts, framing or permissive CORS.
- [x] Add/update focused auth boundary tests in the existing console tests and
  provider integration coverage. Exercise concurrent redemption, replay,
  cross-site requests, wrong browser/state and expired sessions.
- [x] Update `src/runtime/prompt.ts`, affected runtime help, console README and
  user-facing docs to describe automatic continuation and unchanged permissions.
- [x] Run formatter, linter, typechecker and relevant existing tests. Verify
  desktop/mobile, keyboard, form errors, no-JavaScript fallback, short-link
  redemption and simulated cross-site OAuth in a real browser (Chromium only;
  live providers remain untested).
- [x] Run Impeccable's detector and Oracle review; address material findings and
  rerun affected checks. Document the built design and include inspected visuals.

Publication follows repository guidance: reconcile concurrent main changes and
publish the reviewed, verified change. Deployment requires separate authorization;
publication and fixture verification do not establish live activation.
