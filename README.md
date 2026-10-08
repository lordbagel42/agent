# June

A persistent personal companion, built with TypeScript and Rivet.

June talks in Slack, remembers scoped context, and delegates work without turning
every task into a new chatbot. She has one evolving personality, separate workers
for execution, and durable records of what was requested, admitted, and actually
completed.

**This is a personal project, shared for the code and ideas—not a turnkey product.**
Expect owner-specific behavior, rough edges, and changing interfaces. Source
support for a feature does not mean it is enabled, live-tested, or safe to expose.

[Architecture](docs/architecture.md) · [Configuration](docs/usage.md) ·
[Deployment](docs/deployment.md) · [Publication checklist](docs/publication.md)

## What’s here

- **Shared visual spaces.** Optional [HTML artifacts, collaborative Excalidraw
  boards and live workflow views](docs/shared-artifacts.md), with image/link
  delivery and creator-DM PIN protection when June chooses a private view.
  Workflow status views stay bound to the originating requester and source.
- **Conversation that continues.** Slack DMs, mentions, threaded follow-ups,
  reactions, multipart replies, and intentional silence. Owner and guest context
  have separate privacy and permission boundaries.
  June can send an ordered list of independently addressed messages directly
  with `sendMessages`, including an owner DM requested from a public channel or
  a worker-completion reply. No worker or separate approval is needed to send;
  private reads and recipient privacy still have their own restrictions. Each
  message has a durable receipt, and uncertain sends are not automatically retried.
- **Work in the background.** Persistent execution agents handle substantive
  tasks while June keeps chatting. Native coding jobs can use Amp, Codex, Claude,
  or Pi, with immediate admission of new exact tasks, worktrees, cancellation,
  and recovery records. Historical pending jobs do not run automatically.
- **Memory with provenance.** Optional encrypted evidence storage, scoped recall,
  version-bound public style changes, fingerprint-bound forgetting, and page-bounded
  configured imports. June can review and accept/reject pending claims in their
  authenticated audience; extraction and reflection never accept them automatically.
  Forgetting reads scoped impact before June queues exact logical deletion without
  a human command. The host alone reports cleanup completion; queued is not done,
  and logical deletion is not physical erasure of journals/backups or sent content.
- **Tools with boundaries.** Optional web search, MCP connections, scoped browser
  recipes, and vault-backed credentials. June judges ordinary task access at
  runtime, without owner/private-DM prerequisites or compulsory per-task human
  confirmation. Explicit disables, scopes, account access and secret protection remain.
- **Durable automation.** Reminders, cron and event wakeups, authored JavaScript
  workflows, and optional HTTP apps on a separate app host.
- **Operator visibility.** A private console and authenticated APIs expose
  configuration, receipts, pending work, and diagnostics without treating a
  model’s report as proof of success.

Slack is the primary channel. A WhatsApp Cloud API adapter remains in the source
but is shelved; Linq/RCS is not a registered runtime integration.

## How it fits together

```diagram
┌──────────────────────┐                 ┌──────────────────────┐
│ Messaging            │                 │ Owner / operator     │
│ Slack · WhatsApp*    │                 │ config · activation  │
└──────────┬───────────┘                 │ private API/console* │
           │ events / replies            └──────────┬───────────┘
           │                                        │ authority
┌──────────┴───────────────────────────┐            │
│ June                                 │<───────────┘
│ verified ingress · scoped context    │
│ conversation / execution workers     │   ┌────────────────────┐
│                                      │<->│ Model providers    │
│ Rivet actors + journaled workflows   │   │ OpenAI · Anthropic │
│ inbox / outbox · wakeups · workflows │   │ Codex app-server   │
└──────────────────┬───────────────────┘   └────────────────────┘
                   │ host-checked capabilities
          ┌────────┴─────────────────┬────────────────────┐
          │                          │                    │
┌─────────┴──────────┐  ┌────────────┴────────┐  ┌────────┴───────────┐
│ Memory/reflection* │  │ Tools/credentials*  │  │ Coding/apps*       │
│ evidence · recall  │  │ web search · MCP    │  │ admitted jobs      │
│ reviewed curation  │  │ browser · vault     │  │ worktrees/verifier │
│ personality        │  │ bound receipts      │  │ separate app host  │
└────────────────────┘  └─────────────────────┘  └────────────────────┘
```

