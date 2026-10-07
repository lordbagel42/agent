# June Debug: independent private archive

June Debug is a separate shadcn-svelte website with its own Node service,
SQLite database and viewer sign-in. It is **not a route in June's console**.
Once an upload is acknowledged, reading, searching, signing in and exporting
that capture require neither June nor Rivet. A failed main-site deploy cannot
replace the independently installed debug bundle.

Deploy on a **different host** for host-failure isolation. Colocation protects
against June process/release failures, not shared host, disk, reverse-proxy,
network or identity-provider failures. This site does not capture new evidence
while June is down, nor recover a snapshot that never finished uploading.

## Capture and inspect

After an operator configures the service, send `DEBUG a short explanation` to
June. The owner-DM receipt includes `/s/<UUID>` on the debug origin; reports from
other surfaces send that link only to the owner DM. The initial receipt says
upload queued, not available. Sign in with a registered **passkey** or the
site's **viewer credential**.
If the upload is pending, retry the page rather than issuing another DEBUG.
`DEBUGSHARE` uploads the same capture independently of its Amp investigation.

The page has searchable recent captures, timeline, message history, timing logs,
retained model request, delivery receipts, capture scope and complete raw JSON.
Select an evidence row for its exact retained payload and source path. Searches
inside a capture precede pagination; archive search covers metadata (UUID,
reason, session, revision and scope), not every message body. Export JSON returns
the full immutable snapshot. All content is point-in-time evidence, not live
health, cost, verified success or an inferred root cause.

Open **Conversation** on a capture for a read-only transcript at
`/s/<UUID>/conversation`. Choose coordinator or activity history; they may
overlap and are never merged or deduplicated. Records stay in retained order,
with source timestamps only when explicitly present. Assistant records can
include delivery summaries, not just words sent to the user. **Inspect record**
opens the original payload and JSON path. Search covers full records before
pagination; long text is visibly shortened with the complete record available
in the inspector and export. The **Evidence** page retains the full diagnostics.
Conversation links use the same sign-in and privacy rules as other captures.

Capture obeys existing retention/privacy rules. Timing logs cover exactly
matched retained inputs in the current process's 128-trace buffer, not global
logs or unjoinable historical traces. Raw service logs, provider-internal traffic,
volatile tool results and unrelated conversations are excluded. Exclusions are
visible in the page; pasted secrets are not guaranteed to be redacted. Keep the
archive and downloads private.

Fresh captures recheck deletion tombstones and record provenance even if cleanup
was interrupted. Stale model-request caches and evidence that cannot prove
independence after deletion are omitted. Existing captures are immutable exports:
deleting source memory or clearing history does not purge already-saved captures
or downloads. Archive removal requires separate authorized operator handling.

June can inspect the latest ten receipts using owner-private
`inspection:"debug-shares"` (interaction agents delegate the inspection).
`website` includes the URL, `pending|saved|rejected`, attempts and available
retry/error metadata. The host owns publication: transient failures retry from
15 seconds to one hour, actor wake resumes pending work, and permanent errors
or destination changes stop it. Generation-fenced callbacks prevent duplicate
wakes from multiplying retry chains. `saved` acknowledges independent storage,
not present availability. Configuration removal pauses pending uploads. Old captures
are not backfilled. Neither June nor the website may duplicate an upload, replay
a message, launch an investigation for DEBUG, or grant repair authority.

June stores diagnostic bodies in actor-local SQLite, not workflow state. Each
32 KiB part commits before an immutable SHA-256/length manifest; the source
command receipt is acknowledged only after that manifest. Retries reuse the
same UUID and bytes. Wake-up migrates legacy inline/compressed snapshots and
partial transfers losslessly before workflow replay, without launching work
from the migration itself. Delivery and uncertain-launch fences are unchanged.
No automatic cleanup deletes these bodies or incomplete orphan parts.

