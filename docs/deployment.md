# June's trusted-main deployment loop

The deployment controller follows trusted updates to the configured repository's
`main` branch. `scripts/deploy/deploy.py` is a June-only host poller,
not a CI platform or a model tool. Preparation may run locally (the default) or
in GitHub Actions (operator opt-in). Activation always stays on June's host.
No release proposal, PR gate, inbound webhook or whole-homelab update is needed.
**This code does not provision or activate itself.** The operator integrates and
bootstraps it.

For a private repository, use a dedicated **read-only GitHub
deploy key** and pinned GitHub host keys, not a person's `gh` login or the coding
worker's write credential. Coding agents need separately scoped write access to
this one repository; they cannot write the installed deployment controller.

Paths below describe an example service layout, not a published deployment.
Provision access and obtain operator authorization for your own environment.

## GitHub Actions preparation

`.github/workflows/june-build.yml` runs on every push to `main`, preparing the
exact pushed SHA in Debian 13/x86-64 with Node 24.21.0 and pnpm 10.33.0. It runs
the same `preflight.sh`: frozen install with hooks disabled, formatting, types
and routing/delivery safety tests. It has read-only repository permission, no
deployment/configuration secrets, no LAN connection and no service-control step.
`june/build` success is **not** `june/deploy` success. In-flight builds are not
cancelled by newer pushes; the local pending queue still coalesces independently.

The producer exports source from Git, never the working tree. It uploads a
seven-day `june-<SHA>` artifact containing only `release.tar.gz`: prepared
`node_modules` plus a small manifest binding the exact source archive digest,
revision and runtime platform. Tar preserves executable bits and internal pnpm
links; hardlinks become independent files. Private/generated source paths and
runtime config are never packaged. There is no cross-run dependency cache.

When enabled, the controller verifies the expected workflow, push event, main
branch, repository, exact SHA and successful run before selecting an artifact
from that run. It validates the API-provided SHA-256 digest of the downloaded
ZIP, not a checksum supplied alongside arbitrary bytes. The API credential is
never forwarded to the signed storage URL. Downloads allow only HTTPS GitHub
Actions/Azure Blob storage locations, with no subsequent redirects. Neither
artifacts from PRs nor an artifact name alone establish provenance.

The host exports source independently and matches the producer's source digest.
Extraction is limited to dependencies: no source replacement, release marker,
absolute/traversing paths, external links, hardlinks or special files. Limits
are 2 GiB downloaded ZIP, 2 GiB inner archive, 5 GiB expanded dependency bytes
and 200,000 entries. Before tar parsing, the consumer also bounds all
decompressed bytes to 6 GiB and extension metadata to 1 MiB per header and
16 MiB total; global PAX headers and sparse formats are rejected. The ZIP
central directory, including effective ZIP64 values, is limited to 64 KiB
before parsing. A new Actions preparation requires 9 GiB free disk for
download, extraction, source and reserve; retained candidates still require
1 GiB. The host seals and hashes the result and creates `.june-release.json`
with its own config/Node/service binding. Existing drain, stop-evidence,
readiness, identity, compatibility, rollback and staging-recovery rules remain.

Missing/running builds produce `deferred/actions_pending`. API or download
availability failures produce `deferred/actions_unavailable`; metadata is
polled at most once a minute per unchanged candidate. The current service stays
untouched and there is **no automatic local-build fallback**. These two expected
wait reasons do not launch autonomous recovery or create legacy operator holds;
terminal Actions failures still follow the configured recovery policy. Unsuccessful
completed builds, expired/missing/invalid artifacts and changed build policy
terminally fail that candidate with a fixed reason. Publish a forward commit
after resolving the cause; rerunning an already failed SHA does not re-admit it.

June can inspect these outcomes through her existing owner-authenticated
`release: {"action":"inspect","revision":"<SHA>"}` directive. The receipt
distinguishes Actions waiting/unavailability, build success, validation/policy
failure and actual deployment evidence, and links to the private workflow logs.
It cannot dispatch/rerun Actions, change policy pins, drain or activate. Build
timings and raw logs are not in the controller feed; missing evidence is unknown.

### Operator activation (separate from publishing code)

1. Deploy the compatible app reader first using local preparation. Older
   readers reject the new reason codes; do not enable Actions mode first.
2. Review the workflow, `build_release.py` and `preflight.sh` at an exact commit.
   Record their Git **blob IDs**, not the app commit ID, in root-owned
   `/etc/june/deploy.json`:

   ```json
   "actionsBuild": true,
   "actionsPolicy": {
     ".github/workflows/june-build.yml": "<reviewed 40-character blob ID>",
     "scripts/deploy/build_release.py": "<reviewed 40-character blob ID>",
     "scripts/deploy/preflight.sh": "<reviewed 40-character blob ID>"
   }
   ```

   Obtain each with `git rev-parse <reviewed-commit>:<path>`. This preserves the
   independently installed preflight boundary: an app commit cannot silently
   remove the required checks. Policy changes require a fresh operator review
   and pin update before a new forward candidate is admitted.
3. Provision a separate root-owned `0600` `/etc/june/github-actions-token`
   through the existing secret mechanism. Restrict its fine-grained GitHub
   permission to **Actions: read** on this repository. Do not reuse the coding
   worker credential, SSH deploy key or model environment. The existing status
   token's permissions do not automatically grant artifact access.
4. With explicit installation authorization, settle controller operations and
   install the reviewed `deploy.py` under the normal operator lock. Do not
   install the producer/workflow on June or change configuration concurrently
   with activation. Refresh controller provenance as usual. Verify a real
   hosted build and artifact transfer before considering the cutover proven.

Omitting `actionsBuild` keeps existing local preparation unchanged. Switching
back is an operator policy change, not automatic outage recovery; keep the
compatible reader while historical Actions reasons remain in the bounded feed.
Already sealed releases remain immutable and usable without GitHub artifacts.
GitHub queues, transfer time, storage usage and private-repository Actions
billing remain operational considerations; this is not a 30-second guarantee.
The initial local producer probe measured 1.48 GB compressed and 4.15 GB expanded
dependencies (43,903 archive entries). These are decimal byte sizes, not a future
size guarantee; they supersede the older 2.3 GiB local-install estimate below for
artifact-transfer planning.

