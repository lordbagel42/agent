# June

The design is one conversational identity across messaging platforms,
with independent execution workers, replaceable models and tools, and durable
work rather than a new bot/session for each channel. June uses she/her pronouns.
Her owner will develop her personality with her rather than receiving a fixed
character sheet. TypeScript is the implementation language.

This is the accepted design, not a completion or production-availability claim.
The [implementation evidence matrix](implementation-plan.md) pins the audited
source revision and separates **implemented / host-integrated / June-callable /
enabled / live-verified**. Missing deployment evidence remains unknown. A source
module, an operator API, a model action and an enabled live service are different
facts; planned or in-flight changes do not establish any of them.

```diagram
┌──────────────────────────────────────────────────────┐
│ Slack · WhatsApp Cloud API · future channel adapters  │
└────────────────────────┬─────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────┐
│ Authenticated ingress · identity/scope · durable inbox│
└────────────────────────┬─────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────┐
│ June: conversation, beliefs, personality, commitments │
│ Rivet actors + journaled workflows                    │
└─────────────┬─────────────────────────┬────────────────┘
              ▼                         ▼
┌────────────────────────┐   ┌─────────────────────────┐
│ Memory + reflection    │   │ Independent supervisors │
│ Evidence graph + Git   │   │ Amp · other coding tools│
│ Dreaming + jury        │   │ MCP · browser · vault   │
└────────────────────────┘   └─────────────────────────┘
```

Model providers and credentials sit below these layers, not inside the channel
adapters. Permission checks, credential release, and deployment controls sit
outside the model's editable personality and memory.

## Rivet instead of Temporal

Use RivetKit 2.3.21 and its self-hosted engine. Rivet provides per-actor state,
SQLite, queues, sleep/wake, and journaled workflows. Its self-hosting baseline is
one Rust engine with a persistent data directory plus the TypeScript application;
neither a Rivet Cloud account nor a separate Postgres service is needed initially.

This is a fit for an owner-scoped companion and per-job coding supervisors. Keep
the domain and channel contracts independent of Rivet. Do not adopt the separate,
preview agentOS product merely because it is available. Use Rivet's workflow
primitives for orchestration; do not build a second workflow engine. Its packaged
Services process is disabled. The current npm distribution still pulls agentOS
dependencies transitively; process simplicity does not mean a small dependency
tree.

Important differences from a generic job queue:

- Ordinary queue entries are deleted on receive, not on completion. Use a
  journaled workflow for processing that must resume after interruption.
- State is normally saved on a throttle. Explicitly flush intent before external
  side effects and persist receipts before reporting success.
- A journal cannot make an external send exactly-once. Ambiguous sends must be
  visible and held for reconciliation rather than automatically repeated.
- Persist the self-hosted engine's data directory and keep its control plane and
  inspector private. The webhook server is the public boundary.

Development recovery checks use the real engine with disposable state and fake
external boundaries to exercise accepted-state survival and held ambiguous
sends/launches. These checks are not evidence that every dormant production
workflow has replayed successfully. Native `transaction_closed` shutdown errors
were recorded during earlier RivetKit 2.3.21 validation; this document does not
establish whether a current deployment reproduces them. Extended recovery and
idle sleep/wake checks remain separate from process health.

Sources (reviewed 2026-09-26):

- https://github.com/rivet-dev/rivet
- https://rivet.dev/actors/docs/state
- https://rivet.dev/actors/docs/queues
- https://rivet.dev/actors/self-host/control-plane/vm

## First increment

Slack Events API and the official WhatsApp Cloud API are registered transports.
Linq is an experimental alternative transport.
Linq Partner API V3 documents RCS with SMS fallback; the offline text/webhook
prototype is not wired into June. Real account/carrier validation and durable
integration are still required, and conflicting RCS reaction documentation must
be resolved before enabling reactions on that transport.

The [WhatsApp setup](whatsapp.md) binds exactly one owner to the business phone
number. Its 24-hour customer-service window is enforced; proactive templates,
inbound media and groups are not implemented. This is a Business Platform
integration, not personal-account pairing. A narrow blue/green ingress forwards
signed webhooks to the ready slot; Meta retries unavailable ingress rather than
a second local durable queue. Configuration and enrollment remain separate from
source support, and June can inspect the missing setup through her capability matrix.