June's existing owner-private Rivet `database-schema`/`database-rows` inspection
can read source conversation tables `debug_body_manifests` and
`debug_body_parts`. Match the manifest's `sha256`, order parts by `part_index`,
decode base64, and verify byte length and SHA-256 before parsing JSON. Destination
debugShare actors use the same tables under existing operator access. Metadata
inspection remains body-free; never publish private chunks in chat or logs.
Previously published captures whose source bodies were retired remain at the
destination or acknowledged independent archive. This app-storage change needs
a June forward release, not a debug website deployment or new permissions.

## Operations history and June's private reader

`/operations` lists retained deployment, recovery, DEBUGSHARE, owner Amp task and
local/remote Amp coding observations. `/operations?id=<operationId>` opens the
immutable timeline. The latest controller observation includes revisions, queue,
phase, retry state, holds and recovery ownership; more than five minutes old or
ahead of the clock means stale/unknown. Sequence, not upload order, determines
the latest event. Occurrence time and source-observation time are separate.
Completed Amp work is not verified recovery or deployment. Unknown/no-thread
outcomes must not be replayed. The page grants no mutation authority.

Events contain fixed-code metadata only, never titles, task bodies, results,
credentials or raw logs. Matching failures are exact source + phase + reason
(or status), across distinct retained operations including reconciled ones;
this is the same symptom signature, **not a confirmed common root cause**.
The bounded related list links to all matches. Missing records are coverage gaps,
not proof that nothing happened. DEBUG remains capture-only.

The authenticated viewer API is `GET /api/operations[/:id]`. List parameters are
`q`, `source`, comma-separated `sources`, `failuresOnly=true|false`, `failureKey`,
`offset` and `limit` (1–100). Filters apply before totals and pagination, across
retained history. `source` and `sources` intersect when both are supplied;
invalid sources/booleans return 400. Amp grouping is
`sources=amp-task,debugshare,coding`. Existing capture deep links are unchanged.

For June, provision a third distinct credential as `JUNE_DEBUG_OPERATIONS_TOKEN`
in the independent site and reference the same secret through June's optional
`debugSite.operationsTokenEnv`. It authorizes only `GET /api/operations-read`
and its detail route, not captures, passkeys, browser sessions or ingest. Never
give June the viewer token. Owner-private `inspection:"debug-operations"` and
typed `{target:"debug-operations", sources, failuresOnly, query, source,
failureKey, operationId, offset, limit}` use this reader.
Interaction agents delegate; workers and automated events keep existing grants.
Each response contains a complete bounded JSON record page. Continue with
`nextOffset` and unchanged filters; `relatedQuery` retrieves matching operations.
Summaries link the last failure's event ID and sequence; `operationId` retrieves
full timeline events and controller payloads. The default is three records,
maximum ten; large pages return fewer whole records with an adjusted next offset.
Each page is a fresh observation; new arrivals may shift offsets. This is
separate from `inspection:"operations"` for local unresolved conversation markers.

Recording needs coordinated operator installation, not just source publication:

- Install the archive bundle on the existing private database (additive event
  tables, no archive restoration/deletion). The independent updater's storage
  pins intentionally fence this change until a reviewed forward install and
  rebootstrap; preserve passkeys and captures.
- To record coding attempts, configure June's optional
  `debugSite.operationsDatabase` as an absolute private SQLite journal path
  outside immutable releases. Parent directory and files must be service-owned
  0700/0600 without symlinks. It uses the existing write-only ingest credential.
  Both local Amp and remote Amp attempts are recorded; non-Amp local runtimes
  are not mislabeled. Disabling configuration pauses publication.
- Install `operations.py` beside the separately reviewed `deploy.py` and
  `debugshare.py`. In each private config add
  `"operations":{"origin":"https://debug.example.com","tokenFile":"/private/ingest-token","database":"/private/operations.sqlite"}`.
  Create the existing service-owned 0700 parent and private token file first.
  Controller and recovery workers share a journal; dispatcher uses its own.
  Install/configure under the existing operator locks and ownership rules.

