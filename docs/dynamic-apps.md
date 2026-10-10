# Dynamic Apps

June writes small interactive web apps and publishes them on their own origins:

- `https://<appId>.mrrpmraow.com/` — public, anyone with the link.
- `https://<appId>--signed-in.mrrpmraow.com/` — anyone who signs in through
  Cloudflare Access (email one-time code or GitHub). This is not an owner or
  Slack-workspace allowlist.

An app is static browser code (HTML, CSS, JavaScript; external HTTPS scripts and
styles are allowed) plus a per-app shared JSON storage API. **No generated code
runs on the host.** The host is the Cloudflare Worker in [`apps-host/`](../apps-host),
enabled for June by default.

## Architecture

```
June (LXC 215)                       Cloudflare (mrrpmraow.com zone)
┌──────────────────────┐  signed   ┌──────────────────────────────────────┐
│ execution worker     │  HTTPS    │ Worker june-apps                     │
│  apps:{prepare,...}  │──────────▶│  apex /control/*  (Ed25519 verify)   │
│ src/apps/client.ts   │           │  Registry DO: receipts, source,      │
│ key: <state>/apps-   │           │               publications, nonces   │
│      ed25519.pem     │           │  AppData DO (one per app): JSON KV   │
└──────────────────────┘           │  <app>.domain          → public      │
                                   │  <app>--signed-in.domain → Access    │
 viewers ─────────────────────────▶│     (Access app + JWT re-verified)   │
                                   └──────────────────────────────────────┘
```

- **Control auth.** June generates an Ed25519 key on first start at
  `$RIVETKIT_STORAGE_PATH/apps-ed25519.pem` (0600, shared by both slots; the
  first writer wins). She signs
  `june-apps-v1\nMETHOD\npath\ntimestamp\nsha256(body)`. The Worker accepts only
  public keys in its `JUNE_KEYS` variable, a ±2 minute clock window and each
  signature once. No shared secret is ever transferred; the public key is
  visible in the capability matrix (`dynamic-apps` row) and the agent MCP
  `get_status` result.
- **Durable state.** Receipts, source and publications live in one
  SQLite-backed Durable Object (`Registry`). App data lives in one Durable
  Object per app and audience (`AppData`). Cloudflare replicates both; there is no node-local
  disk, single-pod writer or process-local tracking.
- **Isolation.** Every app has its own origin on a registrable domain separate
  from `raygen.dev`, so app pages cannot read or toss cookies for June's
  console or debug site. Responses send `no-store`, `nosniff`,
  `frame-ancestors 'none'`, `worker-src 'none'`, COOP and `noindex`. Storage
  writes require the app's own `Origin` (or `Sec-Fetch-Site: same-origin`), so
  one app's page cannot write another app's data. The host never forwards
  cookies or Access assertions anywhere.
- **Audience.** The hostname fixes the audience. The `--signed-in` host is
  covered by the Access application `June apps (signed-in)` (Allow Everyone,
  one-time PIN or GitHub). The Worker additionally verifies the
  `Cf-Access-Jwt-Assertion` signature, issuer, audience, expiry and human
  (`type: app`) identity before reading anything. A public app is never served
  on the signed-in host or vice versa.

## June's workflow

The `apps` directive is available to execution workers in every admitted
conversation; interaction agents delegate to them.

1. **prepare** `{action:"prepare", appId, files:[{path,content}], access, title}`
   stores the exact source and audience and returns a receipt (24 h). Nothing is
   published. `jobId` may replace `files` for a verified coding-job build when
   `dynamicApps.workspace` and native coding are configured.
2. **deploy** `{action:"deploy", appId, receiptId}` publishes exactly that
   receipt's source and audience, replacing the live version. Repeating it is a
   no-op. Expired, mismatched or foreign receipts are rejected. Workers can
   prepare and deploy in one task; no human confirmation is required. The owner
   can also send `!deploy-app <receipt>` as a fresh plain-text Slack DM.
3. **inspect** `{appId}`, **list**, **unpublish** `{appId}` read or change the
   publication. Unpublishing returns 404 immediately and keeps receipts and data.
   `list` and the latest-receipt part of `inspect` cover only the calling
   conversation's apps, except in the owner's private DM.

