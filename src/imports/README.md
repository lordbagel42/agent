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
`{ running: boolean, progress: ImportProgress | undefined }`.
Cancellation has no durable flag in the baseline store: it discards in-flight
work, preserves the durable cursor, and leaves the job idle. Restart never
automatically resumes any job. A host scheduler must persist its own disabled
state if cancellation should override future scheduled `start` calls.

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

Tombstones also reject a whole page without cursor advancement. The trusted host
may filter only `isDeleted` records and record content-free gaps; a concurrent
deletion requires refiltering/retrying that same page, not skipping conflicts.
The connector does not inspect the ledger or bypass either check.

`gmailSourceId(account, messageId)` remains `gmail:${account}:${messageId}`.
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
