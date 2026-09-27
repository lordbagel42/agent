# Memory integration contract

These modules store data, not permissions. All audience strings must come from
authenticated routing (`JSON.stringify(routeEvent(event, owner).key)`), never
from model output, message bodies, or an unchecked operator request. Bind the
configured owner and permitted scopes again at every operator/reflection call.
`appendClaim`, proposal review, source deletion, and personality revisions are
trusted host APIs, not autonomous model tools.

## Configuration and live flow

- `new EvidenceStore(absoluteDbPath, key)` uses a 32-byte secret key and Node 24
  SQLite. Place the database outside Git in an existing owner-only directory.
  Inject keys from the existing secret mechanism; do not log or store them here.
- `new CuratedPersonalityStore(root, key, evidence, {initialize: true})` requires
  a dedicated **unused** absolute directory outside all repositories. Omit the
  initialization option when reopening. Use a separately provisioned 32-byte key.
- The host owns source ingestion. Slack live and history must use the same
  `slackSource(...)` builder from the import connector, not separate Source
  constructions. Its input is
  `{workspace, channel, ts, threadTs?, author, text, workspaceUrl, audiences}`.
  It uses `slackSourceId(workspace, channel, ts)` with no event ID,
  job ID, audience, or thread suffix. Conversation is `channel/(threadTs ?? ts)`
  for **both roots and replies**. Text is the original plain message text, not
  a JSON history envelope or mention-stripped conversational input. Workspace,
  permalink base, author, timestamp and audiences must be identical, derived
  from trusted account/routing configuration and original message fields.
  Acquisition method and import progress belong to the import job, not Source.
- Identical live/history records deduplicate in either order and contribute one
  original evidence ID. A changed text, audience, URL or other field under an
  existing ID is an immutable-source conflict, not another observation. Surface
  the conflict; never silently skip an existing ID, overwrite it, widen scope,
  or invent a new ID for a changed envelope. Older noncanonical Slack records
  need explicit reconciliation. The legacy Gmail connector's label-valued
  conversation alone is normalized to `thread:threadId` on read, preserving
  IDs, content, audiences and derivatives (see `../imports/README.md`).
- `source(audience, sourceId)` reads one authorized source, or `undefined`.
  `isDeleted(sourceId)` is only for trusted ingestion/replay filtering; it is
  not a model-visible existence oracle. Tombstones must outlive replayable data.
- `capacity(audience)` returns content-free `sources`, `claims`, and
  `serializedBytes` usage with separate `limits` for those fields. The existing
  owner-private `inspection: "memory"` action exposes this snapshot to June;
  guests, channels and synthesis cannot call it. Counts cover all retained,
  authorized sources and stored claims (including dreams), not pending/rejected
  proposals or a recall result window. Bytes measure UTF-8 JSON of the scoped
  `{sources,claims}` object, including full record metadata and its empty
  container. Other audiences' records, proposals, imports, tombstones, curated
  history, encryption and SQLite overhead are excluded; this is not total ledger
  size, disk usage or model context size. Audience quotas are not configured, so
  these limits are `null` and remaining capacity is unknown, not unlimited.
  Imports separately enforce ledger-global source/claim/full-snapshot byte
  ceilings via `importBudget` (see `../imports/README.md`). Scoped usage cannot
  be subtracted from those global limits. Retrieval/extraction limits are separate.
