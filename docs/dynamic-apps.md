# Rivet Dynamic Apps

June writes small server-side web apps and runs them with
`@rivet-dev/dynamic-apps@0.3.1`. Each app is a Fetch handler (or Hono app) that
the SDK builds in an isolated AgentOS VM and serves through a **dedicated app
host with its own Rivet engine** (`src/apps/{main,host,viewer}.ts`), deployed as
the `june-apps` pod on the mrow cluster (`lordbagel42/mrow-gitops`,
`apps/june-apps`). It is not a route in June's service.

```
June (LXC 215)                           mrow cluster, namespace june-apps
┌───────────────────────┐ signed HTTPS ┌──────────────────────────────────┐
│ execution worker      │  Cloudflare  │ host (3091 public listener)      │
│  apps:{prepare,...}   │──tunnel ────▶│  apex /control/* (Ed25519 only)  │
│ src/apps/client.ts    │  → Gateway   │  <app>.mrrpmraow.com    public   │
│ key: $RIVETKIT_STORAGE│              │  <app>--signed-in.…     Access   │
│  _PATH/apps-ed25519.pem              │ SQLite receipts + Rivet engine   │
└───────────────────────┘              │ (native sidecar, own namespace)  │
                                       └──────────────────────────────────┘
```

Apps are enabled for June by default; she needs no configuration or secret.
She generates an Ed25519 key in her state directory on first start and signs
`june-apps-v1\nMETHOD\npath?query\ntimestamp\nsha256(body)`. The host accepts
only public keys listed in `juneKeys` of its `host.json`, a ±2 minute window and
each signature once. The public key is shown in the capability matrix
(`dynamic-apps` row) and the agent MCP `get_status` result; pinning it in
mrow-gitops is the only activation step. Until then `apps list` reports that the
host does not trust June's key.

The pinned SDK needs `src/apps/dynamic-apps-core.patch`. Its builder originally
exports through a world-writable host mount and tries to assign guest UID 1000
to the archive, failing under a different unprivileged service UID. The patch
keeps the archive in the VM and retrieves bytes through AgentOS's filesystem API.
It caps the **built archive at 4 MiB**, leaving base64/framing headroom under the
8 MiB response budget. Boundary checks cover both binary and UTF-8/NUL data.
It does not run the host as root, change guest identity, or widen host permissions.
The patch lives under `src` so June's existing deployment export includes it;
frozen-lockfile installs apply and verify it. Revalidate it on SDK upgrades.

**Actor-backed apps are unsupported.** Self-hosted Rivet's runner credential is
engine-wide, and the SDK forwards it through actor callbacks into generated code.
Stripping it breaks actor startup; namespaces do not scope its authority. This
integration rejects exports declaring `rivetkit` in dependencies/devDependencies,
and uses the SDK's `createNamespace: false` actor rejection as a second guard.
This flag is not a promise of zero provisioning: the SDK still creates its host
actors/storage and may provision a namespace. Supporting app actors requires a
separately designed app-scoped credential or per-app engine isolation boundary,
plus end-to-end callback verification. Do not populate this host with existing
actor apps through the dashboard or another client.

## June's workflow

The `apps` directive is available to execution workers in admitted
conversations; interaction agents delegate to them. June judges the task and
audience; there is no compulsory human approval.

1. **prepare** `{action:"prepare", appId, files:[{path,content}], access, title}`
   stores the exact source and audience and returns a receipt valid for 24 h.
   Nothing runs. Source rules: `package.json` with `"type":"module"` and `main`
   pointing at an entrypoint that default-exports a Fetch handler or Hono app;
   at most 128 files, 64 KiB each, 256 KiB total; no dotfiles, `node_modules`,
   or `rivetkit`. `jobId` may replace `files` for a verified coding-job build
   when native coding and `dynamicApps.workspace` are configured.
2. **deploy** `{action:"deploy", appId, receiptId}` builds and deploys exactly
   that receipt's source and audience, then waits up to about 90 s for the
   outcome. Repeating it returns the same receipt. A build rejected by the SDK
   (install, build, invalid handler, entrypoint, size) is `failed`: nothing
   reached the engine and the previous release keeps serving. Any other failure
   is `unknown` and blocks that app until an operator reconciles it.
3. **inspect** `{appId}`, **list**, **unpublish** `{appId}`. Unpublishing closes
   viewing immediately; the engine keeps the release and receipts remain.

An app ID belongs to the conversation that first deployed it. A receipt can only
be deployed from the conversation that prepared it. The owner's private DM may do
either for any app, and `!deploy-app <receipt>` remains an owner command.

Apps are served at `https://<appId>.mrrpmraow.com/apps/<appId>/` (public, no
login) or `https://<appId>--signed-in.mrrpmraow.com/apps/<appId>/` (anyone who
signs in through the Cloudflare Access application "June apps (signed-in)", with
email one-time PIN or GitHub; not an owner or workspace allowlist). `/` redirects
to the app path. The hostname fixes the audience: a signed-in app is never served
on its public hostname and vice versa. App IDs are single DNS labels without
`--`, so every app has its own origin under universal TLS.

## Configuration and isolation

June's optional config block, with defaults:

```json
{
  "dynamicApps": {
    "enabled": true,
    "endpoint": "https://mrrpmraow.com",
    "workspace": "apps"
  }
}
```

`workspace` is optional and enables coding-job builds (it requires enabled native
coding and a verifier). A legacy `tokenEnv` is accepted and ignored.

The host's config, selected by `JUNE_APPS_CONFIG` (mrow-gitops
`apps/june-apps/host.json`):