Source journals bind their destination and keep immutable upload IDs/bytes.
Background publication retries transient failures from five seconds up to five
minutes, not the underlying launch/deployment. Conflicts and permanent HTTP
rejections remain retained for operator reconciliation. Local recording failures
fail soft with content-free coverage warnings; action and journal commits are
separate and can leave gaps. The dispatcher unit currently discards stdout/stderr,
so its warning visibility needs operator review; absence of logs is not success.
Retained deployment events and current dispatcher receipts backfill once with
honest historical timing. Cleared incidents and old coding runs cannot be
reconstructed. No automatic retention pruning, owner notification or repair
launch is added. Check source journals, acknowledged archive events, loaded
revisions and real private inspection separately before claiming live coverage.

## Passkey sign-in and recovery

Sign in with the existing viewer credential, open **Passkeys** in the header,
name the device or password manager, and select **Add passkey**. Complete the
browser's device-verification prompt yourself. On later visits, use **Sign in
with passkey**; capture deep links are preserved through sign-in. Up to 16
passkeys can be enrolled. Browsers without WebAuthn can still use the viewer
credential. Both methods require a current browser with Web Locks support so
concurrent tabs cannot overwrite sign-in cookies or undo a sign-out with a late
response. The lock covers authentication HTTP requests, not device prompts.

Registration and removal require a browser sign-in within the last five minutes;
sign out and back in if prompted. Removing a key signs out **all devices** and
invalidates outstanding ceremonies, including one already being verified. It
does not delete the local copy in the device/password manager. Keep the viewer
credential safely available for lost-device recovery. Never give it to June or
paste it into a conversation. An operator rotating a compromised viewer token
must also review enrolled keys: token rotation alone does not revoke passkeys.

SimpleWebAuthn verifies signatures, exact configured origin, hostname RP ID and
required user verification. Discoverable credentials are required; no platform
attachment is forced, so compatible phones, password managers and security keys
work. Only public keys, counters and display metadata live in the private SQLite
archive. Five-minute single-use challenges and eight-hour sessions live in
process memory with HttpOnly, Secure, SameSite=Strict cookies on HTTPS. Restarting
this site revokes sessions/challenges, not enrolled keys. No identity provider or
June service is involved. Changing the canonical hostname requires enrolling new
passkeys there with the viewer credential; existing keys are origin-bound.

The site adds its passkey tables without changing saved captures. Rollback must
preserve the live database, not restore an old archive. Installation of the
updated independent bundle enables support; only the owner's successful browser
enrollment proves a real passkey exists. Never enroll an operator/agent-owned key
as a production test. June may explain this workflow, but cannot enroll, remove,
recover or impersonate the owner's keys.

## Build and preview locally

