# June Debug frontend

This is the standalone private diagnostic archive UI, not a route in June's
main console. It calls only same-origin `/api/session`, `/api/logout`, and
`/api/snapshots` endpoints. The independent archive server owns authentication,
authorization, persistence, security headers, and history-route fallback.

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
  expiry clearing, safe errors, and authenticated exports.
- `projection.ts`: explicit retained evidence only, supporting flat historical
  snapshots and wrapped coordinator/activity snapshots. Unknown timestamps are
  not replaced by capture time or parsed from opaque IDs.
- `App.svelte`: history navigation, auth shell, timezone selection, and exports.
- `CaptureView`, `EvidenceTable`, `JsonViewer`, `ArchiveRail`, and `Login`:
  bounded UI responsibilities. Tables show 40 rows per page, archive pages
  render at most 50 captures, and JSON renders at most 16,000 characters at once.
  Evidence filtering and JSON search cover full retained payloads; the original
  JSON attachment remains available from the capture header.

No replay, investigation, deletion, or permission mutation is exposed. A stored
capture is not proof that June is live or that an investigation succeeded.
