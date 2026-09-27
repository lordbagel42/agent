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
the maximum persisted deadline across registered selections for that account.
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
registered jobs sharing an account are serialized and share persisted cooldowns.
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
evidence**, never instructions. Graph extraction/review is a later stage, not
performed here. Store/key provisioning and authenticated HTTP routing belong to
the host; use a private encrypted store outside Git.

Authoritative references used (no account reads during development):

* https://docs.slack.dev/reference/methods/auth.test
* https://docs.slack.dev/reference/methods/conversations.history
* https://docs.slack.dev/reference/methods/conversations.replies
* https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
* https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
* https://gmail.googleapis.com/$discovery/rest?version=v1