Ownership: an app ID belongs to the conversation that first deployed it. Other
conversations cannot deploy or unpublish it; the owner's private DM can.
A receipt can only be deployed from the conversation that prepared it, or from
the owner's private DM.

Source rules: `index.html` required; extensions html, htm, css, js, mjs, json,
webmanifest, svg, txt, md, csv, xml; at most 128 files, 64 KiB each, 256 KiB in
total; no dotfiles, `node_modules`, `credentials` or `secrets` segments. Paths
ending in `/` serve `index.html`; extensionless paths fall back to
`<path>/index.html`, `<path>.html`, then `index.html`.

Storage API (same origin, JSON): `GET /_june/storage/<key>` (404 when unset),
`PUT` with a JSON body, `POST` `{"increment": n}` for atomic counters, `DELETE`,
and `GET /_june/storage?prefix=&limit=` (≤100 entries). Limits: 1000 keys,
64 KiB per value, 5 MiB per app and audience. Signed-in apps can
`GET /_june/me` for the viewer's email. Data persists across redeploys with the
same audience; public and signed-in storage are separate, so changing audience
never exposes data the other audience wrote. Any viewer or script of that
audience can read, overwrite or delete it: it is shared scratch space, not an
integrity boundary.

## Configuration

June needs no configuration. The optional block, with defaults, is:

```json
{
  "dynamicApps": {
    "enabled": true,
    "endpoint": "https://mrrpmraow.com",
    "workspace": "apps"
  }
}
```

`workspace` is optional and enables coding-job builds; it requires enabled
native coding and a verifier for that workspace. A legacy `tokenEnv` key is
accepted and ignored.

## Operating the host

The Worker, its routes and its Access application belong to the Cloudflare
account `Raygen`:

| Resource | Value |
| --- | --- |
| Worker | `june-apps`, route `*mrrpmraow.com/*` |
| Durable Objects | `Registry`, `AppData` (SQLite, migration `v1`) |
| DNS | proxied `mrrpmraow.com` and `*.mrrpmraow.com` → `100::` (originless) |
| Access | self-hosted app `*--signed-in.mrrpmraow.com`, Allow Everyone, OTP + GitHub |
| Vars | `APPS_DOMAIN`, `ACCESS_ISSUER`, `REVISION`; secrets `ACCESS_AUD`, `JUNE_KEYS` |

**Workers Builds deploys the host automatically**: the trigger "Deploy
apps-host from main" on Worker `june-apps` watches `apps-host/*` on `main`, sets
`SKIP_DEPENDENCY_INSTALL=1` (so Cloudflare does not install June's root pnpm
workspace), runs `npm ci && npm run typecheck` in `/apps-host`, then
`npx wrangler deploy`. Its status appears as the `Workers Builds: june-apps`
GitHub check. To deploy manually instead, use a Cloudflare API token that can
edit Workers on the account:

```sh
cd apps-host
npm ci
npm run typecheck
CLOUDFLARE_API_TOKEN=... npm run deploy
```

`ACCESS_AUD` and `JUNE_KEYS` are Worker **secrets**, so deploys keep them. Set
or rotate them with `wrangler secret put ACCESS_AUD` / `wrangler secret put
JUNE_KEYS` (a JSON array of base64url public keys). Local development needs a
copy of `wrangler.jsonc` without `routes` (so `Host` headers select apps) and
`--var` values for both secrets.

**Trusting a new June key.** If June's state directory is replaced, she
generates a new key and `apps list` reports that the host does not trust it.
Read the new public key from `get_status` (agent MCP) or the capability matrix
and add it to `JUNE_KEYS`; remove the old one.

**Changing the domain.** Set `APPS_DOMAIN` and the route, add the proxied
wildcard DNS records, move the Access application, and set
`dynamicApps.endpoint` for June. Existing app URLs change; data and receipts
stay in the Durable Objects.

Logs are Workers observability logs for `june-apps`; no request bodies, source
or credentials are logged by the host.
