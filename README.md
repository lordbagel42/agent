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

June can reply with text, a native reaction, both, or intentional silence. A light
acknowledgment no longer forces an extra text message. Delivery history records
what the platform accepted, including uncertain or rejected reactions.

Incoming reactions and delivery receipts are recorded; they do not trigger an
LLM turn yet. Images, attachments, voice, WhatsApp templates, proactive schedules,
Claude subscription auth, and self-deployment are unavailable. Memory, imports,
reflection and tool modules are local integration work, not evidence of live
provider access or permission to activate them. All optional integrations remain
off unless explicitly configured and separately authorized.

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
Rivet conversation data and journals are not encrypted by the optional evidence
store. Use filesystem permissions and encrypted storage. Backup retention,
physical erasure and disaster-recovery reconciliation remain operator work;
do not load sensitive historical accounts merely because offline checks pass.

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

Coding is disabled by default. Enabling it requires `coding.enabled: true`, an
explicit `coding.runtime`, named absolute workspace paths, a separate
`coding.isolation.<workspace>.worktreeRoot` for each, and
`JUNE_ALLOW_NATIVE_CODING=1`. There is no default runtime or authentication fallback.
Each isolation policy may name an independent verifier with absolute `argv[0]`,
bounded `timeoutMs` and nonsecret `env`. A worker report is not verification.

Supported runtime configurations, all dormant until separately authorized:

| `coding.runtime.kind` | Required configuration and authentication |
| --- | --- |
| `amp` | Supported Amp installation/login on the dedicated execution host. |
| `codex` | Dedicated absolute `home` with supported CLI file authentication; optional `model` and absolute `executable`. Separate from the companion's Codex home. |
| `claude` | `apiKeyEnv` and private `stateDirectory`; optional `model`, `maxTurns` (40 by default), and `allowedTools` (empty by default). API keys only, not Claude subscription tokens. |
| `pi` | Operator-pinned absolute `executable`, exact `provider`/`model`, private `home`, `agentDir`, `sessionDir`, explicit `path`, and `hostSandboxAcknowledged:true`. Provision Pi's supported `auth.json` in its dedicated directory; only HOME/PATH are passed by this host. |

Provider/session directories must already be canonical, owner-only directories
outside repositories. Read the [Codex](src/coding/codex.md) and
[Pi](src/coding/pi.md) contracts before provisioning. No runtime signs in or
copies another tool's credentials. An API-key environment reference is not proof
of account identity, provider eligibility, or authorization.

**Native execution is not a sandbox.** The workspace list and worker prompt are
not filesystem or network isolation. Amp can inherit host access and credentials;
the other runtimes' filtered environments do not prevent filesystem access.
Keep native execution disabled until protected-host acceptance establishes the
required credential, process and network isolation. This increment does not
enforce a separate credential broker or deployment policy.

Each proposal durably binds the parsed runtime/execution configuration before
approval. Changing that configuration cannot resume a saved thread under a new
adapter, state directory or verifier. Jobs from an older unbound schema require
manual reconciliation; the host will not invent a binding. The digest does not
authenticate external credentials, executable contents or native configuration;
changing those still requires operator review, not automatic resumption.

Ask June privately for a coding task. She returns the scope and an
`/approve <job-prefix>` command; approval is for local work, not push/deployment.
After an uncertain result, first inspect the saved native session and workspace and
confirm the old worker is no longer running. Only then send
`/resume-stopped <job-prefix>`. Do not resume a job with an unknown live worker.
If a worktree exists but no thread ID was saved, even confirmed-stopped resume
is rejected: manual reconciliation only, never a replacement session. A failure
before worktree preparation may be explicitly resumed under the same binding.

The pinned Amp SDK writes a string prompt before output consumption. Awaiting
`onThread` therefore does **not** prove that the native session was saved before
work began. Natural iterator exhaustion validates the owned process exit, not
descendant or remote-tool quiescence. The existing hard-kill fixture interrupts
after the ID callback; it does not exercise real pre-ID Amp crash/recovery.
Unknown startup/cancellation retains admission, including without a saved ID.

Private operator endpoints require `Authorization: Bearer <operator-token>`:

- `GET /operator/conversation`: history, events, outbox, and coding proposals.
- `GET /operator/jobs/<full-job-id>`: job state, saved thread ID, and report;
  forgotten-source jobs are no longer exposed or resumable.
