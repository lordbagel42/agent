# June warm-standby deployment

Status: proposed implementation contract; not implemented or enabled.

## Goal and availability promise

Keep the currently healthy June running while a candidate builds and undergoes
startup validation. A preparation failure must not stop or fence the old process.
Keep Slack event intake available during the final, exclusive runtime handoff.
Responses may be delayed while queued events wait for activation. This is not a
promise of uninterrupted model execution, console availability, or correctness of
arbitrary new code.

The owner approved this direction in
[the design thread](https://ampcode.com/threads/T-01a0e7e4-3140-742b-8bc1-6e19fcac42d5).
Live installation, routing changes and service changes require separate operator
authorization. Publishing application code does not install the controller.

## Current behavior

`scripts/deploy/deploy.py` already prepares immutable releases before draining
June. Its activation path stops `june.service`, switches `current`, starts the
candidate, and only then checks readiness and actual process identity. A failed
candidate cannot be rolled back across an unproven state contract.

`src/http/app.ts` rejects new requests while the lifecycle fence is held.
`src/main.ts` starts the registry and recovers authored workflows before opening
the HTTP listener. Consequently, launching a second ordinary June against the
same state is not a safe startup check or standby implementation.

## Chosen architecture

Use a stable durable Slack intake service, a side-effect-free candidate standby,
and an exclusive application-runtime handoff. Do not use two simultaneously
active June runtimes, and do not copy production conversation state to make an
incompatible rollback appear safe.

### Stable intake

Keep the public Slack POST endpoint in a small separately managed service that
does not restart for ordinary June releases. Verify Slack signatures and their
timestamp window when receiving events, before committing the bounded raw
envelope to a private durable queue. Acknowledge only after durable acceptance;
reject invalid input, and return a retryable failure when storage is unavailable
or its configured capacity is exhausted. Handle Slack URL challenges without
enqueuing them. Do not log message bodies or credentials.

The active June receives queued envelopes over an authenticated private path.
Preserve their original identity, audience and arrival metadata. The private
path trusts authenticated intake verification, not an expired public signature;
it must never weaken timestamp verification on the public endpoint. Existing
workspace, owner, event normalization and disclosure checks still apply.

Delivery is at least once. Remove a queue entry only after June confirms durable
inbox acceptance. Lost acknowledgments must reuse the same event identity and
existing inbox deduplication, not repeat model or Slack effects. Do not introduce
a queue lease whose expiry could authorize two application runtimes. Pause
forwarding during handoff while continuing durable public intake.

### Candidate validation and standby

Retain immutable artifact verification, resource limits, configuration binding,
formatting, type checks and existing safety checks. Add an isolated startup
exercise using disposable state, synthetic inputs and no production send/model
credentials. It checks module loading, initialization and shutdown, but does not
claim to prove production workflow replay or external provider availability.

The candidate's production standby mode must be selected before opening live
stores, creating actors, recovering workflows, starting schedulers, connecting
channels or launching workers. It may load and validate configuration and code,
then expose only a private standby-status/activation surface. Standby readiness
is distinct from active readiness. An HTTP server returning 200 is insufficient
evidence of safe standby or successful activation.

Activation is authenticated and bound to the exact immutable revision and
controller attempt. The candidate acquires exclusive runtime ownership before
opening any live state or enabling effects. The old process must have completed
the existing proven drain and strict stop before that ownership transfers.
There is no timeout-based takeover of unknown work.

### Cutover and failure handling

1. Build, seal, startup-check and prepare standby while old June remains active.
2. Persist cutover intent, pause queue forwarding, and request old June's drain.
   A busy/unsupported drain resumes forwarding and admission without stopping it.
3. Revalidate artifacts, identities, bindings and ownership. Strictly stop the
   drained old runtime; uncertain stop evidence blocks activation.
4. Persist the activation boundary before allowing the candidate to open live
   state. Start its active runtime and verify revision, process identity, workflow
   readiness and private intake acceptance before resuming queue forwarding.
5. Record success and retain the prior immutable release under existing cleanup
   policy. Standby/candidate cleanup must never target the active process.

Preparation/standby failures leave the old runtime untouched. Before candidate
activation is authorized, recovery can restart the unchanged old runtime after
a proven stop. Once activation may have opened live state, preserve today's
compatibility rules: rollback requires independent compatibility evidence and
candidate quiescence. Otherwise retain queued intake and request forward recovery.
An unknown activation response is not permission to repeat activation or assume
the candidate never touched state.

Persist intent and phase transitions in controller SQLite. On restart, identify
the exact application/standby invocations and queue-forwarding state. Ambiguous
operations retain the existing recovery/operator ownership fence. Never infer
ownership or successful activation from a symlink, port, stale health receipt,
expired lease or missing process alone.

## Compatibility and rollout

Keep the feature disabled until its intake service, private credentials, runtime
ownership mechanism and service topology have been installed and verified in an
authorized operator window. Preserve the legacy single-service path for existing
installations. Do not remove the current coding/reflection/WhatsApp drain gates
as part of this change; unsupported configurations defer rather than risk overlap.

Expose bounded phase/failure evidence through the existing owner-authorized
release inspection interface. Update June's actual interaction, execution and
automated-event instructions: she can inspect observed deployment progress but
must not duplicate controller work, claim standby is active, or infer live
enablement from source support. Keep new feed fields backward-compatible or
explicitly gated for older readers.

## Verification and acceptance

Use focused tests for core safety boundaries: rejected unauthenticated replay,
durable-before-ack intake, deduplication after a lost acknowledgment, no live-state
access/effects in standby, and refusal of overlapping runtime ownership. Exercise
controller crash/reopen at each cutover boundary and failed startup/drain/stop/
readiness paths using disposable processes and state. Assert that preparation
failure leaves the old process serving and that events accepted during handoff
are eventually delivered without duplicated effects.

Run project formatting, linting, type checking and relevant existing deployment,
lifecycle, routing and delivery checks. Validate the service/locking behavior with
disposable real-systemd units before claiming host-level handoff correctness.
Production enablement additionally requires capacity verification for old June,
candidate preparation/standby and intake together, plus an authorized live
cutover observation. Local fixtures alone cannot establish zero-downtime live
behavior.