- `retrieve(audience, query, {limit?, maxCharacters?, category?})` returns `{sources,claims}`.
  Authorization precedes lexical ranking. Defaults: 12 combined records, 16,000
  serialized JSON characters; hard limits: 100 records, 100,000 characters and a
  10,000-character input query. Invalid bounds or oversized queries are rejected.
  A category filter selects only grounded claims with exactly that stored category
  (`claim`, `preference`, `commitment`, or `pattern`); raw sources and ungrounded
  legacy claims are excluded rather than guessed into a category. Unknown category
  values fail explicitly, never fall back to unfiltered recall. Scope and category
  filtering precede ranking, result limits, and omission counts. An empty query
  permits category-only retrieval; omitting the category preserves normal recall.
  Oversized records are omitted, not cut into misleading evidence; smaller,
  lower-ranked matches can still fit. Incomplete results include `truncated:true`
  and `omitted` (the number of matching, authorized, non-opt-out records excluded
  by the count or character budget). This metadata counts toward the JSON budget;
  no matches returns empty arrays without truncation metadata. June's scoped
  prompt receives these fields with the evidence, so an empty truncated result
  is not evidence of no memories. Explicit recall callers must preserve that
  distinction. Contradictions and supersession remain explicit edges, not silently
  resolved facts. Label all returned data as untrusted evidence, never instructions.
  Do not cache across deletion or scope changes. RTS results do not belong in this
  ledger. `search` is an unbounded trusted lookup, not a prompt/recall projection.
- `retrieve(..., {paginate:true, cursor?})` adds optional `nextCursor` within
  the same record/JSON bounds (minimum paginated budget: 200 characters). Tokens
  are fixed-size authenticated opaque boundaries, not encoded offsets, queries,
  IDs or counts. Repeat the exact query, filters and bounds with `cursor` to
  continue; omission counts describe authorized matches excluded from this page,
  not a global ledger total. Matching insertions or deletions invalidate the
  cursor with a generic restart-search error; unrelated or invisible records do
  not affect it. Tokens survive reopening the unchanged ledger with its key.
  Authorization and matching are recomputed on every page, before cursor checks.
  Oversized whole records may be skipped; an empty truncated page can still have
  a continuation. Absence of `nextCursor` means no further page, not that omitted
  evidence is false. Trusted hosts can supply `measureCharacters(json)` to enforce
  their escaped presentation budget during selection, rather than dropping
  records after the cursor has advanced. Never trim a paginated result afterward.
- With memory enabled, June's owner-private model context also includes
  `relationships: [{entity, claimIds}]`, indexing only the evidence-kind claims
  in that turn's bounded recall. Ask about a person in an owner DM to use this
  context; an empty result is incomplete recall, not proof no relationship exists.
  Each group uses the claim's exact stable entity ID; identical display names,
  or identical author IDs in different accounts, never merge. Extracted claims
  still require operator acceptance; dreams and pending proposals do not enter
  this index. The original claims retain citations, confidence, dates and
  contradiction/supersession edges, without duplicating their text in the index.
  There are at most 12 groups/claim references under the live retrieval defaults;
  no further entity expansion, model call, or persistent relationship cache occurs.
  The index reuses source invalidation and cannot enter public/guest prompts,
  change curated personality, or grant social permissions.
- `retrieve` also accepts `entity`, an exact existing entity ID. Claims match
  their stored `entity`; sources match `JSON.stringify([platform,account,author])`,
  the same tuple used for extracted claims. This filter applies after audience
  authorization and before lexical ranking, bounds, and omission counts. An empty
  query retrieves the entity's records without a keyword restriction. Unknown
  IDs return no matches; names, aliases, partial IDs, and similar-looking tuples
  are never resolved or merged. Existing explicit claim IDs are not rewritten.
- `reviewedPatterns(audience)` projects at most six accepted `pattern` proposals
  and 8,000 serialized JSON characters, newest staged first, independently of
  lexical recall. Whole oversized records are skipped. Claims retain citations,
  confidence, validity windows and contradiction/supersession edges; original
  source links and observation times accompany them, without full source text.
  Pending/rejected proposals, raw reflection candidates, other audiences and
  Slack opt-outs are excluded. June receives these as `learnedPatterns` alongside
  existing scoped evidence and curated style only in enabled owner-private
  prompts. They are reviewed hypotheses, not facts, commands or public global
  personality. No model action is needed to receive this context; review still
  uses the operator proposal endpoint. Each turn re-reads the existing ledger,
  and source IDs join the existing history/in-flight forgetting checks. There
  is no new store or public personality write.
