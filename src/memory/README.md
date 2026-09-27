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
- `retrieveSource(audience, sourceId, {maxCharacters?})` is the bounded exact
  recall projection. It returns the original source and provenance in the same
  `{sources,claims}` envelope as `retrieve`, with no inferred claims. Missing,
  deleted, foreign-audience, and opted-out Slack sources all return empty arrays.
  An authorized source that exceeds the serialized budget is omitted whole with
  `truncated:true, omitted:1`; it is never clipped into an apparent quotation.
  Defaults and hard character limits match `retrieve`.
- `inspectClaim(audience, claimId, {limit?, maxCharacters?})` reads exactly one
  retained claim, never a pending/rejected proposal or a lexical match. Missing,
  foreign and deleted IDs all return `{claim:null, quotations:[]}`. Each quotation
  contains its original source ID, author, platform/account/conversation, observed
  time and URL. Grounded citations are checked against original text; sources
  without a selected citation use their full original text, never a paraphrase.
  Defaults are six quotations and 3,000 JSON characters; hard limits are 100 and
  100,000. Whole oversized records are omitted with `truncated:true` and `omitted`;
  an oversized claim returns no quotations rather than losing its uncertainty or
  relationships. Claims (including accepted ones) remain hypotheses, dreams remain
  speculation, and quotations prove provenance rather than truth or entailment.
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

For an exact original, ask "Show source ID …" in the same owner-private turn.
June can use `recall: {kind: "source", sourceId: "…"}` with empty text and no
other action. The ID is exact (1–2048 characters, not a keyword query). The
same 3,000-character serialized/escaped budget applies to that one whole source,
including its original observation time, author, account, conversation and URL.
No neighboring sources or inferred claims are expanded. Missing, deleted,
opted-out and unauthorized IDs produce the same absence without echoing private
metadata; an authorized oversized source is explicitly omitted, not clipped.

For an exact retained claim, ask "Inspect claim <ID> and its original evidence."
June can use `recall: {kind:"claim", claimId:"<exact ID>"}` with empty text and
no other action. The same private receipt path returns the claim and up to six
original quotations with provenance, bounded to 3,000 escaped JSON characters.
There is no keyword/prefix fallback and no pending-proposal promotion. Missing,
inaccessible, pending/rejected and deleted claims share the same unavailable
response; budget omissions are reported separately. Claims depending on Slack
`##` opt-outs are also unavailable, consistent with the recall/history policy.
Acceptance does not make a hypothesis fact, and quoting a source does not prove
entailment. Claims retain uncertainty, validity dates and unresolved relation IDs;
dreams remain speculation. Original references include transitive dependencies
and source-bearing grounding fields, not contradiction/supersession counterparts
as extra corroboration. The host records originals even if some quotations are
omitted, so deletion still invalidates the receipt and derivatives.

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

To inspect recorded updates to a known claim, June can use
`recall: {kind: "supersession", claimId: "exact-claim-id"}`. The host calls
`inspectSupersession(audience, claimId, {limit?, maxCharacters?})`, following only
explicit supersession edges in both directions from an accepted claim. Defaults
are six visited claims and 3,000 serialized JSON characters (hard maxima 100 and
100,000); the host also bounds escaped output. Visible branches remain separate;
nodes are ordered newer-to-older by recorded edges, not dates or verification.
Each node carries `supersedes` and `supersededBy` IDs only for included endpoints.
`incomplete` means endpoints were omitted by bounds or could not be resolved;
`cyclic` means the visited graph cannot be ordered. Empty `supersededBy` means no
newer update is shown, never proof of current truth. Foreign incoming updates
cannot affect the result; missing, foreign, opted-out and forgotten roots have
the same absence. This is a scoped view, not proof the entire history is known.
Claims remain untrusted; inspection does not accept or mutate them, and inherits
recall's owner-private authorization, deletion checks and provenance binding.

### Inspect claims that depend on a source

In an owner-private conversation, ask June which claims depend on an exact source
ID. June requests `recall: {kind:"dependents", sourceId:"<exact ID>"}` with empty
text and no other action. The host uses the existing recall authorization and
deletion checks, never a model-supplied audience or a second graph database.

