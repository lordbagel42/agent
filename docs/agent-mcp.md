# Owner-trusted agent MCP and callbacks

June can optionally serve an authenticated **Streamable HTTP MCP server at
`/mcp`**. This is separate from the outbound MCP client in `src/tools/mcp.ts`.
It is intended for owner-trusted agents doing debugging, testing, and collaboration.

**Every MCP credential grants owner-equivalent access.** Agents share the owner's
private conversation and can inspect memory and exercise available operator
controls. Client IDs identify callers for audit and revocation, not privacy
isolation. Conversation IDs correlate traffic, not separate private histories.
Protect these credentials as administrative credentials; a stolen valid token
can disclose private information and perform owner operations until revoked.

## Configuration

Inbound MCP is absent by default. Add an `agentMcp` block to the normal configuration;
the existing `mcp` block configures outbound connections and remains separate:

```json
{
  "agentMcp": {
    "origin": "https://june-agents.example.com",
    "directory": "/var/lib/june/agents",
    "keyEnv": "JUNE_AGENT_STORAGE_KEY",
    "clients": {
      "amp-debug": {
        "tokenEnv": "JUNE_AGENT_AMP_TOKEN",
        "expiresAt": 1798761600000
      }
    },
    "destinations": [
      { "origin": "https://receiver.example.com", "pathPrefix": "/june" }
    ]
  }
}
```

Choose your actual origins and a future expiry (epoch milliseconds); the example
expires at 2027-01-01 UTC. `directory` must already exist, be canonical, owned by
the service account, mode `0700`, and outside Git repositories. Run only one June
process per storage directory. Keep database files and backups private.

Provision secrets with your normal secret manager:

- Each client token: at least 32 random bytes encoded as unpadded base64url
  (43–128 URL-safe characters accepted). Never reuse the operator token or another
  client's token. Maximum 32 configured identities.
- `JUNE_AGENT_STORAGE_KEY`: 32 random bytes encoded as standard base64, distinct
  from client credentials. This encrypts webhook URLs, signing keys and payloads
  with AES-256-GCM, and keys message-idempotency digests. Back it up separately.
  Wrong keys fail startup. There is no automatic encryption-key migration.

Clients send `Authorization: Bearer <client-token>` on **every** request. The
server is stateless at the MCP transport layer: no login cookies, OAuth discovery,
session credentials, or persistent GET/SSE stream. It accepts POST with standard
MCP JSON/Accept headers and returns JSON responses. The official SDK client works.

Only publish `/mcp` through an authorized HTTPS ingress; preserve its configured
Host, disable body/Authorization logging, and keep `/operator/*`, `/console/*`
and Rivet ports private. Requests with an unexpected Host or supplied Origin are
rejected. Local testing can use a canonical loopback HTTP origin. Public HTTP
origins are rejected. Deploying ingress or provisioning live credentials is a
separate operator action, not performed by the implementation.

An MCP-only installation may have `owner.identities: []` and no Slack/WhatsApp
config. It still needs normal model configuration and **must not** use setup
mode: setup mode cannot accept messages. Memory/coding/import integrations retain
their existing explicit configuration and host opt-ins.

## Tools and message lifecycle

| Tool | Purpose |
| --- | --- |
| `get_status` | Read readiness and enabled capabilities. |
| `send_message` | Submit `{idempotencyKey, conversationId, text}` to the shared owner conversation. |
| `get_message` | Inspect an admitted message by returned UUID, including reply, local delivery and callback receipts. |
| `read_messages` | Page through shared private history with optional `after` cursor and `limit` (1–50). |
| `operator_request` | Call a named existing owner operation; see below. |
| `query_telemetry` | Page through retained OpenTelemetry spans/logs, inspect an exact trace, or read status/metrics. |
| `register_webhook` | Register a destination, subscriptions, expiration and correlation ID. |
| `list_webhooks`, `get_webhook`, `revoke_webhook` | Inspect metadata or revoke a callback. URLs and signing keys are not listed. |
| `send_webhook` | Durably queue a signed event for a registered callback. |
| `get_webhook_delivery` | Inspect accepted, rejected, queued or unknown delivery by UUID. |
| `list_clients`, `revoke_client` | Inspect or permanently revoke a configured client ID. |
| `read_audit` | Read content-free tool attempts/outcomes, 100 records after a sequence cursor. |