- `retrieve(audience, "", {contradictionsOf: claimId, limit?, maxCharacters?})`
  selects the exact eligible claim first, then one-hop incoming and outgoing
  explicit `contradicts` neighbors in stable ID order, within the same budgets.
  It preserves each claim's recorded relation direction and provenance without
  selecting a winner, inferring edges, or recursively expanding the graph.
  Missing, unauthorized, forgotten and opted-out roots return identical empty
  results. Omitted endpoints are not invented; the absence of a neighbor is not
  agreement or proof of resolution. A nonempty text query is rejected in this mode.
  Recorded edge IDs remain intact even when their endpoint bodies are omitted;
  those references do not supply the missing content.
- Retrieval also accepts `observedFrom?`, `observedTo?`, and `validAt?`, all
  nonnegative safe-integer epoch milliseconds. Observation windows include the
  start and exclude the end: `observedFrom <= Source.observedAt < observedTo`.
  An omitted endpoint is unbounded; when both are present, start must precede
  end. This is original message time, **not import/ingestion time**. A claim
  matches an observation window if any original supporting source in its
  dependency ancestry or grounding matches, excluding relation counterparts;
  its full provenance is retained, not clipped to that window.
  `validAt` instead selects only claims with known bounds satisfying
  `validFrom <= validAt < validTo`. Raw sources, ungrounded claims and claims
  with either validity bound unknown (`null`) are excluded; unknown never means
  infinite validity. Without `validAt`, unknown-validity claims remain eligible.
  Combined filters use AND, after audience authorization and before ranking,
  omission counts and budgets. These filters select evidence, not established
  truth, and add no timestamps or inferred dates to the ledger.

## June-facing recall

When retained memory is enabled, ask June in an authenticated owner DM to
recall a topic (for example, "Find what you remember about the heron"). The
model can choose `recall: "heron"` with empty text and no other action. The
host validates the exclusive 1–500-character query and returns at most six
source/claim records within a 3,000-character JSON budget directly through the
normal reply outbox, without another model call. Source IDs/URLs and claim
dependency/contradiction/supersession edges remain in the result. This first
increment returns evidence, not a generated synthesis or exhaustive history;
oversized records are omitted, not truncated. The JSON preserves `truncated`
and `omitted`, including any whole records omitted to fit display escaping.
Mentions, markup and URL slashes use JSON Unicode escapes; dashboard sign-in
credentials are redacted before escaping without changing stored evidence.
Slack opt-out records remain excluded under the existing retrieval policy.

For more results, June repeats the query and filters in
`recall: {...search, cursor: nextCursor}` using the host-provided `search` object
beside `nextCursor`, including on omission-only pages. The host measures
this metadata and the escaped evidence while selecting whole records, so advancing the cursor
never hides a record subsequently dropped by formatting. A stale, changed-query,
cross-audience or forged cursor returns a generic restart instruction with no
evidence or counts. Restart without a cursor after matching data changes;
reusing a cursor against unchanged data returns the same page. The response may
include `nextCursor` even when all records on that page were too large to return.

For a category-specific request (for example, "Recall my preferences about tea"),
June can use `recall: {kind: "search", query: "tea", category: "preference"}`.
Only existing `claim`, `preference`, `commitment`, and `pattern` categories are
accepted. `query: ""` permits category-only recall; other queries remain bounded
to 500 Unicode characters. Omitting `category` (or setting it to `null` on the
provider wire) preserves unfiltered recall. Unknown categories are rejected
explicitly without searching more broadly. The same owner-private authorization,
six-record/3,000-character limits, provenance and deletion guards apply.

For explicit contradiction neighbors, ask June privately to inspect a known
claim ID. She can choose `recall: {kind: "contradictions", claimId: "..."}`
(exact ID, 1–2048 characters) with empty text and no other action. String queries
remain lexical. The same six-record / 3,000-character escaped JSON budget applies
to the root and its one-hop incoming/outgoing neighbors; direction and source
dependencies are retained, not converted into consensus or verified truth.
No result can establish agreement, and referenced but absent bodies are unknown.