Use the repository's pinned Node 24 and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm debug:build
pnpm debug:check
pnpm debug:preview
```

The preview uses a temporary database containing **only synthetic captures**.
Its intentionally public fake viewer credential is
`june-debug-synthetic-preview-viewer`. It loads no June config or credentials.
Set `JUNE_DEBUG_PREVIEW_ORIGIN` to the exact HTTPS portal origin when exposing
it through an orb portal. Use the orb's supervised services, not a detached
shell. Never run the preview against a real archive or use its credentials for
production. The production entry point contains no preview fixtures or bypass.

## Install separately (operator authorization required)

1. Build the desired verified revision. Copy **all of `dist/debug-site/`** to
   its own immutable directory, for example `/opt/june-debug/releases/<revision>`.
   Point `/opt/june-debug/current` there. Keep this outside June's releases,
   release cleanup and deployment controller. The bundle needs Node 24.21+ only;
   no repository, node_modules, provider clients or Rivet engine are required.
2. Create a dedicated `june-debug` OS user. Install the example
   `scripts/deploy/june-debug-site.service` independently. It has no `PartOf`,
   `Requires` or `BindsTo` dependency on June. Its private 0700 state directory
   and 0600 SQLite archive must be owned by that user, without symlinked parents.
3. Provision `/etc/june-debug/site.env` through the deployment's secret mechanism
   (root-readable only). Set `JUNE_DEBUG_ORIGIN` to a dedicated canonical HTTPS
   origin and supply **two different cryptographically random credentials**:
   `JUNE_DEBUG_VIEWER_TOKEN` and `JUNE_DEBUG_INGEST_TOKEN`. Use at least 32 random
   bytes encoded as base64url; accepted strings are 32–4096 characters. Never
   put tokens in Git, chat, URLs or access logs. The viewer credential must not
   be present in June's environment. Site sessions expire after eight hours and
   are revoked by a site restart; rotating a token requires restarting this
   independent service.
4. Terminate TLS with an independently managed private ingress/reverse proxy to
   loopback port 3092. Preserve the browser's Origin; do not cache responses or
   record authorization/cookie headers or request bodies. Allow uploads up to
   64 MiB. Keep network access owner-private where possible and retain the
   application's sign-in even behind an access proxy. Neither auth nor ingress
   should depend on June. Mount no June data/config directories into the service.
5. Configure June with the separate write-only credential through her normal
   coordinated configuration/deployment process:

   ```json
   {
     "debugSite": {
       "origin": "https://debug.example.com",
       "tokenEnv": "JUNE_DEBUG_INGEST_TOKEN"
     }
   }
   ```

   Absence disables new uploads and changes no existing DEBUG behavior. This is
   independent of `debugShare` and `JUNE_ALLOW_DEBUGSHARE`. Both components must
   be installed/configured; publishing source is not activation.
6. Verify the running site's `/health` returns `ready:true` and the intended
   built `revision` (the probe checks its database and UI assets). Log in, issue
   one authorized DEBUG, inspect the acknowledged upload and exported payload,
   then test reading and **fresh sign-in** while June/main console is unavailable
   during an approved maintenance test. Do not stop production to test without
   authorization. Verify the loaded June revision too.

The archive is append-only and has no automatic retention/deletion job. Monitor
its disk space and restrict backups as private conversation data. Back up with
SQLite's supported backup tooling or while this service is stopped; never copy
an actively modified file as a backup. Disk exhaustion rejects new uploads and
may require independent service recovery. Restoring old application code must
not restore old conversation data or delete captures.

Capture evidence is read-only to viewers; recent authenticated browser sessions
can manage the owner's passkeys. The upload token can add immutable
captures but cannot read them, create viewer sessions or overwrite a UUID.
Existing matching uploads are idempotent; conflicts return 409. No authorization
is implied by possession of a capture URL.

## Independent automatic updates

`scripts/deploy/debug_site.py` is an independently installed trusted-main poller,
not part of June's controller. The optional `june-debug-deploy.timer` checks public
`lordbagel42/agent` main about once a minute after the previous poll finishes.
Only `enabled:true` in root-owned `/etc/june-debug/deploy.json` admits updates.
Publishing source alone installs or enables nothing.

The installed policy builds a Git archive as a separate unprivileged user, with
frozen dependencies, lifecycle hooks disabled, formatter/linter/type checks,
focused tests and a disposable-database smoke test of the actual bundle. It
seals a root-owned immutable release, atomically switches `current`, restarts
only `june-debug-site.service`, and requires the exact revision and same process
invocation to remain ready for five seconds. The website briefly restarts and
existing browser sessions expire; archive contents and enrolled passkeys remain.
Unchanged build inputs skip activation without relabelling the running revision.
All `src`, frontend, dependency and build-config inputs are compared conservatively.

A failed candidate is not automatically retried; publish a forward fix. Fetch
failures retry on subsequent polls. A confirmed activation failure rolls back
**code only**, with the same readiness checks. Interrupted effects, a surviving
build cgroup, non-forward history, changed service configuration or changed
storage policy fence further effects for operator review. Storage pins cover
`src/diagnostics/store.ts` and optional `src/diagnostics/operations.ts`; they are
conservative review gates, not a proof that arbitrary trusted-main code cannot
change data. Moving storage responsibilities requires reviewing these pins too.
The controller/preflight never update themselves from main. No automatic release,
failed-build, cache or archive deletion is performed; monitor disk usage.

`/health` reports the loaded website revision separately from an optional,
bounded `deployment` receipt containing only phases, fixed reasons, revisions
and a timestamp. Missing/unreadable receipts do not fail website health. They
contain no archive data, credentials or build output. Historical receipts do
not prove timer enablement/liveness; use systemd for that. June's owner-private
`inspection:"debug-site-deployment"` integration reads only this credential-free
endpoint at `config.debugSite.origin`; interaction agents delegate. Installation
of the website/controller does not activate new inspection code in June. The
inspection grants no deploy/retry/restart authority. There are no automatic Slack
notifications or repair-thread launches for debug-site updates.

### Operator installation and recovery

Obtain standalone-site authorization and sole ownership first. Use the existing
`/run/lock/june-debug-install.lock` for installation, configuration, manual
activation and recovery; never replace its inode. Stop the **timer only**, let
an active poll/build settle, and then acquire the lock. Do not stop June or its
controller/dispatcher. The commands below are installation requirements, not an
instruction to run them against another deployment.

1. This policy targets Linux/systemd with cgroup v2, Python 3.12+, Git, pinned
   Node `/opt/node-v24.21.0-linux-x64`, pnpm 10.33.0 and the existing layout above.
   Create a separate `june-debug-build` system user/group with no login. Neither
   the builder nor site user may own controller policy or release directories.
2. Create root-owned `/opt/june-debug/build` and `releases` (0755), plus the
   builder-owned `/var/cache/june-debug-build` (0700). Provision a read-only
   Corepack cache at `/opt/june-debug/corepack` containing verified pnpm 10.33.0.
   Builds have no personal GitHub credentials or live archive/config access;
   public Git/npm networking remains available. No archive credentials are
   passed to build processes.
3. Create `/var/lib/june-debug-deploy` root:`june-debug` mode 0710 and its `public`
   directory root:`june-debug` mode 0750. Initialize a root-only bare Git repository
   at `source.git` there. The controller writes root-only `state.json` and an
   atomic root:`june-debug` 0640 `public/status.json`. Do not grant the website
   write access. All parents must be canonical and protected from untrusted writes.
4. Install reviewed `debug_site.py` and `debug-site-preflight.sh` root-owned,
   non-writable by other users, into `/usr/local/lib/june-debug-deploy`. Add its
   root-owned `manifest.json` with `revision` set to that reviewed exact commit
   and `sha256` mapping both filenames to their installed file SHA-256 values.
   Never generate this provenance from unreviewed/mixed checkout contents.
5. Install root-only `/etc/june-debug/deploy.json`:

   ```json
   {
     "enabled": false,
     "storagePins": {
       "src/diagnostics/store.ts": "<reviewed Git blob ID>",
       "src/diagnostics/operations.ts": null
     }
   }
   ```

   Use `git rev-parse <healthy-revision>:<path>` for each existing storage file;
   `null` means the file is absent at that revision. These are **blob IDs**, not
   commit IDs. The policy must match the manually verified healthy release.
6. Install the service/timer in `/etc/systemd/system` and
   `june-debug-deploy.conf` in `/etc/tmpfiles.d`. Run tmpfiles creation for that
   rule to create the 0600 lock both now and at boot; then reload systemd. Verify
   the sandbox, a real isolated build, and a collected empty build cgroup before
   enabling updates. Never weaken archive/credential permissions for a build.
7. With the poller settled, invoke the installed controller's
   `--bootstrap <verified-healthy-revision>` (it acquires the same lock itself).
   This writes an integrity marker only if absent, verifies live identity, and
   reconciles state. Independently verify provenance before first bootstrapping
   a manually installed bundle; bootstrap is not a source-to-bundle attestation.
   Set `enabled:true` under the lock and enable/start the timer. Observe an
   actual update and a subsequent unchanged poll, exact `/health`, MainPID and
   InvocationID, archive/credential permissions, and public authentication.

For `blocked`, disable/stop the timer, inspect protected state and the exact
`june-debug-build-stage-*.service` journal, and settle any surviving build or
service job before changing code/policy. Never clear a fence to replay an
uncertain effect. A storage-policy change requires a reviewed manual forward
install on the existing archive and fresh pins, followed by bootstrap from that
healthy release. Existing release markers are immutable; do not rewrite an old
marker to claim new compatibility. Preserve archive/passkeys/credentials and
any independently running investigations. Resume only after reconciliation.

## Raygen's independent installation

`https://debug.raygen.dev` runs on `amp-runner` (LXC 214, Tower), separately
from June (LXC 215, Optiplex). The `june-debug-site.service` user is
`june-debug`; its archive is `/var/lib/june-debug/archive.sqlite`. Its root-owned
bundle is under `/opt/june-debug/releases`, selected by `current`, with pinned
Node 24.21.0 under `/opt/node-v24.21.0-linux-x64`. June's deployment controller
does not own these paths or units.

