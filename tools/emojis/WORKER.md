# Private cloud emoji backend

The HTTP API is June's primary integration. This Worker serves only a static
login/dashboard shell publicly; no catalog, status, or search data is public.
All API credentials are distinct, randomly generated **32–512 character** bearer
tokens. Put them in secret storage, never query strings, browser persistence,
Git, or model-visible tool arguments. The dashboard holds its read token in
memory. No MCP server is required.

## API

All API responses use `Cache-Control: no-store`. Send JSON for POST bodies and
`Authorization: Bearer <role token>`. Responses never include provider errors.
Wrong role/missing credential: 401; invalid input: 400; obsolete lease: 409;
unconfigured secrets/storage failure: 503. An empty queue is 200 with a null lease.

| Endpoint | Role | Request / response |
| --- | --- | --- |
| `GET /api/status` | read or admin | `IndexStatus` from `src/shared.ts` |
| `GET /api/search?q=...&limit=12&mode=hybrid` | **read only** | `{results: SearchHit[], mode, durationMs, semanticAvailable}` |
| `POST /api/jobs/claim` | indexer | `{}` → `{lease: EmojiLease \| null}` |
| `POST /api/jobs/heartbeat` | indexer | `{leaseId}` → `{expiresAt}` (epoch milliseconds) |
| `POST /api/jobs/complete` | indexer | `{leaseId, result: EmojiResult}` → `{ok:true}` |
| `POST /api/jobs/fail` | indexer | `{leaseId, code, uncertain}` → `{ok:true}` |
| `POST /api/import` | admin | `{sources: EmojiSource[], results: EmojiResult[]}` → `{ok:true,sources,results}` |
| `POST /api/reindex` | admin | `{name}` → `{ok:true}`; alias resolves to canonical job |
| `POST /api/sync` | admin | `{}` → 202 `{ok:true}`; next cron reconciles |
| `POST /slack/events` | Slack signature | signed challenge or workspace-scoped event |

Search accepts 1–300 characters, 1–50 results, and `mode=hybrid|keyword`.
Hybrid combines FTS5 BM25 and semantic rank with reciprocal-rank fusion; exact
shortcodes rank first. A provider failure returns **200 keyword results** with
`mode:"keyword"`, `semanticAvailable:false`, and
`degraded:"semantic_unavailable"`. Explicit keyword mode does not call AI and
reports `semanticAvailable:false` (not attempted). No result bodies are cached.
Semantic work runs alongside keyword search with a 150 ms wait budget. Slow
semantic work produces explicit keyword fallback, not an unbounded wait. Query
vectors alone are cached for one hour under a hashed, non-public Worker Cache
API key; slow first requests can warm that cache after responding. No raw query,
credential or catalogue result is cached. Network/D1 time still adds to the wait
budget, and cold or unique semantic queries may fall back more often.
The 200 ms target is a deployment measurement goal, **not a guarantee**; measure
warm/cold p50/p95 end-to-end on realistic queries and provider failures.

General JSON bodies are capped at 512 KiB. Imports are bounded upserts, not
replacement: at most 50 explicit sources and 20 canonical results per call;
result-only batches also upsert their embedded sources. Importing old revisions
is an explicit administrative overwrite; normal completion can never do that.
Only authoritative Slack reconciliation removes names absent from the catalog.
Source revision hashes follow `catalogSources` exactly. Workspace is fixed to
`T0266FRGM`; changing workspaces requires a separate database/index/deployment.

## Paid-work safety

Only canonical images get jobs. Alias documents stay independently searchable
while using the canonical analysis. Claims are atomic SQL update/returning.
Leases last five minutes; heartbeat well before expiry, including while waiting
for a provider. A claimed job is conservatively considered potentially submitted:
**any expired running lease becomes unknown**, never automatically requeued.
`fail` requires a lower-case error code (`[a-z0-9_]{1,64}`), never raw exceptions.
`uncertain:true` records unknown, otherwise failed; neither automatically retries.

Persist each local result before completion. Retry the same completion payload
after network ambiguity: the same completed lease and canonical result digest
is idempotent. A different digest, expired lease, obsolete revision, deleted
name, or admin requeue is rejected. Explicit admin reindex fences existing leases
and authorizes another paid attempt; inspect the local durable output first.
The read token cannot claim work or trigger reconciliation, and the indexer
cannot search, import, reindex, or read status.

## Durable search and reconciliation

D1 owns sources, jobs, analyses, current search documents, FTS5, sync state, and
the embedding outbox. SQL triggers update documents/FTS/outbox in the same
transaction as catalog/results. Analyses are keyed by canonical name/revision.
Vector IDs combine 128 bits of source revision and 128 bits of result digest;
names without analysis use revision-derived IDs and name-only text. Embedding
input is name plus the compact `embeddingText`, never the full description.

Every minute cron expires leases, processes a dirty sync marker (or reconciles
if the last successful sync is an hour old), then drains at most 32 outbox items.
Slack events verify raw-body HMAC-SHA256 and a five-minute timestamp window.
The `emoji_changed` callback must have the fixed workspace ID. A durable
coalesced counter is incremented **before** the acknowledgement. Slack's signed
URL verification payload has no team ID; only that challenge is exempt from
workspace validation. Retries may increment the counter again harmlessly.

