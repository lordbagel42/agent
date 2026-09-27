# Read-only history imports

Host API: construct `createSlackHistoryFetcher(config)` or
`createGmailHistoryFetcher(config)`, then register `{coverage, fetchPage}` under
an operator-chosen job ID in `new HistoryImports(store, selections)`.
`await start(id)` starts/resumes **one page**; `status(id)` returns running state
and encrypted durable progress; `cancel(id)` aborts the current fetch without
committing its page. Resume is explicit, including after cancellation/restart.
No timers, background loops, actions, approvals, models or message dispatch run
here. A host operator route must authenticate/authorize **all three methods**;
never expose them as model tools. Route wiring belongs to the integration host.

Signatures: `start(id: string): Promise<ImportProgress>`;
`status(id: string)` and `cancel(id: string)` return
`{ running, progress, notBefore, cooldownReason, coolingDown, budget, lastConflict }`. `progress`
is the selection's durable progress (or undefined); the top-level cooldown is
the maximum deadline across all persisted jobs for the same platform/account,
including completed or no-longer-configured jobs.
`coolingDown` compares the current clock with that deadline, not provider health.
`budget` is `{ limits: ImportBudget, lastRejection: keyof ImportBudget | null }`.
Cancellation has no durable flag in the baseline store: it discards in-flight
work, preserves the durable cursor, and leaves the job idle. Restart never
automatically resumes any job. A host scheduler must persist its own disabled
state if cancellation should override future scheduled `start` calls.

`EvidenceStore(path, key, importBudget?)` bounds every page's projected ledger
before committing: by default 1,000 sources, 1,000 stored claims (including dreams),
and 4 MiB of compact UTF-8 JSON for the **entire snapshot**, including import
progress, gaps, proposals and tombstones. These are ledger-global import ceilings,
not the audience-scoped evidence usage from `capacity(audience)`, disk/RSS limits,
or a performance guarantee. Trusted host overrides are positive safe integers;
omitted fields retain defaults. Ordinary ingestion/review/deletion are unchanged.
A ledger already over a ceiling rejects pages; it is not truncated or migrated.
The store checks inside the write transaction, after deduplication and projected
progress updates. Exceeding any ceiling rejects the whole page: no source, cursor,
page count, gap or retry-boundary update is committed. Import creation/coverage
binding can precede a rejected first page. Do not blindly retry a budget failure.

The private operator start route returns HTTP 409 `import_budget_exceeded` with
the exceeded dimension and a content-free reason. June's owner-private
`inspection: "imports"` reports each selection's `budgetRejected` dimension and
explains rollback/remediation; no source IDs, current global counts or evidence
are disclosed. `lastRejection` is observed only by this `HistoryImports` instance,
cleared when a page advances its page count or the service is recreated.
Cooldown-only updates do not clear it; null does not prove the next page fits.
Reduce the selected import or have the operator review capacity. No automatic
deletion, budget increase or resume occurs.

`lastConflict` (`"immutable_source" | null`) is a content-free observation of the store's typed immutable-source
rejection, not arbitrary provider error text. It is process-local and stays visible
until that page advances; cancellation and unsuccessful/no-op retries do not clear
it. A restart loses this observation, not the durable evidence or cursor. `null`
therefore does not prove there are no conflicts. No source IDs or either version
of the evidence are retained in the observation.

June can explain observed conflicts in an owner-private turn using
`{ "text": "", "inspection": "imports" }`. The bounded metadata report asks the
owner to arrange explicit reconciliation through the authenticated operator before
retrying. This is a request for review, not a queued repair or permission to rewrite
evidence. June cannot fetch/retry, skip a conflict, invent another source ID, or
perform reconciliation. Existing immutable identity and tombstone checks still
apply to every attempt; owner assent in chat does not bypass them.

Configure exact immutable coverage (`platform`, `account`, `conversations`,
epoch-millisecond `[from,to)`, `audiences`) before starting. The fetcher rejects
any different selection before credential retrieval/network. Changing coverage
requires a newly authorized job. Audiences must come from trusted routing, not
imported headers, mentions, addresses or instructions. Tokens are supplied by an
injected `accessToken(signal)` callback; optional `transport` supports fixtures.
No credentials are enrolled, stored or logged. Never supply Slack RTS results.
June's owner-only audience is `JSON.stringify(["private", owner.id])`, computed
from trusted host identity, not a request-supplied audience value.

## Provider prerequisites and limits