The existing Cloudflare homelab tunnel and Consul/Traefik route the dedicated
hostname to `192.168.0.214:3093`. The independently enabled
`june-debug-proxy.socket`/`.service` forwards to loopback `3092`; it does not
depend on June. Public DNS and the Consul registration were installed directly
in the authorized operator window, not adopted into Pulumi state. Preserve
them when later importing infrastructure management.

Viewer and ingest tokens are distinct random values in root-only
`/etc/june-debug/site.env` on amp-runner. The owner can retrieve only the viewer
credential in a private terminal there:

```sh
sudo -n sed -n 's/^JUNE_DEBUG_VIEWER_TOKEN=//p' /etc/june-debug/site.env
```

Never paste that output into chat or logs. Only the ingest credential belongs
in June's root-only slot environment. Enabling it changes June's protected
runtime binding and requires a new forward release, not rewriting an existing
release marker. An installation check uses clearly labelled synthetic captures;
it is not evidence of a real owner DEBUG or permission to launch DEBUGSHARE.

This topology isolates June's process, release, LXC and physical compute host.
It still shares homelab power/network/Internet and the Cloudflare account,
tunnel, Traefik and Consul ingress. Failure of that ingress can hide the archive
even while its service and disk remain healthy. The archive additionally shares
Tower and the runner LXC with other runner workloads; it is not an off-site
backup or a dedicated-host security boundary. No automatic archive retention or
backup was enabled by this installation.

