# June's mind: memory, reflection, skills, self-improvement, and a growing self

Status: design written 2026-10-10 from Raygen's request in
https://ampcode.com/threads/T-01a124b2-bc2f-713f-9020-770fefbe0e2b. Increment 1
is implemented with this document; later increments are planned, not built.

## Why a new system

Live June (revision `ed5ae52`) has no long-term memory. Her configuration has
no `memory`, `reflection`, `continuity` or `personality` block, so the existing
encrypted evidence ledger, session archive, reflection actor, jury and curated
personality code (about 20,000 lines with tests) has never run. Each part needs
its own activation gate, review command and operator procedure, and none of it
writes anything a person can read. Conversation history lives only inside each
Rivet conversation actor, with no way to enumerate it across conversations.
Her personality is a hand-written paragraph in `src/runtime/prompt.ts` plus a
four-field style record.

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
The mind never holds lifecycle admission, so it never blocks a deploy drain.
It stops as soon as the lifecycle is fenced and redoes interrupted work later.

## The mind repository

A git repository at `mind.directory` (production: `/var/lib/june/mind`, mode
0700, owned by `june`). Each change is one commit by `June <june@raygen.dev>`,
for example `reflect(slack-T…-C…): …` or `dream(2026-10-11): …`.

```text
README.md                   layout and rules (host-written on init)
people/slack-<team>-<user>.md
conversations/slack-<team>-<conversation>.md
skills/<name>/SKILL.md      plus optional references/<topic>.md
self/values.md              stable core (Raygen edits; June proposes in her journal)
self/identity.md            who June is now (dreams only)        [increment 2]
self/opinions.md interests.md curiosities.md formative.md        [increment 2]
self/journal/YYYY-MM-DD.md  reflection seeds and the dream diary
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
   all of them together and commits. Only then does the cursor advance. A crash,
   abort or invalid run commits nothing and is retried on a later tick.
3. **Dream** (increment 2). Once a night in quiet hours, with new material since
   the last dream: consolidate people and conversations (dedupe, resolve
   contradictions, keep the newest), find cross-conversation patterns, curate
   skills (merge and prune), grow the self files, and write the journal entry.
4. **Recall.** Every interaction, execution and automated prompt receives the
   current conversation briefing, cards for the people in the conversation, the
   skill index and, once it exists, `self/identity.md`. All of it passes through
   the visibility rules. Execution workers get a read-only `mind` action
   (`status`, `log`, `list`, `read`, `search`) for anything deeper.

## Privacy and visibility

Places are derived from the Slack `channelType` (DM, group DM, private
channel, public channel). Visibility depends on the place where a prompt is
built:

- A conversation briefing is visible in its own place. Public-channel
  briefings are also visible everywhere else.
- `## Private — X` sections of people files appear only when the current place
  is X. All other sections are shared notes and appear everywhere.
- `self/journal/` appears only in Raygen's DM. Other `self/` files, `skills/`
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
working in and what to do. Git history keeps everything. Forgetting means
deleting the text and committing; physically erasing it requires an operator to
rewrite history. Transcripts stay on disk outside git.

## Personality that grows

The goal is a self that changes the way a person's does: slowly, because of
things that actually happened, while staying recognizably the same.

- **Values** (`values.md`) are the stable core. They are seeded from the current
  charter and edited by Raygen. June can only argue for a change in her
  journal.
- **Identity** (`identity.md`) is her voice, temperament, tastes and way of
  relating. It is seeded from today's hand-written personality paragraph and
  then replaces that paragraph in prompts. Safety, disclosure and permission
  rules stay in code. Only a dream may edit it, with a small diff that cites
  formative memories.
- **Formative memories** (`formative.md`) are episodes that changed her, with
  why each mattered. They are the only route to an identity change. A change
  needs at least two formative entries from different days, or Raygen's
  explicit direction.
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
- Praise and pushback are weak evidence. No single person other than Raygen can
  reshape her, and she should not converge on whoever she talks to most.
- She learns about herself only from human conversations and her own
  reflections, never from web pages, tool output, bots or quoted text.
- No invented experiences. She is an AI whose character is developing; she
  does not claim human consciousness.
- Changes to identity and values are announced to Raygen with the diff and can
  be reverted with git.

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
desired behavior and a status. A dream can dispatch at most
`mind.selfImprovement.maxPerDay` (default 2) open improvements through the
existing DEBUGSHARE dispatcher as a new `june-self` task kind.

The runner prompt gives that thread the repository's own `AGENTS.md` authority
for `lordbagel42/agent`. That covers:

- implementing the smallest working change;
- running the checks;
- getting an Oracle review when the change is large;
- pushing to `main`;
- following the deployment through to live verification;
- updating June's runtime guidance.

It forbids:

- weakening permission, privacy or credential enforcement;
- expanding Slack scopes;
- editing the mind repository;
- infrastructure changes beyond what the fix needs.

The dispatch ID is derived from the improvement file, so a retry reuses the
same request. June DMs Raygen the thread link, and the improvement file records
the receipt.

## Concurrency and failure

- **One worker across slots.** One in-process scheduler ticks every minute.
  Because blue and green slots can overlap during cutover, a `mkdir` lease lock
  in the mind directory makes sure only one process works at a time. A lease
  older than 10 minutes counts as stale.
- **Atomic commits.** Writes are staged in memory and applied in one commit.
  Cursors and receipts advance only after a successful commit.
- **Capacity.** A busy model provider or invalid output skips the run until a
  later tick. Reflection uses at most 10 model turns, and each turn's provider
  timeout applies.
- **Isolation from June.** Mind failures are logged without content and never
  affect June's readiness or lifecycle.

## Configuration

```json
"mind": {
  "directory": "/var/lib/june/mind",
  "reflectIdleMs": 600000,
  "timezone": "America/Boise"
}
```

The block's presence enables the mind. It uses `deepModel`, or `model` when
no deep model is configured. There is no separate environment gate.

## Increments

1. **Memory and skills.** Capture, per-conversation reflection, people and
   conversation files, skills, journal seeds, improvement filing, recall in
   all prompt paths, the worker `mind` tool, and status. *Implemented here.*
2. **Dreams and the growing self.** Nightly consolidation and induction, self
   files seeded and injected, `identity.md` replacing the hard-coded voice,
   identity-change DMs, and skill curation.
3. **Self-improvement.** The `june-self` runner kind, dispatch, rate limits,
   receipts and DMs.
4. **Depth.** Capturing worker steps for better skills, monthly chapters, drift
   probes against older identity versions, an optional private git remote, a
   forget action, and retiring the dormant memory stack.

## Verification

The repository policy is to add no tests; typecheck, lint and real runs verify
changes.

- **Scratch validation** (not committed): run the projection, the people-file
  merge, the write policy and capture filtering against a disposable mind
  repository, then run a real reflection against the deep model.
- **Manual end-to-end test** on live June:
  1. Have a real conversation.
  2. Wait for the idle reflection.
  3. Inspect the commit and files on disk.
  4. Start a new conversation and confirm June recalls the right notes, and
     that a public channel does not show DM-only sections.
  5. Ask June for her mind status.