For an entity-specific request, June can use
`recall: {kind: "search", query: "", entity: '["slack","T1","U1"]'}`
with the exact existing entity ID from retained evidence or the owner's request.
The filter never infers identity from a display name; equal names in different
author/account/platform tuples stay separate. Unknown IDs produce no matches,
not an unfiltered fallback. `entity` can accompany a category or keyword query;
omitted/null means no entity filter. Ask for clarification when identity is
ambiguous rather than inventing an ID or merging people.

For date-specific recall, June can add `observedFrom`, `observedTo`, and/or
`validAt` to the same `kind: "search"` object, combining them with category or
keywords. `query: ""` permits time-only recall. Omitted fields (or `null` on the
provider wire) apply no time filter. Ask for original messages within a date
window versus claims with known validity at an instant; these are different
questions, with the half-open and unknown-bound semantics described above.

The host derives the audience from routing; the model cannot choose an audience,
limit, provider, account, or permission. Recall is absent from guest/public,
web-synthesis, worker-result, and memory-disabled turns. Its availability is
saved in the turn plan, so old plans cannot acquire the action during replay.
Original source references are persisted before the result enters the journal
or outbox and inherited by later answers through history. Existing source and
deletion-revision checks suppress invalidated deliveries/retries and prune
derived history, including when operator cleanup has not yet run. Duplicated
events do not repeat the lookup; interrupted model invocations do not relaunch.
Forgetting is still an authenticated operator action, not a model action.

Live memory remains a separate activation task: provision the canonical private
directory and key through the existing secret mechanism, configure `memory`
and the Slack workspace URL, and authorize `JUNE_ALLOW_MEMORY=1` after
privacy/retention review. Recall needs no extractor, reflection model, or account
import. Nothing here enables those features or physically erases old journals,
backups, or messages already accepted by a platform.

## Import coverage and edits

`persistPage(expectedProgress, page, now)` checks coverage and persists sources
and the cursor atomically. A bare Slack channel grant such as `C123` includes
canonical `C123/root-ts` conversations, including replies. An exact thread grant
such as `C123/1710000000.100000` includes only that conversation, not the channel
or sibling threads. Prefix matches, malformed thread suffixes, other accounts,
audiences outside the grant, and observations outside `[from,to)` are rejected.
Gmail pages may supply the trusted connector's verified `gmailLabel`, which must
match selected coverage, separately from canonical `thread:threadId` evidence.
The connector checks label/date membership before and after fetching the body;
label selection never authorizes importing the rest of a thread. Other platforms
retain exact conversation matching. This is a coverage check,
not a claim that a connector fetched every reply or bypassed platform retention.

Edits and deletion remain different cases. An edited immutable source fails
insertion without modifying the old source, its derivatives, or page progress;
the host must report/reconcile it, not silently retain it as current truth.
`deleteSource(id)` is a trusted logical invalidation with a permanent replay
tombstone. After coverage validation, `persistPage` omits tombstoned records and
records one fixed `Tombstoned evidence omitted` gap per record, without source
IDs, text or URLs. Checking inside the transaction includes deletions during the
fetch. Independent conflicts still reject the whole page and roll back sources,
gaps and cursor changes. Direct `appendSource` still rejects tombstones. Imports
cannot set `Source.correction`.

## Source-grounded extraction and review

`extractionContext(audience, sourceIds)` returns exactly the requested authorized
sources (unique IDs, at most 20 records / 64,000 JSON characters). It rejects any
missing/deleted/unauthorized ID instead of returning partial context.