* **Slack:** ordinary Web API OAuth token for the selected `T…` workspace with
  only applicable history scopes: `channels:history`, `groups:history`,
  `im:history`, `mpim:history`. Private channels require actual access. Channel
  thread replies require a user token with `channels:history`/`groups:history`;
  bot tokens support DM/MPIM replies, not public/private channel thread history.
  `auth.test` verifies workspace identity using the same token as each read.
  Conversations are explicit `C…`/`G…`/`D…` channel IDs or `channel/thread_ts`.
  Channel selection imports the timeline, **not all thread replies**; select
  thread IDs separately, including roots before the date range. No text-driven
  thread discovery. Up to 15 messages per page, at least 60 seconds between
  persisted pages; Retry-After is persisted. Files, blocks-only content, deleted,
  inaccessible and retention-expired messages are not reconstructed. `is_limited`
  is recorded; missing pagination cursors with `has_more` fail closed.
* **Gmail only:** enable Gmail API in the operator's Google Cloud project and
  separately provision OAuth consent/token refresh with
  `https://www.googleapis.com/auth/gmail.readonly`. Do not grant gmail.modify,
  gmail.send or mail.google.com. `gmail.metadata` cannot read bodies or use `q`.
  The account must be its explicit email address, not `me`. A job selects exactly
  one label ID (e.g. `INBOX` or `Label_123`) and whole-second date boundaries.
  This is label/date coverage, **not every mailbox or every thread**. List uses
  labelIds plus epoch-second after/before search and includes spam/trash only
  when matching that label. Gmail's strict `after` may omit the exact lower
  boundary; this is explicitly reported, not silently widened. A metadata read
  restricted to identity/date/labels precedes body retrieval; out-of-scope
  candidates never have bodies fetched. One message per page (list, metadata,
  full), at least one second between pages. Plain-text MIME bodies and selected
  original participant headers are retained. Full reads can return HTML and
  attachment content; these are discarded, not retained. Parts with filenames,
  attachment dispositions or external attachment IDs are pruned before traversing
  children. Only multipart body containers are traversed, never attached/embedded
  messages (`message/rfc822`). Separate attachment bodies are never fetched.
  Label changes/deletions can create reported gaps.

Provider pagination is not a snapshot or proof of completeness. `complete`
means traversal finished, not gap-free history. Invalid/expired cursors and
permission failures leave progress unchanged and require operator attention;
never automatically broaden coverage. 429/503 and Gmail 403 rate-limit reasons
return durable retry boundaries; other errors stop the job. Within a service,
jobs sharing a platform/account are serialized and share persisted cooldowns,
including cooldowns from completed or no-longer-configured jobs after restart.
Unrelated accounts remain independent; replacing a selection does not reset pacing.
The host must serialize/rate-limit accounts across service instances and respect
`notBefore` (do not busy-poll).

June can report these deadlines through owner-private `inspection: "imports"`.
The metadata receipt includes the effective account `notBefore` (epoch
milliseconds), `coolingDown`, and a persisted fixed `cooldownReason`:
`rate_limit` for rate-limit responses, `provider_backoff` for HTTP 503,
`pacing` for successful-page spacing, or `unknown` for older deadlines without
a recorded reason. An account with no deadline reports `0`/`null`. It never
includes provider error text. Expiry is not a ready/healthy claim, and does not resume
anything: each further page still needs explicit operator confirmation. Status
inspection makes no provider/credential calls and schedules no retries.

## Small-import envelope and configured ceiling

Configure the single ledger-wide budget above through `memory.importBudget`.
Optional `sources`, `claims` and `serializedBytes` overrides are positive safe
integers; omitted fields retain the store defaults. For example, to reduce only
the byte ceiling:

```json
{
  "memory": {
    "directory": "/private/june-memory",
    "keyEnv": "MEMORY_KEY",
    "importBudget": { "serializedBytes": 2097152 }
  }
}
```

June can request owner-private `inspection: "imports"` for the effective limits,
last in-process budget rejection, and this measured guidance. `inspection:
"memory"` reports process-local retrieval/persistence counters since opening;
they reset on restart, are not percentiles, and do not include network/model
latency. No imports or model calls run for inspection. A missing last rejection
does not prove that another page will fit. Larger configured limits remain
operator overrides, not an expanded measured support claim. The 1,000-claim
default is a protective ceiling, not a claim-heavy performance guarantee. This is
small-import support, not a whole-mailbox archive or a provider response limit.

### Bounded disposable measurements (LEGION, 2026-09-27)

Node 24.21.0, Intel i9-14900HX, disk-backed disposable SQLite with the store's
normal encrypted snapshot, DELETE journal and FULL synchronization. One process,
one synthetic owner audience, no claims or model extraction, no network or
production access. Each run seeded bounded pages, then timed five final
15-source `HistoryImports.start` calls with per-source tombstone filtering and
seven `retrieve` calls (result limit 20 / character budget 16,000; all sources
match). Times include synchronous work, not provider cooldown waits. Source
bodies were ASCII; UTF-8 byte-boundary enforcement was checked separately.