## GitHub deployment details

With a dedicated API credential installed, the controller mirrors deployment
evidence to a native **`june/deploy`** check on the exact commit in
the configured repository. GitHub's **Details** button opens that check's report:

| Controller evidence | GitHub check |
| --- | --- |
| Received or deferred | Queued |
| Preparing or activating | In progress |
| Healthy or operator-reconciled | Completed: success |
| Failed or rolled back | Completed: failure |
| Blocked | Completed: action required |
| Superseded without deployment | Completed: skipped |

Success means that revision was verified healthy, not that it is still running.
The report shows the revision, environment, first/latest event timestamps,
observation-to-outcome duration, and the latest 25 lifecycle events. Known
failure reasons include fixed explanations and recovery guidance. Commit time
is displayed separately; it is not deployment start time. Preparation and
activation requirements are explained, but individual command results are not
recorded or inferred. Fetch failures do not overwrite a candidate's result.
No logs, commit text, credentials, arbitrary diagnostics, or private service
URLs are published.

Existing classic commit statuses receive a Details link to the native check
and continue updating. New commits receive only the native check, avoiding two
parallel entries. Reports have the repository's visibility; keep private
deployment details out of reports published to a public repository.

Use the same private June GitHub App as [June's GitHub connection](github.md),
with **Checks: read and write** and **Commit statuses: read and write** added
to its repository permissions. Install it on `lordbagel42/agent`. Native Checks
reporting uses App installation authentication, not June's user OAuth token or
a personal access token. The former instructions to add Checks to a PAT were
incorrect.

An authorized operator installs the updated controller, `/usr/bin/openssl`,
and the App's RSA PEM private key through the existing private secret mechanism.
The key must be a root-owned regular file, mode `0600`, without symlinks or hard
links, under root-controlled directories; suggested path `/etc/june/github-app.pem`.
Add this optional object to root-owned `0600` `/etc/june/deploy.json`:

```json
"githubApp": {
  "appId": 123456,
  "installationId": 789012,
  "privateKeyFile": "/etc/june/github-app.pem"
}
```

Replace the example IDs with positive JSON integers (not strings): the numeric
App ID, not its OAuth client ID, and the installation ID for `lordbagel42`.
The key path must be absolute. No additional fields or configurable repository
are accepted. The controller verifies that the App's installation for the fixed
repository matches the configured installation and owner before minting a token
restricted to **only `agent`, `checks:write`, and `statuses:write`** (plus GitHub's
implicit metadata read permission). It rejects broader returned grants. Tokens
are cached only in memory and refreshed 60 seconds before expiry. Publication
failure discards the cache and uses the normal retry backoff. A configured App
failure never falls back to the legacy PAT. App configuration does not override
`githubChecks:false`.

One App registration does not mean shared credentials: June retains her user
OAuth client/refresh credentials; the signing key and installation tokens stay
outside June's runtime, MCP, model, and build environments. The App key can mint
broader tokens than this controller requests, so root-only custody is essential.
Neither credentials nor JWTs are written to controller SQLite, feeds or logs.

Without `githubApp` (or with null), legacy `/etc/june/github-status-token` remains
supported for classic statuses. Keep it root-owned `0600` and use
`"githubChecks": false` with the status-only PAT. This preserves `june/deploy`
statuses without Checks calls, but provides no native Details report. Pending
stages share one deduplicated status; superseded revisions report error/not
deployed, never success. Missing legacy credentials leave reporting disabled.
The read-only SSH deploy key and lifecycle token cannot authenticate GitHub API
writes; do not reuse a coding-worker or personal CLI credential.

Keep `githubChecks:false` until the App installation/permissions and controller
upgrade are ready. Enabling it (`true`, or omitted) and restarting the controller
require a separately authorized, coordinated operator handoff after recovery and
existing deployment operations settle. A main push does not install this code,
clear a block, or authorize resuming a disabled controller. After activation,
verify the native check and the existing status's Details URL on an actual commit;
local tests do not attest GitHub permission or delivery.

Reporting happens after recording preparation and after the deployment attempt, never
inside drain/activation/rollback. API failures do not fail deployments: they log
only `github_status_publish_failed: will retry` and back off for 60 seconds.
SQLite retains check IDs and successful report acknowledgements across restarts.
Each flush sends at most ten updates, newest first, including existing history
on first enablement. Only the latest evidence per revision is retried; unchanged
reports are deduplicated. If a check creation response is lost, the controller
looks up its stable external ID before creating another check. A legacy status
POST with a lost response may create a duplicate status on retry, but reporting
never repeats a deployment.

June can inspect the same underlying evidence for the verified owner through her
`release: {"action":"inspect","revision":"<SHA>"}` directive described below.
The local feed does not attest GitHub delivery; if the two disagree, use the
controller evidence and inspect the operator log for publication failures.

## Main arrival and activation are separate facts

One process holds a nonblocking filesystem lock for its lifetime. Every five
seconds it fetches the fixed main ref, checks fast-forward ancestry, and durably
records newly observed commits. Each observed main head is admitted to a durable
pending list in the existing SQLite state before its receipt or observation cursor is
written. The same atomic state write retains the newest admitted head as an
ancestry boundary, even after its queue entry completes; a crash before the
cursor update must not allow a later rewind. Historical intermediate commits first discovered within a single fetch
are recorded as `superseded` without admission. Before starting each attempt, the
controller selects the newest pending head and records its pending ancestors as
`superseded`. Their commits remain in the descendant's history, but those exact
revisions are never falsely reported as deployed. Busy drains, low capacity and
controller restarts preserve pending work until it completes or is superseded.
Only an intentional terminal outcome removes it; an
ambiguous activation or blocked controller still requires operator recovery.

Each selected candidate must descend from the identified running release.
Refreshes after preflight and drain still require fast-forward observed history;
a rewind/divergence blocks activation, and a post-drain block resumes admission
on the current service. New descendant arrivals do not discard completed work.
Config/artifact binding, rollback compatibility, readiness and drain checks are
unchanged. An attempt keeps its selected revision through preparation and drain,
even if new descendants arrive, so continuous pushes cannot starve activation.
The next tick coalesces the backlog again instead of building and restarting for
every historical head. This reduces lag without skipping validation or promising
a fixed deployment time. A failed latest head does not cause an automatic retry
or fallback to a superseded revision; a new forward fix is required.

On upgrade, unfinished preparing/deferred work and received history covered by
the old durable observation cursor are adopted in receipt order. An interrupted
legacy observation's unconfirmed intermediates are not promoted into queued
work. A pending revision already contained in the identified active release
(legacy stale records or an operator's forward jump) is skipped as `superseded`,
never deployed backwards or falsely reported as having run itself. Supersession
is non-deployment accounting, not a failure, active-release or cleanup claim.
There is no publication freeze or bypass of blocked safety/capacity/drain checks.

For each candidate it:

1. Exports only the public source layout from the exact Git revision; rejects
   links, special files, private/generated paths and oversized archives.
2. In local mode, installs the frozen lockfile with package hooks disabled,
   checks formatting, types and the routing/delivery safety tests as `june-build`
   in a bounded systemd cgroup without June data or credentials. In Actions mode,
   verifies and imports the exact revision's remotely prepared dependencies as
   described above instead of running a local install or preflight.
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

Before either activation or rollback switches releases, stopping must leave a
retained systemd execution record matching the pre-stop PID and start time:
normal exit code 0, `Result=success`, inactive service and no pending job/control
process. A changed invocation, timeout, signal, or missing/uncertain evidence
durably blocks as `activation_unknown`, without switching, starting or retrying.
`systemctl stop` returning 0 and the service becoming inactive are not enough.
This certifies only the main process's exit, not native persistence or successful
shutdown of every child; it does not replace the drain contract or shutdown
ordering validation. Lost systemd history requires operator recovery, not an
inferred successful stop.

Local builds have a 2 GiB hard memory limit, no swap and a ten-minute runtime deadline,
leaving headroom for the app and OS in June's 4 GiB container. Provision that
container capacity before installing this controller; the 1 GiB build budget in
the former 2 GiB container could not complete the pinned dependency install.
There is no soft
memory throttle: the former 768 MiB threshold trapped pnpm in reclaim below its
working set. The hard limit still covers the whole build cgroup, including
compiler/test children and charged file cache. An OOM kills the entire build
unit and fails preparation; it never authorizes activation or skipping checks.
Installation explicitly uses one pnpm worker, one concurrent network request and
a 384 MiB V8 old-space limit per isolate; this is not a total RSS cap and applies
only to installation, not later compilation. A candidate that cannot build within
the cgroup budget needs optimization or a separately reviewed capacity change,
not removal of the hard cap. These limits require installation of the controller;
an app push alone does not change the installed build policy. Verify effective
cgroup limits on the host.

Build output and fixed `june_preflight` phase markers are retained in the private
system journal under `june-build-stage-<id>.service`, instead of discarded. Use
`journalctl -u <exact-build-unit>` for operator diagnosis and phase timestamps;
raw output never enters the public feed or GitHub statuses. Retention follows the
host's journal policy, not release or conversation-data retention.

The warm-path **target** is about 30 seconds, not a timeout that bypasses checks.
Measure push-to-observation externally and `received` → `healthy` from the event
timestamps. `elapsedMs` measures observation-to-outcome, not Git commit age:
commit timestamps can be older or supplied by a different clock. Cold dependency
downloads, large installs, busy workers and compatibility recovery can exceed
the target. Measure dependency storage and rollout duration on the intended host
rather than treating the target as a deployment guarantee.

Before building, the controller prunes only obsolete releases recorded in its
own SQLite history. It retains the bootstrap revision, the two most recently
healthy/reconciled revisions, the recorded active revision and the candidate.
It also refuses to remove the actual `current` target. A normal rollout therefore
holds at most four controller releases, including the candidate. Cleanup runs
only with an identified running service and no pending service-manager job;
blocked/unknown operations do not prune. Root-owned, immutable release directories
and valid identity markers are required. Atomic rename to `.prune-<SHA>` makes
interrupted removal resumable. Unknown directories, legacy releases, backups,
the package cache and all conversation data are untouched.

Staging recovery runs on startup and each poll under the same deployment lock,
even when no new main is available or activation is blocked. Before extracting
source, the controller writes a root-only `/opt/june/build/.stage-<id>.json`
record outside the builder-writable directory, binding its device/inode. A gated
launcher cannot start `systemd-run` until its PID and boot identity are durable.
Never-launched stages are reclaimable immediately. Once launch is possible,
recovery requires launcher exit plus durable evidence of a successful
`systemd-run --wait`, or a changed host boot identity. PID absence and an absent
unit alone cannot settle a possibly queued start request. Interrupted launches,
nonzero returns and lost acknowledgements therefore retain their stages on the
same boot for operator inspection; restarting the controller does not clear this
ambiguity. In either recovery case the associated unit must also be inactive/failed
with no job, PIDs or control group. Manager errors or incomplete evidence preserve
the stage; recovery never stops a build. Interrupted removal retains the external
record.
Unregistered/pre-upgrade stages, replaced directories, symlinks and stages with
a release marker remain untouched and require operator inspection. A crash
before registration can leave an empty unregistered directory. This recovery
needs a separately authorized controller installation; pushing main does not
upgrade the installed script.

A new local build requires at least 4 GiB available; a prepared candidate requires
1 GiB. The 1 GiB reserve is checked again after building, before promotion.
Insufficient capacity records `deferred/insufficient_disk`, leaves June serving,
and retries after space is available without requiring another commit. These
checks are not a filesystem quota: substantially larger dependency changes still
require a capacity review. Budget separately for cache growth and legacy artifacts.

## Rollback never rewinds conversations

`/var/lib/june`, Rivet state/journals, messages, delivery intent, coding leases,
worker homes and worktrees are outside releases and are never copied, restored
or deleted by this controller. The poller cannot access `/var/lib/june` in its
service sandbox. Do not change `KillMode=control-group` just to leave coding
children alive: that also leaves Rivet/other children behind. Drain workers to
completion, or independently move their lifecycle into a persistent worker
service before claiming uninterrupted in-flight native execution.

### Stop June before stopping its engine

The app unit must run the root-owned installed controller's stop helper as its
synchronous `ExecStop` command:

```ini
[Service]
ExecStop=
ExecStop=/usr/bin/python3 -I -B /usr/local/lib/june-deploy/deploy.py --stop-app
KillMode=control-group
TimeoutStopSec=60
```

For a drop-in, the empty assignment clears any existing stop command before
installing this one. Verify June's main is the directly tracked Node process,
not a package-manager wrapper or externally reaped PID-file process. Require
`Delegate=no` (delegated control commands use a different cgroup), no `-` prefix
that ignores helper failure, and no `SuccessExitStatus` accepting exit code 1.

Keep the installed script readable by the app service user, but writable only by
root. The helper needs no root credentials or deployment lock: it validates
systemd's invocation, control PID, main PID, immutable release cwd and matching
cgroup, then pins the main process with a Linux pidfd. It sends SIGTERM only to
June and waits up to 45 seconds for that exact process to exit. Only after the
helper finishes does systemd terminate the remaining cgroup. This lets Rivet
persist actor shutdown while its engine is still available. Simultaneously
signalling the engine can strand `registry.shutdown()` until the manager kills
June, which correctly fails the controller's strict-stop check.

The helper never certifies drain or a successful exit, escalates signals, or
writes deployment records. The controller still requires pre-stop drain and the
same retained normal-exit-zero evidence; helper failure/timeout also fails stop.
Do not replace the wait with a background signal command or change `KillMode` to
leave workers behind. Installing this hook changes the runtime binding: use a
coordinated forward release under the new binding, never rewrite an old marker.
Verify the actual host's Python pidfd support and a disposable real-systemd stop
before enabling automatic rollout.

**Initial integration refuses automatic drain whenever native coding, reflection
or WhatsApp is enabled.** Coding commands now share the lifecycle fence, including
queued approvals/resumes, and drain checks current workspace leases and admission
locks after callbacks settle. Cancellation, `needs_review`, and late worker or
verifier success do not clear those durable blockers, including after restart.
An unreadable settlement check, timeout, or workflow fault cannot certify drain.
The coding gate remains because legacy sessions and roots removed from config
are not covered by current-root accounting. Reflection and WhatsApp also still
lack a proven lifecycle fence. Rivet shutdown is not drain evidence: its bounded race can swallow
errors. A drain timeout resumes admission without cancelling effects.

June's owner-authenticated release inspection reports controller evidence; it cannot
drain or activate a release. A coding cancellation acknowledgment or isolation
preflight is not proof of stopped execution or permission to bypass this gate.

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
records. Do not infer permission from equal labels. Workflow versions such as
`memory-dispatch` v2 and `june-conversation-memory-dispatch-v3` are distinct
compatibility epochs. An incompatible downgrade can repeat effects **before**
failing journal replay. Even an idle/drained actor can already have a newer
marker. Migration must also drain old paid/native calls; legacy in-flight model
replay can repeat a call. Never use old database snapshots to make a downgrade
appear healthy.

## Application lifecycle and private status

`main.ts` wires the lifecycle fence for HTTP requests and conversation turns.
Enable the private controller endpoints with `deployment` configuration only
after provisioning its dedicated credential and an immutable release marker:

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
  from an already-authorized **owner** context, including the owner's channel turns.
  The configured host mounts `GET /operator/deployment/events?after=N` behind
  owner bearer authentication. Owner model requests receive bounded read-only
  status, including the loaded running revision separately from historical
  `lastHealthyRevision`; unavailable status never blocks a conversational reply.

Conversation admission remains held through status/typing cleanup and final
persistence. Normal Rivet queue/sleep suspension is not a workflow failure;
the public workflow error hook latches actual failures. Forced aborts cannot
certify natural drain. Native coding, reflection and WhatsApp currently make
the controller drain endpoint refuse certification even if the inbox is idle.

Reflection now holds lifecycle admission through each raw provider call and
its final durable flush, and pauses new steps while fenced. Its additional
`isSettled()` check rejects started/uncertain invocations, running/cancelling
requests and live occupancy even when no local callback remains. Drain never
clears those holds or treats cancellation as settlement. This accounting is
not activation proof: the reflection automatic-deployment gate remains closed
pending complete recovery and transport verification.

The feed is `/var/lib/june-deploy/public/events.json`, atomic root:june `0640`.
It exposes the last 100 events with a monotonically increasing sequence, exact
revision, observation/commit times, status, fixed failure reason and elapsed
milliseconds. `lastHealthyRevision` is a last-known-good observation, **not a
claim that it is currently running**. `received`, `activating`, `healthy`,
`failed`, `rolled_back`, `deferred`, `superseded`, `blocked`, `fetch_failed` and
`reconciled` have distinct meanings. Check the first returned sequence for a
cursor gap; older records remain in root-only SQLite, not in this bounded feed.

No source text, command diagnostics, credentials or arbitrary error strings enter
the feed. The optional repository snapshot below adds bounded commit titles and
descriptions; reading a private diff still requires existing repository-read
permission. Events and commit text are data, not instructions, deployment
authority or permission to notify new channels. Consumer cursors and any
notification delivery intent belong in June's durable journal, with the existing
audience/send restrictions.

### June's deployment tracking

When deployment configuration is present, June's owner-authenticated reply schema and
prompt advertise a `release` directive. This is the same agent-callable structured
action interface used for search and coding proposals, not a CLI or a new poller:

```json
{"text":"","release":{"action":"inspect","revision":"<exact 40-character lowercase SHA>"}}
```

Use `action: "inspect"` with an exact revision to inspect that candidate, or
`revision: null` for recent controller events. Keep other actions unset/null.
The host reads the existing protected controller feed and sends the bounded
receipt directly through June's normal durable delivery workflow. The request
and receipt here are an inspection lookup, not a second deployment queue.

The same directive answers repository-stat questions: the optional
`repositorySnapshot` reports the last fetched `main` revision, its fetch time,
and `totalCommitCount`. This is the complete commit graph reachable from that
exact head, including merged history and merge commits, **not** all branches or
the number of deployment events. A shallow checkout reports a null/unknown total
rather than presenting its partial history as a total.

Commit metadata covers the nine most recent commits reachable from that head
plus the controller's last healthy revision (up to ten unique commits). Inspection
with `revision: null` shows the main head's title and description; an exact SHA
shows that commit's metadata if retained. An empty description is distinguished
from unavailable metadata. Titles
are capped at 256 UTF-8 bytes, descriptions at 2,048, with explicit truncation;
the whole feed is bounded to 256 KiB. Inspection receipts may further shorten
commit text with a display-truncation notice to fit WhatsApp's 4,096-code-point
limit, preserving deployment evidence and repository counts. Text is quoted and
treated as untrusted repository data, never instructions or health evidence.
It is available for authenticated owner requests and through the existing
owner-authenticated `/operator/deployment/events` endpoint. As with status
inspection, the receipt goes directly to the requesting conversation, including
channels. June is warned that commit descriptions may contain sensitive details
and must consider the audience before invoking, preferring a DM for unknown or
sensitive content under the disclosure guidance below. Guests cannot invoke it.
It is not added to GitHub check reports or deployment wakeup payloads.

Metadata is read locally using the controller's existing read-only Git checkout;
June receives no GitHub credentials or new network capability. Collection happens
after deployment processing, outside drain/activation/rollback. Failure retains
the prior snapshot and its original timestamp; after a controller restart it is
unknown until a successful collection. Snapshot time is a successful fetch time,
not a fresh observation when June reads the file.

**Activation order:** deploy this compatible app reader first, then separately
authorize installation of the updated controller and set
`"repositoryMetadataFeed": true` in `/etc/june/deploy.json` under the normal
deployment/operator lock. It defaults off because older readers reject additional
feed keys. Pushing main does not install the controller or enable this field.
Before downgrading to an older reader, disable the flag and republish the legacy
feed. Without the extension, June explicitly reports metadata/count as unknown
while existing deployment inspection continues to work.

No release-request step exists or is needed. Trusted main is already the
controller's release queue; inspect any relevant revision directly. Inspection
does not authorize or publish code. Inspection alone schedules no follow-up;
June can separately register an explicitly requested owner-DM notification through
[durable wakeups](wakeups.md), such as a one-time `deployment`/`healthy` watch.
There is no failed-release retry,
approval token, drain access, policy editing, reconciliation or service control
in this tool. The legacy supervisor remains inactive. Verified owner requests can
use it in DMs or channels; non-owner senders cannot invoke it. The bounded receipt
goes to the requesting conversation. June's instructions treat disclosure as an
audience-sensitive judgment, not a blanket ban on deployment facts outside DMs:
commit hashes and ordinary status are not inherently secret. For genuinely
sensitive details, prefer the authenticated owner's DM and require explicit
authorization for any broader disclosure. This does not open private history or memory to channel
turns, expose credentials/access links, or change action approvals.

Receipts report stage outcomes, fixed failure reasons and next steps; individual
check logs are not exposed by the controller feed. No evidence means unknown,
not passed. A blocked controller is reported even when inspecting another SHA.
The last 100 events may omit older evidence and are not a controller heartbeat.

Phase latency uses only those 100 events for the requested revision (or the latest
candidate revision when `revision: null`). It reports the latest visible attempt:
queue (`received` → `preparing`), combined preparation and drain (`preparing` →
`activating`), activation to verified health (`activating` → `healthy`), and
rollback (`failed:health_failed` → `rolled_back:health_failed`, including candidate
drain). A new `preparing` or `received` event starts a new attempt; timings never
combine visible retries. The feed has no attempt IDs and deduplicates consecutive
statuses, so an unrecorded preparation restart cannot be distinguished; these are
observed event intervals, not proof of uninterrupted execution.
Only adjacent lifecycle endpoints in sequence and nondecreasing
wall-clock time yield milliseconds. Fetch failures do not end a candidate phase.
Missing, aged-out, incomplete, interrupted or out-of-order evidence yields
**unknown**, not zero or success. Reconciliation cannot complete an interrupted
phase. A genuine same-millisecond pair can report zero. Separate install/build,
drain and readiness durations are not recorded, and these intervals are neither
monotonic-clock benchmarks nor current-health attestations. No latency target or
30-second deployment guarantee is implied.

For an exact revision, inspection searches the full bounded feed for its latest
`healthy` or `reconciled` observation, even if it is older than the displayed
three events. That proves the controller verified it live and healthy **at that
time**, not that it is healthy now. No such event means unknown, not never live.
`runningRevision` comes only from the immutable identity loaded by the serving
process at startup, with an observation timestamp. An inspected SHA, healthy event,
main head or historical `lastHealthyRevision` never substitutes for that identity.
This is a process-identity observation, not a fresh independent MainPID/readiness
attestation. Replayed conversation receipts describe their recorded time; call
inspect again for a new observation. If the feed fails, the running identity is
still reported separately while checks and blockers remain explicitly unknown.
An exact identity match is reported separately; a nonmatch does not establish
whether the inspected commit is an ancestor of the currently running revision.

### Installed controller identity is not app identity

The same feed optionally includes `controllerRevision`, an exact source SHA from
separately provisioned controller installation provenance. June reports it through
`release: {"action":"inspect","revision":null}` and owner-authenticated deployment
context, separately from `runningRevision` and `lastHealthyRevision`. Missing,
null, invalid or unavailable provenance means **unknown**, not the app revision,
main head, or any candidate event. Different SHAs alone do not establish age or
ancestry. Pushing app main does not install controller changes.

New app readers accept feeds with or without this field. **Deploy compatible app
readers before enabling publication:** older readers reject extra keys. Without
provenance the controller omits the field, preserving the legacy feed shape.
Before an app downgrade to an older reader, an authorized operator must disable
this extension and republish the legacy feed under the normal maintenance rules.

During a separately authorized controller installation, with the old controller
stopped and operations settled, verify that installed `deploy.py` and
`preflight.sh` come from the recorded exact repository revision. Then provision
this optional entry in root-owned `0600` `/etc/june/deploy.json`:

```json
"controller": {
  "revision": "<exact installed controller source SHA>",
  "digest": "<tree_digest of /usr/local/lib/june-deploy>"
}
```

Use the installed `deploy.py`'s existing `tree_digest(Path(...))` function on the
protected installation directory to obtain the digest, with Python bytecode
writing disabled. Keep that directory root-owned, non-writable by other users,
and unchanged while the controller is running. This binds the operator's source
provenance to installed code bytes and modes, not to app releases or systemd
configuration. At controller startup a missing/malformed record, changed digest,
or unsafe installation yields unknown; only a matching installation publishes
the SHA. No app code can write this record or install controller code.

The feed records the controller's **startup installation observation**, not a
fresh liveness check or proof that files were not replaced since startup. It
may be stale if the controller stopped. Replacing controller files/configuration
or restarting it still requires separate operator authorization; neither an app
push nor June's read-only inspection grants it.

### Superseded candidates and staging recovery are separate

`superseded` means the controller skipped that candidate before activation in
that attempt, not that deployment failed, that it is running, or that its stage
was removed. Staging recovery is separate global maintenance: the optional
`lastStageRecovery: {at, removed}` receipt records only a positive count of
abandoned stage directories actually removed by a recovery pass, after directory
sync and sidecar cleanup complete. It carries no revision, path, stage name,
process identity or raw output. It never changes candidate lifecycle status,
`lastHealthyRevision`, or the serving app's identity. June reports it even when
inspecting a particular revision, explicitly without attributing it to that SHA.

Absent receipts mean **unknown**, not zero, failed cleanup, or no abandoned
stages. Retained/ambiguous stages, partial failures and sidecar-only cleanup
(which may follow promotion) do not count. A crash after removal but before
recording can leave no receipt; this is not an exactly-once cleanup history.
The last receipt survives restart and empty recovery passes, so it is historical,
not proof all stages are now clean or that the controller is alive. Inline build
cleanup and standalone `--prepare` do not produce this recovery receipt.

Deploy compatible app readers before separately upgrading the installed
controller and setting `stagingRecoveryFeed: true` in its private configuration.
The field is omitted by default because older v1 readers reject unknown fields;
recording and cleanup do not depend on publication being enabled. Neither June's
inspection nor an ordinary app release installs/configures the controller.

## One-time bootstrap and access checklist

Provision the Node installation, base service protections and persistent paths
for the intended host. Do **not** use a legacy automatic rollback path across
the compatibility epochs above. Configure trusted publication to `main` under
your repository's review policy; this guide grants no publication authority.

On the **June host only**, an authorized operator must:

1. Provision at least 4 GiB container RAM with adequate physical host headroom;
   builds are capped at 2 GiB and must not share a 2 GiB parent with live June.
   Install Python ≥3.12, Git, systemd, pinned Node 24.21.0 and pnpm 10.33.0. The
   existing `/opt/june/corepack` cache must contain that pnpm version and be
   root-owned/readable; builds set `COREPACK_ENABLE_NETWORK=0` for the launcher.
   Registry package downloads still use pnpm normally.
2. Install reviewed `deploy.py` and `preflight.sh` under root-owned
   `/usr/local/lib/june-deploy`, outside releases/worktrees. Install the supplied
   `june-deploy.service` template but **do not start it yet**. Controller upgrades
   require separate operator installation; main cannot self-replace this policy.
3. Create the dedicated non-login `june-build` account (different UID from June),
   its private `/var/cache/june-build`, and a root-owned bare repository
   `/var/lib/june-deploy/source.git`. Create root-owned `/opt/june/build` (`0711`)
   for staging beside `/opt/june/releases`: both must share the **same mount**
   inside the controller's systemd sandbox for atomic promotion. The cache's
   separate writable bind mount cannot be renamed across, even on the same disk.
   A build may write only its own staging directory and the package cache.
   Root owns `/var/lib/june-deploy`
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
     "origin": "http://127.0.0.1:3080",
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

Keep public webhook ingress **Slack POST only**. Do not expose
health, events, drain, Rivet ports, Git credentials or the service manager publicly.
No code here provisions access or runs Pulumi. The optional GitHub status publisher
makes only the commit-status writes described above.

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

### Automatic Amp recovery handoff

The optional `ampRecovery` controller configuration enables failure-triggered
recovery threads. Install `june-deploy-recovery@.service` alongside the poller
unit, and provision authenticated transport to the runner's Amp CLI outside
application releases. For example, after an operator has approved and provisioned
the June-to-runner SSH identity and independently pinned its host key:

```json
{
  "ampRecovery": {
    "command": ["/home/amp/.amp/bin/amp"],
    "ssh": ["/usr/bin/ssh", "-F", "/etc/june/recovery-ssh-config", "amp-runner"],
    "runnerDirectory": "/home/amp/workspaces/agent"
  }
}
```

`command` is an Amp CLI argv prefix, not shell source. Optional `ssh` is the
OpenSSH executable/options/destination argv; the dispatcher shell-quotes the
complete remote command, preserving argument boundaries. Omit `ssh` only when
an authenticated CLI is installed locally. The controller supplies
`--mode high --executor runner:homelab-amp --runner-dir ...
--stream-json --no-archive-after-execute --title TITLE --execute PROMPT`.
The secret-free prompt must immediately follow `--execute`; a trailing positional
argument elsewhere is not accepted by Amp. The directory must be served by that runner. Verify the actual checkout
there; a directory name does not establish its branch or source provenance.
Do not put SSH inside `command`. The root-owned SSH configuration must select the
approved destination/user and key, `BatchMode yes`, `StrictHostKeyChecking yes`,
an independently pinned `UserKnownHostsFile`, and a bounded `ConnectTimeout`.
The runner's existing Amp authentication stays on the runner. Local transport
must work inside the recovery unit's sandbox (`ProtectHome=true`, read-only
system, writable controller records only). Provision the dedicated transport
identity using approved secret mechanisms, not June's application credentials
or a developer home-directory copy. The existing runner-to-June operator SSH
helper does not provide the reverse path. Transport provisioning is an explicit installation
prerequisite, not something this controller silently creates.

#### Restricted runner SSH endpoint

Install reviewed `scripts/deploy/runner.py` and its matching `deploy.py` as
root-owned, non-writable files in `/usr/local/lib/june-recovery/` on the runner.
The forced command imports only that installed sibling, never checkout code.
Create root-owned, non-writable `/etc/june-recovery/runner.json`, readable by the
Amp account, with the same `command` (one absolute Amp executable) and
`runnerDirectory` as June's `ampRecovery` configuration. Verify the checkout's
remote and that `homelab-amp` serves that exact directory.

Generate a dedicated Ed25519 key on June under `/etc/june/`, root-only mode 0600.
Keep its private half on June. Append its public half to the runner Amp account's
authorized keys without replacing existing keys. Restrict it to June's source
address and this forced command:

```text
restrict,from="192.168.0.215",command="/usr/bin/python3 -I /usr/local/lib/june-recovery/runner.py" ssh-ed25519 PUBLIC_KEY june-recovery
```

The endpoint rejects shell commands, changed modes/runners/directories, extra
arguments, unknown reason codes, and noncanonical investigation prompts. It
discards SSH stdin and clears the SSH-supplied environment before executing Amp,
whose credentials remain in its own home.
Install matching prompt versions on both hosts; version mismatch fails closed.
Use an independently verified runner host key in June's root-owned known-hosts
file. Disable agent/password authentication, forwarding and host-key updates in
the dedicated SSH config. Do not grant this key general SSH or sudo access.

The only alternate command is `june-recovery-self-test`. It launches a real
`high`/`homelab-amp` thread with a fixed no-tools/no-mutations prompt and returns
the normal JSON stream. Run it only for an authorized transport check, through
the same SSH config and service sandbox; verify the init thread ID, executor and
mode, then zero tool calls, `JUNE_RECOVERY_TRANSPORT_OK`, and successful completion.
The prompt requests no tools; it is not a capability-enforced sandbox. The probe
does not create a production incident, claim ownership, or change controller records.
Retain only a bounded identity/result receipt, not the conversation stream.

After a failed preflight, failed readiness/rollback, controller block, fetch
failure, or capacity/drain deferral, the poller records one private SQLite
`recovery` incident and fences further work. Unexpected polling errors and
repository/GitHub reporting errors also create an incident without overwriting
the candidate's lifecycle history. Install `june-deploy-failed.service` alongside
the poller: systemd's `OnFailure` invokes `--controller-failed` when the controller
exits unexpectedly, including startup failures. The poller no longer silently
restart-loops. This handler deliberately bypasses app credentials and release
verification; it does not bypass trusted installation or durable incident state.
Missing/corrupt controller configuration, unavailable SQLite/systemd/SSH/Amp, or
a destroyed installation can still require human recovery. No local controller
can guarantee launching an agent when its own dispatch infrastructure is broken.

It lets any already-running safe rollback finish first. Old failures before the
latest healthy/reconciled event are not replayed. A separate systemd worker
atomically consumes `pending` before creating a thread; repeated polls, restarts,
or lost systemd responses cannot create a second thread. The worker saves only
the Amp init `session_id`, never conversation output or logs. The existing
June-facing deployment feed continues to show the original failure; private
recovery ownership and thread identifiers are not exposed there. June can inspect
the recovery fence with her existing `release.inspect` capability: `blocked`
also covers recovery incidents and operator holds. A reason outside the lifecycle
feed remains unknown, not evidence of a healthy controller. GitHub queued checks
become `action_required` while globally fenced instead of claiming indefinite
deployment progress; this does not falsely mark queued commits as failed.

An incident left in `dispatching` has an **unknown launch outcome**. Do not reset
it to `pending` or start another thread. Inspect Amp and the launcher under
operator control, identify/fence any existing execution, and repair its receipt
only after establishing what happened. No timeout or end-of-turn releases the
recovery fence. Launch/authentication failures therefore fail closed rather than
spawning a thread storm.

Ownership is explicit, not inferred from a released flock. Under the outer
`/run/lock/june-operator-deploy.lock`, stop the poller, wait for prior operations
to settle, and use the root-only installed controller commands (which take the
inner `/var/lib/june-deploy/deploy.lock`):

```sh
# Existing operator retains ownership across stopped processes and free locks:
python3 -I /usr/local/lib/june-deploy/deploy.py --operator-hold OWNER
# Only that operator, after an explicit handoff, releases the hold:
python3 -I /usr/local/lib/june-deploy/deploy.py --release-operator-hold OWNER
# The spawned thread claims its matching recorded incident before mutations:
python3 -I /usr/local/lib/june-deploy/deploy.py --claim-recovery T-... --incident NUMBER
# After verified recovery, only the recorded owner may reconcile and release:
python3 -I /usr/local/lib/june-deploy/deploy.py --reconcile RUNNING_SHA --recovery-thread T-...
```

A hold suppresses new dispatch admission and normal deployment, and rejects
recovery claims. It cannot cancel a launch already admitted by the worker's
durable `dispatching` transition; that thread still cannot claim while held.
On first enabling this feature, an already unresolved failure is automatically
held as `legacy-recovery`; it is not adopted merely because owner metadata is
absent. Only after the actual existing operator explicitly hands off may an
operator release that hold (using `--release-operator-hold legacy-recovery`).
Prefer recording the known operator's hold before enabling the feature.
Reconciliation does not clear an operator hold. With the owner's autonomous
recovery authorization, a successfully claimed incident authorizes diagnosis,
reviewed source fixes published to trusted main, controller/stop-hook repair,
forward deployment, and restarting the poller without another approval round.
It does not authorize deleting non-disposable data, restoring conversation data,
force-killing unknown work, expanding permissions, or taking another operator's
hold. An active human operator still requires a coordinated handoff. The agent
must fix and verify the triggering fault, not merely reconcile the old healthy
app to clear the fence. Keep matching canonical prompts installed on both hosts.
The worker is a separate unit so stopping the poller to claim ownership does not
terminate the Amp connection. After verified repair/reconciliation, the agent
enables/starts the poller and checks queue progress and GitHub reporting.
Install/activate this integration only in a coordinated operator window; source
publication alone neither installs the unit nor grants new recovery privileges.

Local checks:

```sh
pnpm format && pnpm lint && pnpm typecheck
pnpm exec vitest run src/deployment src/core/routing.test.ts src/runtime/delivery.test.ts
uv tool run ruff format --check scripts/deploy
uv tool run ruff check scripts/deploy
(umask 077; PYTHONDONTWRITEBYTECODE=1 python3 scripts/deploy/test_deploy.py)
(umask 077; PYTHONDONTWRITEBYTECODE=1 python3 scripts/deploy/test_runner.py)
(umask 077; PYTHONDONTWRITEBYTECODE=1 python3 scripts/deploy/test_actions.py)
actionlint .github/workflows/june-build.yml
```

Use a disposable `TMPDIR` on a filesystem with sufficient free space if `/tmp`
is a small tmpfs; the existing controller fixtures enforce real disk admission.
The Actions fixtures cover provenance, policy pins, digest verification,
credential stripping, hostile archives, deferral and the unchanged local
activation path. They do not contact GitHub or prove a hosted workflow run.

The core fixtures use real disposable Git commits, SQLite, HTTP subprocesses,
release directories and persistent messages. They cover duplicate activation,
crash/reopen, exclusive lock, latest-head coalescing, force-push rejection,
permission/privacy boundaries, busy drain, failed preflight and compatible vs
unsafe rollback. Staging fixtures abruptly exit/kill a disposable controller,
preserve its surviving build process and unknown same-boot launch, then check
recovery with a simulated earlier boot identity. They also check durable successful
completion, ambiguous systemd responses, interrupted removal and untouched unknown,
sealed and conversation data. The fixture umask matches the controller service.
They measure successful/failed warm fixture elapsed time. They
do **not** prove production cgroup isolation, full June restart time, GitHub fetch
latency, real coding-worker drain or Rivet compatibility. Validate those on the
combined candidate and disposable state before the initial live activation.

## Optional Slack deployment responder

`scripts/deploy/slack_responder.py` is a separate Python-standard-library service,
installed outside app releases. It listens on private port 3081 and accepts only
POST `/webhooks/slack`; normal requests are forwarded byte-for-byte to June on
the same host address, port 3080, including Slack signatures. It does not expose June's health,
console, or operator routes. Keep it behind the existing public HTTPS ingress,
with a 1 MiB request limit and short request/header timeouts; do not expose the
Python HTTP server directly to the Internet.

With `"slackResponderFeed": true` in the controller's root-owned config, the
controller atomically publishes `public/slack-responder.json` before draining.
This separate file does not extend/break the legacy events feed. Its revision is
the durable activation **intent**, not the latest main head or last healthy SHA.
Preparation does not enable notices. Healthy activation, verified rollback,
reconciliation, or successful admission resume clears it. An unresolved intent
with a block/recovery/hold returns 503 without claiming a deploy is progressing.
A hold without an intent leaves normal routing unchanged. Missing/malformed
state fails closed; upstream failure alone never enables a deployment notice.
Controller crashes retain intent until recovery records a block or reconciles;
the responder cannot independently prove controller liveness or progress.

During an unblocked intent, authenticated workspace callbacks are acknowledged
without reaching June. Only human one-to-one DMs and literal `<@BOT_USER_ID>`
mentions receive `currently deploying <linked seven-character SHA>`. Channel
replies stay in the incoming thread (or start a reply thread); unthreaded DMs
stay unthreaded. Names, subscribed-thread followups, group-wide pings, edits,
deletions, hidden events, and bot messages do not trigger replies. This fixed
public commit notice grants no access to June's tools or private conversation
context and does not change her normal owner/guest routing permissions.

SQLite records hashed event and message identities **before** acknowledging or
sending, deduplicating retries and message/app_mention copies. Claims last 48
hours (including Slack's optional 24-hour delayed retries), survive restart,
and suppress forwarding after deployment too. No message bodies or credentials
are persisted. A full 100,000-key budget fails closed rather than evicting live
claims. There is no backlog or send retry: a crash between claim and delivery,
a lost ACK, Slack rejection, or rate limit can lose a notice rather than send it
twice. Requests already forwarded before the deployment boundary remain subject
to June's normal drain and deduplication. The responder ACKs before calling Slack;
bounded request threads and outbound timeouts limit unavailable-Slack work.

### Operator installation (separate authorization required)

Do not change services concurrently with the deployment/recovery owner. Source
publication does **not** activate this integration. In a coordinated window:

1. Install the reviewed controller and `slack_responder.py` as root-owned,
   non-writable code under `/usr/local/lib/june-deploy`, independently of releases.
   Preserve controller provenance and recovery configuration. Provision the
   `june-slack-responder` system user/group with no login shell, and install
   `june-slack-responder.service`. It has no dependency on June's unit and must
   not be included in the controller's app stop/start targets.
2. Provision root-owned mode-0600 `/etc/june/slack-responder.json` through the
   existing secret mechanism. Required keys: `teamId`, `botUserId`,
   `signingSecret`, and `botToken` for the **same existing Slack app/workspace**.
   Optional integer keys: `port` (3081) and `upstreamPort` (3080). `host` defaults
   to `127.0.0.1` and controls both the listener and upstream address. With the
   existing remote Traefik ingress, set it to June's private `192.168.0.215`
   address, where the app already listens. Only literal loopback or RFC1918
   IPv4 addresses are accepted; public, wildcard, and DNS binds are rejected.
   Change only the existing POST-only Consul/Traefik service's port to 3081;
   do not broaden its route or restart the unrelated Cloudflare tunnel. The unit uses
   systemd `LoadCredential`, not command-line/environment secret values. Update
   this credential whenever the app's token/signing secret rotates. No new Slack
   scopes, subscriptions, installations, or app Request URL are needed when
   retaining the existing public ingress URL.
3. Enable `slackResponderFeed` on the controller and verify a freshly published
   marker agrees with its durable state. Do not hand-write a null marker to
   bypass a fence. The marker is root-owned mode 0640 with June's group; the
   responder gets read access through that supplementary group, with private
   June data, controller records, releases, and `/etc/june` hidden by the unit.
   Its own mode-0700 state directory stores only the deduplication database.
4. Start/enable the responder, verify signed local challenge and normal proxy
   behavior, then change only the existing public POST `/webhooks/slack` upstream
   from 3080 to 3081. Preserve all other ingress restrictions. Verify normal
   June readiness/loaded revision independently; this service is not a health
   attestation. Never send real Slack messages merely to test it without consent.
5. On the next authorized deployment, verify notice receipt, silence for ordinary
   traffic, target link, and return to normal routing. Installation and local
   fixtures alone are not live-delivery verification. To remove the integration,
   first restore the original ingress upstream in an authorized window, then
   stop the responder and disable its marker publication; preserve its claims.

Focused local safety check (no live Slack calls):

```sh
(umask 077; PYTHONDONTWRITEBYTECODE=1 python3 scripts/deploy/test_slack_responder.py)
```
