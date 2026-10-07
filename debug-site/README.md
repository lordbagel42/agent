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

- `route.ts`: the URL is the only navigation state. It parses and formats every
  route and builds operation list requests. API responses never write the URL.
- `archive.ts`: in-memory private session/API state, `open(route, force)` route
  loading, stale-response protection, expiry clearing, safe errors, passkey
  ceremonies, and authenticated exports.
- `projection.ts`: explicit retained evidence only, supporting flat historical
  snapshots and wrapped coordinator/activity snapshots. Unknown timestamps are
  not replaced by capture time or parsed from opaque IDs.
- `display.ts`: shared labels, recorded-state tones (never health), Amp thread
  and commit links, and the modified-click-safe link helper.
- `App.svelte`: header navigation, context bar (timezone and explicit Refresh),
  history, auth shell and exports.
- `OverviewView`: the landing page. `CapturesView` / `CaptureView`: the capture
  list and the capture detail page. `OperationsView` / `OperationInspector`: the
  Deployments, Errors, Amp and All operations list with its selected-record
  inspector. `ControllerFacts`: the shared controller observation.
- `EvidenceTable`, `ConversationView`, `JsonViewer`, `Login` and `Passkeys` are
  unchanged in responsibility. Tables show 40 rows per page, capture and
  operation pages hold 50 rows, timelines hold 100 events, and JSON renders at most
  16,000 characters at once. Evidence filtering and JSON search cover full
  retained payloads; Export JSON stays in the capture header.

## Navigation

| URL | View |
| --- | --- |
| `/` | Overview |
| `/?view=captures&q=…&offset=…` | Captures list with whole-archive metadata search |
| `/s/<id>` and `/s/<id>/conversation` | Capture evidence and conversation (unchanged) |
| `/operations?view=deployments\|errors\|amp&q=…&source=…&signature=…&offset=…&id=…` | Workspaces |
| `/operations?id=…` | Legacy links: the all-operations list with the selection |

Every filter, page and selected ID comes from the URL, so direct loads, the
sign-in return, Back/Forward and modified clicks (new tab or window) all restore
the same state. Moving between views that are already loaded does not trigger
another read. **Refresh** in the context bar is the only re-read; it keeps the
route and selected capture evidence tab, and on a capture it re-reads the capture
itself. Invalid sources, offsets and views fall back to safe defaults. Each
workspace header link returns to its last list, filters and selection within
the authenticated session.

## Workspaces and evidence boundaries

- **Overview** makes four parallel reads: the newest captures, recorded failures,
  deployment/recovery records and Amp operations. Each section shows its real
  archive total and retries on its own. A 401 from any read clears every pane,
  and late successes are discarded. “Latest archived record” is the newest of
  the records that were read; a partial read is labeled partial. Nothing here
  is presented as current service health.
- **Captures**: a dense list with whole-archive search and pagination. The detail
  header fits on one row. The reporter's reason is height-bounded, and
  “Recorded operations” lists operations whose archived metadata contains the
  capture ID (a substring search on `q=<id>`, not a guess based on timing).
- **Deployments** shows the controller observation with active, observed,
  target and controller revisions kept separate. Hold, blocked, retry, queue and
  omitted counts are shown as facts, not controls. Stale (>5 min) observations
  are labeled as such; nothing shows a green “live” state. The controller
  history opens from its operation ID.
- **Errors** shows operations with any recorded failure marker, including ones
  that later completed or reconciled. The inspector shows the exact latest
  failure event (with a jump into the timeline), up to 10 same-signature
  operations, and “List all with this signature”. These are structured
  operational errors, not raw service-journal coverage. Matching signatures do
  not establish a shared root cause.
- **Amp** covers DEBUGSHARE, owner `amp-task` and coding operations, each keyed
  by its own operation ID, so a shared thread ID never merges them. Missing
  latest-event threads read “No thread in latest event”; earlier events may
  still record one. Completed means the execution ended, not that a fix is
  verified. Thread, capture and related-operation links appear
  only where an event recorded them; commit links appear only for full
  40-character revisions.

There are no replay, redeploy, retry, release-hold or investigation controls.

## Server filter dependency

Workspace lists ask the server to filter before pagination: `sources=a,b` for
Deployments (`deployment,recovery`) and Amp (`debugshare,amp-task,coding`), and
`failuresOnly=true` for Errors. A single-source selection uses the existing
`source` parameter. These lists require the Operations backend with those
archive-wide filters; do not activate this frontend against an older server.
Counts and pagination come from the server, not a filtered client-side page.
Historical failures remain visible after completion or reconciliation.

## Session invariants

Operation and capture data are private and held only in memory. Expiry, logout,
passkey revocation, failed session rechecks and pagehide all clear every pane.
Each read checks a session epoch and a per-pane sequence number, so neither a
late response nor a superseded navigation can repopulate private data. All
reads use same-origin credentials, `no-store`, `redirect: "error"` and a 20 s
timeout. Event time and observation time stay separate, and missing times stay
unknown.

## Synthetic preview

Build first, then use a dedicated port. **3092 is a live debug service on this
runner; do not run the preview on its unchanged default port here.** For example:

```sh
pnpm debug:build
PORT=31684 JUNE_DEBUG_PREVIEW_ORIGIN=http://127.0.0.1:31684 pnpm debug:preview
```

The preview uses a temporary archive, displays a synthetic-context banner, and
never reads live config or data. `scripts/preview-debug-site.ts` retains the
capture/conversation fixtures, including a long payload and a long, bounded
reporter reason. It adds:

- a current recovery and its reconciled same-signature match
- a different-phase non-match
- blocked and completed deployments
- a completed DEBUGSHARE with a capture link
- a DEBUGSHARE with an unknown launch and no thread, linked to the main capture
- a queued owner task
- unknown coding execution
- two operations sharing one thread ID
- a stale, held, retrying controller

Additional synthetic history exercises the 50-operation, 100-event and
10-related-operation boundaries. It does not invoke Amp. The viewer
credential is the synthetic-only value in that script, not a production
credential.

## Authentication

Passkey management is an inline settings view, not part of capture evidence.
The viewer credential bootstraps enrollment and remains the recovery method.
Adding/removing keys requires a recent sign-in; removal signs out every device.
Browser cancellation never persists responses, credentials, or captures in local
storage. See `docs/debug-site.md` for the independent server's security boundary.

No replay, investigation, capture deletion, or June permission mutation is exposed. A stored
capture is not proof that June is live or that an investigation succeeded.

This frontend is the owner's human view. June reads the same content-free
operation index through the separate `/api/operations-read` credential; this UI
rebuild leaves that interface unchanged. June's runtime instructions describe
the new navigation without treating source publication as live activation.