- `POST /operator/jobs/<full-job-id>/resume`: JSON `{"confirmedStopped":true}`
  and a UUID `Idempotency-Key` header. Reuse the same key when retrying a request;
  a new deliberate attempt needs a new key. HTTP 202 means queued, not completed.
- `POST /operator/jobs/<full-job-id>/cancel`: idempotently persists a cancellation
  request. HTTP 202 is not proof of stoppage and does not release unknown admission.
  Forgetting permanently revokes a job, even if it overtakes a queued proposal or
  resume; ordinary cancellation does not grant permission to resume it.

There is no automatic resend endpoint for unknown delivery outcomes. Inspect the
platform before taking a new action. A delivery marked `sent` means the provider
accepted it, not that the human read it.

## Dormant owner-private memory and reflection

`memory` is absent by default. Activation requires an existing canonical,
owner-only directory outside repositories, a base64-encoded 32-byte key named
by `memory.keyEnv`, and `JUNE_ALLOW_MEMORY=1` after privacy/retention review.
Optional `memory.curated` uses a dedicated directory and separately provisioned
key. Store actual keys only in the operator's secret mechanism.

Live retention is limited to authenticated owner Slack DMs; imports use the same
owner-private audience and canonical Slack IDs. Public-thread prompts neither
read nor ingest retained memory. Historical channel reads do not grant that
channel access to private memory. Changed records with an existing ID fail
closed; no audience widening or invented duplicate IDs. Enabling retained memory
discards legacy working summaries without provenance before the next scoped
prompt. This is not physical deletion of old journals.

Optional `memory.extraction` and `reflection.model` use explicit API-key
OpenAI/Anthropic structured-output providers; `JUNE_ALLOW_MEMORY_MODELS=1` is a
separate provider/privacy gate, not subscription authentication. Extraction sees
only original inbound source IDs, stages pending claims and cannot accept them.
Reflection enqueues one idle proposal per evidence set, uses durable timers and
owner-wide live turn IDs, and never sends a message or changes permissions.

The existing `conversation-v1` workflow remains. Journaled old iterations stay
on their old path; new iterations persist optional feature choices before use.
New live/extraction attempts persist intent before provider work and never
automatically relaunch an interrupted attempt. Unknown live turn occupancy stays
held until authenticated confirmation of stoppage releases that exact ID.
Cancellation is not proof of remote cancellation or descendant quiescence.

These routes require the existing owner bearer token, not a console cookie:

- `GET /operator/memory`: bounded evidence, pending claims and curated metadata.
  Optional `audience` must equal the configured owner-private scope.
- `POST /operator/memory/proposals/:id/review`: `decision` is `accepted` or
  `rejected`. Review is an operator action, never a model capability.
- `POST /operator/memory/forget`: `{sourceId, confirmed:true}` tombstones first,
  resets working context, revokes old coding approvals/results and requests
  cancellation of associated jobs/reflections. Retry after interrupted cleanup.
  In-flight invalidated replies cannot be sent. Already-dispatched work cannot
  be recalled, and `physicalPurge:false` explicitly excludes journals/backups.
- `POST /operator/memory/personality/revise` and `/personality/rollback`: explicit
  UUID command, grounded evidence/explanation and confirmation, when configured.
- `GET /operator/reflection` and POST `/enqueue`, `/cancel`, `/candidate`,
  `/reconcile`: metadata, staging and recovery only. Live reconciliation takes
  `{id, live:true, confirmedStopped:true}`; never use it while a provider runs.

`imports` contains operator-defined selections (`platform`, `account`,
`conversations`, epoch-millisecond `from`/`to`, `accessTokenEnv`). It additionally
requires `JUNE_ALLOW_HISTORY_IMPORTS=1` after actual account/scope/consent review.
`GET /operator/imports` returns exact coverage and its digest. Each
`POST /operator/imports/:id/start` requires `{confirmed:true,digest,expectedPages}`
from that review and reads at most one page. A successful-page retry cannot
advance a second page. Durable progress binds immutable approved coverage before
credential lookup. Restart never resumes imports; changed coverage requires a
new selection. `/cancel` aborts the current fetch, not already persisted pages.
Imported text never enters the live command inbox. See the detailed
[memory](src/memory/README.md), [import](src/imports/README.md) and
[reflection](src/reflection/README.md) contracts and their remaining limits.

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