`dependentClaims(audience, sourceId, {limit?, maxCharacters?})` returns bounded
`claims: [{id, kind, dependency}]` plus `direct`, `derived`, and `omitted` counts.
A direct claim references the source in `dependsOn` or grounding; a derived claim
reaches it through other claims, including contradiction/supersession dependencies,
just as logical deletion does. A claim with both paths is counted once as direct.
Counts include only authorized stored claims, never unrelated or foreign claims
or pending and rejected proposals. Claim IDs and kinds are metadata, not a statement
of truth; source bodies, claim text, entity IDs and quotations are not returned here.

Defaults are 12 records / 3,000 serialized JSON characters; hard limits are 100
records / 100,000 characters. June uses at most six records and 3,000 characters
after display escaping. Whole records are omitted rather than clipping IDs;
`omitted` and counts share the budget. Missing, deleted and unauthorized sources return
`undefined`, and June reports the same unavailable response. An authorized source
with no dependents returns zero counts. Results are read-only snapshots, not
complete import coverage or a forget preview; this action cannot delete anything.

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
  confidence: number | null; // [0,1] estimate, or unknown; not calibrated truth
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
and different source-ID sets have separate admissions. New proposal IDs bind both
grounding and all canonical supplied input IDs. Different input context does not
inherit an earlier review. Source-set receipts still preserve
the first admitted result, including an exhausted receipt after forgetting.
Changed source content under the same ID still fails ingestion rather than merging.

The host records `claim.extractionContext = {sourceIds, claimIds}` from the exact
pre-inference inputs, including uncited raw sources and `claimIds: []` for known-empty
comparison context. This is deletion-only provenance:
it never adds citations, `dependsOn` edges, or independent corroboration, and the
model cannot set it. Forgetting any supplied source or comparison evidence removes
its influenced pending/accepted proposals and descendants, even if the output
named no citation or relation to that input.
Context IDs are revalidated for scope/existence within admission's transaction.

Legacy extracted proposals have no extraction-context marker. On any deletion,
they and their accepted descendants are conservatively invalidated; opening a
ledger with existing tombstones applies the same closure before returning data.
This can discard unrelated legacy derived claims because their independence is
unknown. Original sources, tombstones, and exhausted source-set receipts remain;
retry cannot refill those receipts or relabel old output as tracked. Historical
context is never guessed from current retrieval. For pre-receipt snapshots,
identical legacy output or its grounding-only tombstone is also rejected before
minting a new context-bound ID; that admission remains exhausted.
This is logical invalidation,
not physical purge. Older strict readers cannot read the new claim field, so
rolling back the binary requires a compatible reader, not restoring old data.

This does not prevent a provider call: runtime intent tracking
owns paid-call retries. The async helper awaits actual provider settlement;
forgetting a batch source or a comparison claim's underlying evidence first
commits tombstones, then aborts matching extractions on that store instance.
It does not signal unrelated batches or release admission early. A provider may
ignore abort; its eventual output is still rejected. Deletion through another
process/store instance cannot signal these local providers, but the durable
staging checks still reject their output. Older snapshots have no admission
receipts; their first post-upgrade admission records one without rewriting
existing proposals.

Operator APIs:

- `proposals(audience): MemoryProposal[]` lists pending, accepted, and rejected
  proposals. `proposal(audience, id): MemoryProposal | undefined` reads one.
- `reviewProposal(audience, id, "accepted" | "rejected"): void` is an
  authenticated operator action. Same-decision retries are idempotent; opposing
  decisions fail. Only accepted proposals become retrievable claims.
- `previewForget(audience, sourceId): ForgetPreview | undefined` is read-only,
  reusing source-dependent inspection's full authorized claim graph. It returns
  `{sourceId,sources:1,claims,proposals:{pending,accepted,rejected},physicalPurge:false}`
  plus **host-only** `fingerprint` and `confirmable`. Missing, deleted and foreign
  source IDs all return undefined. Counts include contradiction/supersession
  derivatives and all authorized proposals; accepted proposals also count as
  claims. The fingerprint binds the audience, exact target, complete authorized
  derivative IDs/edges and proposal statuses, never just bounded inspection rows
  or counts. `confirmable:false` blocks later confirmation when global deletion
  reaches unpreviewed records. Never expose that bit, its reason, or the
  fingerprint in model context or preview receipts. A later confirmation path
  must require confirmable and freshly compare the fingerprint before deletion;
  preview itself does not authorize or perform any mutation or cleanup.
