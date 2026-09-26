# June

One personal companion across platforms, with separate execution workers. June
uses she/her pronouns; her personality is meant to develop with her owner.

**Status: running in the homelab with Slack DMs, conversational replies, and native
reactions. A signed webhook → real model → Slack reply smoke test is verified.
Search permissions are pending; coding remains disabled. Not production-hardened.**
TypeScript, Node 24, Rivet actors and journaled workflows. No Temporal and no
custom workflow engine. See the [architecture](docs/architecture.md) for
the evidence graph, Git memory, personality, dreaming, and later capabilities.

Slack is the active rollout target. WhatsApp is shelved at the owner's request;
its existing adapter is not configured in the startup examples or deployment.
Linq's Android/RCS support is being evaluated as its replacement, not yet wired
into June or tested with a real account.

## What works in this increment

- Slack DMs and mentions, WhatsApp Cloud API text, and native reactions. Webhooks
  are verified before accepting events; unknown identities and bots are ignored.
- Linked owner DMs share history. Public Slack threads have separate context and
  cannot access private history or approve coding tasks.
- Durable inbox, serial turns, event deduplication, and a persisted outbox.
  Ambiguous sends are recorded as unknown, not automatically repeated.
- OpenAI **Responses API** and Anthropic **Messages API**, including explicit
  custom base URLs. The provider must support the adapter's structured JSON
  output format. Arbitrary chat-completions endpoints are not interchangeable.
- ChatGPT subscription access through the pinned official Codex CLI, with a
  dedicated login directory and the normal browser OAuth callback flow.
- Separate, approval-gated Amp jobs, saved thread IDs, and explicit recovery of
  uncertain runs. June reports worker results as reported, not verified.
- Headless configuration, health check, and bearer-protected inspection API.
- Optional owner-private, read-only browser console using the existing operator
  credential. It cannot approve actions or change configuration.

June can reply with text, a native reaction, both, or intentional silence. A light
acknowledgment no longer forces an extra text message. Delivery history records
what the platform accepted, including uncertain or rejected reactions.

Incoming reactions and delivery receipts are recorded; they do not trigger an
LLM turn yet. Images, attachments, voice, WhatsApp templates, proactive schedules,
historical imports, long-term memory, Claude subscription auth, Bitwarden, MCP, browser
use, self-deployment, and configuration changes from the console are **not implemented**
in the runnable host.

## Local startup

Use Linux with Node 24 and pnpm 10.33.0. `.npmrc` selects the pinned Node runtime
when using pnpm. The initial dependency installation may download platform-native
Rivet binaries; no cloud account or Postgres server is required for development.

```sh
pnpm install --frozen-lockfile
cp config.example.json config.local.json
cp .env.example .env
```

Edit the private copies. Replace all example IDs, set a supported model ID, and
supply credentials through your normal secret mechanism. The operator token must
be random and at least 32 characters. Config stores **environment variable names**,
not secret values. Remove a channel's config block and identity if not using it.

```sh
pnpm check
pnpm start
```

The HTTP server defaults to loopback port **3080**. `/health` returns readiness.
Only publish `/webhooks/slack` and `/webhooks/whatsapp` through an HTTPS reverse
proxy. Keep `/operator/*`, Rivet's engine/peer/metrics ports, and its inspector
private. Do not use a preview portal to expose the engine or operator API.

With no `RIVET_ENDPOINT`/`RIVET_ENGINE`, June starts a loopback engine at port 6420
(peer 6421, metrics 6430), storing data under `.data/.rivetkit`. Choose an unused
`RIVET_RUN_ENGINE_PORT` if needed; peer and metrics ports also change. The engine
is a separate process and remains running when June stops, for reuse. Do not run
multiple different June instances against the same default namespace/pool.

For a separately managed engine, set `RIVET_ENDPOINT`, `RIVET_TOKEN`,
`RIVET_NAMESPACE`, and `RIVET_POOL` for that engine's existing configuration.
Back up the engine's actual persistent data directory, not just this checkout.
This prototype does not encrypt stored conversation data or implement retention,
deletion, migrations, or backups. Use filesystem permissions and encrypted storage;
do not load sensitive historical accounts into this increment.

## ChatGPT subscription and initial setup

Set `model` to the following instead of an API provider. No model API key is
needed; the rest of June's operator/channel authentication remains unchanged.

```json
{
  "protocol": "codex",
  "model": "gpt-6-astra",
  "home": "/var/lib/june/.codex",
  "executable": "/opt/june/current/node_modules/.bin/codex"
}
```

