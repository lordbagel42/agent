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

## GitHub deployment details

With a dedicated API credential installed, the controller mirrors deployment
evidence to a native **`june/deploy`** check on the exact commit in
`lordbagel42/agent`. GitHub's **Details** button opens that check's report:

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
parallel entries. Reports remain within the private GitHub repository.

An authorized operator enables reporting by installing the updated controller
and a root-owned `0600` `/etc/june/github-status-token` through the existing secret
mechanism. Use a fine-grained GitHub token restricted to `lordbagel42/agent` with
**Checks: read and write**, plus **Commit statuses: read and write** for existing
status links. When upgrading from status-only reporting, add Checks permission
to the existing token before installing this controller; otherwise publication
fails and the old statuses stop updating. If the installed credential has only
Commit statuses permission, set `"githubChecks": false` in the protected
`/etc/june/deploy.json` during installation. This preserves classic `june/deploy`
statuses without making any Checks calls or requiring broader credentials. It
does not provide the native Details report. Pending stages share one deduplicated
status; superseded revisions report error/not deployed, never success. Omit the
setting (or set it to true) only after provisioning Checks permissions.
The read-only SSH deploy key and
lifecycle token cannot authenticate GitHub API writes; do not reuse a coding-worker
or personal CLI credential. Missing status credentials leave reporting disabled.
Keep the token out of June's model/build environments; rotate it before expiry.
Controller installation/restart still requires operator authorization and must
wait for existing deployment operations to settle.

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

Builds have a 2 GiB hard memory limit, no swap and a ten-minute runtime deadline,
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
the target. The current development dependency tree is approximately 2.3 GiB per
release; the first verified automatic rollouts took about four minutes each.

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

A new build requires at least 4 GiB available; a prepared candidate requires
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

**Initial integration refuses automatic drain whenever native coding, reflection
or WhatsApp is enabled.** Coding commands now share the lifecycle fence, including
queued approvals/resumes, and drain checks current workspace leases and admission
locks after callbacks settle. Cancellation, `needs_review`, and late worker or
verifier success do not clear those durable blockers, including after restart.
An unreadable settlement check, timeout, or workflow fault cannot certify drain.
The coding gate remains because legacy sessions and roots removed from config
are not covered by current-root accounting. Reflection and WhatsApp also still
lack a proven lifecycle fence. These paths are disabled in the current live
configuration. Rivet shutdown is not drain evidence: its bounded race can swallow
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
records. Do not infer permission from equal labels. The live
[`9294216` release](https://github.com/lordbagel42/agent/commit/9294216368d722d4377aea146a4a59136a31ba9e),
`memory-dispatch` v2 and `june-conversation-memory-dispatch-v3` are distinct
compatibility epochs. Real-engine probes found that v2 → live and v3 → v2 can
repeat effects **before** failing journal replay. Even an idle/drained actor can
already have a newer marker. Initial live → integrated migration must also drain
old paid/native calls; legacy in-flight model replay can repeat a call. Never use
old database snapshots to make a downgrade appear healthy.

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
sensitive details, prefer Raygen's DM; consider a narrow public disclosure only
if verified Raygen is extremely persistent and explicit after hearing the concern,
and still prefer a DM. This does not open private history or memory to channel
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

The existing homelab provisioner remains the source for June's Node installation,
base service protections and persistent paths. Do **not** run its old automatic
rollback path across the compatibility epochs above. `main` is the repository's
default and only remote branch. Publish release-ready changes directly there;
never push a worker's partial clone over combined work.

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

Local checks:

```sh
pnpm format && pnpm lint && pnpm typecheck
pnpm exec vitest run src/deployment src/core/routing.test.ts src/runtime/delivery.test.ts
uv tool run ruff format --check scripts/deploy
uv tool run ruff check scripts/deploy
(umask 077; PYTHONDONTWRITEBYTECODE=1 python3 scripts/deploy/test_deploy.py)
```

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