- `deleteSource(id): void` removes the source and all dependent claims/proposals,
  including contradiction/supersession dependencies and all explicit references
  in `grounding`, and tombstones their IDs. Snapshot reads reapply tombstones to
  hide grounding-only derivatives left by older writers; the next write persists
  that cleanup. Unrelated sources and tracked claims remain available; untracked
  legacy extracted output follows the conservative policy above.
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

The owner can also ask “Which imports support these pending claims?” The same
view includes `recordedImports`: selection IDs, the claim's cited source IDs
recorded in each selection, and extraction IDs whose receipts link that proposal.
Selection membership alone does not mean that selection produced the claim;
uncited batch inputs are never presented as support. Empty lists mean no recorded
linkage, not proof no import occurred. Older imports may have no membership data.
Exact page attribution is unavailable: the existing ledger records selection-level
membership, not individual page boundaries. Importing never approves a claim.
This projection joins existing records through
`pendingImportProvenance(audience, proposalId)`; it creates no separate store,
infers no membership from dates/coverage, and shares the row size limit and
deletion provenance of the pending view.

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

To reject a pending claim, the owner instead sends exactly
`!memory-reject proposal:<full 64-character lowercase hex ID>` through the same
verified plain-text Slack DM boundary. The pending view supplies both complete
commands within its existing display budget. Rejection persists the irreversible
decision and bounded original proposal provenance in the encrypted ledger; it
survives reopening, repeated commands and extraction replay. That candidate cannot
later be accepted. Already accepted claims cannot be rejected through this command.
This is not deletion: original sources remain available, and explicit source
forgetting remains the separate operation that removes dependent proposals and
records deletion tombstones. Rejection starts at memory-claim-review version 3;
older journaled rejection text retains its previous conversational path.

## Owner confirmation through June

Ask June in the authenticated owner's Slack DM to preview forgetting an
exact source ID (`forgetPreview: {sourceId}`). When host cleanup is available and
the entire deletion target can be previewed, the host appends a single-use
`!forget-confirm TOKEN` command. Send that exact command as a new ordinary owner
message (not a Slack slash command) within ten minutes. A new confirmable preview
replaces any older unused confirmation. Quoted commands, public/guest turns,
model suggestions and model-supplied confirmation flags cannot authorize deletion.
A preview whose delivery was rejected or uncertain cannot be confirmed.

The host rechecks the exact preview fingerprint and authorization immediately
before tombstoning. Changed dependencies require a fresh preview. Consumption is
persisted first, then the existing host cleanup revokes social grants, clears
working context and cancels associated work. Durable `forgetConfirmations`
receipts retain only binding metadata and pending/started/completed status.
After interruption, send the same command as a new owner message to resume the
same cleanup. Frozen context/job IDs prevent retries from erasing newer work;
completed confirmations and duplicate events do not rerun cleanup. A started
receipt without a ledger tombstone requires a fresh preview, not a cleanup retry.
All results disclose `physicalPurge:false`: journals, encrypted history, backups
and already-sent platform content are not physically erased.

Ask June privately whether forgetting cleanup finished; she can request
`{"text":"","inspection":"forgetting"}`. This read-only report counts recorded
pending/started/completed confirmations and shows at most ten started attempts
with opaque tokens, current tombstone status and recovery guidance. It never
recalls source bodies or returns source IDs, fingerprints or event IDs. For
`repeat-confirmation`, the owner can resend the listed token with the existing
`!forget-confirm TOKEN` command; `fresh-preview` requires a new exact preview,
and `operator-review` means safe recovery could not be established. Inspection
does not authorize or run cleanup. Completed means the host callback returned,
not external stoppage or physical erasure; every report retains `physicalPurge:false`.
Missing receipts do not establish absence of older or operator-initiated cleanup.

## Reflection and personality

`reflectionEvidence(audience, sourceIds, maxAgeMs): Evidence[]` returns original
episodes only, never claim/dream repetitions. Expiry is `observedAt + maxAgeMs`.
The host's reflection `retrieve({ownerId,scope,evidenceIds},signal)` adapter must
check current owner/scope authorization and `freshEvidence` for every returned
item with the current clock. Re-read on admission, before/after inference and
when reading candidates. Keep the raw result out of Rivet journals.

