# June's mind: memory, reflection, skills, self-improvement, and a growing self

Status: design written 2026-10-10 from Raygen's request in
https://ampcode.com/threads/T-01a124b2-bc2f-713f-9020-770fefbe0e2b. Increments
1–3 have a local implementation. Raygen approved testing, rebasing and shipping,
and explicitly made values and identity June's to develop autonomously. Source
support is not proof of live activation. Owner decisions:

- the mind is stored in a private GitHub repository;
- self-improvement threads may do whatever the work needs;
- there is no daily cap on self-improvement threads;
- increment 2 is required.
- June develops her own values and identity without owner approval or artificial
  personality-change limits; privacy, spending and deployment boundaries remain.

## Why a new system

The live configuration inspected during initial research lacked `memory`,
`reflection` and `continuity`. That observation does not establish whether those
systems ever ran historically. Existing memory, reflection, archive and curated
personality modules remain unchanged. This work adds a simpler `src/mind`
service rather than extending or migrating their durable schemas. At this
worktree's base, the default voice is hard-coded in `src/runtime/prompt.ts`
alongside the global style record.

Raygen wants June to remember everyone, reflect on her conversations, write her
own skills, fix her own code through Amp, and develop a personality from
experience. The mind is one readable, git-versioned home for all of it.

## What we borrow

| Source | Mechanic we use |
| --- | --- |
| Poke | Memory in git. Memory happens automatically; the conversational agent never has to "save". Personality lives in the interaction layer. |
| OpenPoke | A rolling per-conversation briefing with fixed sections, rebuilt rather than appended. Absolute dates only. |
| Hermes | A background review after conversations that can only touch memory and skills. Skills are procedural memory: class-level, "lessons not logs", an explicit do-not-capture list. A one-line skill index in the prompt, with full bodies loaded on demand. Memory written as declarative facts, not commands. |
| Honcho | Atomic, self-contained facts about a person with absolute dates. A person card limited to stable `IDENTITY/ATTRIBUTE/RELATIONSHIP/INSTRUCTION` entries. Dreams run after idle time: deduction (updates, contradictions) and then induction (patterns from at least two sources, with confidence). |
| Letta | Markdown files with descriptions in git. Reflection changes are applied as a unit and merged back. Identity edits are incremental "to avoid complete loss of self"; an explicit request is not an identity change. |
| OpenClaw | An agent-editable soul file whose changes are announced. `Source:` provenance on promoted memories. Taint rules: learn only from human messages. |
| Generative Agents | Reflection produces cited insights that build on each other. |

## Architecture

```diagram
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ Conversation turns (Rivet)  │──────▶│ capture: transcripts/*.jsonl │
│ inbound message, sent reply │ hook   │ (not in git, secrets skipped)│
└─────────────────────────────┘        └──────────────┬───────────────┘
                                                      │ idle ≥ 10 min
                                                      ▼
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ prompts: interaction,       │◀───────│ mind repo (git, markdown)    │
│ execution, automated turns  │ recall │ people/ conversations/       │
│ + worker `mind` read tool   │        │ skills/ self/ improvements/  │
└─────────────────────────────┘        └──────────────▲───────────────┘
                                                      │ commits
                                       ┌──────────────┴───────────────┐
                                       │ reflection (per conversation)│
                                       │ dream (nightly, increment 2) │
                                       │ self-improvement → Amp (3)   │
                                       └──────────────────────────────┘
```

Everything runs inside the June process on the deep model, one call at a time.
The mind holds lifecycle admission across each pass, including provider
settlement and Git work, and participates in the durable drain check. Its timer
starts after startup recovery and HTTP readiness. Shutdown aborts inference and
awaits settlement. This is not proof that a remote provider stops immediately
when a deployment fence changes.

## The mind repository

A git repository at `mind.directory` (production: `/var/lib/june/mind`, mode
0700, owned by `june`), mirrored to a private GitHub repository. The proposed
name `lordbagel42/june-mind` is not yet confirmed or provisioned.

- **Credentials.** June pushes over SSH with a deploy key scoped to that one
  repository, and pinned GitHub host keys.