```json
{
  "port": 3090,
  "directory": "/data/host",
  "origin": "https://mrrpmraow.com",
  "juneKeys": ["<June's base64url Ed25519 public key>"],
  "viewerTokenEnv": "JUNE_APPS_VIEWER_TOKEN",
  "viewer": {
    "port": 3091,
    "domain": "mrrpmraow.com",
    "issuer": "https://bagel.cloudflareaccess.com",
    "audience": "<AUD of the signed-in Access application>"
  }
}
```

Start with `pnpm apps:start` (the container runs `supervisor.mjs`). It requires
`JUNE_ALLOW_DYNAMIC_APPS=1`, a viewer credential of at least 32 characters for the
loopback-only operator viewer, and explicit `RIVET_ENDPOINT`, `RIVET_TOKEN`,
`RIVET_NAMESPACE`, `RIVET_POOL` for its **own** engine. Cloud fallback,
`RIVET_ENGINE` and callback/public-endpoint overrides are rejected. The directory
must exist, belong to the host's Unix user, have mode 0700 and contain no
symlinks. Run only one host against this directory/namespace.

Use a dedicated identity/container, resource limits and network policy; do not
give the host June's credentials or mounts. The SDK permits build network access
and dependency scripts, so egress is limited to public 80/443 and DNS.

**Listeners.** Loopback 3090 serves `/health/live`, `/health/ready`, the signed
`/control/*` API and the bearer-only operator viewer `/apps/*`; never route it.
Public 3091 (the only port the Gateway may reach) serves apps on subdomains and,
on the apex only, the signed `/control/*` API plus `/health` (`{ready, revision}`).
The Gateway preserves the Host header; HTTPS terminates at Cloudflare. DNS comes
from external-dns via the annotated `june-apps-public` Service, not manual records.

The host validates Access assertions itself (signature, issuer, audience, expiry,
human identity) before a signed-in app sees a request. Viewer credentials, Access
assertions, identity headers and cookies are stripped before generated code;
response cookies and CORS grants are stripped too. Responses prohibit caching,
embedding and service workers; cross-origin browser requests to signed-in apps
are denied. App cookies and WebSockets are unsupported.

The durable publication pointer selects the **last consumed deployment**.
Starting a deployment closes viewing before the engine switches source; admitted
viewer requests finish first. Only a successful result reopens viewing on the new
release; a `failed` build reopens the previous one; `unknown` stays closed,
including after restart. Changing the viewer configuration invalidates old
receipts and publications: prepare and deploy again.

## Failure and recovery

The host persists deployment intent before calling the SDK. Repeated commands
return the same receipt. Vetted build-phase SDK codes become `failed` and keep
the previous release; any other failure or host interruption becomes `unknown`
and blocks further deployments of that app, including after restart. Raw errors,
stdout, stderr and tokens are never returned or logged.

There is no automatic retry, rollback, deletion or reconciliation API in this
increment. An operator must inspect the dedicated host and Rivet dashboard to
establish what happened. Do not clear receipts, restore an old database or swap
engines merely to unblock deployment: that loses duplicate protection. Back up
the host's `deployments.sqlite` (including WAL safely) and engine state together.
Cancellation/forgetting prevents new preparation/deployment but cannot undo an
already dispatched deployment or erase source already retained by the app host.
Host artifact retention and deployed-resource deletion require separate handling.

## Container pilot and operational logs

`src/apps/host.Dockerfile` packages the pinned Node, SDK and engine versions.
The native ARM64 image workflow verifies a disposable real deployment, credential
stripping, signed control, single-use signatures, scoped deploys, clean build
failures, unpublishing and restart recovery before publishing. Image publication
does not change the cluster; mrow-gitops pins a reviewed image digest and Flux
rolls the single pod.

The host allows one build at a time. A different build receives 409 without
consuming its prepared receipt. `/health/live` reports process liveness;
`/health/ready` requires a reachable engine listener and writable audit log.
Readiness is not a deployed-app health check. On SIGTERM the host rejects new
control requests, finishes in-flight receipts and lets RivetKit drain. Allow
at least 90 seconds before killing the pod; interrupted work remains unknown.

The container runs `supervisor.mjs`, which sends a private IPC drain request
before signaling the SDK. Running `main.ts` directly is unsupported. The engine
must remain alive until that host exits (a Kubernetes native sidecar provides
this ordering).

The pinned Dynamic Apps connection patch bounds initial subscription setup to
45 seconds and retries only `guard.actor_ready_timeout` once with a fresh
subscription. RivetKit otherwise leaves `connection.ready` pending after this
terminal error, poisoning the cached app subscription. No deployment or action
call is replayed. Cold recovery can take over 30 seconds; liveness/listener
readiness does not guarantee instant app serving. Revalidate both dependency
patches when upgrading the SDK.

Structured stdout and private `audit.ndjson` record startup, readiness-related
lifecycle, bounded request categories/status/duration, and deployment receipt
IDs/results. Rotation retains two approximately 5 MiB files. SDK logs retain
only classifications and release digests, never raw generated console output,
source, URLs, request headers/bodies or raw exceptions. These are operational
logs, not a persisted application console. The host becomes unready if audit
writes fail. Container/engine logs still need normal platform log rotation.

The initial Kubernetes pilot is single-writer with retained node-local storage.
That survives pod replacement, **not node/disk loss**, and a PVC request is not
a filesystem quota. Monitor actual disk usage and take consistent off-node
backups before retaining important app state. Existing Alloy metrics collection
does not imply centralized log collection. Do not set three replicas against
this SQLite/engine state: HA needs distributed deployment fencing, an explicit
engine/state ownership design, replicated durable storage and tested failover.

API reference: [Rivet Dynamic Apps](https://github.com/rivet-dev/dynamic-apps/tree/v0.3.1/packages/dynamic-apps).