In an enabled owner-private turn, June can request
`reflectionMemory: {id: "<candidate-alias>", subjectSourceId: "<cited-source-id>"}`
with empty text and no other action. These are references only: rationale,
confidence, quotations and the full source context come from the host-validated
immutable publication, not model replacements. The host dispatches only after
the inference occupancy has actually settled. It captures the current operation
epoch before validation and rechecks it, live occupancy and quiet hours before
the synchronous ledger write. The candidate's generation epoch is never restamped.
The capability is frozen in the turn plan and absent from guest/public turns,
worker results and read-only reflection/search synthesis. Reading a candidate
does not grant staging permission to a continuation; staging needs its own
effect-eligible turn. The private receipt contains only proposal identity/status,
not copied rationale or quotations.

After privately inspecting a current reflection candidate, the owner can send
`!reflection memory <64-hex-candidate-id> <cited-source-id>` to June as a literal
private message (not a Slack slash command). Slack requires verified plain text,
not quoted/code blocks or attachment fallback. The source selects the subject
by its original platform/account/author, never a guessed
display name. This stages the rationale as a **Reflection hypothesis**, not an
observation or accepted memory. Original cited episodes supply exact quotes;
dream-only or mixed dream input cannot be staged. Unknown confidence stays null,
and observation times remain on the original sources. Oversized rationale or
quotes are rejected, not silently clipped. The normal pending-proposal review
surface owns subsequent acceptance or rejection; this command never accepts.
Publication expiry limits admission, not the lifetime of an already-staged
pending memory proposal. Subsequent owner review retains the ordinary memory
validity and deletion rules, plus the durable candidate rejection below.

The trusted reflection actor passes its validated opaque ID as the sixth
`stageProposals` argument. This is a separate durable admission from ordinary
extraction: one candidate cannot generate more proposals or reset review decisions
on retry/reopen, even if the subject selection changes. All original request
sources become deletion-only `extractionContext`, including uncited context;
only cited sources become `dependsOn` evidence. Deleting any input removes the
proposal (or accepted claim) and prevents restaging from stale candidate state.
The generated rationale is never inserted as a new source.

Candidate rejection calls `rejectReflectionProposals(audience, candidateId)`
before persisting the actor's rejection. The ledger remembers the rejected alias
even if nothing was staged, rejects future stale staging, and atomically marks
that candidate's pending proposals rejected. Ordinary memory review then refuses
their acceptance. Retries and reopening cannot restore pending status. A claim
the owner accepted **before** candidate rejection is an already completed review;
candidate rejection does not retract it or delete the original evidence.

The new extraction-receipt alias and rejection tombstones require a compatible
ledger reader after writing. A rollback must not restore old snapshots or drop
rejection receipts to re-enable stale staging.

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

Staged global personality suggestions retain original `sourceIds` in the private
curated store. After source tombstoning, `forgetGlobalProposals()` removes matching
payloads, including copied explanations, from the active encrypted snapshot before
HTTP/June working-context cleanup. Pending reads, staging and reopening reconcile
tombstones too, so interrupted cleanup cannot leave those payloads active. June's
pending-suggestion reads use the same store readers; forgotten suggestions cannot
be read or restaged. Unrelated suggestions, the public global defaults/revisions
and the actor's approval/rejection decisions are unchanged. This is logical
forgetting, not erasure of older encrypted snapshots or journals.

## Ledger operation status

Owner-private `inspection: "memory"` reports scoped capacity and separate
ledger-wide `operationStatus()` metadata. This read-only API performs no I/O
and returns `connection`, `sinceOpenedAt`, `persistence` counters, and `read`/`transaction` records
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

`operationStatus().persistence` exposes fixed-size numeric counters through June's
owner-private `inspection: "memory"`: `calls`, `completed`, `failed`,
`totalDurationMs`, and `maxDurationMs` (null until a sample). These volatile
counters start at zero on each store open. They count settled `transaction()`
attempts, including no-op commits and failed BEGIN/read/change/write/COMMIT or
rollback, not records written. Completion requires a successful COMMIT. Durations
use a monotonic clock and include the entire transaction attempt and rollback,
not just disk I/O. Initial empty-ledger creation, pre-transaction validation,
curated Git saves, and historical writes are excluded. Counts stop at the safe
integer limit; total duration saturates there. No event list, IDs, paths, evidence
bodies, or exception text is retained. Inspection does not write memory; counters
are observations, not proof of complete history or current storage health.

