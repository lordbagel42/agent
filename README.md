# June

A persistent personal companion, built with TypeScript and Rivet.

June talks in Slack, remembers scoped context, and delegates work without turning
every task into a new chatbot. She has one evolving personality, separate workers
for execution, and durable records of what was requested, approved, and actually
completed.

**This is a personal project, shared for the code and ideas—not a turnkey product.**
Expect owner-specific behavior, rough edges, and changing interfaces. Source
support for a feature does not mean it is enabled, live-tested, or safe to expose.

[Architecture](docs/architecture.md) · [Configuration](docs/usage.md) ·
[Deployment](docs/deployment.md) · [Publication checklist](docs/publication.md)

## What’s here

- **Conversation that continues.** Slack DMs, mentions, threaded follow-ups,
  reactions, multipart replies, and intentional silence. Owner and guest context
  have separate privacy and permission boundaries.
- **Work in the background.** Persistent execution agents handle substantive
  tasks while June keeps chatting. Native coding jobs can use Amp, Codex, Claude,
  or Pi, with explicit approval, worktrees, cancellation, and recovery records.
- **Memory with provenance.** Optional encrypted evidence storage, scoped recall,
  reviewed personality changes, forgetting, and explicitly approved history
  imports. Reflection proposes hypotheses; it cannot grant itself permissions.
- **Tools with boundaries.** Optional web search, MCP connections, scoped browser
  recipes, and vault-backed credentials. Tool discovery is not authorization.
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
│ Slack · WhatsApp*    │                 │ config · approvals   │
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
│ evidence · recall  │  │ web search · MCP    │  │ approved jobs      │
│ reviewed curation  │  │ browser · vault     │  │ worktrees/verifier │
│ personality        │  │ scoped grants       │  │ separate app host  │
└────────────────────┘  └─────────────────────┘  └────────────────────┘
```

The boxes group responsibilities, not isolated processes. `*` marks optional
integrations. June owns conversation and synthesis; workers own execution.
Rivet provides persistent actors, queues, and workflow journals rather than a
second custom workflow engine. Model providers are replaceable; permissions stay
in host code, outside personality and memory. The global public-safe personality
is distinct from private learned preferences.

An uncertain external send or launch stays **unknown**, not silently retried.
Durability is not exactly-once delivery. Coding approval is not deployment
approval, and a worktree is not a security sandbox.

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
| Approved remote coding | [Ordinary Amp jobs](docs/amp-jobs.md) (SSH transport, separate from Puck/MCP) |
| Reminders and durable programs | [Wakeups](docs/wakeups.md), [workflows](docs/workflows.md) |
| External tools | [MCP connections](docs/mcp-connections.md), [Slack](docs/slack.md), [GitHub](docs/github.md), [browser](docs/browser.md) |
| Evidence and learning | [Memory](src/memory/README.md), [reflection](src/reflection/README.md) |
| Hosting | [Deployment](docs/deployment.md), [dynamic apps](docs/dynamic-apps.md) |
| Implementation versus activation | [Capability inventory](docs/implementation-plan.md) |

There is no license file yet. Public visibility alone would make this
source-available, not grant an open-source license.