The boxes group responsibilities, not isolated processes. `*` marks optional
integrations. June owns conversation and synthesis; workers own execution.
Rivet provides persistent actors, queues, and workflow journals rather than a
second custom workflow engine. Model providers are replaceable; permissions stay
in host code, outside personality and memory. The global public-safe personality
is distinct from private learned preferences.

An uncertain external send or launch stays **unknown**, not silently retried.
Durability is not exactly-once delivery. Coding admission is not authority to
deploy June, and a worktree is not a security sandbox. App publication uses a
separate exact prepared source/audience receipt. Dashboard sign-in, PINs, provider
consent and authenticated operator/recovery controls remain protected. Tool access
does not automatically inject another person's original history into a prompt.
Verified owner identity is attribution, not a universal safety guarantee; June
judges the actual request, impact and disclosure audience on every task.

### June's repository specialist

For questions about her own code, June delegates to the stable `june-repo`
worker, which calls `repository` with a self-contained question. Other execution
workers consult the same specialist before repo-dependent conclusions or coding
tasks. It is available for admitted task requests when execution and the
capability are enabled, not for automated/completion turns.

Before reasoning, the specialist loads the complete public GitHub source archive
into memory, including docs, scripts and tests. It receives the full file
inventory and can search/read text in bounded pages; it does not put every file
in every prompt. It uses the configured deep model, or the normal model if none
is configured, in an isolated context with no MCP, shell or host-file access.
The snapshot is pinned to the running release commit (public `main` at first
consultation in a non-release instance) and cached until restart. No credentials
are sent to GitHub. A failed download stops consultation without a partial local
fallback. Each question allows at most twelve model calls and returns revision
and source citations, not proof of live configuration or health.

This covers the published source tree, not Git history, untracked files,
submodule contents or Git LFS payloads. Binary/link entries are inventoried but
not interpreted or followed. Snapshot data is shared; question/model context is
not. Normal worker history retains the resulting report under its existing
scope and deletion rules. Source publication does not prove runtime activation.

## Running a local instance

Use Linux, Node 24, and pnpm 10.33.0. The repository pins its Node runtime in
`.npmrc` and dependencies in the lockfile. Rivet’s native engine runs locally;
no Rivet Cloud account or separate PostgreSQL server is required.

```sh
pnpm install --frozen-lockfile
cp config.example.json config.local.json
cp .env.example .env
```

Edit the private copies before starting:

1. Choose a supported model and supply its credential through the environment.
   OpenAI uses the **Responses API**, Anthropic uses **Messages**, and Codex uses
   its official app-server and a dedicated authenticated home. A generic
   chat-completions endpoint is not interchangeable.
2. Set a random `JUNE_OPERATOR_TOKEN` of at least 32 characters. Configuration
   refers to environment variable names, never embedded secret values.
3. Configure the Slack workspace, bot, signing secret, and exactly one human
   owner identity for that workspace. Replace the example webhook domain in
   [`manifest.json`](manifest.json), and review its requested scopes before
   installing it. A requested scope is not an installed grant.
4. Leave native coding, memory, imports, and other optional integrations off
   until their credentials, consent, storage, and isolation are understood.

```sh
pnpm start
# Development with reload:
pnpm dev
```

The HTTP listener defaults to `127.0.0.1:3080`. `/health` reports process/runtime
readiness—not provider authentication, message delivery, or completion of work.
Publish only the required signed webhook paths through HTTPS. Keep the operator
API, console, and Rivet engine/inspector private.