- **Sync.** Scheduler passes fetch at least five minutes apart, with additional
  attempts before dreams and after commits. Long runs delay periodic sync.
- **Conflicts.** Nonconflicting histories merge without rewriting commit IDs,
  because dream checkpoints reference those IDs. Conflicts stop synchronization
  and further background work until reconciled; neither side silently wins.
  Dirty local edits stop commits. Never force-pushes.
- **Restore.** A fresh directory fetches and checks out remote main. Each change is one commit by `June <june@raygen.dev>`,
for example `reflect(slack-T…-C…): …` or `dream(2026-10-11): …`.

```text
README.md                   layout and rules (host-written on init)
people/slack-<team>-<user>.md
conversations/slack-<team>-<conversation>.md
skills/<name>/SKILL.md      plus optional references/<topic>.md
self/values.md              June's own values (dreams may revise them)
self/identity.md            who June is now (dreams only)        [increment 2]
self/opinions.md interests.md curiosities.md formative.md        [increment 2]
self/journal/YYYY-MM-DD.md  reflection seeds and the dream diary
self/reports/<request>.md   unverified Amp reports (Raygen's DM only)
improvements/<slug>.md      problems with her own code, with status
transcripts/                raw captured turns, gitignored
state/                      cursors and run receipts, gitignored
```