The cross-channel design links verified owner identities. Bind the Slack owner
to an explicit user ID in the configured workspace through
[configuration](../src/config.ts), not a display name. Other channel identities
use configured mappings. Owner DMs share one conversation;
Slack channel threads never inherit private DM history or coding authority.
The [routing policy](../src/core/routing.ts) also supports separately scoped
Slack guest/channel conversations when configured. A known Slack sender or a
channel named after the owner does not establish owner identity.

The first increment was headless. Source now includes an optional private console
and owner-private dashboard login links alongside the authenticated operator API,
webhook ingress and health endpoint. See the matrix for wiring and activation
evidence. Console access is not a tool permission grant; development does not
automatically provision a dashboard, connector or account.

OpenAI and Anthropic model adapters normalize a small, validated response
contract. Custom base URLs are explicit configuration, never model-controlled.
Subscription credentials are not treated as interchangeable API keys.
ChatGPT subscription access uses the official, pinned Codex CLI with a dedicated
credential directory and its supported sign-in flow. When `protocol: "codex"` is
selected outside setup mode, the host uses the [hot Codex provider](../src/models/codex-hot.ts)
for conversational inference, separate from June's coding worker. Channel-free setup mode is an
explicit configuration option, not a statement about the current live instance.

Coding runs through a separate persistent supervisor, using Amp's SDK first.
Native local Amp execution is opt-in, operates on configured workspace paths,
and is not a security sandbox. It is inappropriate on a host containing secrets
or resources the coding agent must not access. Never describe Amp's report as an
independently verified deployment or completion.

Conversation history and delivery/job records are working context, not proof of
comprehensive long-term recall. Source also contains encrypted evidence storage,
scoped retrieval/extraction, private personality curation, historical imports and
reflection/jury requests behind separate activation gates. These implementations
do not establish that every planned operation is host-integrated, June-callable
or live-verified. Use the matrix's operation-level evidence.

## A changing personality, grounded in evidence

Borrow behavior selection from Vector, not its implementation. Vector's public
`victor` source uses a delegation stack, eligibility checks, strict-priority and
score/weighted dispatchers, habituation, cooldowns, and decaying stimulation.
The inspected adaptation is mostly authored rules and small persistent counters,
not a learned personality. Some of that public source is proprietary, so use the
ideas without copying the code.

June should have three different kinds of state:

1. **Stable charter:** identity, honesty, privacy, and the owner's authority.
   June cannot revise this to give herself more permissions.
2. **Slowly changing personality:** one public-safe global profile for June's
   conversational style, tastes, values and interests, with versioned explanation
   and rollback. Private relationship context and evidence-backed learned patterns
   remain scoped overlays, not separate public identities or material to copy into
   the global profile. The owner's corrections outrank inferred preferences;
   publishing a private-derived suggestion requires review of the exact public
   payload. The matrix distinguishes existing scoped curation from global-profile
   implementation; neither permits June to edit her own authority.
3. **Transient drives:** curiosity, desire to finish commitments, social
   initiative, novelty, and cognitive load. These decay, habituate, and compete
   with cooldowns. They select useful behavior, not claims of biological needs,
   subjective experience, or consciousness.

The knowledge graph connects entities (people, projects, events, concepts),
episodes, claims, preferences, commitments, and June's self-model. Edges record
who asserted a claim, the exact source and access scope, when it was observed,
when it applies, confidence, contradictions, and supersession. A belief is not a
fact because June repeated it. Preserve incompatible hypotheses until evidence
resolves them. Distinguish June's emerging tastes from beliefs about her owner.

Use append-only source events and a rebuildable SQLite graph/index initially.
Use Git for curated Markdown/JSON memory, beliefs, personality revisions, and
dream patches—not every raw email. Graph versions reference source IDs and Git
commits. Entity resolution must not merge people by display name alone. Every
retrieval filters by the current audience before ranking or summarization;
private memories never enter a public-channel prompt.

Forgetting must invalidate raw data, graph edges, embeddings, summaries, caches,
and dream-derived claims. Git reverts alone do not erase private data from Git
history. Sensitive imports stay outside the memory Git repository; deletion
requires tombstones, derivative invalidation, and the documented backup/history
retention policy. Never put vault credentials into either memory store.

## Reflection is continuous; interruption is deliberate

Run reflection as separately scheduled Rivet workflows, interleaved with real
work rather than one unbounded recursive prompt:

- **After an interaction:** extract evidence-backed memory proposals and notice
  corrections, unresolved commitments, and surprises.
- **While idle:** replay relevant episodes, connect previously separate topics,
  revisit uncertain beliefs, and investigate a curiosity queue.