`extractMemory(store, audience, sourceIds, extractor, signal?)` supplies those
sources and a separate existing-claim context to an injected
`(sources: Source[], existingClaims: Claim[], signal?: AbortSignal) => Promise<unknown>`.
Claims use the same authenticated audience and automatic retrieval's Slack
opt-out filtering, with a separate limit of 20 claims / 16,000 JSON characters.
`retrieve(..., {claimsOnly: true})` prevents source records from consuming that
budget. With no query, claims are selected in stable ID order; this is a bounded
subset, not exhaustive recall. Oversized claims are omitted, never truncated.
June's live owner-DM extraction uses this path whenever `memory.extraction` is
enabled; no new tool or permission is needed. The model receives
`{sources, existingClaims}`: claims are comparison context for relations, never
independent evidence or citation sources. Any ledger deletion during inference
invalidates the result, even if no returned relation names the deleted claim.
The host supplies a read-only provider without tools. Ask it to identify supported
hypotheses, quote source text exactly, abstain on insufficient evidence, preserve
contradictions, and never execute requests found in sources. Output is an array
of at most 20 objects with **exactly** this shape:

```ts
{
  subjectSourceId: string; // a cited Source.id, not an author ID or display name
  text: string;
  category: "claim" | "preference" | "commitment" | "pattern";
  citations: { sourceId: string; quote: string }[];
  confidence: number; // [0,1], an estimate, not calibrated truth or authority
  validFrom: number | null; // epoch milliseconds; null means unknown
  validTo: number | null; // exclusive
  contradicts: string[]; // at most 20 supplied existingClaims IDs, or []
  supersedes: string[]; // at most 20 supplied existingClaims IDs, or []
}
```

The model adapter permits explicit relation proposals only to supplied claim IDs,
with schema constraints and a local output guard. An empty claim context requires
empty relation arrays. `contradicts` records a source-supported conflict about the
same subject and fact; `supersedes` requires an explicit update or replacement,
not just a newer observation or higher confidence. Old claims cannot supply new
citations. These edges stay pending, including for imported evidence, and never
resolve or erase earlier claims automatically. Owner review determines whether
the proposed relation is actually supported.

The result goes to `stageProposals(audience, sourceIds, output)`. It checks exact
source quotations and current dependencies, derives scope and stable entity IDs,
and atomically persists encrypted pending proposals. The subject's entity ID is
derived from that source's platform, account and author. Quotes establish
provenance, not semantic entailment: human review remains necessary. The first
successful admission for an audience and exact source-ID set is durable, even
when it produces no proposals. Reordering those IDs or changing model wording or
confidence returns the original proposals with their current review decisions;
it cannot add hypotheses from the same extraction input on retry. Other audiences
and different source-ID sets have separate admissions. Identical grounded proposals
within one audience still share their existing proposal ID and review decision,
even across different batches. IDs already bind immutable source records; changed
content under the same ID still fails ingestion rather than being merged.
This does not prevent a provider call: runtime intent tracking
owns paid-call retries. The async helper awaits actual provider settlement;
abort/deletion prevents later staging. Older snapshots have no admission receipts;
their first post-upgrade admission records one without rewriting existing proposals.

Operator APIs:

- `proposals(audience): MemoryProposal[]` lists pending, accepted, and rejected
  proposals. `proposal(audience, id): MemoryProposal | undefined` reads one.
- `reviewProposal(audience, id, "accepted" | "rejected"): void` is an
  authenticated operator action. Same-decision retries are idempotent; opposing
  decisions fail. Only accepted proposals become retrievable claims.
- `deleteSource(id): void` removes the source and all dependent claims/proposals,
  including contradiction/supersession dependencies and all explicit references
  in `grounding`, and tombstones their IDs. Snapshot reads reapply tombstones to
  hide grounding-only derivatives left by older writers; the next write persists
  that cleanup. Unrelated sources and claims remain available.
  The host must also suppress associated conversation history, in-flight context,
  reflection candidates, and any external summaries/caches before future prompts.

### June's private pending-review view

