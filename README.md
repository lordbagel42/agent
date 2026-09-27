# June

One personal companion across platforms, with separate execution workers. June
uses she/her pronouns; her personality is meant to develop with her owner.

**Status: the homelab service and private console are running. Genuine human
Slack DM → model → reply delivery is verified, including text replies and native
reactions, after enabling organization-ready deployment for the enterprise
installation. Search and coding remain disabled. Not production-hardened.**
TypeScript, Node 24, Rivet actors and journaled workflows. No Temporal and no
custom workflow engine. See the [architecture](docs/architecture.md) for
the evidence graph, Git memory, personality, dreaming, and later capabilities.

Slack is the active rollout target. WhatsApp is shelved at the owner's request;
its existing adapter is not configured in the startup examples or deployment.
Linq's Android/RCS support is being evaluated as its replacement, not yet wired
into June or tested with a real account.

## What works in this increment

- Slack DMs and mentions, WhatsApp Cloud API text, and native reactions. Webhooks
  are verified before accepting events; bots are ignored. Slack guests can
  directly mention June or DM her without gaining owner privileges.
- Optional owner-only participation in channels containing `raygen`, scoped
  surrounding messages, sender names/IDs, exact Slack timestamps and file
  descriptors. Other participants provide context, never authorization.
- Linked owner DMs share history. Public Slack threads have separate context and
  cannot access private history or approve coding tasks.
- Durable inbox, serial turns, event deduplication, and a persisted outbox.
  Ambiguous sends are recorded as unknown, not automatically repeated.
- [Durable wakeups](docs/wakeups.md): June can manage one-time reminders, cron
  notifications and native/signed-webhook event watches from her owner's Slack DM.
- [Persistent execution agents](docs/execution-agents.md): June delegates substantive
  owner work, keeps chatting while workers run, reuses them for follow-ups, and
  synthesizes results. `executionEnabled: false` restores the direct fast/deep path.
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

Incoming reactions and delivery receipts are recorded; they can wake June when
an explicit event watch matches. Reading image/attachment bytes, voice, WhatsApp templates,
Claude subscription auth, self-deployment, and configuration changes from the
console are unavailable. Memory, imports,
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

All Codex inference uses a persistent official app-server holding three
unused ephemeral threads per configured provider. Each reply consumes a thread
once; completed threads are unloaded before replacement. There is no per-reply
exec fallback or opt-in flag. This requires an auth-only Codex home with no nonempty `config.toml`, `AGENTS.md`,
or `AGENTS.override.md`, and no nonempty `/etc/codex/{config,managed_config,requirements}.toml`.
Unsupported managed requirements/configuration layers and changed effective
safety/provider settings fail closed before thread prewarm; policy is never overridden.
Operator-owned configuration must remain stable while the provider runs. Authentication
continues through the existing official login; do not copy credentials to enable it.
June can inspect sanitized pool state in an owner-private conversation using the
discoverable `modelStatus` output action. She cannot restart or reconfigure it.
See [hot Codex design and measurements](docs/hot-codex.md) for limits and evidence.

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

### Fast replies, deeper reasoning and public web search

`model` is the primary conversational pass. Optional `deepModel` uses the same
configuration shape. The primary model can request one deeper pass with a
contextual acknowledgment; the deep pass cannot escalate again. Interrupted
model/search calls remain uncertain rather than being automatically repeated.
API providers accept `maxOutputTokens` and `timeoutMs`; OpenAI also accepts
`reasoningEffort`. Codex accepts `reasoningEffort` and `serviceTier` (`fast` or
`default`), but has no hard output-token cap. Defaults are unchanged.

For the existing dedicated Codex login, configure Astra
`low`/`fast`/15000ms for `model` and Astra `high`/`fast`/75000ms for `deepModel`.
Web-search synthesis uses the primary model, so these settings request fast tier
for every active conversational pass. Memory, reflection and coding have separate
model configurations and remain disabled in this deployment.

The current Astra backend rejects reasoning effort `none`; `low` is its lowest
supported effort, not no-thinking mode. Fast-tier requests succeeded in controlled
provider probes, but a real Slack end-to-end speedup has not been established.
There is no extra classifier invocation. Coordinate live settings changes with
the [deployment controller](docs/deployment.md); releases bind the exact config.