## Retention and limits

### Offline restore must replay before opening memory

Never serve a copied snapshot using the ordinary two-argument constructor.
For an offline, disposable copy use
`new EvidenceStore(path, key, {restore: {watermark, pages}})`. The path must
already contain a snapshot. `pages` is a synchronous iterable of complete
`exportTombstones` pages, starting at `after: 0` and ending at `nextAfter: null`,
all pinned to the independently retained `watermark`. Supply that expected
watermark from trusted retention metadata, not from the stale snapshot or an
unverified page. Keep the snapshot offline with no other readers or writers.
Restore accepts only an existing, clean rollback-journal SQLite snapshot, with
no `-journal`, `-wal` or `-shm` sidecars. It rejects WAL/recovery inputs before
SQLite opens them rather than converting or repairing the candidate.

Opening authenticates the encrypted snapshot and every page's MAC, requires the
same persisted ledger ID, then validates page bounds, offsets, completion,
duplicate IDs and the shared tombstone prefix. It then removes forgotten sources
and all dependent claims, relations, proposals and extraction references in one
encrypted transaction, verifies that the exact ciphertext was written, and
rejects an export missing any snapshot dependants. Only after commit does
the first index build run and a readable store return; any replay failure closes
the store and rolls back without exposing a partially restored handle. Repeating
the same replay is safe and preserves newer local tombstones. Ordinary reopen
preserves the replay receipt and the deletions. Restored snapshots now include
`restoreWatermark`; code rollback requires a compatible reader. Never bypass a
schema rejection by replacing the ledger with an older copy.

Host configuration accepts `memory.restore: {watermark, tombstonePages}`, where
`tombstonePages` is an absolute path to a JSON array of those ordered pages.
Protect this ID-bearing file with the same owner-only retention controls as
the independent export. Startup finishes replay before opening curated
personality, creating runtime consumers, or serving HTTP. Missing, malformed or
incomplete replay input aborts startup at the content-free memory-restore stage;
it does not fall back to ordinary opening. This configuration does not copy or
replace a database, fetch exports, grant restore authority, or activate memory.

June's existing owner-private `inspection: "memory"` reports readiness, the
persisted replay watermark (or no restore receipt), and current deletion
watermark, without evidence or tombstone IDs. The trusted host equivalent is
`restoreStatus()`. A receipt proves only which supplied watermark was replayed,
not that retention is current. Unsigned exports, changed pages, other ledgers
(even with the same key), and snapshots predating persisted ledger identity are
rejected. Restore never assigns a new identity to a legacy snapshot; those need
separate trusted reconciliation. The operator must retain **all** later deletions
independently and pin the required watermark from that trusted retention record.
An unmarked file replacement cannot reveal later deletions by itself. Production
restore, backup replacement and other stores' restore procedures remain separate
work.

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

June can request `{"text":"","inspection":"snapshot-retention"}` on an
owner-private turn; public/guest turns and synthesis cannot use it. This is
separate from the no-scan `retention` inventory and reports unavailable when no
curated store is attached. It never creates a store or starts cleanup.
`CuratedPersonalityStore.retentionReport()` is a metadata-only retention dry run:
it preserves every snapshot referenced by the current curated Git history,
including historical/rollback revisions whose evidence has been tombstoned.
It reports aggregate file counts and bytes only, never paths, IDs, provenance,
personality values or explanations, and never reads/decrypts snapshot payloads.
Classification stops at 200 commits and 1,000 snapshot files; incomplete scans
report unknown (`null`) review-candidate and missing-snapshot totals, not zero.
Other counts are observed lower bounds when incomplete. The existing filesystem
safety validation still inspects the store tree; these are classification limits,
not an overall I/O/time budget. Missing referenced files indicate missing restore
inputs; presence does not verify ciphertext integrity or restore readiness.

Unreferenced files are **operator-review candidates, not deletion permission**:
they may belong to an in-flight write, another ref, or a retained backup. No age
cutoff, backup dependency verification, prune command, scheduler, or deletion API
is provided. Preserve Git metadata, encrypted snapshots, separately managed keys,
and independent tombstones throughout the backup window; replay later tombstones
before serving any restored data. The report neither verifies other retained
copies nor turns logical deletion into physical erasure.

