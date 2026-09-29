# Hack Club emoji library

A standalone Cloudflare Worker backed by Neon Postgres. GitHub Actions maintains
the catalogue and requests bounded Worker embeddings; no always-on LEGION
process is needed for search or maintenance. June uses the read-only HTTP API.
An optional outbound Linux indexer generates new image descriptions; Actions
does not launch or retry that inference. See [WORKER.md](WORKER.md) for activation.

## Index on LEGION (or the homelab)

Run commands from `tools/emojis`. This package has its own pnpm workspace and
lockfile, and selects Node 24.21 through `.npmrc`.

```sh
SHARP_IGNORE_GLOBAL_LIBVIPS=1 pnpm install --frozen-lockfile
export EMOJI_DATA="$HOME/.local/share/hackclub-emojis/catalog"
export CODEX_HOME="$HOME/.local/share/hackclub-emojis/codex"
mkdir -p "$CODEX_HOME"
chmod 700 "$CODEX_HOME"
```

Use a **dedicated, private Codex home**, with an existing authorized login or an
owner-run `pnpm exec codex login` using that home. Do not use your normal Codex
home: inherited tools, skills, policy and instructions are deliberately rejected.
Keep `auth.json` mode 0600 and its directory owned by the indexer's user. Do not
copy authentication from LEGION to another host as part of data migration.

Import an authorized `emoji.list` export (`{ok:true,emoji:{...}}` or a name/URL
map). Alternatively omit `--catalog` and provide `SLACK_BOT_TOKEN` through the
private process environment; the CLI checks `auth.test` workspace first.

```sh
pnpm indexer sync --data "$EMOJI_DATA" --catalog /private/catalog.json
pnpm indexer serve --data "$EMOJI_DATA" --port 3091
# In another terminal, start a bounded pilot before the bulk job:
pnpm indexer run --data "$EMOJI_DATA" --home "$CODEX_HOME" --limit 20 --max-concurrency 4
pnpm indexer run --data "$EMOJI_DATA" --home "$CODEX_HOME" --max-concurrency 1000
```

The dashboard listens **only on loopback**. Use an authenticated preview for
remote access; `PUBLIC_URL` allows that exact preview hostname. Never expose the
local listener directly. It has no write controls. Cloud search uses separate
read, indexer and admin credentials, described in [WORKER.md](WORKER.md).

The bulk scheduler starts at four simultaneous descriptions and doubles no
faster than every 30 seconds after enough completions. It retains at least
4096 MiB host available memory and 1 GiB disk space by default, limits native
image preparation to two operations, and skips isolated, confirmed generation
failures (including terminal server and request-connection errors) without
retrying them. This requires a healthy app-server and confirmed turn retirement;
uncertain connection failures still stop the batch.
On each distinct terminal generation failure,
the batch pauses if the last minute contains at least five such failures and
they make up 10% or more of terminal model calls. Cached results and
duplicate-image waiters do not inflate that count. An overdue turn is interrupted
individually; its slot is reused only after matching terminal and thread-closed
receipts. Other calls can continue. That attempt stays `unknown` without replay
and counts toward the failure cutoff. A valid result that wins the interrupt
race is preserved.
Authentication, quota, protocol, provider-health and all other uncertain failures
still stop new admission immediately and drain already-claimed work. Missing
interrupt or cleanup receipts stop the whole provider. Duplicate
images sharing one failed generation count once toward the failure threshold.
Resuming processes only pending rows. `--initial-concurrency 500 --max-concurrency 500`
starts and stays at up to 500 descriptions instead of the default ramp.
The cap is 1,000 fresh ephemeral Codex threads in one pinned app-server, **not
1,000 resident CLI processes**. Account limits and measured resource pressure
may keep actual concurrency below that cap. There is no automatic durable job
replay. Ordinary Codex request/stream retries, unbounded connection retries and
WebSocket fallback are disabled. The pinned CLI still controls authentication
recovery (including a request after a 401); this is not a billing-level exactly-once
guarantee. Fresh, bounded, tool-free threads avoid multi-turn continuation.

Aliases resolve to their canonical image; duplicate bytes share cached analysis.
PNG/JPEG/WebP/GIF inputs are bounded and re-encoded; animations supply up to eight
spread frames. Descriptions separate observations, visible text, subjects,
actions, palette/style, emotions, suggested uses and uncertainty. Versioned JSON
also records source revision, image hash, sampled frames, provider/model, prompt
version, duration and indexing time. A compact description is used for semantic
embeddings; the detailed description is retained in SQLite/Neon.

```sh
pnpm indexer status --data "$EMOJI_DATA"
pnpm indexer export --data "$EMOJI_DATA" --output /private/new-results.ndjson
# After inspecting failures and confirming the former process has stopped:
pnpm indexer retry --data "$EMOJI_DATA"
# Potentially paid, ambiguous attempts require explicit opt-in:
pnpm indexer retry --data "$EMOJI_DATA" --include-unknown
```

Restarting reconciles interrupted work to `unknown`, not pending. Never run two
writers against copied versions of the same catalogue. SIGINT/SIGTERM drain and
retire owned work; hard crashes may require waiting 60 seconds for local ownership
expiry. Inspect status after restarting before explicitly retrying unknown jobs.
Valid terminal answers survive provider cleanup failures; admission stops while
already completed results are retained. Source changes fence search publication,
not retention of completed content-hash analysis.

## Publish results and listen for new emoji

After the operator provisions and deploys the Worker (see [WORKER.md](WORKER.md)),
inject `EMOJI_ADMIN_TOKEN` privately for upload, or `EMOJI_INDEXER_TOKEN` for the
listener. Do not put secrets in command arguments, Git or shell history.

```sh
pnpm indexer upload --data "$EMOJI_DATA" --service https://emojis.raygen.dev
pnpm indexer connect --data "$EMOJI_DATA" --home "$CODEX_HOME" --service https://emojis.raygen.dev
```

Upload sends bounded, idempotent administrative upserts and may be rerun. Finish
the bulk job first; do not upload an old catalogue over an active authoritative
Slack sync. `connect` polls the queue every two seconds, processes one image at a
time, heartbeats its lease and saves the result before completing it remotely.
Lost completion responses retry the same saved payload, never another model
call. Uncertain inference becomes unknown on restart; stale receipts/results are
retained locally for recovery. The Worker dashboard owns connected-job status.
No inbound listener is needed by the connected indexer.

To move to the homelab, stop the LEGION writer, checkpoint/close SQLite, and
transfer the **data directory** (including any WAL files) through an authorized
private channel. Keep the source until the destination is verified. Set up a
separate authorized Codex login there, then run the same commands. Do not run
both copies. System service installation is an operator step, not performed by
the CLI. The description-provider boundary is `createCodexDescriber`; a future
ai.hackclub.com adapter must honor the same structured-output and uncertainty
contract. Only Codex is implemented today.

## Checks and current limits

```sh
pnpm format && pnpm lint && pnpm typecheck && pnpm test
pnpm exec wrangler deploy --dry-run
```

Core tests cover ownership, uncertain-work replay, stale-source rejection,
authentication and durable completion. The Worker test uses a disposable Neon
database with real pgvector and mocked AI; supply `EMOJI_TEST_DATABASE_URL`
privately or it explicitly skips database checks. A real Codex synthetic-image
probe passed on LEGION, including restart. Semantic quality, deployed CPU use
and p50/p95 latency require live verification. Source publication does not prove
provisioning, Actions enablement, a Slack installation change or June activation.

See [June integration](../../docs/emoji-search.md) for the first agent client.
