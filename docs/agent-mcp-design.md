# Owner-trusted agent MCP and outbound webhooks

Status: approved by owner on 2026-09-29. See `agent-mcp.md` for the implemented
configuration, limits, verification scope and remaining Amp receiving dependency.

## Goal and authority

Expose June to authenticated agents for conversation, debugging, and testing.
The owner explicitly wants these agents to have owner-equivalent access,
including shared private conversation context, memory, and available operator
controls. Do not introduce per-agent conversation privacy restrictions or
content censorship. Record the actual agent identity for audit; do not falsely
attribute its messages to a human Slack identity.

All MCP credentials are administrative credentials. They do not authorize a
caller to retrieve raw credentials, change host security policy through a model
prompt, or bypass a disabled integration. Existing confirmations, idempotency
requirements, forgotten-source revocation, and uncertain-worker recovery rules
remain applicable. MCP callers can supply the same explicit confirmations as
the owner; they do not need a separate human approval for each supported call.

## Approach

Use an optional Streamable HTTP MCP server in the existing HTTP host, the
existing durable conversation runtime, and a separate reusable webhook delivery
service. Reuse installed MCP SDK support rather than implementing JSON-RPC.

An Amp-only bridge would couple June to one caller and would not meet the generic
workflow requirement. A new parallel conversation engine would duplicate June's
history, model invocation, and crash-recovery behavior. Neither is needed.

MCP messages enter the owner-private conversation with an explicit agent
transport address. Correlation identifies the initiating client conversation
and message; replies remain available through MCP whether or not a callback
exists. Concurrent messages use June's existing serial turn processing. Agent
conversation identifiers correlate traffic; they are not privacy boundaries.

Preserve replay compatibility for existing Rivet workflows. New transport
behavior must not change the interpretation of previously journaled Slack or
WhatsApp turns. Existing platform adapters and owner routing remain unchanged
except for the explicit new agent transport path.

## MCP tools

- `get_status`: readiness and configured capabilities, without credentials or
  claims that a configured provider has been verified live.
- `send_message`: conversation correlation ID, plain text, and a caller-supplied
  idempotency key. Returns a durable message receipt, not a false claim that a
  model reply is already complete.
- `read_messages`: bounded cursor-based retrieval of messages and replies.
  Owner-private shared context is accessible, not restricted to the caller.
- `get_message`: processing state, response, and associated delivery state.
- `operator_request`: structured access to the explicitly enumerated existing
  operator operations for conversation/job inspection, cancellation/recovery,
  memory, imports, and reflection when configured. Operation names and validated
  arguments select host-owned handlers, never arbitrary URLs, headers, filesystem
  paths, shell commands, or internal engine requests. Preserve each handler's
  validations and confirmations; return unavailable for disabled features.
- `register_webhook`, `list_webhooks`, `get_webhook`, `revoke_webhook`: manage
  persistent callback registrations with a name, destination, subscriptions,
  correlation metadata, expiration, and receiver authentication configuration.
- `send_webhook` and `get_webhook_delivery`: deliberately send a message/event to
  a registered destination and inspect the receipt. Reuse an idempotency key to
  inspect/retry admission without creating another external effect.

The operator surface is deliberately a named operation catalog, not a general
HTTP proxy. Tool discovery must explain confirmations and distinguish accepted,
completed, rejected, and unknown outcomes.

## June-facing behavior

MCP conversations use plain text, with no native reaction or platform-specific
formatting instruction. Do not split a response into multiple platform messages
or censor its contents. Enforce documented resource limits by rejecting oversized
input rather than silently truncating it. Provider limits and refusals still
exist; this interface cannot promise to remove provider policy.

June can select a registered webhook by its opaque ID and supply a message plus
correlation metadata through a structured model action. Resolve destinations and
credentials in the host, never in model-generated request headers or URLs.
Expose only active destination descriptions to June. An automatic reply callback
and an intentional new outbound message are distinct events with distinct IDs.

Expose the same enqueue/delivery API to host workflows. This work supplies an
outbound action usable by workflows; it does not introduce a new dynamic workflow
definition language, arbitrary-code execution, or a new scheduler.

## Authentication and exposure

