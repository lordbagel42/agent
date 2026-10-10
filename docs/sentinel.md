# Silent effect sentinel

The host checks selected effects for instructions smuggled through untrusted
content. Guest tasks remain allowed; being a guest is not an injection signal.
Chat and reads do not run the judge. This is a probabilistic veto, not a new
permission system or a guarantee that every injection will be caught.

With a Codex main model, the default judge uses the existing subscription home
and executable, `gpt-6-astra` and `max` reasoning, in a separate hot provider with
two in-flight calls. The pinned 0.157.1 app-server advertises literal `max` for
this model; `ultra` additionally delegates tasks and is not used. Existing
API-key decision adapters remain supported through `sentinel.model`. Missing or
invalid provider configuration is inspectable and does not stop chat startup.

`sentinel.maxWaitMs` defaults to 15000 and accepts 0–60000. Zero is opportunistic:
only a verdict already available at commit can veto. The call starts when the
exact action is known and overlaps remaining preparation; the commit awaits only
the residual budget. A timely answer is independent of provider cleanup, whose
capacity remains reserved until settlement. The cap came from 20 alternating
injected-guest/legitimate-owner fixtures using the real subscription, native
decision schema, and full execution prompts (121207 / 174540 system characters):
p50 11355 ms, p95 13571 ms, all classified correctly. The default adds 1429 ms
above the measured p95; one sample took 15214 ms and would exceed it. Larger
contexts and upstream load can increase fail-open frequency; these are not
production percentiles.

## Covered boundaries

- Amp task inbox publication and coding proposals, including skill proposals.
- MCP tools saved as effects (`approval`), including Slack/GitHub/Amp owner
  connections. Descriptions, catalog/schema pages and returned read bodies are
  transient judge evidence. Tools configured as reads are not gated.
- Configured mutating/credentialed browser recipes, before broker grants.
- Dynamic app preparation and deployment, bound to source digest and access.
- Social outreach, direct/workflow agent webhook send/revoke, settings mutation and applied
  memory-forget previews.

Personality changes, memory backup, raw Rivet reads, DEBUGSHARE dispatch/resolution,
legacy explicit human controls, and other effect families are not covered by this
increment. Existing permission, scope, lifecycle, idempotency and revocation checks
still apply. Add another boundary with a host-supplied `EffectGuard`: construct a
ticket using exact arguments and call `commit()` immediately before committing.
A returned string means withheld, not an approval or permission to reroute.

## Trigger and release

A positive decision persists the exact action, authenticated requester/scope,
source event ID and short evidence-based rationale in a mode-600 SQLite ledger
under a mode-700 `sentinel` directory inside `RIVETKIT_STORAGE_PATH`. No ordinary
verdict or context is persisted there. The ledger survives restarts and
conversation forgetting; it is operator-private, not part of conversation memory.

The owner receives one private Slack notice, with redacted action/rationale
excerpts and `!sentinel-release <UUID>`. Only fresh plain authenticated owner-DM
commands release; quotes, imports, worker claims and shared-channel commands do
not. Release allows one exact requester/scope/address/action-bound retry for ten
minutes, consumed atomically. It never executes anything, changes permissions,
changes the destination or replays an unknown effect. The requester must retry.
The ledger is rechecked at commit so concurrent checks cannot bypass a new veto.
Coding carries only a host-created fingerprint/ledger-version snapshot across
its worker handoff, then rechecks it synchronously before queue dispatch. It does
not consume a released retry twice or journal transient MCP evidence. Existing
completed dispatches are not retroactively checked. Amp's release fingerprint
includes the original request text as well as the generated task brief.

Notifications claim dispatch durably. Confirmed-not-sent retryable rejection
(including Slack 429) receives up to three attempts, respecting retry-after and
surviving restart. Unknown/interrupted sends are never retried. Notification
failure does not release the action. Intact notice copies are excluded from Slack
ingress/context/history imports and MCP result bodies to prevent reinjection.

June can use `inspection:"sentinel"` for configuration, provider health,
process-lifetime counters and recent scoped receipt metadata. Only owner-private
inspection includes redacted action/rationale details. Timeout, capacity, error,
oversized context (512000 characters), and abstention fail open with counters,
not normal notifications, info logs or reply text. Known vetoes remain withheld
even if their receipt/notification fails. The only always-present prompt change
is one host note telling June not to duplicate the check or invent approvals.
