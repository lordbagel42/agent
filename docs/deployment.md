# June's trusted-main deployment loop

The owner-authorized delivery policy is direct, trusted pushes to
`lordbagel42/agent:main`. `scripts/deploy/deploy.py` is a June-only host poller,
not a CI platform or a model tool. No release proposal, PR gate, GitHub Actions
runner, inbound webhook, or whole-homelab Pulumi update is required. **This code
does not provision or activate itself.** The operator integrates and bootstraps it.

The repository is **private**. The poller uses a dedicated **read-only GitHub
deploy key** and pinned GitHub host keys, not a person's `gh` login or the coding
worker's write credential. Coding agents need separately scoped write access to
this one repository; they cannot write the installed deployment controller.

## Main arrival and activation are separate facts

One process holds a nonblocking filesystem lock for its lifetime. Every five
seconds it fetches the fixed main ref, checks fast-forward ancestry, and durably
records newly observed commits. It retains only the latest observed head for
activation, refreshing after preflight and again after draining. An arrival
during activation waits for the next iteration. A force-push/backwards ref blocks
activation rather than selecting a stale revision.

For each candidate it:

1. Exports only the public source layout from the exact Git revision; rejects
   links, special files, private/generated paths and oversized archives.
2. Installs the frozen lockfile with package hooks disabled, checks formatting,
   types and the existing routing/delivery safety tests. This runs as `june-build`
   in a separate bounded systemd cgroup without June data or credentials.
3. Seals a root-owned release at `/opt/june/releases/<40-character-SHA>`.
   `.june-release.json` binds the source revision, complete installed-file digest,
   compatibility fingerprint and runtime binding. The controller verifies retained
   bytes; an existing revision is never silently overwritten.
4. Checks the old running revision, records intent, and obtains a bounded drain
   fence. Busy/uncertain model calls, sends, workers or verifiers defer activation;
   the old service stays running and admission is resumed.
5. Stops only `june.service`, atomically switches `current`, starts the exact
   candidate, checks readiness plus actual MainPID working-directory identity,
   and durably records success or failure.

The warm-path **target** is about 30 seconds, not a timeout that bypasses checks.
Measure push-to-observation externally and `received` → `healthy` from the event
timestamps. `elapsedMs` measures observation-to-outcome, not Git commit age:
commit timestamps can be older or supplied by a different clock. Cold dependency
downloads, large installs, busy workers and compatibility recovery can exceed
the target. This first version deliberately retains releases and has no automatic
garbage collector. Budget disk for the pnpm cache and multiple complete releases;
the current development dependency tree is approximately 2.3 GiB per release.

## Rollback never rewinds conversations

`/var/lib/june`, Rivet state/journals, messages, delivery intent, coding leases,
worker homes and worktrees are outside releases and are never copied, restored
or deleted by this controller. The poller cannot access `/var/lib/june` in its
service sandbox. Do not change `KillMode=control-group` just to leave coding
children alive: that also leaves Rivet/other children behind. Drain workers to
completion, or independently move their lifecycle into a persistent worker
service before claiming uninterrupted in-flight native execution.

**Initial integration refuses automatic drain whenever native coding, reflection
or WhatsApp is enabled.** These paths can outlive cancellation and do not yet have
a proven lifecycle fence. They are disabled in the current live configuration.
Rivet shutdown is not drain evidence: its bounded race can swallow errors. The
parent fence instead tracks awaited turns and HTTP work, refuses non-abort
workflow faults, and resumes admission on timeout without cancelling effects.

Trusted main authorizes **forward** code updates after preflight and drain;
it does not establish downgrade compatibility. By default automatic rollback
requires unchanged non-test `src/**` (except the pure `src/console/view.ts`
presentation module), package/lockfile/runtime pins, plus the exact same config,
effective service unit including drop-ins, and Node checksum binding. Equality
is a conservative unchanged-contract check, not a proof of arbitrary code safety.
Treat the excluded view as presentation only; adding persistence there violates
the contract. No concurrent config, namespace, state-path, unit, credential-scope
or out-of-band service change is permitted while the poller owns activation.
Environment files must not override runtime/namespace configuration.