The MCP server is absent unless explicitly configured. Initially support
operator-provisioned, high-entropy per-client bearer credentials, separate from
the existing operator token. Keep configuration as secret references, not raw
tokens. Authenticate every HTTP request, bind identity server-side, reject
unconfigured browser origins and unexpected hosts, and do not treat session or
conversation IDs as authentication. Client tokens cannot be forwarded downstream.

Support individual credential expiry and revocation. Revocation blocks new
requests and pending callbacks owned by that credential; it cannot recall
already-dispatched messages or previously disclosed data. Audit client identity,
operation IDs, and outcomes without logging request text, tokens, or callback
secrets. Full owner access means a stolen valid credential can disclose private
history and exercise owner controls until revoked; transport security does not
eliminate this risk.

Production exposure requires HTTPS through an explicitly configured ingress,
with only the MCP route published. Keep operator, console, and Rivet control-plane
routes private. Apply bounded request bodies, response pages, concurrency, and
per-client request rates, plus a global unauthenticated request limit. Deployment
and public ingress changes are separate authorized operations, not local setup.

## Callback security

Registration is dynamic within an operator-configured destination policy. Allow
HTTPS endpoints only, with normal certificate verification, and reject URL
userinfo and fragments. Secret-bearing URLs, if required by a receiver, must be
handled as credentials and never returned in list results or logged.

Require approved origins, and restrict paths where an origin hosts multiple
services. Reject redirects. Validate resolved addresses against private,
loopback, link-local, multicast, and metadata ranges and ensure the actual
connection uses the validated resolution; a lookup followed by an ordinary
unconstrained fetch is insufficient against DNS rebinding. Do not allow callers
to bypass these controls with a per-request flag. Prefer a maintained IP parser
and an explicit connection policy over hand-written IP classification.

Generic callbacks use a versioned JSON envelope containing event ID, type,
timestamp, conversation/message correlation, and payload. Sign the exact request
bytes with a callback-specific HMAC key and include a timestamp. Return a newly
generated signing key only during registration. Receivers must verify signatures,
enforce a timestamp window, and persist event IDs before performing effects.
Store callback secrets encrypted using a separately provisioned host key, outside
conversation histories and model prompts. Rotation and registration expiration
must be explicit.

Some existing receiving services require their own authentication and payload.
Support host-owned delivery profiles for such integrations rather than arbitrary
model-generated templates or unrestricted headers. The first implementation
provides the generic signed JSON contract. Add an Amp-specific profile only once
its supported receiving API and authentication are verified; do not invent one.

## Durability and failures

Persist registrations, messages, delivery intent, and receipts. Bind each
idempotency key to the full canonical request and reject reuse with different
contents. Admission is durable before acknowledging success. Registration
revocation and expiration are rechecked immediately before dispatch.

Delivery states distinguish queued, dispatching, accepted, rejected, and unknown.
Persist dispatch intent before network I/O. A timeout, crash, or disconnected
response after possible dispatch is unknown, not safely retryable. Do not
automatically send again in that state. Generic HTTP failures do not prove the
receiver performed no effect. Polling still exposes June's original reply even
if callback delivery is unknown or fails.

Use bounded network timeouts and response reads. Do not store or expose arbitrary
callback response bodies. A successful HTTP response means receiver acceptance,
not completion of an Amp turn or any downstream workflow. No exactly-once delivery
claim: receiver-side idempotency is necessary, and automatic uncertain retries
are outside this initial contract.

## Verification and delivery

Follow the repository's minimal-test policy. New automated tests protect core
authentication/authority, secret isolation, SSRF defenses, idempotency, and crash
boundaries preventing duplicate external effects. Use existing runtime coverage
and focused local checks for ordinary tools and model behavior.

Exercise the official MCP client against a disposable local instance: handshake,
tool discovery, owner-context messaging, polling, callback registration, signed
delivery, revocation, and a structured June-initiated callback. Check operator
confirmations and disabled integrations. Use fake model and HTTP boundaries, not
production credentials, for failure and restart cases. Run formatter, linter,
typechecker, and relevant existing tests; preserve concurrent worktree changes.

Document configuration and client setup, callback verification and deduplication,
recovery of unknown outcomes, and the full authority of MCP credentials. Report
local implementation separately from deployed availability and real Amp delivery.
Live Amp validation requires a documented supported receiving endpoint and an
explicitly authorized real call. Generic webhook success alone does not establish
that Amp can receive it without a plugin.
