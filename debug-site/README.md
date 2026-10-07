# June Debug frontend

This is the standalone private diagnostic archive UI, not a route in June's
main console. It calls only same-origin `/api/session`, `/api/logout`,
`/api/passkeys`, `/api/snapshots` and `/api/operations` endpoints. The independent
archive server owns authentication, authorization, persistence, security headers,
and history-route fallback.

From the repository root (the existing `.npmrc` selects Node 24):

```sh
pnpm install --frozen-lockfile
pnpm debug:format
pnpm debug:check
pnpm debug:build
```

Equivalent package commands are `pnpm --dir debug-site format`, `check`, and
`build`. `lint` includes Biome, Svelte-aware Prettier, and `svelte-check` with
warnings treated as failures, including accessibility diagnostics. Three local
accessibility suppressions preserve keyboard access to scrollable evidence;
they do not disable the checker globally. Unit tests run with
`pnpm --dir debug-site test`.

Vite writes `../dist/debug-site/public` (relative to this package). The build
has no external fonts/resources, inline HTML scripts/styles, embedded fixtures,
or configured credentials. Serve these assets with the independent archive
server; `pnpm --dir debug-site dev` is only a frontend development server and
does not supply or proxy an API. Do not use a public unauthenticated fixture
server with private captures.

## Components and ownership

`src/lib/components/ui` contains actual shadcn-svelte registry source installed
with `shadcn-svelte@1.7.0 add button input label badge tabs skeleton -y` using
the registry in `components.json`. Its MIT license is copied into the public
bundle. Components retain their registry structure; local styling extends the
June dark-neutral tokens in `src/app.css`. Bits UI provides label/tab behavior,
and Lucide supplies local SVG icons. There are no remotely loaded assets.

- `archive.ts`: in-memory private session/API state, stale-response protection,
  expiry clearing, safe errors, passkey ceremonies, and authenticated exports.
- `projection.ts`: explicit retained evidence only, supporting flat historical
  snapshots and wrapped coordinator/activity snapshots. Unknown timestamps are
  not replaced by capture time or parsed from opaque IDs.
- `App.svelte`: history navigation, auth shell, timezone selection, and exports.
- `CaptureView`, `EvidenceTable`, `JsonViewer`, `ArchiveRail`, `Login`, and `Passkeys`:
  bounded UI responsibilities. Tables show 40 rows per page, archive pages
  render at most 50 captures, and JSON renders at most 16,000 characters at once.
  Evidence filtering and JSON search cover full retained payloads; the original
  JSON attachment remains available from the capture header.
- `OperationsView`: controller observations, API-backed metadata search, 50-row
  operation pages, 100-event timeline pages, and up to 10 related operations.
  “Show all matches” filters the full retained symptom history, including
  reconciled operations; counts include the selected operation. Refresh and
  filtering keep the selected incident, including when it is outside the results.

## Operations semantics

`/operations?id=<encoded operation ID>` shares the existing private session and
auth return route. Browser Back/Forward preserves operation selection; Evidence,
Conversation, and inline passkey settings keep their existing routes. Operation
metadata is private and in-memory only. Expiry, logout, passkey revocation and
pagehide clear it together with captures, and late responses cannot restore it.

Event time and observation time are shown separately. Missing event times stay
unknown. The controller strip labels observations over five minutes old as stale
(using the browser clock), not as failed or healthy. It does not poll or contact
June. Refresh only reads the archive; it does not retry an operation.

Symptom matching means the same source, phase and reason/status, not a shared
root cause. A recorded completed Amp thread is not verified recovery. Links open
the retained capture or Amp thread; private prompts, responses, titles and logs
are not copied into Operations. There are no replay, retry or repair controls.

## Synthetic preview

Build first, then use a dedicated port. **3092 is a live debug service on this
runner; do not run the preview on its unchanged default port here.** For example:

```sh
pnpm debug:build
PORT=31684 JUNE_DEBUG_PREVIEW_ORIGIN=http://127.0.0.1:31684 pnpm debug:preview
```

The preview uses a temporary archive, displays a synthetic-context banner, and
never reads live config or data. `scripts/preview-debug-site.ts` retains the
capture/conversation fixtures and adds a current recovery, its reconciled symptom
match, a different-phase nonmatch, completed DEBUGSHARE with capture link, queued
owner task, unknown coding execution, and stale controller. Additional synthetic
history exercises the 50-operation, 100-event and 10-related-operation boundaries.
It does not invoke Amp. The viewer credential is the synthetic-only value in that
script, not a production credential.

## Authentication

Passkey management is an inline settings view, not part of capture evidence.
The viewer credential bootstraps enrollment and remains the recovery method.
Adding/removing keys requires a recent sign-in; removal signs out every device.
Browser cancellation never persists responses, credentials, or captures in local
storage. See `docs/debug-site.md` for the independent server's security boundary.

No replay, investigation, capture deletion, or June permission mutation is exposed. A stored
capture is not proof that June is live or that an investigation succeeded.