Choose absolute paths for the actual installation. Authenticate the dedicated
service account with `CODEX_HOME` set to that same directory and `codex login`.
Use the normal browser callback; **do not use device-code authentication**. On a
headless host, forward the browser computer's `127.0.0.1:1455` to the service
host's `127.0.0.1:1455` over SSH before opening the authorization URL. Codex owns
token storage and renewal; June neither imports other accounts' credentials nor
implements private ChatGPT endpoints. See [OpenAI's auth documentation](https://developers.openai.com/codex/auth/).

The adapter uses ephemeral generations, an empty temporary workspace, read-only
sandboxing, no automatic approvals, and disabled shell/browser/MCP configuration.
It rejects substantive tool events and validates the final JSON. These controls
are not a claim that Codex exposes a strict zero-tool mode or an OS security
boundary. The companion model does not replace the separately approved Amp worker.

For initial provisioning without channel credentials, set `setupMode: true`,
remove `slack` and `whatsapp`, set `owner.identities` to `[]`, and keep coding
disabled. This runs the private health/operator service only; it cannot receive
messages or invoke the model. `/health` checks the runtime, **not** ChatGPT login.
Disable setup mode when adding real channel credentials and verified identities.

The initial `pulumi-homelab` deployment uses `lxcs/june`: unprivileged LXC 215 on
optiplex, private HTTP port 3080, root-owned releases, and a non-root systemd
service. Its Codex/Rivet data lives outside the releases under `/var/lib/june`.
Only POST requests to `https://june-slack.bagelindustries.com/webhooks/slack` are
publicly routed; June verifies Slack signatures before accepting them. Health,
operator, and engine endpoints remain private. The homelab service stops its
entire cgroup, including Rivet's detached engine, on restart; that differs from
plain local `pnpm start`.

## Platform configuration

**Slack:** create/install a bot, enable Event Subscriptions and its App Home
Messages tab, and configure the public HTTPS `/webhooks/slack` URL. Subscribe to
`message.im`, `app_mention`, `reaction_added`, and `reaction_removed`; grant bot
scopes `im:history`, `app_mentions:read`, `chat:write`, `reactions:read`, and
`reactions:write`. Supply its signing secret, bot token, workspace ID, and bot
user ID. The owner's allowlist uses the **human user's** ID, not the bot's.
Public-channel interaction currently requires a mention; replies stay threaded.

### Optional Slack Real-time Search (RTS)

RTS is `assistant.search.context`, not the legacy RTM transport. The existing
signed Events API still delivers messages. To enable search, add and approve the
bot scope `search:read.public`, reinstall the app if Slack requires it, and set
`slack.searchEnabled: true`. It defaults to false and normal chat does not need it.
The deployed app's current grant lacks this scope; search is not live yet. The
adapter/model/runtime integration is tested locally; the live release contains
the disabled transport but not the model/runtime integration yet.

The app manifest also requests user scopes `search:read.public`,
`search:read.private`, and `search:read.im` for planned private-channel and DM
search. The updated manifest was synced and an app approval request submitted on
2026-09-26. Admin approval is not a user OAuth grant: verify the consenting user,
workspace, and actual granted scopes before enabling a future private-search
integration. Never use Slack CLI management credentials as runtime credentials.

When asked to find something in Slack, June may request one bounded search for
the current message. Slack's per-message `action_token` stays in a bounded,
short-lived process-local cache and is consumed once. A restart or expired grant
requires a fresh message; there is no background retry or history scraping.

The first integration searches public messages only and sends escaped snippets
with source links directly to the same conversation. It does **not** send the
retrieved content to the conversational model or retain it in history, durable
outbox payloads, workflow results, logs, or memory. Only delivery metadata is
durable; interrupted sends remain unknown rather than being repeated. This
deliberately follows Slack's no-storage policy. Private-channel/DM search needs
separate user consent and is not implemented.

See Slack's [RTS guide](https://docs.slack.dev/apis/web-api/real-time-search-api)
and [method reference](https://docs.slack.dev/reference/methods/assistant.search.context).

**Linq (experimental):** the [Partner API V3](https://docs.linqapp.com/channel/imessage/)
supports iMessage, RCS, and SMS despite the documentation's `imessage` path.
Its documented `preferred_service: "RCS"` uses RCS with SMS fallback, not iMessage.
An isolated, offline text/webhook prototype has been checked; it is not a
production adapter. Actual line provisioning, carrier support, webhooks, and
reactions require account-specific validation. Do not add a `linq` config block
yet; the runtime does not register that channel.

**WhatsApp (shelved):** retained implementation notes only; do not provision an
account for the current rollout. This is a **Business Platform Cloud API** adapter, not
pairing to your personal WhatsApp account. Section 4.7 of
[Meta's terms](https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform),
updated September 23, 2026 and reviewed September 26, restricts general-purpose
AI assistants when AI is their primary functionality, with country-specific
exceptions. See the linked [AI-provider policy](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers).
Confirm June's actual account/region eligibility **before deploying or buying a
number**; implementing the protocol does not establish permission to use it.

For an eligible setup, configure a Meta app and business phone number, subscribe
its `messages` webhooks at `/webhooks/whatsapp`, and choose a private verification
token. Supply the app secret, access token, phone-number ID, and a supported Graph
API version. Allowlist the owner's WhatsApp sender ID (international digits).
Only user-initiated free-form conversations are supported; sending at or beyond
24 hours from the last incoming user message is rejected locally. Business-initiated
templates and personal-account bridges need separate implementations and policy review.

## Coding and operator access

Coding is disabled by default. Enabling it requires both `coding.enabled: true`
with named, absolute workspace paths and `JUNE_ALLOW_NATIVE_CODING=1`. Amp must be
installed/authenticated on that dedicated host using its supported setup.

**Native execution is not a sandbox.** The workspace list and worker prompt are
not filesystem or network isolation. Amp can inherit host access and credentials;
do not enable it on a shared machine with resources it must not touch. This
increment does not enforce a separate credential broker or deployment policy.

Ask June privately for a coding task. She returns the scope and an
`/approve <job-prefix>` command; approval is for local work, not push/deployment.
After an uncertain result, first inspect the saved Amp thread and workspace and
confirm the old worker is no longer running. Only then send
`/resume-stopped <job-prefix>`. Do not resume a job with an unknown live worker.
If no thread ID was saved, manual investigation is required.

Private operator endpoints require `Authorization: Bearer <operator-token>`:

- `GET /operator/conversation`: history, events, outbox, and coding proposals.
- `GET /operator/jobs/<full-job-id>`: job state, saved thread ID, and report.
- `POST /operator/jobs/<full-job-id>/resume`: JSON `{"confirmedStopped":true}`
  and a UUID `Idempotency-Key` header. Reuse the same key when retrying a request;
  a new deliberate attempt needs a new key. HTTP 202 means queued, not completed.

There is no automatic resend endpoint for unknown delivery outcomes. Inspect the
platform before taking a new action. A delivery marked `sent` means the provider
accepted it, not that the human read it.

### Private read-only console

The console is absent unless configuration explicitly includes a fixed browser
origin, for example:

```json
"console": { "origin": "http://127.0.0.1:3080" }
```

Use an authenticated SSH tunnel from your computer to the existing private HTTP
listener. Keep the forwarding socket on loopback; use the actual service address,
not an assumed loopback listener on the remote host. For the existing homelab
listener, the forwarding shape is:

```sh
ssh -N -L 127.0.0.1:3080:192.168.0.215:3080 <authorized-ssh-host>
```

Open `http://127.0.0.1:3080/console/session/login` on that computer. The hostname
and port must match the configured origin. Enter the existing operator token
through the password form, not a URL. An explicitly configured private HTTPS
origin is also supported. Non-loopback HTTP origins are rejected. Never publish
`/console`, `/console/session/*` or `/operator/*` through the Slack proxy, a
development portal, or any public ingress. Disable access/body logging for these
private routes, and do not place untrusted content on the same origin.

The server exchanges the token for a 15-minute HttpOnly, SameSite=Strict session;
HTTPS cookies are Secure. Restarting the host revokes sessions. Login POSTs are
limited to ten per minute across this owner-only host. Sign out at
`/console/session/logout`. Browser cookies authorize only the console, not the
Bearer-only operator API. Existing operator clients are unchanged.

The overview shows selected configuration facts, content-free Slack ingress
counts, durable event counts, capability gates and saved proposal counts. It
does not show credentials, conversation text, job goals/reports, provider paths,
or infer provider health from configuration. Unconnected memory, reflection,
approval and revocation sections remain unavailable. No action callbacks or
opaque-link routes are mounted; viewing the page cannot approve or run work.

Enabling this surface does not migrate state, enable providers or grant deployment
authority. To roll back to a release predating the console, restore its config or
remove the optional `console` field before restart; the older parser rejects
unknown keys. Preserve current durable state and reconcile unknown effects rather
than restoring an old data snapshot blindly.

## Development checks and limitations

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm test
```

Tests use signed webhook fixtures, fake model/transport/Amp boundaries, and real
Rivet engines on disposable disk and loopback ports. They require no production
credentials. The startup test exercises the real HTTP host and engine restart;
the crash test interrupts external operations before a receipt can be persisted.
No test launches a real coding agent or sends a live message.

RivetKit is pinned to 2.3.21. The native runtime currently emits
`transaction_closed`/scheduled-alarm errors during actor shutdown in integration
tests. These are not suppressed. Passing targeted recovery tests does not establish
production reliability; soak testing, upgrades/migrations, backup recovery, and
broader platform end-to-end validation remain gates before expanding beyond the
owner-only Slack rollout or importing sensitive history. Workflow code changes
must preserve replay compatibility with existing journals. Services is disabled,
although RivetKit still pulls agentOS dependencies transitively.