Reuse the **same UUID idempotency key and exact input** when retrying a message.
Reusing the key with different input fails. A lost queue acknowledgement may
requeue the same immutable event; the conversation runtime deduplicates it.
Admission survives process restart. It never launches a replacement paid model
call merely because an earlier invocation's result is uncertain.

`send_message` returns `{id, accepted:true}`, not a completed reply. Poll
`get_message` or subscribe a callback to `reply`. `processing_or_interrupted`
means the system cannot yet distinguish active work from interrupted work;
`uncertain` is not permission to resubmit under a new key. Inspect the existing
operator state before deciding on a new action. `completed` describes processing,
not successful external callback delivery. Check each callback's own receipt.

Agent text is not split, censored, or rendered as Slack markup. Input and model
output are limited to 32,000 JavaScript string units. Reactions are unavailable.
Oversized inputs fail rather than being silently truncated. Providers still have
their own output/token limits and refusal behavior. June can intentionally remain
silent; that is represented explicitly in history. Working history can be reset
by forgetting, so a removed pagination cursor returns `cursor_expired`.

Tool results have `{result: ...}` structured content and an equivalent text block.
Tool failures set `isError`. An operator result also includes its HTTP `status`:
inspect that status before claiming an operation succeeded.

## Owner operations

`operator_request` takes an `operation`, optional path `id`, optional
`idempotencyKey`, optional memory search `query`, and optional JSON `body`.
Only this closed catalog is supported, not arbitrary HTTP requests:

- `conversation`, `slack_ingress`, `latency`, `logs`, `wakeups`, `deployment_events`,
  `console_login_link`, `agents`, `revoke_agent`, `reconcile_browser`.
- `capabilities`, `capability_audit`, `propose_capability`, `grant_capability`,
  `revoke_capability`, `cancel_capability`, `reconcile_capability`,
  `execute_capability`, `capability_receipt`, `capability_link`, `revoke_capability_link`.
- `job`, `job_diff`, `resume_job`, `cancel_job`.
- `memory`, `review_memory`, `forget_memory`, `revise_personality`,
  `rollback_personality`, `memory_tombstones`, `memory_backup_status`,
  `backup_memory`, `validate_memory_restore`.
- `imports`, `start_import`, `cancel_import`, `import_extraction`,
  `start_import_extraction`, `cancel_import_extraction`.
- `reflection`, `enqueue_reflection`, `cancel_reflection`,
  `reflection_candidate`, `reconcile_reflection`.
- `telemetry` (read-only POST; its `body` is the same query as `query_telemetry`).

