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
- `retrieve(audience, query, {limit?, maxCharacters?})` returns `{sources,claims}`.
  Authorization precedes lexical ranking. Defaults: 12 combined records, 16,000
  serialized JSON characters; hard limits: 100 records, 100,000 characters and a
  10,000-character input query. Invalid bounds or oversized queries are rejected.
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
tombstone. A tombstoned record also rejects the entire page without advancing
its cursor. The host may filter known tombstones before persistence and record a
content-free gap, but must not treat arbitrary insertion failures as deletion or
silently skip nondeleted conflicts. An in-flight deletion may require refetching
and refiltering the same page. Imports cannot set `Source.correction`.

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
  including contradiction/supersession dependencies, and tombstones their IDs.
  The host must also suppress associated conversation history, in-flight context,
  reflection candidates, and any external summaries/caches before future prompts.

## Reflection and personality

`reflectionEvidence(audience, sourceIds, maxAgeMs): Evidence[]` returns original
episodes only, never claim/dream repetitions. Expiry is `observedAt + maxAgeMs`.
The host's reflection `retrieve({ownerId,scope,evidenceIds},signal)` adapter must
check current owner/scope authorization and `freshEvidence` for every returned
item with the current clock. Re-read on admission, before/after inference and
when reading candidates. Keep the raw result out of Rivet journals.

An optional `Source.correction` is explicit trusted owner input, not model
inference. Historical import pages cannot set it. Curated `ownerRevise(proposal,
supporting, now, maxAgeMs)` requires `supporting` from `reflectionEvidence` and
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

## Retention and limits

Source IDs are append-only/immutable until deletion; persistence is still one
encrypted full-state SQLite record, not a scalable per-event SQL graph. Every
write rewrites the snapshot; retrieval rebuilds an in-memory scoped index. This
is usable for bounded initial deployments, not a large-mailbox performance claim.
There are no embeddings or persistent model-context caches in this module.

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
