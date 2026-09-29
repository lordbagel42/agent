# Rivet Dynamic Apps

Opt-in Fetch/HTTP-app integration with `@rivet-dev/dynamic-apps@0.3.1`. June can request builds,
prepare verified source, and inspect deployment receipts in an owner-private DM.
The app host is a **separate process with a dedicated Rivet engine**, not another
route in June's service. No live installation or activation is included.

**Fetch/HTTP deployment was checked on a disposable development engine**, including
authenticated POST requests, updating a running app to a different release,
duplicate approvals, and credential stripping. June's approval workflow is also
tested with real Rivet conversations and a fake SDK deployer. Neither check
activates production; verify the same path on the intended isolated host before
enabling it for June.

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

1. Ask June to build an app with a stable lowercase ID, such as `counter`.
   Her `apps` directive accepts `build`, `prepare`, and `inspect`; it is absent
   in guest/public turns and synthesis passes. Planning can use her existing
   execution workers. A build uses the existing coding supervisor and configured
   coding runtime, never a second autonomous coding system.
2. Approve the coding proposal with the usual `!approve <job-prefix>`. The worker
   writes `june-app.json` in its isolated worktree. The supervisor reads this
   bounded export before verification and rejects changes during verification.
   Only a passed, non-replayed verifier result retains the exact exported bytes.
3. Ask June to prepare the app using the full job ID from its completion report.
   This copies the retained artifact to the dedicated host; it does **not** run
   the SDK or grant deployment. Later worktree edits cannot alter the artifact.
   The workspace must also still match its verification receipt at preparation
   and approval time; changed or revoked jobs cannot deploy.
   Choose `access: "public"` for anyone without login or `"signed-in"` for anyone
   who signs in (no owner/workspace allowlist). Null/omitted access leaves the
   app internal-only. Publication requires the optional viewer configuration.
4. Send the returned `!deploy-app <receipt-id>` yourself as a fresh plain-text
   owner Slack DM. Quotes, code blocks, forwarded messages and attachments cannot
   authorize deployment, even if Slack's fallback text contains the command.
   This distinct, ten-minute approval permits dependency installation, generated
   code execution and Rivet resource creation. Models cannot emit an approval
   action. Expired proposals require a new preparation turn and a new receipt;
   replaying the original turn cannot renew an approval.
   The receipt binds the audience as well as the source. Changing the audience
   requires a new preparation/approval, even with identical source. Publication
   cannot recall content already downloaded while public.
5. Ask June to inspect `counter`. She reports `prepared`, `deploying`, `deployed`
   or `unknown`, the artifact digest, recorded release and private URL. These are
   historical receipts, **not health checks**. Active/uncertain receipts take
   precedence over newer preparations. Inspect again explicitly for completion;
   there is no automatic notification or background polling.

An owner-selected workspace verifier must actually validate the exported app,
not merely trust the worker's claim or test unrelated workspace files. The
256 KiB export supports at most 128 text files of 64 KiB each, including
`package.json` and a default Fetch handler/Hono app. It forbids dotfiles,
traversal, `node_modules`, and symlink exports. It is not a secret-content scanner:
never give the coding workspace production secrets.

## Configuration and isolation

June's optional config block is:

```json
{
  "dynamicApps": {
    "endpoint": "http://127.0.0.1:3090",
    "tokenEnv": "JUNE_APPS_CONTROL_TOKEN",
    "workspace": "apps"
  }
}
```

The workspace must already exist in `coding.workspaces` and `coding.isolation`
with a configured verifier and enabled coding runtime. Use a private HTTPS
endpoint for a remote host (no URL credentials, paths or query strings). June
receives only the control credential, distinct from her operator credential.
Changing the app/coding configuration invalidates existing coding bindings.

The dedicated host's private config, selected by `JUNE_APPS_CONFIG`, is:

```json
{
  "port": 3090,
  "directory": "/var/lib/june-apps",
  "origin": "https://apps.example.invalid",
  "controlTokenEnv": "JUNE_APPS_CONTROL_TOKEN",
  "viewerTokenEnv": "JUNE_APPS_VIEWER_TOKEN"
}
```

Start with `pnpm apps:start` in its separately authorized service environment.
It requires `JUNE_ALLOW_DYNAMIC_APPS=1`, both distinct random credentials (at
least 32 characters), and explicit `RIVET_ENDPOINT`, `RIVET_TOKEN`,
`RIVET_NAMESPACE`, `RIVET_POOL` for its **own** provisioned engine. Cloud fallback
and `RIVET_ENGINE` are rejected, as are callback/public-endpoint overrides. The
directory must exist, belong to the host's Unix user, have mode 0700, and contain
no symlink components. Run only one host against this directory/namespace.
The integration does not expose an actor callback receiver.