If the candidate fails, the controller first requires its drain fence. It then
stops it and restores retained last-known-good code **only if** rollback is safe.
Changed-contract failures stay blocked for operator **forward recovery**. If
candidate drain cannot be proven, it is left untouched and blocked rather than
killing possibly active workers. A generic health endpoint is insufficient:
parent readiness must detect stuck/diverged durable workflows too.

An operator may install independently verified exact rollback evidence in the
root-only `transitions` list, never in a candidate or model request:

```json
{
  "from": "<exact last-known-good source SHA>",
  "to": "<exact candidate source SHA>",
  "binding": "<unchanged runtime binding from the release marker>",
  "rollbackSafe": true
}
```

Keep the corresponding disposable replay evidence with the operator's release
records. Do not infer permission from equal labels. The live
[`9294216` release](https://github.com/lordbagel42/agent/commit/9294216368d722d4377aea146a4a59136a31ba9e),
`memory-dispatch` v2 and `june-conversation-memory-dispatch-v3` are distinct
compatibility epochs. Real-engine probes found that v2 → live and v3 → v2 can
repeat effects **before** failing journal replay. Even an idle/drained actor can
already have a newer marker. Initial live → integrated migration must also drain
old paid/native calls; legacy in-flight model replay can repeat a call. Never use
old database snapshots to make a downgrade appear healthy.

## Parent application wiring

The parent owns `main`, config, registry and HTTP integration. These are required
before activation; the deployment package does not implement a pretend drain:

- Read `.june-release.json` from the immutable working directory **once at
  startup**. `/health` returns `{name:"June", ready:true, revision:<full SHA>}`
  only when runtime and durable workflow checks pass. Never read the moving
  `current` symlink for process identity.
- A private, bearer-authenticated `POST /operator/deployment/drain` fences all
  new ingress/background triggers/worker launches and returns
  `{revision, drained:true}` only after active work has really settled and intent
  is durable. HTTP timeout is five seconds; return `drained:false` when busy.
  No timeout/abort race may assert that a native process has stopped.
- `DELETE /operator/deployment/drain` idempotently resumes admission and returns
  `{revision, drained:false}`. It must invalidate any earlier pending drain so a
  delayed handler cannot re-fence the app after resume. Keep POST/DELETE private;
  console cookies and model tools do not authorize them.
- `createDeploymentReader({file, ownerId})` in `src/deployment/feed.ts` reads only
  the root-owned bounded feed. Call `read(authenticatedOwnerId, afterSequence)`
  from an already-authorized **owner-private** context, not arbitrary channels.
  Optionally mount `createDeploymentRoutes({read, authenticate})` at
  `/operator/deployment`; it provides only `GET /events?after=N`.

The feed is `/var/lib/june-deploy/public/events.json`, atomic root:june `0640`.
It exposes the last 100 events with a monotonically increasing sequence, exact
revision, observation/commit times, status, fixed failure reason and elapsed
milliseconds. `lastHealthyRevision` is a last-known-good observation, **not a
claim that it is currently running**. `received`, `activating`, `healthy`,
`failed`, `rolled_back`, `deferred`, `superseded`, `blocked`, `fetch_failed` and
`reconciled` have distinct meanings. Check the first returned sequence for a
cursor gap; older records remain in root-only SQLite, not in this bounded feed.

No raw commit messages, source text, subprocess output, credentials or arbitrary
error strings enter the feed. June can identify the exact change by its revision;
reading its private diff requires existing repository-read permission. Events
are evidence, not instructions, deployment authority or permission to notify new
channels. Consumer cursors and any notification delivery intent belong in June's
durable journal, with the existing audience/send restrictions.

## One-time bootstrap and access checklist

The existing homelab provisioner remains the source for June's Node installation,
base service protections and persistent paths. Do **not** run its old automatic
rollback path across the compatibility epochs above. Reconcile the repository's
current default `feat/rivet-messaging` with the combined integrated source, then
publish `main`; never push a worker's partial clone over combined work.

On the **June host only**, an authorized operator must:

1. Install Python ≥3.12, Git, systemd, pinned Node 24.21.0 and pnpm 10.33.0. The
   existing `/opt/june/corepack` cache must contain that pnpm version and be
   root-owned/readable; builds set `COREPACK_ENABLE_NETWORK=0` for the launcher.
   Registry package downloads still use pnpm normally.
2. Install reviewed `deploy.py` and `preflight.sh` under root-owned
   `/usr/local/lib/june-deploy`, outside releases/worktrees. Install the supplied
   `june-deploy.service` template but **do not start it yet**. Controller upgrades
   require separate operator installation; main cannot self-replace this policy.
3. Create the dedicated non-login `june-build` account (different UID from June),
   its private `/var/cache/june-build`, and a root-owned bare repository
   `/var/lib/june-deploy/source.git`. Build staging and `/opt/june/releases` must
   share a filesystem for atomic promotion. Root owns `/var/lib/june-deploy`
   (`0711` traversal only), its `records` (`0700`) and `public` (root:june `0750`).
   No coding/build UID may replace their ancestors, manipulate service-manager
   jobs, or edit `/opt/june`, `/etc/june`, or the controller.
4. Enroll the dedicated **read-only**, repo-specific SSH deploy key at
   `/etc/june/deploy-key` (root `0600`) and independently verify GitHub's host key
   into `/etc/june/deploy-known-hosts`. Supply `/etc/june/deploy-token` (root
   `0600`) through the existing secret mechanism; it must authenticate only the
   required private lifecycle access, and is never given to the builder/model.
5. Write root `0600` `/etc/june/deploy.json`:

   ```json
   {
     "origin": "http://192.168.0.215:3080",
     "healthSeconds": 15,
     "initialRevision": "<exact combined main source SHA>",
     "transitions": []
   }
   ```

6. While holding exclusive operator control, run the installed script with
   `--prepare <SHA>` to prepare **current main only**. Quiesce live June, perform
   the separately reviewed one-time activation of that immutable release, and
   verify messaging/replay/worker behavior. No source marker should be fabricated
   for the old digest-named release. `--prepare` never stops/starts June.
7. With that revision actually healthy, run `--bootstrap` once to initialize
   records. Then start `june-deploy.service`. Default invocation polls;
   `--once` performs one poll under the same lock. Missing records refuse normal
   startup; do not recreate them after data loss to bypass duplicate protection.

The host's existing public ingress remains **Slack POST only**. Do not expose
health, events, drain, Rivet ports, Git credentials or the service manager publicly.
No code here provisions access, makes an external write or runs Pulumi.

## Recovery and verification

An interrupted drain/stop/start is `activation_unknown`, not permission to retry.
The poller keeps observing arrivals but blocks activation. Stop the poller under
operator control, wait for all existing systemd jobs/controller operations to
settle, inspect the retained state and candidate, and establish a healthy
compatible release (normally a forward fix). Preserve messages and unknown effect
markers. Only then use `--reconcile <actually-running SHA>` under the same lock;
it checks retained bytes, readiness, MainPID identity and absence of pending June
jobs, records the observation and clears the block without invoking service
control. It does not repair a force-pushed branch or authorize another writer.
Never run the old provisioner concurrently with this poller.

Local checks:

```sh
pnpm format && pnpm lint && pnpm typecheck
pnpm exec vitest run src/deployment src/core/routing.test.ts src/runtime/delivery.test.ts
uv tool run ruff format --check scripts/deploy
uv tool run ruff check scripts/deploy
PYTHONDONTWRITEBYTECODE=1 python3 scripts/deploy/test_deploy.py
```

The core fixtures use real disposable Git commits, SQLite, HTTP subprocesses,
release directories and persistent messages. They cover duplicate activation,
crash/reopen, exclusive lock, latest-head coalescing, force-push rejection,
permission/privacy boundaries, busy drain, failed preflight and compatible vs
unsafe rollback. They measure successful/failed warm fixture elapsed time. They
do **not** prove production cgroup isolation, full June restart time, GitHub fetch
latency, real coding-worker drain or Rivet compatibility. Validate those on the
combined candidate and disposable state before the initial live activation.