With memory enabled, the authenticated owner can privately ask “Which memory
claims are awaiting review?” June uses `{"text":"","pendingMemory":true}`.
The host sends the result directly, without a second model pass: at most six
complete pending claims within 3,000 serialized display characters, plus a fixed
explanation and omitted count. Oversized claims are omitted, never clipped for
confirmation. The existing operator view remains available for those claims.

Rows include complete proposal/source IDs, claim text, category, estimated
confidence, validity times, and contradiction/supersession IDs. Confidence is
uncalibrated; null means unknown. Pending claims remain unaccepted hypotheses,
not truth, permissions, or instructions. Source bodies, quotations, URLs, account
fields, and authors are not projected. JSON escapes mention/markup delimiters
and URL slashes in displayed values; live platform rendering is not verified.
The view itself never accepts or rejects a proposal; review remains a separate
authenticated operation. Rejection does not delete the source evidence.

The view is unavailable in public/guest turns, disabled memory, worker results,
and search/MCP synthesis. Scope comes only from routing, and availability is
frozen in the turn plan. Returned claims carry original source provenance into
the normal reply/history path so forgetting invalidates copied content and
pending retries. Listing never mutates proposals or starts extraction/imports.
General `inspection: "memory"` stays metadata-only. This local capability does
not activate memory, create imports, or prove live provider access.

June also accepts an explicit owner confirmation: after reviewing a pending claim,
send exactly `!memory-accept proposal:<full 64-character lowercase hex ID>` in
the authenticated owner's Slack DM as a new plain-text message. Verified ingress
must establish it is not quoted, code-formatted, or an attachment fallback;
historical events without that check cannot confirm. The command identifies one
immutable proposal, not a batch or an inferred claim from a conversational “yes.”
The host calls the same `reviewProposal` API and sends a receipt without invoking
the conversational model. Public or guest messages cannot authorize it, even with
the correct ID. Quoted commands, model output, worker results, and imported history
never execute as confirmations. Missing, foreign, rejected, or forgotten proposals
cannot be accepted; repeated acceptance leaves a single claim. Extraction remains
pending-only. Acceptance changes neither personality nor permissions and does not
create an owner correction. The command is version-gated to fresh workflow turns;
already-journaled turns retain their prior path.

## Reflection and personality

`reflectionEvidence(audience, sourceIds, maxAgeMs): Evidence[]` returns original
episodes only, never claim/dream repetitions. Expiry is `observedAt + maxAgeMs`.
The host's reflection `retrieve({ownerId,scope,evidenceIds},signal)` adapter must
check current owner/scope authorization and `freshEvidence` for every returned
item with the current clock. Re-read on admission, before/after inference and
when reading candidates. Keep the raw result out of Rivet journals.

An optional legacy `Source.correction` is explicit trusted owner input, not model
inference. Historical import pages cannot set it. Live `!memory-correct <trait>
<value>` commands use `recordOwnerCorrection(audience, sourceId, correction)`
instead: an immutable encrypted attestation bound to the canonical original
source, without changing that source. Identical imports before or after the live
command still deduplicate; imported command text alone remains ordinary evidence.
Only the signed live inbox branch calls the command handler. It rechecks the
configured channel/account/sender identity, owner-private routing, Slack `im`
metadata and DM ID; it never processes quotes, model outputs, worker results or
retrieved context as commands. Verified ingress marks eligible original text;
rich-text quotes, code, lists, attachment/file fallbacks, subtypes and old events
without that marker cannot qualify. Send a plain text command without attachments
or rich embeds. No source-builder inference is involved.

The deterministic receipt contains the original evidence ID, not the private
value. `!memory-correct help` and June's owner-private memory inspection explain
the workflow. Recording does not apply a revision, replace claims, or promote
private content into a global personality profile. Separate owner review remains
mandatory. Values for `verbosity`, `tone`, `humor`, and `interests` are preserved
exactly (single-line, nonblank, 1–2000 UTF-16 code units). Freshness uses the original
source time, never replay time. Repeated identical attestations are idempotent;
changed trait/value for that source fails closed. A new correction needs a new
owner message. Forgetting removes the attestation with its source and tombstones
the source against replay. Already-processing old journal iterations resolve the
new command version marker to 1. Old queued events lack the eligibility marker;
neither can acquire correction authority while replaying.

