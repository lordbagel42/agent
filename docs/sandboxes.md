# Private sandbox dashboard

`https://sandboxes.raygen.dev` is an independently supervised SvelteKit / shadcn-svelte dashboard. It only observes June's BoxLite provider. It cannot execute commands, read files, open a second runtime or start/stop/remove VMs.

Sign in with the existing **June debug-site viewer key**. The dashboard stores only its SHA-256 hash, never the key, and issues random server-memory sessions. Sessions expire after eight hours; logout revokes the current device, and a service restart revokes all devices. Login attempts are globally limited to ten per minute and at most 32 sessions are retained. The key is high-entropy, not a human-chosen password. Retrieve it using the private terminal procedure in [debug-site.md](debug-site.md); do not paste it into chat or logs. Passkeys from the debug site do not carry across origins.

Inventory supports search, running/not-running filters, individual sandbox metadata, worker activity, runtime limits and dark/light themes. Visible tabs refresh every 15 seconds by default; this can be paused. Failed observations are distinguished from disabled or empty providers. Counts and timestamps describe observations, not independent health attestations. CPU/RAM values are allocations, not measured utilization. Stopped compute can retain a disk. Disabled does not establish absence of retained disks.

Activity is at most 200 metadata-only events since the **June process** started. It is not durable history or full logs; commands, output, worker actor keys, host paths and credentials are excluded. Events belong to hashed worker identities and can span policy generations. Existing crash fences, cleanup ownership and execution permissions are unchanged. BoxLite 0.10.5 metrics can boot stopped VMs, so inspection exclusively uses `listInfo()`.

June has the same projection through `inspection:"sandboxes"` in authorized owner-private execution workers. Interaction agents delegate; shared/guest/automated turns without inspection grants cannot query it. Knowledge is included in all final prompt paths. June must not duplicate dashboard polling, lifecycle operations, retries or operator recovery.

## Build and installation

Run Node 24 and the pinned pnpm from the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir sandboxes-site format
pnpm --dir sandboxes-site lint
pnpm --dir sandboxes-site check
pnpm --dir sandboxes-site test
pnpm --dir sandboxes-site build
```

The adapter-node `sandboxes-site/build` output is self-contained. Install it with a parent `package.json` containing `{"type":"module"}` into a root-owned, immutable `/opt/june-sandboxes/releases/<source-sha>` on the June host. Point `/opt/june-sandboxes/current` to that release. Set `SANDBOX_REVISION=<source-sha>` in root-only `/etc/june-sandboxes/release.env` and install [the service unit](../scripts/deploy/june-sandboxes.service). It runs as a separate dynamic UID, has no June storage access, and uses `LoadCredential`, not environment/command-line secrets. Verify the host's pinned Node path before installing.

Provision root-only `/etc/june-sandboxes/credentials.json` with `viewerKeyHash` (64 lowercase hex characters) and `readToken` (43 base64url characters). Derive the latter **on the June host** as HMAC-SHA256 using the existing operator token as key and `june:sandboxes:read:v1` as data, base64url without padding. Give this service only the derived value, never the operator token. It authorizes only `GET /sandboxes/snapshot`, not `/operator`. Rotation of June's operator token requires reprovisioning this derived credential and restarting only the dashboard. Viewer-key rotation requires separately updating the hash and restarting the dashboard.

Default upstreams are loopback June blue/green ports 3081/3082. Before reading, the server requires a ready process and matching health/snapshot revisions. Fetches have three-second deadlines, reject redirects, and cap JSON bodies at 512 KB. Only the allowlisted schema reaches authenticated browsers. No browser can choose the upstream. `/health` reports dashboard readiness/revision, not June or BoxLite health. Missing credentials fail closed.

Follow [deployment.md](deployment.md) for the outer operator lock, existing holds/recovery fences, settled poller and authorized live installation. Preserve any other operator's ownership. Do not enable BoxLite or alter June's binding just to install this service. Publish/activate the compatible June snapshot endpoint before verifying data flow.

Ingress is the existing wildcard raygen.dev tunnel → Traefik → Consul service `june-sandboxes`, private June address `192.168.0.215:3094`. Match only `sandboxes.raygen.dev`, exclude `/health`, and allow tunnel source `192.168.0.204/32`. The service's network sandbox accepts Traefik `192.168.0.203` plus loopback only. Do not expose any June admin port or snapshot endpoint directly. This narrowly scoped Consul registration is operator-installed, not owned by a broad Pulumi apply; preserve it during later infrastructure adoption.

Verify loaded MainPID/revision, local health, unauthenticated data denial, cross-origin POST rejection, fresh HTTPS sign-in and a real snapshot. Check both desktop/mobile and populated synthetic fixtures without treating fixtures as live VM evidence. The current deployment host does not have `/dev/kvm`; a disabled provider is expected until a separately configured BoxLite-capable host is available.