Use a dedicated Unix identity/container, HOME, cgroup/resource limits and network
policy. Do not inherit June's `.env`, Rivet credentials, Slack tokens, Codex/Amp
login, filesystem mounts or operator credentials. The stock SDK permits build
network access and dependency scripts; its VM is not proof of safe access to
your LAN. Restrict egress and isolate the engine from June before activation.
Use a self-contained npm installation in PATH; Arch's split distro npm failed
inside the SDK's projected filesystem with missing `nopt` during the probe.

The control and internal credential-only viewer listener remains loopback-only.
Never expose that listener through public ingress or inject its bearer into a
public proxy: it bypasses the publication policy for private operator checks.
Keep `/control/*`, `/health/*`, `/api/rivet/*`, and engine ports private.
Neither credential belongs in browser code, URLs or logs.

### Optional public and sign-in-required viewers

Add `viewer` to the dedicated host configuration only after provisioning the
corresponding ingress, certificates and Access application:

```json
{
  "viewer": {
    "port": 3091,
    "publicDomain": "public-apps.example.invalid",
    "signedInDomain": "signed-apps.example.invalid",
    "issuer": "https://YOUR-TEAM.cloudflareaccess.com",
    "audience": "REPLACE_WITH_THE_ACCESS_APPLICATION_64_HEX_AUD"
  }
}
```

Replace the placeholders with verified application metadata; these are not
secrets. `viewer` starts a **separate `0.0.0.0` listener**, which exposes only
`/apps/<appId>/*`. Each app has its own HTTPS origin, such as
`https://counter.public-apps.example.invalid/apps/counter/`. Public and signed-in
domain suffixes must be distinct and neither may contain the other. The host
rejects mismatched app IDs/hosts, regardless of forwarded headers. Preserve the
external Host at ingress; terminate HTTPS there. Allow only that gateway to reach
the viewer port. Do not publish health/control routes or other pod ports.

The signed-in domain needs a Cloudflare Access **Allow Everyone** policy with a
login method available to anyone, such as email one-time PIN—not an owner policy,
workspace membership requirement, Service Auth or Bypass. The host validates the
Access assertion's signature, issuer, audience, expiry and human identity against
cached, rotating public keys. It never trusts an email header alone and does not
receive or log the user's password. The public domain needs no Access login.
Verify wildcard TLS coverage: ordinary apex wildcard certificates do not cover
these deeper app subdomains. Use the existing DNS writer, not competing manual
and GitOps records. No hostnames, certificates, Access policies or DNS records are
provisioned by this code.

Missing/legacy policy never becomes public automatically. The durable publication
pointer selects the **last consumed deployment**, not the most recently prepared
receipt. Starting deployment closes viewing before the engine can switch source;
already admitted viewer requests must finish before the engine changes code.
A stalled request therefore delays deployment rather than gaining access to the
next release. Only a successful recorded result reopens viewing. An unknown
outcome stays closed, including after restart. The viewer rechecks that pointer
after authentication and serving to avoid returning a response under a
superseded audience. Changing viewer configuration invalidates its old
approvals/publications; reprepare and approve, never rewrite stored binding markers.

Viewer credentials, Access assertions, identity headers and cookies are stripped
before generated code; response cookies and CORS grants are stripped as well.
Responses prohibit caching, embedding and service workers; cross-origin browser
requests to signed-in apps are denied. App cookies, WebSockets and service workers
are unsupported. Generated code must still be reviewed for deliberate disclosure
or unsafe application actions; login alone does not make its data owner-private.
This grants viewing only, not authoring or deployment permission. The June-facing
integration still requires its own separately coordinated runtime activation.

## Failure and recovery

The host persists deployment intent before calling the SDK. Repeated commands
return the same receipt. Failure or host interruption becomes `unknown` and
blocks further deployments of that app, including after restart. A few vetted
SDK failure codes are exposed; raw errors, stdout, stderr and tokens are not.

There is no automatic retry, rollback, deletion or reconciliation API in this
increment. An operator must inspect the dedicated host and Rivet dashboard to
establish what happened. Do not clear receipts, restore an old database or swap
engines merely to unblock deployment: that loses duplicate protection. Back up
the host's `deployments.sqlite` (including WAL safely) and engine state together.
Cancellation/forgetting prevents new preparation/approval but cannot undo an
already dispatched deployment or erase source already retained by the app host.
Host artifact retention and deployed-resource deletion require separate handling.

## Container pilot and operational logs

`src/apps/host.Dockerfile` packages the pinned Node, SDK and engine versions.
The native ARM64 image workflow verifies a disposable real deployment, credential
stripping and restart recovery before publishing. Image publication does not
activate June; the cluster's Flux configuration pins a reviewed image digest.

The host allows one build at a time. A different build receives 409 without
consuming its approval. `/health/live` reports process liveness;
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