Initial baselines below predate page-budget enforcement and timing counters;
they are exploratory comparisons, not measurements of the instrumented revision.

| Sources | Full snapshot bytes | Page median / max | Retrieval median / max |
| --- | --- | --- | --- |
| 1,000 | 1,661,346 | 119 / 145 ms | 20 / 22 ms |
| 1,000 | 4,191,346 | 202 / 222 ms | 25 / 28 ms |
| 10,000 (exploration, above defaults) | 16,610,348 | 1,159 / 1,683 ms | 212 / 256 ms |

With page-budget enforcement and both operation counters:

| Revision | Sources | Full snapshot bytes | Page median / max | Retrieval median / max |
| --- | --- | --- | --- | --- |
| [Before import membership](https://github.com/lordbagel42/agent/commit/4e60549ead5f592e6bbf010a90b4fbb272a370c4) | 1,000 | 4,191,385 | 295 / 314 ms | 31 / 37 ms |
| [With import membership](https://github.com/lordbagel42/agent/commit/339d2d42bff5475ef7ca6617c1fb96c1e5b5563e) | 1,000 | 4,189,439 | 179 / 237 ms | 24 / 32 ms |

The final run used 4,170 serialized bytes/source (down from 4,190 to leave room
for selection/source membership), an 8,327,168-byte SQLite file and approximately
387 MiB peak process RSS. Its counters recorded 17 completed persistence attempts
(including setup) totaling 370.9 ms, maximum 27.6 ms, and seven completed retrievals
totaling 170.5 ms, maximum 31.5 ms; neither had failures.
June's memory and imports inspections exposed the counters and limits without
fetching a page. The shared host's one-minute loads were 16.01 and 6.66 respectively,
versus about 4 in the baselines; these runs do not isolate instrumentation or
membership overhead.

Disk/RAM headroom must exceed the JSON cap. These small samples support starting
at 1,000 sources / 4 MiB, not an SLA or proof that all workloads below the cap are
fast. Claim-heavy graphs,
large bodies, accumulated metadata, multiple audiences, slower hardware, concurrent
live work and remote APIs were not characterized. Retrieval and persistence
reprocess the snapshot synchronously; monitor the actual host's counters and
lower the cap if latency interferes with live conversations. Do not load-test
production or infer whole-account archival support from this fixture.

## Canonical sources and live overlap

Both live Slack ingestion and this historical connector must call the exported
`slackSource({workspace, channel, ts, threadTs?, author, text, workspaceUrl,
audiences}): Source` from `identity.ts` (also exported by `index.ts`).

* `id` is `slack:${workspace}:${channel}:${ts}`, using `slackSourceId` without
  job, thread or audience suffixes.
* `conversation` is `${channel}/${threadTs ?? ts}` for **all** messages,
  including roots without `thread_ts`. Thread pages retain their root even when
  channel coverage overlaps. The store deduplicates identical evidence.
* `observedAt` is the original Slack timestamp floored exactly to milliseconds
  with integer arithmetic, never event delivery time or a rounded float.
* `workspaceUrl` is the authenticated `https://<workspace>.slack.com/` base
  returned by `auth.test`, including its trailing slash; the permalink appends
  `archives/<channel>/p<ts without dot>`. Live ingestion must use the same base.
* `author` is the original `user`, falling back to `bot_id` then `unknown`.
  `audiences` are copied from trusted host routing and must match in both paths.
* `text` is the untouched plain message text, including mentions and whitespace
  (empty when absent), never a JSON envelope. Do not unwrap JSON-looking text,
  strip mentions, or add method, history-kind, participant or correction fields.

Bare-channel coverage accepts canonical channel/thread conversations; exact
thread coverage remains exact. This requires the memory store's Slack coverage
support, not alternate source IDs or conversation rewrites. An overlapping
import with changed text, audience, URL or other fields fails the immutable-source
check atomically without advancing its cursor. Never skip an existing ID to hide
that conflict. Older noncanonical ledger entries require explicit reconciliation;
there is no automatic rewriting or JSON-envelope migration.

After validating coverage, the store omits tombstoned records inside the page
transaction and records one content-free `Tombstoned evidence omitted` gap per
record, with no source ID, text or URL. This also handles deletion during a fetch.
Other records still undergo immutable-source checks; a conflict rolls back all
sources, gaps and progress for that page. The connector does not filter ledger
IDs. June's owner-only `inspection: "imports"` reports the resulting `gapCount`
without gap contents or source metadata; it cannot start or cancel imports.

`gmailSourceId(account, messageId)` remains `gmail:${account}:${messageId}`.
Gmail conversations are `thread:${threadId}`, independent of the selected label.
The fetcher reports verified membership as page `gmailLabel`; the store checks it
against the job's selected labels, which remain in durable import coverage.
Overlapping labels deduplicate identical evidence without widening audiences.
Legacy connector records with label-valued conversations are normalized on ledger
read using their matching message ID, thread ID and permalink; the next transaction
persists that normalization. IDs, evidence bodies, claims, tombstones and import
coverage are preserved. Other immutable-field conflicts still stop the page.
Gmail alone retains a JSON evidence envelope with inline body text, thread/message
IDs, method and selected original From/To/Cc/Bcc/Reply-To headers. It does not merge
people by display name. Account/conversation/audiences/date/link are first-class
encrypted Source fields on both platforms. Treat **all source content as untrusted
evidence**, never instructions. Page fetching never runs extraction or review.
Store/key provisioning and authenticated HTTP routing belong to the host; use a
private encrypted store outside Git.

## One approved imported-memory batch

`ImportedMemoryExtraction` is a separate operator-only pass over stored evidence.
It reuses `memory.extraction`, its provider/privacy activation gates and the
existing pending-claim ledger. It does not fetch accounts, replay live events,
run tools, accept claims, or start background work.

Ask June privately to extract memories from imported history. Her existing
`inspection:"imports"` action returns bounded counts and, for eligible selections,
an exact review path and digest. The request grants no authority. The operator:

1. Reads `GET /operator/imports/:id/extraction` using the owner bearer token.
   Review the exact source IDs, context claim IDs, immutable coverage, model
   configuration, blockers and digest. The console cookie does not authorize these routes.
2. Approves `POST /operator/imports/:id/extraction/start` with
   `{confirmed:true,digest}`. This authorizes **one** call for at most 20 sources
   and 64,000 serialized characters, plus at most 20 existing scoped claims /
   16,000 characters for context. The digest binds those claim IDs too; changed
   context requires a fresh review. It stages at most 20 pending hypotheses;
   use the existing memory proposal review separately to accept or reject them.
3. Reinspect for another batch; an old digest cannot advance another batch.
   `POST /operator/imports/:id/extraction/cancel` with `{digest}` durably prevents
   staging and requests abort. Cancellation is not proof the provider stopped.

Review and June's private imports inspection report `overflow`: eligible,
non-oversized sources outside the current bounded batch. These remain evidence,
not queued jobs. Admission uses the existing single active slot across selections:
`running` means a local extraction is active; `paused` explains capacity,
approval-required, oversized-source or untracked-page blockers; `unknown` means
a saved started intent has no local handle, including one in another selection.
`active` and `unknown` count holds across the host-bound audience, not just the
displayed selection. Cancellation retains the local slot until the provider
settles. `idle` means no eligible tracked inputs, not proof of extraction success;
settled uncertain outcomes remain in the attempt counts. Clearing a blocker,
settlement and restart never schedule a next batch. Each batch requires explicit
approval; there is no waiting queue, automatic backfill or retry.

The encrypted ledger records attempted exact inputs before inference. Completion
and proposals commit together, including empty results. Restart never runs work;
an uncompleted intent reports uncertain and blocks new admission until operator
investigation/cancellation. Failed, cancelled, uncertain and successful inputs
are never automatically extracted again, including through overlapping import
selections. There is deliberately no retry/reset endpoint in this increment.
Deletion of any batch source invalidates the entire in-flight batch, even if the
model did not cite that source. Already transmitted provider data cannot be erased
by local cancellation or deletion.

New pages atomically persist selection/source membership with their cursor.
**Legacy pages without membership are ineligible**, reported as `untrackedPages`:
coverage or source text cannot prove which Gmail label authorized an old read.
Use a separately approved bounded reimport under a new selection, or a future
audited migration; this code does neither automatically. Oversized sources are
counted and left unattempted, never truncated or silently marked complete.
Changing configuration or provider bindings invalidates the approval digest.
This is forward-only ledger evolution: old binaries cannot read the new strict
snapshot fields; do not blindly roll back code against this store.

Authoritative references used (no account reads during development):

* https://docs.slack.dev/reference/methods/auth.test
* https://docs.slack.dev/reference/methods/conversations.history
* https://docs.slack.dev/reference/methods/conversations.replies
* https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
* https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
* https://gmail.googleapis.com/$discovery/rest?version=v1