Reconciliation validates Slack `auth.test` before `emoji.list`. Enterprise tokens
must independently prove access to `T0266FRGM` through `auth.teams.list`; an
enterprise ID alone is never accepted. Every catalogue request explicitly selects
that workspace. Reconciliation uses a durable fenced ten-minute lock, bounded D1
batches, and only removes unseen sources after all batches succeed. Events arriving
during a sync remain dirty. Partial failures leave the marker pending; next cron
retries. Catalog publication is incremental,
not a whole-catalog snapshot swap. Partial administrative imports should not run
concurrently with authoritative sync unless overwriting them is intended.

Outbox records exist before external writes. Workers AI model is
`@cf/baai/bge-small-en-v1.5`, **384 dimensions**, Vectorize **cosine** index.
Vector writes are deterministic batched upserts; failures retain pending work.
Successful acknowledgement marks only the same current vector ID indexed.
Vectorize acknowledgement is not immediate query visibility. Every semantic hit
must resolve to a current D1 vector ID; keyword candidates are revalidated after
AI returns as well. Changed or removed records cannot leak stale analyses even
while Vectorize mutations are propagating. A stale vector write racing a delete
may leave an unreachable vector in Vectorize; correctness does not depend on
garbage collection. Keyword search remains available while embeddings catch up.

## Local verification (no provisioning)

Install this package's dependencies using its documented pnpm workflow, then:

```sh
pnpm exec wrangler types
pnpm exec wrangler d1 migrations apply raygen-emojis --local --persist-to /tmp/emoji-d1-check
pnpm exec tsx --test src/worker/boundaries.test.ts
pnpm exec biome check src/worker wrangler.jsonc slack-manifest.json
pnpm typecheck
pnpm exec wrangler deploy --dry-run
```

Use a unique disposable local state directory, then remove only that directory.
The boundary test uses Wrangler's local D1/workerd through `getPlatformProxy`,
with persistence and remote bindings disabled. It invokes the real HTTP handler;
AI and Vectorize are in-memory mocks. It checks role separation, atomic claim,
lease ownership, idempotent completion, revision fencing, aliases, expiry,
deletion/FTS cleanup, stale-vector filtering, outbox retry, keyword degradation,
and Slack signatures/workspace checks. It is **not** a live AI quality/latency,
Vectorize consistency, Slack installation, or deployed HTTP test.

Ordinary `wrangler dev` may access Workers AI remotely and incur costs even
without `--remote`; do not use it as an offline semantic test. `.dev.vars.example`
lists local keys; do not put real credentials in fixture tests. Generated
`worker-configuration.d.ts` derives secret types from `secrets.required`.
Wrangler also augments `NodeJS.ProcessEnv`; keep the standalone indexer's type
configuration isolated or handle that generated ambient typing without forwarding
cloud credentials to a model subprocess.

## Operator deployment checklist (not executed by this implementation)

1. Obtain explicit authorization for Cloudflare provisioning/deployment and Slack
   app installation/configuration. Verify the target account and DNS zone.
2. Provision a dedicated D1 database and replace the all-zero placeholder ID in
   `wrangler.jsonc`. Provision a dedicated Vectorize index named `raygen-emojis`
   with 384 dimensions and cosine distance; no metadata indexes are required.
3. Configure distinct read/indexer/admin secrets and Slack bot/signing secrets
   using secret storage/interactive Wrangler prompts. Never put their values in
   command arguments. Give June **only READ_TOKEN** through server-side config.
4. Apply `migrations/0001_catalog.sql` to the intended remote database using
   `wrangler d1 migrations apply raygen-emojis --remote` after reviewing target
   and backup strategy. Generate types and inspect a dry run before deploying.
5. Deploy the Worker/custom domain `emojis.raygen.dev`, verify unauthenticated
   data rejection and authenticated status, and verify the minute cron is active.
6. `slack-manifest.json` is a **new standalone app template**, not a replacement
   for June's live manifest. For an existing app, first fetch its live manifest,
   preserve unrelated settings, and obtain approval before adding `emoji:read`,
   `emoji_changed`, and the event URL. Complete signed URL verification and
   install in `T0266FRGM`; verify `auth.test` workspace before initial sync.
7. Call admin sync, inspect resulting counts, and connect the outbound indexer.
   Import existing durable output in bounded batches if needed. The indexer
   requires no inbound port. Verify add/change/alias/remove and completion retry
   on disposable names before relying on production search.
8. Measure real semantic quality and warm/cold p50/p95 latency. Verify provider
   failure fallback and removal while Vectorize propagation is delayed. No 200 ms
   claim should be made until this deployment-specific measurement passes.

Current documentation consulted: Cloudflare Vectorize Workers binding API,
Workers secret configuration/type generation, installed Wrangler 4.142.0 schema
and generated workerd types. No cloud resources or Slack app were changed here.
