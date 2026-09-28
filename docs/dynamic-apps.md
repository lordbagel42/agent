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
4. Send the returned `!deploy-app <receipt-id>` yourself as a fresh plain-text
   owner Slack DM. Quotes, code blocks, forwarded messages and attachments cannot
   authorize deployment, even if Slack's fallback text contains the command.
   This distinct, ten-minute approval permits dependency installation, generated
   code execution and Rivet resource creation. Models cannot emit an approval
   action. Expired proposals require a new preparation turn and a new receipt;
   replaying the original turn cannot renew an approval.
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

The host listens on loopback only. A private, authenticated proxy may expose
**only `/apps/*`**, on an origin separate from June and any administrative UI,
injecting the viewer bearer server-side. Never put either token in a URL or
browser JavaScript. Keep `/control/*`, `/api/rivet/*`, and engine ports private.
Inbound proxy/auth headers and cookies are stripped before generated code, and
`Set-Cookie` is stripped from responses. Cookie-based sessions and WebSocket
proxying are not supported by this adapter. Apps on this origin share a browser
trust boundary; this is not a public multi-tenant hosting service.

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

API reference: [Rivet Dynamic Apps](https://github.com/rivet-dev/dynamic-apps/tree/v0.3.1/packages/dynamic-apps).
