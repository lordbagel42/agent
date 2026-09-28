# Warm-standby Deployment Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Keep implementation and verification in this worktree.

**Goal:** Preserve healthy June during candidate preparation and durably accept Slack events during exclusive runtime handoff.

**Architecture:** Extend the existing independent Slack responder with opt-in durable intake rather than introduce another public service. Prepare a candidate on the inactive blue/green port, behind a startup barrier that precedes all live-state access. A controller-controlled handoff and inherited kernel file lock prevent overlapping active runtimes.

**Tech Stack:** TypeScript, Hono, Python standard library, SQLite, Linux flock and systemd.

**Spec:** `docs/superpowers/specs/2026-09-28-blue-green-deployment-design.md`.

## Execution record — 2026-09-28

Tasks 1–3 and Task 4's documentation, implementation, verification and review
are complete. The checklist below preserves the original plan; this execution
record is the current status. Publication is the remaining source-delivery step.
Live installation is separate and has not been performed or authorized here.

- Node 24 formatter, linter and typecheck passed; Python Ruff checks passed.
- Controller, responder and runner suites passed (55 Python tests). The final
  focused TypeScript run passed 171 tests, including disposable startup, registry,
  Slack, HTTP, deployment and shared-prompt paths.
- An isolated user/mount/network/PID namespace ran the actual launcher, full June
  and Rivet, plus durable intake against synthetic local providers. It verified
  standby without live writes, competing activation refusal, queued delivery
  across releases and lost-ACK retry with exactly one model call.
- Oracle reviewed the feature, corrections and concurrent-main integration;
  no unresolved blockers remained. Corrections bind `slot.env`, probe actual
  authenticated replay before unpause, and preserve trusted original arrival.
- Concurrent private-listener support was preserved. Intake control may target
  the same existing allowlisted private host as the legacy controller origin;
  app slots and replay remain loopback-only.
- After integrating concurrent Actions preparation, all 66 Python tests and
  27 affected deployment/prompt/startup TypeScript tests passed, with static
  checks and another bounded Oracle merge review. Actions policy pins still
  fail closed and need operator review for the changed preflight script.
- Real target systemd/MainPID/cgroup behavior remains an installation prerequisite,
  not a result claimed by these local fixtures. No live Slack sends, service
  changes, production replay or infrastructure mutations were performed.

## Global constraints

- No live configuration, routing or service mutations in this implementation.
- Preserve the legacy deployment path unless explicitly configured for blue/green.
- Never acknowledge an event before durable acceptance, restore conversation data,
  bypass unsupported drains, or infer settlement from a timeout.
- New tests cover privacy, exclusive ownership and duplicate-side-effect boundaries.
- Review and validate before publishing; installation remains separately authorized.

## Task 1: Durable intake in the existing responder

Files: `scripts/deploy/slack_responder.py`, `scripts/deploy/test_slack_responder.py`.

- [ ] Add optional `durableQueue` configuration with distinct `token`, bounded
  `maxBytes` and `maxEvents`; keep the existing notice behavior when absent.
- [ ] Commit verified raw envelopes plus content type, arrival time and stable
  identity in SQLite before ACK. Use event IDs for callbacks and raw-body hashes
  for interactions. Preserve completed deduplication receipts with bounded retention.
- [ ] Add authenticated `GET/POST /operator/deployment/intake`. POST accepts only
  `{revision, port, paused}` (full SHA, port 3081 or 3082, boolean). Return those
  fields plus `settled`; pause waits for in-flight forwarding, without cancelling it.
  Initial queue state is paused with no target. Persist routing before replying.
- [ ] Forward one queued envelope at a time to the configured loopback slot's
  `/operator/deployment/slack`, with a fresh Slack signature, original content
  type, `x-june-intake-token` and `x-june-received-at`. Confirm matching active
  `/health` revision before forwarding. Delete only on successful durable app ACK.
