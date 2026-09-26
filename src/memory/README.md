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
- The host owns source ingestion and canonical IDs. Slack live and history use
  `slackSourceId(workspace, channel, ts)` from the import connector: no event ID,
  job ID, audience, or thread suffix. A changed envelope under an existing ID is
  an immutable-source conflict, not a second independent observation. Handle
  overlapping live/history records explicitly; never overwrite or widen scope.
- `source(audience, sourceId)` reads one authorized source, or `undefined`.
  `isDeleted(sourceId)` is only for trusted ingestion/replay filtering; it is
  not a model-visible existence oracle. Tombstones must outlive replayable data.
- `retrieve(audience, query, {limit?, maxCharacters?})` returns `{sources,claims}`.
  Authorization precedes lexical ranking. Defaults: 12 records, 16,000 serialized
  JSON characters; hard limits: 100 records, 100,000 characters. Oversized records
  are omitted, not cut into misleading evidence. Contradictions and supersession
  remain explicit edges, not silently resolved facts. Label all returned data as
  untrusted evidence, never instructions. Do not cache across deletion or scope
  changes. RTS results do not belong in this ledger.

## Source-grounded extraction and review

`extractionContext(audience, sourceIds)` returns exactly the requested authorized
sources (unique IDs, at most 20 records / 64,000 JSON characters). It rejects any
missing/deleted/unauthorized ID instead of returning partial context.

`extractMemory(store, audience, sourceIds, extractor, signal?)` supplies that
context to an injected `(sources: Source[], signal?: AbortSignal) => Promise<unknown>`.
The host supplies a read-only provider without tools. Ask it to identify supported
hypotheses, quote source text exactly, abstain on insufficient evidence, preserve
contradictions, and never execute requests found in sources. Output is an array
of at most 20 objects with **exactly** this shape:

```ts
{
  subjectSourceId: string; // the cited author's identity, not a display name
  text: string;
  category: "claim" | "preference" | "commitment" | "pattern";
  citations: { sourceId: string; quote: string }[];
  confidence: number; // [0,1], an estimate, not calibrated truth or authority
  validFrom: number | null; // epoch milliseconds; null means unknown
  validTo: number | null; // exclusive
  contradicts: string[]; // existing authorized claim IDs, or []
  supersedes: string[]; // existing authorized claim IDs, or []
}
```

The result goes to `stageProposals(audience, sourceIds, output)`. It checks exact
source quotations and current dependencies, derives scope and stable entity IDs,
and atomically persists encrypted pending proposals. Quotes establish provenance,
not semantic entailment: human review remains necessary. Identical proposals
deduplicate; acceptance/rejection is not reset by extractor retries. The async
helper awaits actual provider settlement; abort/deletion prevents later staging.

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