### Independently retained tombstones

`GET /operator/memory/tombstones` requires the existing owner bearer token (not a
console cookie). It is read-only and `Cache-Control: no-store`. Optional query
fields are `after` (default 0), `watermark` (default current deletion revision),
and `limit` (default/max 100, minimum 1). Values must be nonnegative safe decimal
integers; malformed, duplicated, unknown, or out-of-range parameters are rejected.
An optional `audience` must equal the configured owner-private audience. The
export itself is ledger-wide, not audience-filtered: tombstones retain only IDs.

The trusted store method `exportTombstones({after?, watermark?, limit?})` returns:

```ts
{
  version: 1,
  ledgerId: "...",          // UUID persisted inside the encrypted ledger
  after: 0,                // number of IDs already consumed
  watermark: 3,            // pinned deletionRevision(), not a wall-clock time
  tombstones: ["source-1", "claim-1"],
  nextAfter: 2,             // null when this pinned range is exhausted
  mac: "..."               // lowercase 64-hex HMAC-SHA256
}
```

Each page contains at most 100 IDs and 64,000 UTF-8 JSON bytes, including metadata.
IDs include transitively removed claims/proposals, not just original sources.
No bodies, quotations, source metadata, credentials, or encryption keys are
exported. IDs themselves remain private metadata; protect exported pages with
independent restricted storage and the operator's retention policy.

Pages are authenticated, not encrypted. `tombstoneExportMac(key, page)` returns
32 MAC bytes using HMAC-SHA256 over UTF-8
`JSON.stringify(["june-tombstone-export-v1", ledgerId, after, watermark, tombstones, nextAfter])`.
Its dedicated key is derived with HKDF-SHA256 from the existing evidence key,
empty salt, info `june-tombstone-export-auth-v1`, and length 32. No key is exported.
Restore must strictly validate the version-1 page, compare its MAC in constant
time, require the encrypted snapshot's ledger ID, and verify complete sequential
coverage to an independently trusted required watermark before exposing evidence.
Valid MACs alone do not prove freshness or completeness of a retained set.

New ledgers receive a random UUID on creation. Existing ledgers lacking one are
upgraded once on open inside an encrypted transaction before index construction;
subsequent opens and exports do not rewrite it. Backups predating that identity
cannot be authenticated against newly exported pages by guessing identity from
the key or count. Restore must reject that mismatch, not silently assign an ID.
This is a one-way format upgrade for pre-export binaries: their strict snapshot
schema rejects `ledgerId`, even though the snapshot version remains 1. A code
rollback needs a reader that understands the field; never restore an older ledger
to work around that incompatibility and thereby discard later tombstones.

Start at `after=0`, retain the returned `watermark`, and pass that same watermark
with each `nextAfter` until it is null. The append-only order survives restarts;
later deletions cannot shift this pinned range. An empty completed page is valid,
including an empty ledger. Require `0 <= after <= watermark <= current revision`.
After independently retaining a complete range, start an incremental export with
`after` equal to its watermark and omit `watermark` to pin the next range. Do not
treat a partial export as complete. A watermark is a count for this ledger's
append history, not a timestamp; never combine exports from unrelated or
rolled-back histories based only on counts. Keep the same ledger identity across
all pages and independently retain the required watermark.

June can privately answer “Inspect tombstone export status” using
`inspection: "tombstones"`. The host returns only the current watermark, API path,
and bounds, never IDs or an unbounded export. Public/guest and synthesis turns
cannot call it. Neither this status nor an API read records or proves independent
retention, performs a restore, or changes live backups. Replay before restored
memory becomes readable remains a separate restore operation.

## Local encrypted evidence backup

With the existing memory opt-in enabled, the verified owner can send the exact
`!memory-backup` command as plain text in a private Slack direct message to June.
Verified ingress marks fresh plain commands; old queued messages, rich-text
quotes/code, attachments, model output and other participants cannot authorize it.
The host uses the event's stable ID for idempotency; replay cannot create a second
artifact or replace the original with newer data. June can call
`inspection: "backup"` for a read-only content-free status receipt. The prompt
explains both paths. Neither path reveals a key, evidence body, or local path.

