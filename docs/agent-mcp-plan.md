# Agent MCP and Webhooks Implementation Plan

> Execute inline using superpowers:executing-plans; use bounded parallel help only
> for independently owned files or research. Preserve other checkout changes.

**Goal:** Owner-trusted MCP messaging, inspection/control, and reusable outbound
webhooks available to June and external agents.

**Architecture:** Extend the existing conversation transport, keeping one shared
owner-private actor. An optional MCP host authenticates administrative clients.
A private SQLite outbox persists encrypted webhook registrations and durable
idempotency records; validated HTTPS delivery never retries uncertain effects.

**Tech Stack:** Node 24, TypeScript, Hono, MCP SDK 1.30.1, RivetKit 2.3.21,
node:sqlite, Zod, and maintained IP address parsing.

**Spec:** `docs/agent-mcp-design.md` (approved by owner).

## Constraints

- Owner-equivalent access, not isolated private contexts.
- Disabled unless configured; no deployment or real message sends.
- Never forward MCP credentials or log callback secrets.
- Preserve existing workflow replay and channel behavior.
- New tests only for authentication, privacy, and duplicate-side-effect risks.
- Format, lint, typecheck, and execute relevant existing coverage before delivery.

## Tasks

- [x] **1. Durable outbound webhook service.** Add `src/agent/webhooks.ts` and
  focused security tests. Use SQLite atomic admission and dispatch markers;
  encrypted registrations; strict Zod inputs; per-registration revocation/expiry;
  HTTPS allowlisted origins/path prefixes; validated and pinned public DNS
  addresses; HMAC timestamp/event signatures; bounded responses/deadlines.
  Public host API: register/list/get/revoke, enqueue/send, inspect delivery,
  drain pending, close. Identical idempotency keys return existing state; changed
  input fails. Unknown outcomes remain unknown across restart. Add a maintained
  IP parser dependency. Validate URL, DNS, replay, encryption, revocation and
  concurrent duplicate-send cases with disposable fixtures.
- [x] **2. Agent message transport.** Add `src/agent/service.ts`; persist message
  admission in SQLite before forwarding to the shared owner actor. Retrying
  queue admission is safe via stable event IDs. Add `agent` channel in
  `src/core/contracts.ts` and explicit configured identity routing. Poll the
  owner snapshot for message state instead of duplicating conversation history.
  Persist replies in the runtime outbox and enqueue callback delivery before
  reporting local acceptance. Bound message pages and retain exact text.
- [x] **3. June-initiated webhook actions.** Extend `ModelRequest` and
  `CompanionReply` with a structured registered-target action. Extend
  `src/models/provider.ts` and `src/models/codex.ts` schemas and parsing, enabling
  the field only when destinations are available. In `src/runtime/registry.ts`,
  journal destination availability and use a new workflow version for the action
  step. Disallow reactions for agent messages and record webhook receipts in
  model history, without URLs or secrets. Add agent memory provenance in
  `src/main.ts`. Verify existing model/runtime tests and one fixture round trip.
- [x] **4. Authenticated MCP server and startup.** Add
  `src/agent/mcp.ts`, `src/agent/operator.ts`, and strict optional config in
  `src/config.ts`. Mount a stateless official SDK Web Standard transport at
  `/mcp`, authenticate every request, enforce configured Host/Origin, no cookies,
  rate/concurrency/body/result limits, per-client expiry and revocation. Expose
  explicit tool schemas, structured results, bounded polling, named operator
  operations, and callback lifecycle tools. Forward only host-constructed
  internal requests to existing operator handlers; no arbitrary proxy. Wire
  setup, recovery pump, lifecycle and shutdown in `src/main.ts`.
- [x] **5. Integration and documentation.** Run the official MCP client against
  a disposable HTTP instance and fake model/callback receiver. Prove shared
  owner context, single message execution on retries, signed callback, revocation,
  explicit operator confirmations, restart semantics and June-selected delivery.
  Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, and relevant existing tests.
  Update `docs/agent-mcp.md`, configuration examples and README with exact setup,
  owner-level credential risk, receiver verification and Amp integration limits.
  Commit only this work after checks, without pushing or deploying.

## Amp receiver research

Check official Amp API/workflow documentation for a supported endpoint that can
send to an existing thread without plugins. If unavailable, document that fact
and the generic receiving contract; never guess API endpoints or use another
thread/tool as purported webhook verification.

## Verification and delivery

On 2026-09-29, formatting, lint, typechecking, and all 405 tests in 38 files
passed. Existing Rivet shutdown transaction/alarm warnings remain visible.
A disposable real `main.ts` HTTP smoke check with the official MCP client and
fake model passed authentication, separate operator credentials, reply polling,
application/engine restart deduplication, and revocation, with one model call.
Security fixtures cover signed callbacks, SSRF restrictions, revocation,
forgetting, uncertain outcomes, and duplicate delivery prevention.

No real external messages, production configuration, ingress changes, or
deployment were performed. The calling agent supplies its own thread webhook;
June advertises registration through MCP instructions and her agent prompt.
An Amp API integration or new bridge is not a requirement. No live Amp delivery
was tested; the supplied receiver must accept June's documented envelope.