The independent updater was enabled on 2026-10-05 with installed controller
policy `af177bdd528ada18d7baa356c34b6fcdc77dae32`. Its first automatic activation
advanced the site from `206557b1bf68c13b5580125b17e26903e6f2f463` to that revision;
later unchanged polls preserved MainPID 206912 and the process invocation.
Loopback/public readiness, the live credential-free inspection, private API
boundaries, unchanged credentials/unit, and preserved archive inode/0600 mode
were verified. June was not restarted by this standalone rollout.

The dedicated builder uses a 4 GiB ceiling and 15-minute timeout. Its real
sandboxed preflight and disposable-bundle smoke passed; the initial 2 GiB attempt
was OOM-killed without touching the running site. Boot-lock creation and inode
preservation were tested with an isolated tmpfiles root, not a host reboot.
These are historical installation receipts: inspect current `/health`, timer
state and installed provenance for current status. Later Operations storage
changes still require the separately authorized forward-install procedure.

On 2026-10-07 the runner returned after an interruption during a later build.
The website recovered the same verified release (MainPID 85), the boot lock was
created with 0600 permissions, and the poller fenced the interrupted build.
No candidate had been promoted and no build process/cgroup survived. The operator
reconciled the unchanged healthy release and resumed the timer without changing
storage pins, restoring archive data, or restarting June.

The existing ingress socket failed at boot because its explicit LAN address was
not yet available (`Cannot assign requested address`). Starting that socket after
the address appeared restored public readiness without restarting the website.
Its persistent boot-order configuration was not changed by the updater rollout;
loopback health alone does not prove public ingress is available after a reboot.