- **Deep dreams:** synthesize patterns, simulate alternative responses, propose
  personality/skill changes, and evaluate those changes against held-out
  interactions. A dream is a hypothesis, never another independent source.
- **Jury sessions:** independent first-pass agents argue larger decisions from
  different perspectives; a critic checks evidence, a synthesizer records the
  decision and dissent. Agreement is not proof. High-impact actions still obey
  the external approval policy.

Use the owner's preferred strong reasoning model (GPT-6 Astra where supported)
for deliberation. Jev is a separate typed-decision provider, not a text generator:
use atomic questions for relevance, novelty, uncertainty, or interruption cost,
with abstention and owner-specific evaluation. Do not interpret model confidence
as a permission grant or an automatically calibrated truth probability.

Even with effectively unlimited tokens, respect upstream rate limits, concurrent
work limits, cancellation, privacy, quiet hours, and the owner's attention.
Deduplicate curiosity tasks, reserve capacity for live conversation, and detect
reflection that repeatedly produces no new evidence. Background reflection can
run frequently without messaging the owner every time. Material surprises,
completed commitments, and useful questions may earn an interruption.

## First-deployment history import

Historical Slack and email imports require the account owner's explicit
authorization for the selected coverage. This document grants no account access,
permission to send messages to contacts, or authority to widen platform access.

At onboarding, bind the actual accounts and show the exact read scopes and
source/date coverage. Use resumable paginated imports and platform rate limits;
Slack permissions, retention, and API limits may make “every message” impossible.
Read-only credentials and a local encrypted raw store precede extraction. Keep
mailboxes, workspaces, threads, participants, and source links as provenance;
content about third parties retains its original privacy scope. Stage graph
proposals for review, report gaps, and do not replay historical action requests
as new instructions. Import progress is visible while normal conversation stays
available. The first graph is a revisable interpretation, not a claim to have
understood a person completely.

## Capability-local acceptance work

These are design requirements, not an ordered list of wholly missing modules.
Some foundations are implemented and integrated; others are unmounted or still
planned at the matrix's pinned revision. Each increment must expose a usable
June-facing path where appropriate, preserve external approval boundaries, and
report activation/live evidence separately.

1. **Memory and personality:** the evidence graph, Git-curated memory,
   contradiction/deletion semantics, and visible personality revisions above.
   Then add the read-only, resumable onboarding imports.
2. **Credential and tool plane:** evaluate Bitwarden's supported agent APIs
   against the existing personal vault. If they cannot safely serve it, build a
   narrow broker around supported vault access with owner-granted item/origin
   scopes, short-lived use grants, audit, and revocation. June requests “use this
   account for this action”; browser/API workers receive the credential, not the
   prompt. MCP servers and browsers use the same capability/approval boundary.
3. **Links and configuration:** an owner-controlled domain for short links,
   prefilled forms, and action links. Opaque unguessable IDs, expiry, revocation,
   audience checks, and explicit POST confirmation for mutations; chat unfurlers
   and GET requests must never execute an approval. Add a small modern console
   backed by the same APIs as chat configuration, not a second control plane.
4. **Initiative and dreams:** event triggers, durable timers, curiosity/attention
   arbitration, continuous reflection, and evaluated dream patches.
5. **Juries and self-improvement:** June turns feedback into an Amp job in an
   isolated worktree, with scoped context rather than her full private memory.
   Another process verifies tests and regressions. Versioned rollout, health
   checks, rollback, and migration compatibility precede any self-update. Keep
   credential and approval enforcement outside June's writable checkout.
6. **Additional runtimes/auth/channels:** Claude Code, Codex, Pi, and others
   implement the coding-runtime contract. API keys/custom URLs and subscription
   sessions are distinct auth strategies. Use only the provider's supported
   subscription client/OAuth flow and terms; never relabel a browser/session token
   as an API key. Unsupported combinations fail explicitly. RCS remains deferred.

The conversational agent owns personality and communication. Workers own task
execution. Background dreaming may suggest work but cannot expand its authority.
Persistence means tracked commitments, recovery, safe retries, and explicit
blockers—not ignoring revocation, repeating irreversible actions, or claiming
that every task is possible.

Further sources reviewed for the June steering (2026-09-26):

- https://github.com/os-vector/wire-os-victor/tree/main/engine/aiComponent/behaviorComponent
- https://github.com/os-vector/wire-os-victor/tree/main/engine/moodSystem
- https://github.com/os-vector/wire-os-victor/blob/main/LICENSE-README
- https://docs.typesafe.ai/ (Jev's typed decision primitives and confidence)