- [ ] Check invalid signatures/control credentials, delayed delivery, restart,
  lost ACK, capacity, paused intake and in-flight pause settlement using disposable
  SQLite and local HTTP fixtures. No real Slack sends.

## Task 2: Private replay and candidate startup barrier

Files: `src/config.ts`, `src/http/app.ts`, `src/main.ts`, new
`src/deployment/standby.ts`, `scripts/deploy/slot.py`, targeted safety tests.

- [ ] Add optional deployment `intakeTokenEnv` and `blueGreen` configuration.
  Mount replay only with its separate credential; reuse the ordinary Slack
  adapter, audience checks and durable submission handler.
- [ ] Apply standby barrier immediately after parsing config and immutable marker,
  before any live store/actor initialization. Bind fixed blue/green loopback ports
  3081/3082. Private standby status is not active `/health`.
- [ ] `POST /operator/deployment/activate` uses the deployment token and exact
  release revision. Acquire the inherited lock through `/usr/bin/flock` before
  closing standby HTTP and proceeding with live initialization. Hold its original
  descriptor until process exit. Refuse malformed launcher/slot configuration.
- [ ] The installed Python launcher opens a pre-provisioned runtime lock, passes
  its descriptor to directly exec'd Node, and keeps Node as systemd MainPID.
  Do not allow model tools or arbitrary app paths to select the executable.
- [ ] Exercise unauthorized activation, a competing lock holder, standby without
  live-state writes, clean standby stop, and no public timestamp bypass.

## Task 3: Controller and systemd integration

Files: `scripts/deploy/deploy.py`, `scripts/deploy/preflight.sh`, new
`scripts/deploy/june-slot@.service`, `scripts/deploy/test_deploy.py`.

- [ ] Generalize exact service identity and strict stop to the two fixed slot
  units, preserving legacy `june.service` defaults.
- [ ] Add opt-in controller `blueGreen` configuration with loopback intake origin.
  Bind both slot units and installed launcher into runtime identity. Resolve
  each slot to its immutable release and reject ambiguous/current mappings.
- [ ] Persist intent before starting standby. Validate candidate standby while
  old remains ready. Pause intake, drain old, verify stop, then authorize candidate
  activation. Resume forwarding only after candidate readiness and PID identity.
- [ ] Preserve strict rollback compatibility after activation; preparation failures
  never stop old. Unknown standby/activation/stop stays blocked for recovery.
  Reconciliation verifies actual running identity and repairs intake routing only
  under the existing explicit recovery/operator authority.
- [ ] Extend isolated preflight to run existing disposable application startup
  coverage without production credentials. Verify controller fault paths, including
  failed standby, busy drain, failed stop, health failure and crash/reopen.

## Task 4: Operational instructions and integrated verification

Files: `docs/deployment.md`, `src/runtime/prompt.ts`, relevant existing tests.

- [ ] Document opt-in installation prerequisites, durable queue privacy/retention,
  two slot identities, ownership lock provisioning, bootstrap and recovery steps.
  Distinguish supported source, authorized installation and verified live behavior.
- [ ] Update shared June operating knowledge used by interaction, execution and
  automated events. Keep `release.inspect` read-only and existing feed compatible.
- [ ] Run formatting, linting, type checking, existing controller/responder tests,
  focused TypeScript safety tests and disposable startup workflows.
- [ ] Inspect the complete diff, obtain the required stronger-agent review, fix
  findings and rerun affected checks. Record any unavailable real-systemd coverage.
- [ ] Commit the coherent feature and publish according to repository guidance,
  rebasing over concurrent main changes rather than holding other agents' pushes.

## Plan review

The existing responder is the stable intake boundary, not a second new service.
Re-signing is confined to its authenticated private replay path; public Slack
timestamps remain enforced. Both processes may exist, but only the kernel-lock
holder may initialize live state. Isolated startup exercises are not production
replay proof. Queue availability is separate from reply/console availability.