Enable replaceable public search with
`"webSearch": {"provider":"tavily","apiKeyEnv":"TAVILY_API_KEY"}` and load the
credential through the service's private environment. Missing credentials mean
unavailable, not failed startup. One explicit public query permits one synthesis
pass with further searches/escalation disabled. Queries must not contain private
Slack/history/memory; result snippets are untrusted evidence, not instructions.
Tavily is temporary: Raygen wants a free or self-hosted replacement. No live
Tavily request is implied by configuration or offline verification.

## Platform configuration

**Slack:** create/install a bot, enable Event Subscriptions and its App Home
Messages tab, and configure the public HTTPS `/webhooks/slack` URL. Subscribe to
`message.im`, `app_mention`, `reaction_added`, and `reaction_removed`; grant bot
scopes `im:history`, `app_mentions:read`, `chat:write`, `reactions:read`, and
`reactions:write`. Supply its signing secret, bot token, workspace ID, and bot
user ID. Raygen's owner ID is fixed in code to `U08R4KDL6UF`, bound only to the
configured workspace. Other configured Slack owner IDs are replaced, not merged.
Anyone in that workspace can initiate a turn by directly mentioning June or
messaging her 1:1. Group pings alone are not invitations. Set
`slack.participateInOwnerChannels: true` to also accept Raygen's unmentioned messages
in channels whose verified current name contains `raygen`. Group DMs remain
excluded. Raygen can also follow up without another mention in threads June
started or has posted text in. Successful Slack sends record thread participation
locally across restarts, without a Slack lookup on each follow-up. Slack's signed
parent-author field, when present, also recognizes older threads June started. Older threads
she joined need one new reply from June to enter the local record. This requires
Slack to deliver channel message events (`message.channels`/`message.groups`
and the corresponding installed history scopes); an app-mention subscription
alone cannot deliver unmentioned follow-ups. Guest mention rules are unchanged.
June chooses reply placement with `replyInThread`: false posts in the
main DM/channel, true uses the existing thread or starts one on the incoming
message, and unset preserves incoming placement. Normal DMs and ongoing channel
conversation should generally stay unthreaded; mentions do not force threads.
Raw messages beginning with `##` are hard-excluded before normal processing,
including automatic history/context and retained-history imports. Leading
whitespace is not trimmed. Explicit tool lookups can still retrieve this text.
The other Slack conventions are model guidance, not runtime filters: `<>` (or
Slack's encoded `&lt;&gt;`) and group pings ask June to stay silent unless directly
mentioned. In a thread, `@June !stop` asks her to stop without acknowledgment;
surrounding whitespace and `!STOP` are accepted by the guidance. Later unrelated
messages should not resume the stopped task, but a new explicit request can.
This does not forcibly cancel an in-flight turn. The prompt receives the host's
verified `botMentioned` flag, so names and group pings do not establish a direct
mention. Existing owner/guest permissions still apply.

### Owner-only Slack transcripts

Raygen can ask June, in any admitted Slack conversation, “show me your DMs with
@someone” or request a channel/thread by ID and timestamp. June's `slackHistory`
directive reads with **her bot token**, not Raygen's personal OAuth token, and
delivers only to Raygen's verified one-to-one Slack DM. Guests, trusted friends,
group DMs as destinations, and linked non-Slack identities cannot invoke it.
Channel reads require June's membership; it never joins or opens conversations.
User names must match uniquely within the bounded directory lookup; an @mention
or Slack user ID avoids ambiguity. It resolves existing DMs, not someone else's
private conversations with third parties.

Enterprise Grid bot tokens are supported only after verifying the configured
workspace in `auth.teams.list`. Discovery is workspace-scoped; explicit source
IDs must also appear in the bot's workspace membership list. An enterprise ID
alone does not grant access to another workspace. Grant and membership discovery
each stop after five pages of 200 entries, failing closed when unverified.

Install the bot scopes `im:read`, `im:history`, `channels:read`,
`channels:history`, `groups:read`, `groups:history`, `mpim:read`, `mpim:history`
and `users:read` for the corresponding conversation types. A manifest request is
not proof the installation has those grants. Missing permissions, unsupported
token/method combinations, and rate limits fail without switching credentials.

Each request reads one page of up to 15 retained plain-text messages; long
messages are explicitly truncated at 1800 escaped characters. The report includes
a continuation cursor when Slack provides one. A timeline is not a recursive
thread export: request replies using `threadTs`. Files, deleted messages and
expired history are not recovered. Directory and DM discovery each stop after
five pages of 200 entries. These limits do not imply complete coverage.

Transcripts never enter the model, durable outbox contents, conversation memory,
or workflow results; only a delivery receipt is retained. Automatic Slack context
and history imports skip June's marked transcript messages so they cannot later
be reused by social posting or other model tools. Requests and continuation
cursors remain ordinary conversation data. Sending is guarded by the existing
durable no-resend mechanism; uncertain delivery requires an explicit new request.

### Shared June, owner priority and approvals

June keeps one identity and may be playfully sassy with people other than Raygen.
Guest conversation state is isolated by participant and surface; it never joins
Raygen's private history. Two active turn slots reserve at least one for Raygen,
with owner waiters admitted first and at most one guest active. Existing work is
not killed. Guests are limited to four admitted turns per minute per person and
a bounded waiting queue. These process-local limits reset on restart.

Guests initially receive text/reactions and same-surface context, not private
memory, Slack search, coding, deep-model escalation or public web search.
Relationship trust does not grant permissions. June has a structured `social`
action and instructions to proactively ask Raygen when additional access helps:

- `post`: on Raygen's turns, sends immediately to any Slack conversation/user ID
  the bot can address, with an optional thread timestamp (`null` for unthreaded).
  June chooses `conversationId`, `threadId`, and `text`; the host fixes the
  workspace. One model pass performs the send and returns a delivery receipt,
  with no second approval round trip. Guests cannot use it. Slack permissions
  still apply; this does not connect RCS or bypass channel membership. Replayed
  sends retain their original payload and uncertain sends are not repeated.
- `request_access`: names the person, conversation, purpose, exact shared excerpt,
  requested tools (`webSearch`/`deep`), and notification placement (`dm`/`thread`).
  Guests may request only their own tools on their current surface, without
  proposing private excerpts. Owner-originated requests stay in Raygen's DM.
- `outreach`: an opt-in preview/approval flow for one exact DM, from an
  owner-private request. Ordinary owner-directed sends use `post` instead.
- Raygen replies with exactly `!allow ID`, `!deny ID`, or `!revoke ID`. In a
  channel, prefix that with June's mention. Quoted commands, model output and
  other senders cannot approve anything. June can inspect the active grants
  supplied to her prompt; Raygen's private turns also show recent proposals.

Pending requests expire after 24 hours. Approved access is remembered for 30
days, scoped to one person and conversation, and revocable. The approval preview
explicitly covers the whole conversation, not only one thread; the purpose is
guidance, not an automatic semantic access classifier. Only the exact reviewed
excerpt is supplied to guests—never automatic retrieval from Raygen's memory.
Grants are rechecked before dispatch and delivery. Revocation cannot undo an
already dispatched effect or erase something previously shared.

Approval notifications are bounded to two per guest per day and twenty total
guest requests per day. Delivery uses persisted no-resend markers; uncertain
outreach is not automatically repeated. Slack DMs use the recipient's user ID
with `chat.postMessage` and existing `chat:write`; Slack may still reject an
inaccessible recipient. Permission records, previews and receipts live in
`social.sqlite` under `RIVETKIT_STORAGE_PATH`, private mode `0600`, outside releases.
Like Rivet conversation history, this ledger is not encrypted at rest; include it
in the same private storage/backup policy.

Adapters can implement optional `setTyping` for ephemeral activity during new
context loading, model and lookup calls. Updates run alongside work, refresh
without overlapping, and attempt to clear on success, failure or cancellation;
they never create messages or journal entries. Slack uses `assistant.threads.setStatus` with existing
`chat:write` permission. It is thread-scoped (including DM threads), not the
ordinary top-level DM typing bubble. The reply thread is selected before context
loading only when the input is already threaded; top-level input does not invent
a thread for a status indicator. June can select placement in her response.
Status starts after durable acceptance,
turn admission and replay checks; queued turns still wait for their predecessor.
The original inbound scope/context is preserved. Existing journaled turns retain
their earlier placement policy, including an inbox iteration already waiting at
upgrade; the next fresh iteration enables June's placement choice. Typing is
best-effort and never dictates where the reply belongs.
Unthreaded Slack DMs use a temporary `hourglass_flowing_sand` reaction instead of
the unavailable native typing bubble. It starts alongside context/model work,
is not repeatedly added, and is removed on completion/cancellation. An ambiguous
add, failed cleanup, or process crash can leave it behind; reactions have no Slack-side TTL.
An existing reaction not added by this activity run is left alone.
Unsupported surfaces and status failures do not prevent a reply. Live Slack
status rendering still needs verification after an authorized rollout.

Set `slack.contextEnabled: true` for one bounded same-channel/thread context page.
It preserves the initiating message once and the original sender of each
surrounding message. No cross-channel fallback, file downloads or raw response
cache is used. Missing read grants degrade to current-message context. Channel
prompts exclude owner-private memory and unprovenanced/foreign-surface history.

The checked-in manifest additionally requests `channels:read`, `channels:history`
and `message.channels` for public participation; `groups:read`, `groups:history`
and `message.groups` for private channels; and `users:read` for display names.
These new grants/events are **not yet verified live**. Apply/reinstall only after
reviewing the intended scopes; no MPIM scope, user token or files scope is needed.

For an enterprise-installed app (`is_enterprise_install: true`), also enable
[organization-ready deployment](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/#enable-organization-wide-installation)
with `settings.org_deploy_enabled: true`. June's manifest includes this flag to
match its CLI installation. This does not add workspace grants; keep the actual
installation restricted to the intended workspace.

Verify the Request URL in Slack's App Management Event Subscriptions page and
save the settings. A manifest containing the URL does not prove that events are
enabled or that Slack completed URL verification. Keep the signing-secret,
workspace and human-message checks intact. Confirm delivery with a real human DM;
API/app-authored messages carrying `bot_id` or `app_id` are intentionally ignored,
even if their user ID matches the owner.

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

Ask June privately to inspect native coding prerequisites. The model action is
`{"text":"","inspection":"native-coding"}`, with no other actions, available
even when coding is disabled. Its timestamped read-only report distinguishes
closed activation gates, absent runtime/workspace/isolation configuration and
local directory problems from **unverified** authentication and protected-host
acceptance. It inspects up to ten workspaces (numbered in configuration order),
checks overlapping roots and private runtime directories, and reports omitted
checks explicitly. It returns no paths, credential names/values, command
arguments or raw errors; it does not execute a CLI, verifier or coding worker.
Existing directories, a configured supervisor and Pi's sandbox acknowledgment
are not containment evidence. Automatic deployment drain with native coding
remains unsupported; idle/cancelled job labels do not prove settlement. This
inspection never enables coding, grants approval or permits uncertain resumes.

When coding is unavailable, ask June privately how to recover it. Her
`codingJob: {action:"list", id:null}` response separates operator configuration
review from unverified authentication and host isolation. An unavailable runtime
does not establish which prerequisite failed or mean that the account is signed
out; use preflight for observed prerequisite failures. Never paste credentials
into chat or reuse the companion's login as proof of coding access. Recovery
guidance grants no activation, job, push or deployment permission and does not
change configuration or launch a worker.

Each proposal durably binds the parsed runtime/execution configuration before
approval. Changing that configuration cannot resume a saved thread under a new
adapter, state directory or verifier. Queued or saved proposals without a
preview-time binding cannot be approved or resumed: request a fresh proposal
after reconciling any uncertain execution. A consumer-time binding from the older
schema is not sufficient; the host will not invent preview-time evidence. The
digest does not authenticate external credentials, executable contents or native
configuration; changing those still requires operator review, not automatic resumption.

Ask June privately for a coding task. She returns the scope and an
`/approve <job-prefix>` command; approval is for local work, not push/deployment.
June can also discover availability and recent jobs with
`codingJob: {"action":"list","id":null}`, inspect one with
`{"action":"inspect","id":"<job-id-or-prefix>"}`, or request cancellation with
`{"action":"cancel","id":"<job-id-or-prefix>"}`. These are private model
directives with empty text and no other actions, so asking June “show my coding
jobs” or “cancel coding job ID” uses the existing supervisor directly. IDs must
belong to the owner-private conversation; prefixes must be unique and at least
12 hexadecimal characters. Forgotten/revoked jobs are not exposed.

The host returns timestamped, bounded metadata: durable status, attempt count,
cancellation flag, saved native thread ID, worktree presence, and separate
verification status. It does not return task/source text, host paths or raw worker
reports. Disabled execution is discoverable without enabling it; configuration
is not proof of provider login or health. Cancellation means **requested, not
confirmed stopped**; uncertain capacity stays held. Neither directive approves,
resumes, launches, pushes or deploys work. Public turns, guests, worker results
and synthesis cannot invoke them. Old workflow iterations keep their old path.

Ask June “inspect the independent verifier outcome for coding job ID” to read
`verification` separately from `workerResultRecorded`. No recorded receipt means
`status: "unknown"` and `passed: null`, even if the worker claimed success or a
legacy job says completed. A recorded receipt exposes the operator verifier's
status, tri-state pass result, exit code, bounded base/HEAD commit IDs, original
receipt time, and historical flag; missing or invalid provenance is null.
HEAD is captured before the command, not bound to immutable file contents.
Historical receipts do not verify current files. Command output stays omitted;
these results neither attest a deployment nor authorize one.

Ask June privately “why is coding job ID blocked?” to use the same `inspect`
directive. Its `runtimeBinding` is `pending`, `missing`, `unavailable`, `matched`
or `mismatch`; no binding digest or configuration values are returned. A bounded
`recovery` reason/guidance explains missing/mismatched bindings, prepared work
without a saved session, a legacy session without an isolated worktree, or an
otherwise unresolved review. These are current blockers, not a reconstruction of
the original failure. A match or absent recovery reason is not permission to
resume or evidence of provider health. Inspection never repairs/rebinds a job.

When an attempt settles, June queues one result notification to the requesting
DM through the durable outbox, even if her model returns no summary. Duplicate
completion and restart reuse that notification; an uncertain send stays unknown
and is not repeated automatically. A separately approved resume can produce a
new attempt notification. Forgotten-source results remain suppressed. Worker
claims and unknown outcomes are not independent verification or deployment proof.

After an uncertain result, first inspect the saved native session and workspace and
confirm the old worker is no longer running. Only then send
`/resume-stopped <job-prefix>`. Do not resume a job with an unknown live worker.
If a worktree exists but no thread ID was saved, even confirmed-stopped resume
is rejected: manual reconciliation only, never a replacement session. June's job
report explains that the external run may still be active. The operator must
inspect the isolated workspace and native runtime's sessions/processes, identify
any existing run and confirm it stopped, and inspect workspace admission and
reconcile any retained admission record before separately approved work. Preserve
the workspace and any retained admission record until that review is complete;
cancellation or host restart alone is not proof the run stopped. There is no
automatic session rebinding or lease reset.
A failure before worktree preparation may be explicitly resumed under the same
binding.

The pinned Amp SDK writes a string prompt before output consumption. Awaiting
`onThread` therefore does **not** prove that the native session was saved before
work began. Natural iterator exhaustion validates the owned process exit, not
descendant or remote-tool quiescence. The hard-kill fixture interrupts a mock
native runtime both before and after the ID callback, checking durable recovery,
June's report input and retained admission; it does not prove real Amp recovery.
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

## One global, iterable personality

June reads one durable, owner-wide public style snapshot on each new conversation
turn, including guest DMs and channels. It works without enabling retained memory
or reflection. The first increment allows tone, verbosity, humor and curiosity
from a fixed vocabulary; June's public self-description is generated from these
values. It cannot contain private evidence, arbitrary instructions or permissions.
Honesty, privacy, identity and authority remain outside the editable profile.

Ask June about her voice or how she would change it: her prompt includes the
current version and instructions to propose an exact confirmation command in
ordinary reply text. A model reply is a proposal, not a write. Send these as
ordinary messages in an authenticated owner-private DM (not Slack slash commands,
quotes, code blocks or attachment captions):

```text
!personality
!personality revise {"expectedVersion":0,"changes":{"tone":"dry","verbosity":"concise"},"explanation":"Try a shorter, drier voice","publish":true}
!personality history
!personality rollback {"expectedVersion":1,"targetVersion":0,"explanation":"Restore the initial voice","publish":true}
```

Use the current version shown by `!personality`; stale edits are rejected and
duplicate events do not append twice. Rollback can restore any saved version and
always appends a new revision. History shows the latest five revisions with
explanations. Guests and owner channel turns can read the public profile but
cannot inspect history or publish changes. All new turns use the same revised
voice; in-flight turns retain their snapshot.

No secret or configuration change is needed for this feature. State and private
explanations live in the existing Rivet data/journal and backup retention domain,
not the encrypted/forgettable evidence store; keep explanations non-sensitive.
Existing private curated traits remain intact for operator review, but do not
provide a second per-scope voice on new turns. No private evidence is promoted.
This slice does not autonomously infer or publish traits, edit free-form biography,
or claim a real-provider behavioral evaluation from its runtime fixture checks.

## Dormant owner-private memory and reflection

`memory` is absent by default. Activation requires an existing canonical,
owner-only directory outside repositories, a base64-encoded 32-byte key named
by `memory.keyEnv`, and `JUNE_ALLOW_MEMORY=1` after privacy/retention review.
Optional `memory.curated` uses a dedicated directory and separately provisioned
key. Store actual keys only in the operator's secret mechanism.

Curated traits are owner-private contextual preferences, not June's global
personality. When memory is enabled, June receives their provenance-validated
values as `ownerPrivatePreferences` in owner-private turns only, and may use
them when relevant and compatible with the global profile. The global profile
wins conflicts. Private evidence, inferred preferences, and owner corrections
do not publish identity changes; use the separate `!personality` publication
path for those. Public and guest prompts never receive the private preferences.
Forgetting supporting evidence removes the preference from future prompts.

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
scoped original sources and a bounded existing-claim context. It can propose
explicit contradictions or replacements of supplied claims, but stages only
pending proposals and cannot accept them, including proposals from imports.
Reflection enqueues one idle proposal per evidence set, uses durable timers and
owner-wide live turn IDs, and never sends a message or changes permissions.

With curated memory configured, June can use `personalitySuggestion` privately
with `{expectedVersion, changes, evidenceIds, explanation, confidence}` and empty
text/no other action. It stages one encrypted global-style suggestion, **never
applies it**. `changes` uses the global profile's fixed style vocabulary; null
fields mean unchanged. The host checks the exact current profile version and
1–20 distinct original sources in the owner's audience, all observed within seven
days. Confidence is not approval authority. At most 20 unexpired suggestions per
audience are staged; identical content deduplicates. Receipts contain only the
opaque suggestion ID and target version, not rationale or source text.

`CuratedPersonalityStore.pendingGlobalProposal(scope,id,now)` synchronously
revalidates provenance, expiry and deletion; `pendingGlobalProposals(scope,limit,
now,excludedIds)` excludes decided IDs before applying its 1–20 result bound.
Both return private copies, not public prompt content. The global personality
actor owns later accept/reject decisions; the payload's `pending` marker only
means staged, never approved. A changed global head must be reviewed again;
suggestions never retarget automatically. Deletion hides affected suggestions,
but old encrypted snapshots/backups are not physically purged by this check.

June can inspect these subsystems in an owner-private turn using
`inspection: "memory" | "imports" | "reflection" | "retention"`, with empty text and no other
actions. The host replies directly with timestamped proposal/revision counts,
up to ten configured import progress summaries, or reflection queue/candidate
counts. Disabled subsystems report unavailable. These metadata-only receipts do
not duplicate recall or expose source text, personality values, cursors, gap
contents, or reflection rationale. They grant no review, forget, import control,
reflection trigger, or approval authority; guests, public turns and synthesis
cannot call them. Changed import coverage fails closed rather than attributing
old progress to a new window.

With memory enabled, send `!memory-correct tone warm and concise` (or
`!memory-correct help`) as a standalone message in the configured owner's Slack
DM. Supported traits are `verbosity`, `tone`, `humor`, and `interests`; values
are single-line, 1–2000 UTF-16 code units, preserved exactly. June can explain the
workflow, and her memory inspection includes its instructions, but cannot issue
the command on the owner's behalf. The host records immutable, private correction
provenance and returns its evidence ID without a model call. Quotes, imported
instructions, public messages, guests, and model output cannot create it.
This only records evidence: a separate owner-reviewed curated revision must cite
that ID with the matching trait/value within the existing freshness window.
It does not alter arbitrary memories, June's global style profile, or permissions.

For "what copies can remain after forgetting?", June uses `inspection: "retention"`.
This fixed five-category report covers the evidence ledger, Rivet journals,
curated/filesystem snapshots, backups, and delivered messages. It uses only
runtime wiring, not ledger reads, actor snapshots, filesystem enumeration or
provider queries. It remains available when memory is disabled: unconfigured
does not mean no old copies exist. Logical deletion removes data from active
use; physical erasure is unverified for every category. Copy counts, backup ages,
retention deadlines, external copies and individual deletion status remain
unknown. This is a category inventory, not a copy census or deletion certificate;
it neither deletes anything nor authorizes a scan or purge.

For "why did that import conflict?", June uses the same `inspection: "imports"`
action. Observed immutable-source conflicts explain that the rejected page left
old evidence and its cursor intact, and request explicit authenticated operator
reconciliation. This does not queue a repair, retry, overwrite, skip, or create
replacement IDs. Conflict observations are process-local and page-bound; absence
after restart is not proof of no conflict. Existing identity checks remain intact.

Reflection inspection also explains interrupted/unknown invocations and shows up
to five held scoped requests and five owner-wide live turn references. References
are SHA-256 fingerprints, not API IDs: raw request/turn IDs can encode private
source and scope IDs. Use bearer-authenticated `GET /operator/reflection` privately
to match the SHA-256 of each exact UTF-8 ID. After independently verifying that
the old worker/provider stopped, an operator can POST `/operator/reflection/reconcile`
with `{id, confirmedStopped:true, live:false}` for a held reflection request or
`{id, confirmedStopped:true, live:true}` for a live turn. Require `reconciled:true`
and re-read status before reporting the hold released. If stoppage is unverified,
leave the hold and outcome unknown. Never paste raw IDs or credentials into chat,
use a fingerprint as an API ID, or guess an ID for unidentified legacy occupancy.
Reconciliation does not prove reflection succeeded, approve a candidate, clear
dedupe or retry work. June cannot perform it. Ordinary live occupancy can include
the inspection itself and is not evidence of interruption.

The existing `conversation-v1` workflow remains. Journaled old iterations stay
on their old path; new iterations persist optional feature choices before use.
New live/extraction attempts persist intent before provider work and never
automatically relaunch an interrupted attempt. Unknown live turn occupancy stays
held until authenticated confirmation of stoppage releases that exact ID.
Cancellation is not proof of remote cancellation or descendant quiescence.

Ask June privately about interrupted inference with
`{"text":"","inspection":"inference"}`, with no other actions. The host sends
up to ten recorded recovery receipts from that private conversation, newest by
inbound event time, with opaque receipt IDs and the original unknown status.
Forgotten events, message bodies and raw invocation keys are omitted. Timestamps
describe inbound events, not inference start or interruption; those times were
not recorded. Missing receipts, including on legacy events, prove neither success
nor intentional silence. This read-only view does not retry, reconcile, reclassify
or release uncertain work; actions may already have occurred. Guests, public
turns, worker results and synthesis cannot invoke it.

These routes require the existing owner bearer token, not a console cookie:

- `GET /operator/memory`: bounded evidence, pending claims and curated metadata.
  Optional `audience` must equal the configured owner-private scope.
- `POST /operator/memory/proposals/:id/review`: `decision` is `accepted` or
  `rejected`. Review is an operator action, never a model capability.
- `POST /operator/memory/forget`: `{sourceId, confirmed:true}` tombstones first,
  resets working context, revokes old coding approvals/results and requests
  cancellation of associated jobs/reflections. Retry after interrupted cleanup.
  Social records lack complete evidence provenance, so each deletion also
  revokes all existing social grants/pending outreach and redacts their frozen
  prose and delivery payloads, retaining content-free replay IDs. Copied owner
  and guest working history is reset; unrelated evidence remains retrievable
  and new social requests can be approved normally. Durable deletion revisions
  enforce this even after a crash before cleanup.
  After any deletion, unprovenanced platform history is no longer supplied to
  models (it may contain copies of forgotten text); current-message enrichment
  and fresh local conversation history remain available.
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

## Private read-only console

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

### One-time dashboard sign-in links

Ask June **in your private conversation** for a dashboard login link. Her
`dashboardLogin: true` action sends a short URL such as
`https://june.raygen.dev/<random-id>` directly to that conversation; it is not
available to guests, public channels, execution workers, or synthesis passes.
She must not reuse old links or invent URLs. Amp and trusted operators can create
the same links through the private listener:

```sh
curl --fail --request POST \
  --header "Authorization: Bearer $JUNE_OPERATOR_TOKEN" \
  http://127.0.0.1:3080/operator/console/login-links
```

The response is `201` JSON with `url` and `expiresAt`. URLs use the configured
console origin, never request headers. Each link has a random 144-bit identifier,
expires after **10 minutes**, and can create exactly one **15-minute** session.
Opening it shows a **Sign in** button; only that same-origin confirmed POST
consumes it, so GET/HEAD previews do not burn the link. Expired, used, and
restart-invalidated links return `410` with recovery instructions. At most 32
unexpired unused links are held in memory; issuance at capacity returns `429`.
Restarts revoke links and sessions. The operator token never appears in a link.

The delivery record retains the link, but the host redacts login URLs from
June's subsequent conversation-model inputs, including history and fetched
platform context. The model does not need the credential to remember that a
link was sent.

Treat these links as temporary credentials: share them only with the owner,
never in public channels, logs, screenshots, or analytics. Proxy routing for the
private dashboard must forward root `/<24-character-id>` GET/HEAD requests and
`/console/session/link/*` GET/HEAD/POST requests as well as `/console/*`; keep
`/operator/*` private. Disable/redact URL and body logs on those routes. Links do
**not** bypass Cloudflare Access, SSH, or other private-ingress authentication,
and they do not grant tool permissions. No arbitrary redirect destinations are
accepted; redemption always opens `/console`.

The overview shows selected configuration facts, content-free Slack ingress
counts, durable event counts, capability gates and saved proposal counts. It
does not show credentials, conversation text, job goals/reports, provider paths,
or infer provider health from configuration. Unconnected memory, reflection,
approval and revocation sections remain unavailable. No action callbacks or
action-link routes are mounted; viewing the page cannot approve or run work.

### Token intelligence

`/console/usage` is an owner-session-only dashboard with rolling 24-hour, 7-day,
and 30-day windows, model filtering, UTC input/output charts, cache and reasoning
breakdowns, stage attribution, latency percentiles, measurement coverage, and the
latest 100 attempts. `/console/usage/export` exports the same filtered snapshot
and aggregates as JSON; both routes are private and no-store.

The host creates `usage.sqlite` inside `RIVETKIT_STORAGE_PATH`, with private file
permissions. This additive SQLite/WAL ledger is independent of forward-only
conversation journals. It stores random attempt IDs, configured provider/model
names, stages, timestamps, wall time, outcomes, and numeric usage counters only.
It never stores prompts, replies, raw provider responses, credentials, user IDs,
or conversation IDs. Keep the storage directory private and persistent.

Codex, OpenAI Responses, and Anthropic Messages report usage at the transport
boundary; fast, deep, synthesis, memory extraction, and reflection are attributed
separately. Cache reads/writes are subsets of input, and reasoning is a subset of
output. Anthropic input is normalized to include its separately reported cache
counts; when either cache field is missing, the normalized input total is unknown.
Codex 0.157.1 reports cumulative counts for its fresh ephemeral invocation,
not a resumed conversation; its all-zero fallback is treated as unavailable.
Individual zero detail counters may still be provider defaults, not independently
verified zero usage. Native coding workers, external observer services, and
non-model tools are not included. Latency is host wall time, not tokens/second.

Intent is written before a provider operation and settlement after it. An
interrupted call remains unresolved; a telemetry settlement failure never turns
a successful model operation into a retry. Failed calls may consume tokens.
There is no historical backfill or guarantee of continuous observation. Missing
counters remain unknown rather than zero. The dashboard does not call models.

ChatGPT subscription activity is distinct from API activity. Billing, remaining
quota, subscription fees, and dollar estimates are unavailable: no invoice API or
verified rate card is connected. Token counts are neither a bill nor a promise
of free or unlimited use.

Enabling this surface does not migrate state, enable providers or grant deployment
authority. To roll back to a release predating the console, restore its config or
remove the optional `console` field before restart; the older parser rejects
unknown keys. Preserve current durable state and reconcile unknown effects rather
than restoring an old data snapshot blindly.

## MCP connections

The private dashboard's **Connections** page adds remote MCP servers and native
Slack OAuth. June can use explicitly enabled tools in owner-private conversations;
effects require exact, single-use dashboard approvals. See
[MCP setup and permissions](docs/mcp-connections.md) for configuration and limits.

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