For channel-free provisioning, set `setupMode: true`, remove channel blocks,
set `owner.identities` to `[]`, and keep coding disabled. See the
[operation guide](docs/usage.md#chatgpt-subscription-and-initial-setup) for the
model setup requirements and limitations.

### Environment

| Variable | Purpose |
| --- | --- |
| `JUNE_CONFIG` | Private config path; defaults to `config.local.json`. |
| `JUNE_OPERATOR_TOKEN` | Private operator authentication. |
| `MODEL_API_KEY` | Example API-model credential; the name is configurable. |
| `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN` | Slack webhook verification and bot access. |
| `JUNE_ALLOW_NATIVE_CODING` | Explicit native-execution gate; off by default. |
| `JUNE_ALLOW_AGENT_ENVIRONMENTS` | Opt-in [per-worker BoxLite command environments](docs/execution-agents.md#per-worker-command-environments), with agent-browser preloaded. |
| `JUNE_ALLOW_MEMORY`, `JUNE_ALLOW_MEMORY_MODELS` | Separate retention and model-processing gates. |
| `JUNE_ALLOW_HISTORY_IMPORTS` | Additional history-import gate; not account consent. |
| `RIVETKIT_STORAGE_PATH` | Persistent engine storage; defaults under `.data`. |

See [`.env.example`](.env.example) and [configuration details](docs/usage.md)
for optional providers, engine settings, and feature-specific requirements.

## Security and privacy

June is **not a sandbox or a multi-tenant service**. Native agents run with their
host’s access. Keep credentials, private homes, unrelated repositories, and
administrative services outside their reach using real process/network isolation.

Conversation history, journals, imported sources, credentials, and authenticated
browser state are private runtime data, not repository assets. Evidence-store
encryption does **not** encrypt Rivet history or journals. Configure filesystem
permissions, encrypted storage, backups, and retention separately. Model calls
send authorized context to the selected provider.

Do not publish `.env`, local configuration, data directories, raw logs, screenshots
of private sessions, or a copy of this working directory. Ignore rules are a
guardrail, not a secret scanner. Existing Git history needs its own review; see
the [publication checklist](docs/publication.md).

## Development

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm test
```

Tests use disposable state, fake service boundaries, and real local Rivet engines.
Browser tests also need the matching Playwright Chromium installation. They do
not establish live provider compatibility or production recovery. Known Rivet
shutdown/alarm diagnostics and replay/migration limits are documented in the
[operation guide](docs/usage.md#development-checks-and-limitations).

| Area | Read more |
| --- | --- |
| System design | [Architecture](docs/architecture.md) |
| Conversation workers | [Execution agents](docs/execution-agents.md) |
| Remote coding | [Ordinary Amp jobs](docs/amp-jobs.md) (SSH transport, separate from Puck/MCP) |
| Reminders and durable programs | [Wakeups](docs/wakeups.md), [workflows](docs/workflows.md) |
| External tools | [MCP connections](docs/mcp-connections.md), [Slack](docs/slack.md), [GitHub](docs/github.md), [browser](docs/browser.md) |
| Trusted external agents | [Optional inbound agent MCP](docs/agent-mcp.md): configure `agentMcp`, separately from outbound `mcp` connections |
| Evidence and learning | [Memory](src/memory/README.md), [reflection](src/reflection/README.md) |
| Hosting | [Deployment](docs/deployment.md), [dynamic apps](docs/dynamic-apps.md) |
| Implementation versus activation | [Capability inventory](docs/implementation-plan.md) |

Inbound `agentMcp` is opt-in administrative access to shared owner-private
context, named operator controls, messaging, and signed outbound callbacks.
Use independently revocable client credentials and explicitly allowed callback
destinations; never reuse the operator token. Durable admission recovery and a
single-delivery background pump resume queued work after restart; uncertain
deliveries are not blindly retried. Forgetting invalidates pending callbacks,
but cannot recall dispatched effects. Enabling configuration requires a separate
operator decision; this implementation is not evidence of a production deployment
or a verified live receiver. See the setup guide before provisioning credentials.

There is no license file yet. Public visibility alone would make this
source-available, not grant an open-source license.