For traces, call `query_telemetry` with `{"view":"traces","limit":10}`, then
follow an observed `traceId` or paginate with `before: nextBefore`. Other views
are `status`, `logs` and `metrics`; filters include exact `name`, `status`, and
`since`/`until` epoch milliseconds. Read `status` for retention and recording/export
failures. These are June's locally retained records, not remote collector queries.
Unfinished spans may be interrupted; a returned callback is not evidence of a
successful effect. Keep results owner-private and inspect authoritative receipts
before considering any retry. See [OpenTelemetry](usage.md#opentelemetry) for
coverage, privacy, retention and optional OTLP export configuration.

Bodies follow the existing operator API documented in the README. For example,
`resume_job` requires the full job ID, a UUID idempotency key and
`body: {confirmedStopped:true}`; `forget_memory` requires
`body: {sourceId, confirmed:true}`. Import start needs the reviewed digest and
expected page count. Disabled integrations return unavailable, not implicit
activation. Coding approval can be sent through `send_message` as the existing
`/approve <job-id>` command. Confirmation is an explicit assertion by the trusted
agent, not a requirement for another human approval dialog. Do not assert a
worker has stopped without checking it.

## Webhook registration and delivery

Example `register_webhook` input:

```json
{
  "idempotencyKey": "1596e868-7985-439a-bd80-a23b44161e81",
  "name": "Amp thread callback",
  "url": "https://receiver.example.com/june/thread-callback",
  "expiresAt": 1790812800000,
  "events": ["reply", "message"],
  "conversationId": "my-thread-correlation"
}
```

Replace the example expiry (2026-10-01 UTC) with one in the future and at most
90 days away. `reply`
subscribes to replies to MCP messages; optional `conversationId` filters these
replies. Omitting it subscribes to all MCP replies in the shared owner context.
`message` permits deliberate sends from June or MCP tools; its correlation ID
is included in the envelope but does not hide the destination from June in other
private conversations. Other platforms' ordinary replies are not automatically
broadcast to these callbacks.

Only operator-allowlisted HTTPS origins/path subtrees are accepted. Paths use
segment boundaries (`/june` does not allow `/junebug`); encoded/semicolon paths,
userinfo, fragments, and redirects are rejected. Query strings are supported for
receivers that need capability URLs, but the whole URL is encrypted and omitted
from inspection. DNS is checked for public addresses and pinned for the actual
TLS connection. Private, loopback, link-local, multicast, mapped-private IPv6,
and other nonpublic ranges are denied. Callers cannot override this policy.

The first registration returns an additional `signingKey` (base64url). Store it
securely at the receiver. An identical retry returns the registration but **not**
the key. If that first response was lost, revoke the registration and create a new
one. Rotate by creating a replacement registration and revoking the old one.

`send_webhook` accepts `{idempotencyKey, webhookId, type, payload}`. `type` is
`message` or `reply`; custom event data belongs in the JSON `payload` object.
The host API uses the same `WebhookService.enqueue()` method, enabling workflow
integration without a new workflow engine. `drain()` processes pending work;
June's host runs a recovery/delivery pump every second. The interaction model
delegates callback work to an execution worker, which can select
`{agentWebhook: {action: "send", id, text}}`. The capability also supports `list`,
`delivery` and `revoke`; authored workflows use `agent_webhook` with the same
action schema. Sends require a registered destination and fresh authorized
private event. Notification-only and synthesis turns do not grant this capability.
June cannot generate destinations, credentials, or request headers. Queued work
retains the initiating client's identity, including when using another client's
registration, so revocation stops pending effects.

Receivers get one POST with this envelope:

```json
{
  "version": 1,
  "id": "stable-delivery-uuid",
  "time": 1790686800000,
  "type": "message",
  "conversationId": "my-thread-correlation",
  "payload": { "text": "A message from June" }
}
```

Automatic `reply` payloads include `messageId`, `conversationId`, and `text`.
June-selected `message` payloads contain `text`; workflow/MCP callers may provide
other bounded JSON fields. Receiver authentication is the generic HMAC contract,
not arbitrary caller-selected headers or provider-specific templates.

Headers:

- `X-June-Event-Id`: matches envelope `id`.
- `X-June-Timestamp`: decimal Unix seconds at dispatch.
- `X-June-Signature`: `v1=` followed by lowercase hex HMAC-SHA256, using the
  **base64url-decoded signing key**, over UTF-8 timestamp, a literal `.`, and the
  **exact raw request body bytes** (not parsed/re-serialized JSON).

Verify the signature with a timing-safe comparison, reject timestamps outside a
short window such as ±5 minutes, check the header event ID matches the body, and
durably deduplicate event IDs before downstream effects. Bind each receiver URL
to its intended target; never trust payload text to choose an arbitrary Amp thread
or command. Return 2xx only after durable acceptance, not just after parsing.

Delivery is conservative: queued → dispatching → accepted/rejected/unknown.
Intent is persisted before network I/O. Timeouts, non-2xx responses, crashes after
dispatch, and oversized responses are **unknown**, never automatically retried.
They may already have caused an external effect. Even a 2xx response establishes
only receiver acceptance, not that an agent turn completed. Inspect both sides
before deliberately creating a new delivery. No exactly-once guarantee is made.

Revocation, expiry and current destination policy are checked again immediately
before dispatch, after DNS resolution. Forgetting memory conservatively cancels
all still-queued callbacks before tombstoning context. Already dispatched effects
cannot be recalled; encrypted old outbox records, actor journals and backups are
not physically purged by forgetting.

## Limits and operations

- MCP: 128 KiB request body; 512 KiB result before its duplicate text encoding;
  120 requests/minute/client, 600/minute globally, four active/client and 16 total.
- Webhooks: 10-second DNS-through-response deadline, 16 KiB response-body cap;
  response bodies are neither stored nor exposed.
- Payloads: 64 KiB JSON, depth 16 and 4,096 nodes.
- Lifetime storage caps: 256 registrations, 4,096 webhook deliveries and 4,096
  message admissions, including revoked/deduplication records. Exhaustion rejects
  new admission. There is no automatic eviction that could resurrect old effects.
- Audit: last 10,000 tool attempts/outcomes; identities/operation names only,
  not arguments, message text, bearer tokens, or callback secrets.

These conservative lifetime caps are appropriate for the initial owner/debugging
rollout, not an unbounded event bus. Before exhaustion, reconcile pending/unknown
effects and plan archival/retention. Do not delete deduplication state and retry
old keys; backup rollback also risks repeating effects. Message admissions are
stored on private disk until queue acknowledgement; private conversation text
and Rivet journals are not encrypted by the webhook key. Use encrypted storage
and protected backups for the full host.

`revoke_client` requires `{id, confirmed:true}` and persists across restart.
It also prevents future dispatch of that client's registrations/deliveries.
Reissue a new client ID; do not try to resurrect a revoked ID. Provision token
changes through host configuration and restart. Never reuse an ID for a different
principal. The existing private operator token can inspect `/operator/agents`
and POST `/operator/agents/:id/revoke` with `{confirmed:true}` if MCP access is lost.
Revocation cannot undo disclosures or operations already started.

## Agent-provided thread webhooks

The calling agent owns creation of its thread webhook. June accepts the resulting
URL through `register_webhook`; she does not need to create an Amp webhook,
integrate with Amp's messaging API, or require a new bridge.

MCP connection instructions and the `send_message` description advertise this
option. June's agent prompt also tells her to suggest registration when arranging
future notifications, including when no callback is registered yet.

1. Generate a webhook for the calling thread using that agent's available tools.
2. Register its HTTPS URL with `events: ["reply", "message"]` and a future expiry.
3. Match `conversationId` to `send_message` to scope automatic replies.
4. June can send subsequent notifications to the registered destination.

The receiver origin/path must be in the host destination policy. The generated
webhook must accept the signed JSON envelope documented above, with message text
in `payload.text`; verify its receiving contract rather than assuming any URL
accepts any payload. Capability URLs stay encrypted and out of model context.
No live Amp thread webhook was supplied or tested during implementation.

## Verification scope

Security tests exercise administrative authentication, shared owner context,
unchanged confirmation requirements, idempotency across restart/concurrent calls,
credential revocation, encrypted webhook secrets, destination policy/DNS pinning,
signatures and uncertain dispatch. A real Rivet fixture exercises automatic
replies and workflow-selected callbacks with a fake model and transport, with
activity sessions both enabled and disabled. Session-mode polling reads bounded,
deletion-filtered activity projections rather than the legacy conversation log.
The pre-rebase disposable `main.ts` HTTP/official MCP-client smoke check verified
application and engine restart without repeated model invocation; that host-level
check has not been repeated on the new base. No production credentials, public
TLS ingress, real model calls, or live Amp callbacks were used.