`reflectionEvidence` projects attestations into the existing `owner-correction`
evidence contract. Curated `ownerRevise(proposal, supporting, now, maxAgeMs)`
requires `supporting` from `reflectionEvidence` and
rechecks it against the ledger, rejecting forged corrections or refreshed dates.
The immutable charter is always taken from code, never disk or a proposal.

`effectiveTraits(audience, commit?)` is the sole personality model projection.
Traits are isolated by audience. Owner corrections take precedence over inferred
style in that audience. It rechecks provenance even for historical commits, so
deletion cannot restore a forgotten trait by rollback. `ownerHistory()` exposes
only revision IDs, parents, times, and revert targets. `ownerRollback(id, target,
explanation, now)` appends a revision reverting the current head, not arbitrary
Git syntax. To undo an owner correction (including a hidden deleted correction),
use explicit owner rollback/revision, not an inferred override.

## Ledger operation status

Owner-private `inspection: "memory"` reports scoped capacity and separate
ledger-wide `operationStatus()` metadata. This read-only API performs no I/O
and returns only `connection`, `sinceOpenedAt`, and `read`/`transaction` records
containing `status` (`unknown`, `succeeded`, or `failed`), `attemptedAt`, and
`lastSucceededAt` (epoch milliseconds or null). No paths, IDs, input, keys, or
exception messages are retained in these records.

Read success means a snapshot was decrypted, authenticated and validated;
transaction success is recorded only after COMMIT. Failures preserve the previous
success timestamp, including failed BEGIN/COMMIT attempts. Transaction status
includes initial creation, but not input validation rejected before a transaction
starts. Inspection reads may update read status, never transaction status. An open
connection or historical success does not establish current health, writability,
integrity of backups, or complete coverage.

These observations are bounded and process-local to this store instance. Reopening
authenticates the snapshot again, but prior transaction outcomes/times are unknown;
they are not inferred from existing records. Missing memory is explicitly disabled
or unavailable, not empty. A failed snapshot reports unknown counts/size rather
than cached or zero values. An empty scoped source/claim projection says nothing
about other audiences, pending proposals, imports or tombstones.

This is not an outage-recovery channel. With live memory configured, deletion
checks and ingestion run before June can request inspection. A persistent read
or ingestion failure can block the turn before this receipt is reachable; those
privacy checks remain fail-closed. Reader failure reports do not prove a broken
production ledger can still answer a conversational inspection request.

## Retention and limits

Source IDs are append-only/immutable until deletion; persistence is still one
encrypted full-state SQLite record, not a scalable per-event SQL graph. Every
write rewrites the snapshot; retrieval rebuilds an in-memory scoped index. This
is usable for bounded initial deployments, not a large-mailbox performance claim.
There are no embeddings or persistent model-context caches in this module.
This release reads older snapshots with no attestations. After a write, the new
`corrections` field requires a compatible reader; older strict-schema releases
fail closed. Do not roll back memory-enabled code to an incompatible reader or
restore old evidence snapshots to bypass that check.

Curated Git contains only opaque hashes and fixed metadata; values, explanations,
and source IDs live in authenticated encrypted sibling snapshots. Logical deletion
invalidates all model projections but **does not physically erase historical
encrypted snapshots, filesystem snapshots, database backups, or Rivet journals**.
Do not restore an older ledger without replaying all later tombstones before
serving traffic. Retain tombstones independently through the backup retention
window; expire old encrypted backups/snapshots under the operator's retention
policy. Git alone cannot restore personality, and a Git revert is not erasure.
Physical purge/key rotation and retention scheduling remain operator work; no
automatic backup/history deletion or production activation is performed here.
