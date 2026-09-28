# Emoji Search Implementation Plan

**Goal:** Give agents fast, grounded search over Hack Club Slack's custom emoji.

**Architecture:** A portable Node indexer uses Codex on LEGION initially and later
on the homelab. A standalone Cloudflare Worker owns authenticated search,
catalogue synchronization, indexing leases and the dashboard. D1 stores source
records and full-text search; Vectorize stores semantic vectors. June is the
first API consumer. Nothing requires a June runtime restart to index locally.

**Tech stack:** TypeScript, Node 24 SQLite, pinned official Codex 0.157.1,
Sharp, Hono, Cloudflare D1/Vectorize/Workers AI, static HTML/CSS/JavaScript.

**Approved design:** Owner approved the design in this thread on 2026-09-28,
including authenticated access, persisted jobs, aliases, sampled animation
frames, and a measured ramp toward 1,000 simultaneous descriptions.

## Constraints

- Keep the standalone package in `tools/emojis`; it must run without June.
- Use an explicit external data directory; never commit catalogue or credentials.
- One fresh Codex thread per canonical image description; never reuse history.
- Model output is untrusted data. No native tools, shell, MCP, hooks or browser.
- A changed/deleted source must invalidate outstanding results and searches.
- No automatic replay of uncertain inference; distinguish unknown from pending.
- Never claim 200 ms semantic latency without deployed measurement.
- No deployment, live Slack configuration change or June restart is authorized.
- Prefer runtime checks; new tests only protect authentication or job ownership.

## Tasks

- [x] Define versioned source, analysis, result, lease and status contracts in
  `tools/emojis/src/shared.ts`; validate every external boundary with Zod.
- [x] Implement portable local SQLite catalog/job/result storage, content-hash
  image analysis cache, single-owner execution, explicit restart reconciliation,
  bounded downloads/frame extraction and Codex inference in `src/indexer/`.
- [x] Add `sync`, `run`, `serve`, `export`, `upload`, `connect`, and `retry` CLI
  operations. Runtime state and auth homes are explicit arguments/environment.
- [x] Build read-only live status/search dashboard in `public/`; exercise desktop,
  mobile, empty, sign-in, search and error states. Keep write controls off the local
  preview. Browser checks pass; visual inspection is blocked by media-upload quota.
- [ ] Verify pinned Codex image input and structured output using a small real
  sample. Measure RSS/host memory and account throttles before increasing load.
  Start initial indexing only after scope/auth/image access is established.
- [x] Implement Cloudflare Worker, SQL migration, HTTP search, bearer roles,
  signed Slack events, reconciliation, leased jobs, idempotent ingestion and
  asynchronous embedding publication. Use source-revision checks when returning
  vector matches so eventual consistency cannot resurrect deleted emoji.
- [x] Integrate owner-private read-only search in June's execution capability loop with
  configuration, prompt discoverability, bounded untrusted observations and
  no administrative/indexing credential in model input.
- [x] Run formatter/linter/typecheck, focused existing tests and runtime failure
  checks (expired leases, stale results, authentication, alias cycles, deletions,
  malformed images/results). Attempt screenshot inspection and report limitations.
- [x] Document homelab migration, setup, grant requirements, deployment commands,
  measured concurrency/latency and any blocked live steps. Review before publishing.

## Verification and gated live work

- Real Codex synthetic-image description and restart passed (~11 seconds per
  image); ordinary generation retry/fallback is disabled. Durable job replay is
  prevented, but CLI authentication recovery is not billing-level exactly-once.
- Five core standalone checks, Worker dry run, June's 60 relevant existing tests,
  and the owner-private delegated lookup workflow passed. Local slow-semantic
  fallback took 163 ms with a mocked provider; this is not production latency.
- Desktop/mobile browser checks cover sign-in, empty/results/expanded descriptions,
  literal untrusted text, failed requests, no horizontal overflow and 44px controls.
  Screenshot capture works, but media-upload quota prevents visual inspection.
- Oracle reviewed and rechecked retention, retry policy and audience corrections.
- Full Slack catalogue access/export remains unavailable on LEGION. The initial
  bulk run, measured concurrency ramp and 1,000-way execution have not started.
- Cloud provisioning, domain deployment, Slack subscriptions and June activation
  require operator authorization. The local dashboard is separate from production.