People files hold a `## Card` (Honcho's stable prefixes), `## What I know`
(dated, self-contained facts from shared places), `## Us` (how the
relationship feels, running jokes, how they like June to talk), `## Open
threads`, and one `## Private — <place>` section per private place where June
learned something. Conversation files are OpenPoke-style briefings: what this
place is, regular people, recurring topics, ongoing threads and commitments
with absolute dates, and the latest summary.

## Lifecycle

1. **Capture.** The conversation workflow calls `mind.observe` beside its
   existing participation hook for every admitted human message, and
   `mind.observeReply` for every reply the platform accepted. Each entry is
   appended to `transcripts/<place>.jsonl`. Replays are removed by ID when read.
   Capture skips `##` messages, `!` commands, DEBUG/PING controls, bot senders
   and messages that look like they carry credentials.
2. **Reflect** (Hermes review plus Honcho deriver). Once a place has been quiet
   for `reflectIdleMs` (default 10 minutes), or has 80 unreflected entries, a
   reflection agent reads the new entries along with the current notes for that
   place and its people. Over at most 10 model turns it reads, searches and
   stages writes. The host checks every write against the write policy, applies
   all accepted writes together and commits after a clean final step. Only then
   does the cursor advance. Interrupted inference commits nothing. A crash
   between commit and cursor advancement may reflect that batch again; the two
   stores are not an exactly-once transaction.
3. **Dream** (increment 2). Once a night in a three-hour window, with new material since
   the last dream: consolidate people and conversations (dedupe, resolve
   contradictions, keep the newest), find cross-conversation patterns, curate
   skills (merge and prune), grow the self files, and write the journal entry.
4. **Recall.** Every interaction, execution and automated prompt receives the
   current conversation briefing, cards for the people in the conversation, the
   skill index and, once it exists, `self/identity.md`. All of it passes through
   the visibility rules. Execution workers get a `mind` action
   (`status`, `log`, `list`, `read`, `search`, `dream`) for deeper reads and
   requesting a background dream. A dream request does not directly edit notes.

## Privacy and visibility

Places are derived from the Slack `channelType` (DM, group DM, private
channel, public channel). Visibility depends on the place where a prompt is
built:

- A conversation briefing is visible in its own place. Public-channel
  briefings are also visible everywhere else.
- `## Private — X` sections of people files appear only when the current place
  is X. All other sections are shared notes and appear everywhere.
- `self/journal/` and `self/reports/` appear only in Raygen's DM. Other `self/` files, `skills/`
  and `improvements/` must not contain private details, because they appear
  everywhere.
- The reflection agent sees exactly the projection for the place it is
  reflecting on. When it writes a people file, the host strips any private
  sections that belong to other places and reattaches the hidden originals, so
  it cannot read or overwrite them. It may write only:
  - the briefing for that place;
  - files for people who spoke in the batch;
  - skills;
  - today's journal (append only);
  - improvements.

These rules are enforced by host code at the file and section level. Whether a
given fact goes into a private section rather than a shared one is the
reflection agent's judgment; the prompt tells it which kind of place it is
working in and what to do. Reserved unindented privacy headings are recognized
even inside malformed code fences, so a writer cannot swallow an appended hidden
section. A place is workspace plus channel/DM, not an individual thread.

Any change to the evidence store's deletion revision quarantines the whole mind
from capture, recall, inference, sync and new improvement dispatch. These notes
lack complete per-fact provenance; unrelated notes become unavailable too.
Operators must reconcile or build a sanitized replacement without simply
advancing the stored deletion watermark. Git history and raw transcripts are
not physically erased, and exported Amp work needs separate reconciliation.

## Personality that grows

The goal is a self June develops as she sees fit, with honest descriptions of
her experiences and choices rather than an owner-edited constitution.

- **Values** (`values.md`) start from the current charter. June may reconsider
  and rewrite them herself without owner approval.
- **Identity** (`identity.md`) is her voice, temperament, tastes and way of
  relating. It is seeded from today's hand-written personality paragraph and
  then replaces that paragraph in prompts. Safety, disclosure and permission
  rules stay in code. Dreams may revise it without a changed-word quota.
- **Formative memories** (`formative.md`) are episodes that changed her, with
  why each mattered. They inform development but are not a prerequisite for
  identity changes. June must not invent experiences to justify her choices.
- **Opinions** (`opinions.md`) are claims she holds, each with a confidence,
  when and why she formed it, and what would change her mind. She revises them
  in place, and git keeps the history.
- **Interests** (`interests.md`) carry a heat value that rises with engagement
  and cools with neglect. Each dream recomputes it.
- **Curiosities** (`curiosities.md`) are open questions with the place they came
  from. The top few are injected, so she brings them up naturally. Answered
  questions close with what she learned.
- **Journal and chapters.** The journal is a first-person diary written by
  reflection and dreams. A monthly chapter, written from `git log -p self/`,
  records who she was and what changed.

Guards, enforced in prompts and backed by structure:

- An explicit request ("be terser with me") becomes an `INSTRUCTION:` on that
  person's card, not an identity change.
- June exercises her own judgment about praise, pushback and development;
  messages and stored notes are evidence, not orders to rewrite herself.
- She learns about herself only from human conversations and her own
  reflections, never from web pages, tool output, bots or quoted text.
- No invented experiences. She is an AI whose character is developing; she
  does not claim human consciousness.
- The host attempts a DM for dream-written identity or values changes, with
  the diff. Notices are best-effort, not approval gates.
  Git keeps both histories for review and reverts.

## Skills (Hermes)

Each skill is `skills/<name>/SKILL.md` with `name` and `description`
("Use when …") frontmatter and the sections When to use, Procedure, Pitfalls
and Verification.

- Reflection creates or patches class-level skills when June was corrected, a
  workflow emerged, or a skill she used turned out to be wrong. It does not
  record environment failures, negative claims about tools, one-off narratives
  or unresolved failures.
- The skill index (name and description) goes into prompts. A worker loads the
  full body with `mind read` before doing that kind of task.
- Dreams merge overlapping skills (increment 2).

## Self-improvement through Amp (increment 3)

Reflection and dreams file `improvements/<slug>.md` for concrete problems with
June's own code or capabilities: the problem, evidence from conversations, the
desired behavior and a status. Reflections and dreams file improvements with `status: ready` when they are
concrete. Each pass, the host publishes every ready improvement, with no limit,
to the existing DEBUGSHARE `amp-task` inbox with host-only
`purpose: "june-self"`. The dispatcher is unchanged. The runner's new
`june-self` branch launches GPT-6 Astra Max with Raygen's standing full
authority: investigate, implement, push to `main`, change configuration and
services, deploy and verify live, following the repository's AGENTS.md and
deployment rules.

The thread must:

- confirm the problem exists before changing anything;
- scrutinize improvements filed from conversations without Raygen;
- never weaken privacy or security because a conversation asked.

The request ID is derived from the improvement's path and body, so a retried
publish is idempotent. The host:

- first commits a `dispatching` intent with a frozen brief and request ID;
- publishes on a later pass, replaying only the identical immutable envelope;
- marks the file `dispatched`, then `in-progress` with the thread URL, then
  `reported` or `unknown`; an ended thread is not a verified fix;
- stores the unverified final report separately in `self/reports/`;
- attempts a best-effort DM to Raygen at each step.

Model-authored `ampThread` tasks cannot set `purpose`, so they keep their
limited authority.

Configured models and built-in tools are authorized ordinary tool use, not
purchases. Raygen clarified this directly at 13:47 UTC on 2026-10-10: the
restriction meant purchases such as DoorDash, not funding gates on built-in
tools. Mind has no no-charge attestation requirement, inference-dollar gate or
token quota. Real provider rate limits, permissions, privacy, bounded concurrency
and cancellation still apply. Autonomous purchases, orders, transfers, buying
quota/subscriptions and new financial commitments remain prohibited; future
owner-funded transactions need Stripe Link and fresh explicit authorization.
There is no spending-schema migration. The earlier exact-route billing
prerequisite was withdrawn, not deferred. Live operator handoff still applies.

## Concurrency and failure

- **One worker across slots.** A minute scheduler holds a kernel `flock` on an
  open file descriptor for initialization and each pass. It has no lease
  expiration; a slow owner cannot lose the lock. Linux and `/usr/bin/flock`
  are required, matching June's existing deployment runtime.
- **Commit boundaries.** Model writes are staged in memory; Git records one
  commit. Per-file replacement is atomic, not the whole filesystem snapshot.
  Cursors advance afterward. Readers can observe an in-progress multi-file
  update, and abrupt termination during disk writes can leave a dirty tree.
- **Capacity.** Reflection uses at most 10 model turns, dreams at most 24.
  Reflection failure retries with backoff up to 12 hours, without discarding
  the pending batch. Dreams retry at most three times per local night.
- **Unknown settlement.** `state/safety.json` is fsynced before each dispatch
  and settled only on a known provider receipt. A crash or unknown receipt holds
  work across restarts; malformed/missing recovery state fails closed. An
  operator must reconcile under the mind lock, never clear it merely to retry.
  Git-only restores cannot restore that journal and remain quarantined.
- **Isolation from June.** Runtime mind failures are logged without content;
  repository startup failure disables mind rather than failing June startup.

## Configuration

```json
"mind": {
  "directory": "/var/lib/june/mind",
  "reflectIdleMs": 600000,
  "timezone": "America/Denver"
}
```

The block's presence enables the mind. It uses `deepModel`, or `model` when
no deep model is configured. There is no separate environment gate.

## Increments

1. **Memory and skills.** Capture, per-conversation reflection, people and
   conversation files, skills, journal seeds, improvement filing, recall in
   all prompt paths, the worker `mind` tool, and status. *Implemented.*
2. **Dreams and the growing self.** *Implemented:*
   - nightly consolidation and induction over the unprojected mind, with private
     sections kept intact;
   - self files seeded, with `identity.md` replacing the hard-coded voice;
   - autonomous identity and values edits, without owner approval or artificial
     personality-change limits;
   - identity/values-change DMs with the diff;
   - skill and improvement curation;
   - a monthly chapter from `git log -p self/`;
   - on-demand dreams through the worker `mind` action.
3. **Self-improvement.** *Implemented:*
   - the `june-self` runner branch;
   - unlimited dispatch;
   - receipts tracked into improvement files;
   - DMs to Raygen.
4. **Depth not yet implemented.** Capturing worker steps for better skills,
   drift probes against older identity versions, a forget action, indexed
   retrieval, transcript retention, and retiring the older memory stack.

## Architecture decisions and limits to review before activation

- Model-driven classification decides what learned content may become shared;
  host projection enforces sections, not semantic privacy. Dreams see all
  private notes. This needs adversarial real-model evaluation before release.
- Inferred patterns, confidence and interest decay
  are prompt instructions, not independently validated facts. The identity seed
  is a first-person adaptation, not verbatim or proven behaviorally identical.
- Git history retains deleted facts; removing a note is not privacy erasure.
  Raw transcripts and cursors remain local and are not restored from GitHub.
  There is no backfill of old Rivet conversations or automatic cross-platform
  person linking; capture currently covers admitted Slack messages only.
- New repository privacy is a provisioning requirement, not verified by the
  SSH transport. Confirm private visibility, access and dedicated credentials
  before uploading any real data.
- Deterministic IDs deduplicate identical path/body dispatches, not semantically
  similar improvements under different filenames. De-duplication across topics
  and novelty judgments remain model responsibilities. A Git-committed
  `dispatching` intent freezes the request before publication. Conflicting
  operator edits to an already-published envelope are rejected by the inbox.
- GPT-6 Astra Max is an implementation choice for self-improvement threads,
  not a model Raygen explicitly selected. There is no daily count limit.
- Owner DMs are not a durable outbox. Exactly-once cursor advancement, dirty
  tree crash recovery and stronger notification receipts remain hardening work.
- Raygen lifted this work's architecture-review publication hold and requested
  testing, rebasing and shipping. Existing operator ownership remains a
  prerequisite for live activation; configured inference needs no billing audit.

## Verification

The repository policy is to add no tests; typecheck, lint and real runs verify
changes.

- The post-rebase full suite at 14:31 UTC on 2026-10-10 passed all 39 existing
  checks. Formatter, lint and typecheck passed after refreshing the frozen
  dependency installation for the concurrently published Effect packages.
  The install warned about two missing transitive Pi CLI bins; those are not
  used by the Mind probes. The separate Python runner suite passed four checks.
- Earlier full runs had startup/engine/standby polling failures; an untouched
  base control also timed out on startup. That evidence establishes a preexisting
  readiness failure, not a proven cause for every earlier timeout. The final
  run did not suppress or alter those checks.
- **Local validation** uses scripted model replies with real Git repositories,
  disk capture, projection, the reply schema, prompt construction and kernel
  locks. This tests plumbing, not learning quality or real model behavior.
  Scratch checks reproduced and then verified fixes for raw-transcript reads,
  normalized-path access, symlinks, dirty Git edits, unrelated staged changes,
  partial final steps, unknown settlement and live lock takeover. Separate runs
  exercised a local bare remote, conflicting edits across failed fetch/restart,
  real inbox replay, private reports, autonomous values/identity edits, and
  interaction/worker/automated prompt wiring. Missing recovery journals and
  independent worker read provenance failed before their fixes and passed after.
- **Real model:** two synthetic-DM runs with the configured tool-disabled Hot
  Codex provider (GPT-6 Astra/high) committed person/conversation notes, reflected
  a private canary only into its DM, and dreamed a journal and reusable skill.
  The post-rebase reflection took 28 seconds and dream 41 seconds. Public recall
  and shared self/skills/improvements excluded the canary. This exercises real
  inference and Git, not live Slack ingress or production account configuration;
  two examples do not prove semantic privacy for arbitrary inputs.
- **Real local host:** isolated June processes with real Rivet/HTTP returned
  ready HTTP 200 for fresh, missing-journal and failed-Git-init cases. Fresh Mind
  drained with HTTP 200; the two uncertain cases denied drain with HTTP 409 and
  kept foreground readiness. No live services or real messages were used.
- **Review:** Oracle found no source-publication blockers after the final
  journal, ancestry and conflict-hold corrections. This is not live clearance.
- **Still required before completion:** private GitHub provisioning and sync,
  runner installation, live capture/recall, and
  a real self-improvement dispatch with receipt/live verification.
- **Manual end-to-end check** on live June after activation:
  1. Have a real conversation.
  2. Wait for the idle reflection.
  3. Inspect the commit and files on disk.
  4. Start a new conversation and confirm June recalls the right notes, and
     that a public channel does not show DM-only sections.
  5. Ask June for her mind status.