The existing bearer-only operator API also exposes `POST /operator/memory/backup`
with exactly `{id: "<64 lowercase hex characters>", confirmed: true}` and
`GET /operator/memory/backup` for status. Reuse the request ID only to recover the
same backup; a new explicit request needs a new ID. No caller chooses a path.
The result is a manifest, not a download. Authentication and `no-store` remain
the enclosing operator router's responsibility.

`EvidenceStore.backup(id)` copies the current `records` payload byte-for-byte to
`<memory-directory>/backups/<id>/evidence.sqlite`, retaining the ledger's existing
AES-256-GCM envelope and externally managed key. This copies only the current
encrypted snapshot, not historical SQLite free pages. It writes a sibling
`manifest.json`: `{version:1, format:"june-evidence-v1", id, createdAt,
ciphertextBytes, ciphertextSha256, tombstoneWatermark}`. The watermark comes from
authenticating those exact bytes, not a separate live-state read. Backups require
the persisted encrypted ledger identity; retries and status reject missing or
different identities, including a different ledger encrypted with the same key.
Directories are owner-only `0700`, files `0600`; symlink destinations, relative/in-memory stores,
and nonprivate directories fail closed. Artifacts are never overwritten.
An incomplete artifact fails closed on retry and needs operator reconciliation.

`backupStatus()` authenticates the artifact referenced by the last successful
receipt (`backups/latest.json`), even after restart, and returns
`{latest, tombstoneWatermark, independentRetentionVerified:false,
scope:"evidence-ledger-only"}`. Latest means the last confirmed request, which
may be a retry of an older artifact. The manifest's timestamp/ID and SHA-256 are
metadata and mismatch checks, not cryptographic proof of provenance. The
tombstone count is checked against the authenticated snapshot; it is not a
global deletion clock or independent retention receipt.

Trusted offline tooling can use `readEvidenceBackup(directory)` to obtain
`{manifest,payload}` with read-only SQLite and hash/schema checks. This helper
rejects WAL headers and journal/WAL/shared-memory sidecars before SQLite opens;
it never converts or recovers the candidate database. Only a closed
rollback-journal artifact is accepted. This helper does **not** authenticate
the ciphertext or authorize restoration; never expose
its payload to chat, HTTP, logs, or workflow journals. Restore must separately
authenticate with the existing secret key, validate the snapshot schema and
ledger identity, and replay later independently retained tombstones before any
memory becomes readable. A backup receipt is not restore readiness.

This is only the evidence ledger (including its proposals, import progress and
tombstones), not curated personality, Rivet journals, credentials, or a whole
June installation. Local disk loss still loses the backup. Nothing is uploaded,
physically purged, expired automatically, or independently retained by this
command. Verification uses disposable local data only; no live export or
production replacement is part of acceptance.

## Offline restore validation

`validateEvidenceBackup(directory, key, {watermark, pages})` checks a backup's
manifest, ciphertext hash, AES-GCM authentication/key, ledger schema and signed
tombstone replay on an owner-only disposable copy. It binds the manifest's
tombstone count to the authenticated snapshot before replay. Supply the latest
independently trusted watermark and complete signed pages from the same ledger;
the backup's own count is not a freshness anchor. Legacy snapshots without a
ledger identity, stale/incomplete/mismatched pages, malformed data and wrong keys
fail closed. Neither the original ledger nor the backup is opened for writes.
The temporary copy is deleted; only content-free validation metadata is returned.

For a running host, bearer-only `POST /operator/memory/restore/validate` accepts
exactly `{ "id": "<64 lowercase hex backup ID>" }`. It validates that fixed local
backup against the host's current signed deletion history and in-memory key;
request-supplied paths, keys, pages and watermarks are rejected. This local
preflight does **not** verify independent backup/tombstone retention.

June can inspect the last process-local result with `inspection: "memory"` in
the owner's private conversation. It reports `validated`, `rejected`, `stale`
after new forgetting, or not run (including after restart). No body, tombstone
ID, secret key or filesystem path is exposed. June cannot run validation or
replace a store. A successful preflight is not a restore authorization: actual
replacement remains an explicit operator operation, requiring a fresh validation
against the latest retained deletion watermark. There is no automatic production
restore, and this evidence-ledger check does not validate curated Git or journals.
