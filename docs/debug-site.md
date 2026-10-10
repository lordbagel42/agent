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

June can inspect the latest ten receipts using exposed
`inspection:"debug-shares"` (interaction agents delegate the inspection).
She judges which receipt details belong in the current audience; archive links
still require viewer authentication.
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

June's exposed Rivet `database-schema`/`database-rows` inspection
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
captures and read issue metadata, but cannot read capture bodies, create viewer
sessions, mutate issues or overwrite a UUID.
Existing matching uploads are idempotent; conflicts return 409. No authorization
is implied by possession of a capture URL.

## GitHub issues and autonomous Amp triage

This optional integration tracks work in **`lordbagel42/agent` GitHub issues**.
The private **Issues** page (`/issues`) shows last-observed GitHub open/closed
state, capture/recovery links, Amp receipts and published commits. Capture pages
link to their issue. Refresh reads saved metadata; it never starts work. Search
and state filters cover the latest 100 observed issues, not the full GitHub archive.
June's exposed `inspection:"debug-issues"` reads the same metadata through
her ingest credential; interaction agents delegate the read to an execution worker.

- New ingested DEBUG/DEBUGSHARE captures register one source, `debug:<UUID>`.
  DEBUG is still **capture-only**, with no Amp launch. DEBUGSHARE keeps its
  existing investigator. The investigator can also register its exact source
  when no archive upload was configured; this does not imply evidence exists.
- Deployment recovery can register `recovery:<incident number>` before dispatch.
  Its existing recovery agent owns that issue. Issue tracking failures never
  block otherwise-authorized incident recovery.
- The optional `june-issue-sources` service on June's host observes DEBUGSHARE
  receipts and durable recovery source records, independently of June's process.
  It exports only source ID, phase, thread ID and revision, in bounded batches;
  it never opens snapshots/task results or makes HTTP requests under deployment
  locks. Repeated metadata posts cannot regress state or change thread identity.
  Initial archive uploads can report unavailable/queued separately from immutable
  snapshot bytes. Missing receipts mean **dispatch unobserved**, not running.
  Enabling this exporter can link retained host receipts, but never relaunch them.
- Every 30 seconds after the previous sync settles, the site polls GitHub for
  new/updated issues. Only issues created after **first activation** enter the
  issue-job queue. Editing/reopening an issue never creates a second assignment;
  historical issues and captures are not automatically backfilled. Generated
  diagnostic/recovery issues are excluded from this queue.
- The independent worker claims one issue at a time and dispatches Amp on
  **homelab-amp, High + Fast**. It judges ordinary code requests at runtime and
  may implement and publish under normal repository rules regardless of author
  identity, preserving verified attribution. Issue text cannot override host
  policy or grant deployment, restart, infrastructure or secret authority.
  Both the updated independent issue worker and debug service/API must be
  installed for this behavior; repository publication alone does not activate it.
  Existing DEBUGSHARE GPT-6 Astra Max + Fast, recovery Ultra + Fast and operator rules are unchanged.
- Assigned Amp threads use `issue_comment` for progress/blockers and
  `issue_complete` after shipping reviewed code. Completion verifies a full
  40-character commit is an ancestor of remote `main`, posts a completion comment,
  then closes the issue. It does **not** verify correctness or activation.
  An Amp `returned` receipt is not issue completion; closed is not deployed.

Generated GitHub bodies contain only identifiers, a private evidence/status URL
and an optional revision. They never contain the reported reason, snapshot body,
raw logs, credentials or conversation text. This repository may be public: agents
must keep progress/completion comments public-safe too. Linking a capture or Amp
thread does not bypass its access controls. There is no additional Slack notifier.

### Activation prerequisites (operator authorization required)

Source publication does **not** install this integration or enable automatic
work. Coordinate these changes with existing installation/deployment ownership:

1. Review and install the independent debug bundle under the standalone-site lock
   described below. This change adds `issue_records` to its existing database;
   preserve that database and install the reviewed updater policy with its added
   `issue-tracker.ts` storage pin. Update all three storage pins only after a
   verified manual forward install. Do not bypass the updater's storage-policy
   block or restore old data. Older installed policies do not cover the new pin.
2. Set `JUNE_DEBUG_ISSUES_ENABLED=1` in the site's protected environment. Configure
   **exactly one** GitHub credential mode: renewable installation tokens via
   `JUNE_DEBUG_GITHUB_REFRESH_TOKEN` and the service below, or an independently
   verified, repository-only `JUNE_DEBUG_GITHUB_TOKEN` with Issues read/write and
   Contents read. Static mode has no refresh; renewable mode never falls back to
   it. Neither mode uses June's encrypted MCP/OAuth credentials or a broad personal
   token. Provision a separate random `JUNE_DEBUG_ISSUE_TOKEN` (same encoding
   and length rules as the viewer token), distinct from viewer and ingest tokens.
   Set `JUNE_DEBUG_GITHUB_ACTOR_ID` to the verified numeric GitHub user/bot ID that
   this token creates issues as. Source reconciliation checks this ID and the
   creation timestamp, never a public marker alone. Rotation preserves the
   expected creator of already-pending write intents. Provision a distinct
   `JUNE_DEBUG_ISSUE_OPERATOR_TOKEN` for operator-only launch reconciliation;
   never install that token in Amp/MCP or the automation worker. Omitting it
   disables reconciliation, not triage. All site credentials must differ,
   including the optional Operations reader credential.
   Keep all values out of Git, chat and logs. Do not change an existing GitHub App's
   permissions or installation without owner approval.
3. Install the worker using the companion updater below. It keeps `issues.py`
   **alongside** its matching `deploy.py` in an immutable `/opt/june-issues` release,
   outside the existing controller installation and its whole-directory digest.
   Update `debugshare_runner.py` and the separately installed recovery controller
   only in their respective coordinated operator windows. Install the disabled
   `june-issues.service` template; it uses the existing `amp` account's CLI auth.
   Activate June's updated receipt reader before installing the updated
   `debugshare.py` dispatcher: the older strict reader rejects its new `kind`
   field. The new reader accepts both legacy and typed receipts.
4. Provision root-only `/etc/june-issues/runner.json` and its token file (0600),
   plus a canonical root-only 0700 state directory. Example **paths, not secrets**:

   ```json
   {
     "origin": "https://debug.raygen.dev",
     "tokenFile": "/etc/june-issues/token",
     "command": ["/absolute/path/to/amp"],
     "runnerDirectory": "/existing/homelab-amp/allowed/directory",
     "stateDirectory": "/var/lib/june-issues"
   }
   ```

   Use the verified installed CLI path and runner allowlist, not guessed paths.
   The worker retains its private claim journal as root and drops CLI children
   to `amp`. It performs a read-only runner check before recording launch intent.
5. Grant `amp` only this exact fallback command through reviewed sudo policy:
   `/usr/bin/python3 -I /opt/june-issues/current/issues.py tool`. Do not grant
   arbitrary Python, arguments, config paths or the `worker` command. JSON actions
   arrive on stdin; the helper reads the protected token and never returns it.
   `issue_track`, `issue_inspect`, `issue_comment`, `issue_complete` are also
   discoverable at the private Streamable HTTP MCP endpoint `/mcp/issues` with
   the separate automation bearer token. Viewer/ingest credentials cannot call it;
   the automation credential cannot sign in or read archive bodies. MCP enrollment
   is optional when the installed fallback is available.
6. For host-observed lifecycle reporting, use the companion updater's `sources`
   role on **June's host**. This installs the matching `source_status.py` and
   `issues.py` bundle and `june-issue-sources.service`. Separately provision
   root-only `/etc/june-issues/sources.json` (0600):

   ```json
   {
     "origin": "https://debug.raygen.dev",
     "tokenFile": "/etc/june-issues/automation-token",
     "debugDirectory": "/var/lib/june-debugshare",
     "recoveryDatabase": "/var/lib/june-deploy/records/deploy.sqlite"
   }
   ```

   Verify these paths against the host; use its existing private permissions.
   The token is the separate automation credential, never the operator credential.
   The exporter retries only idempotent metadata at `/api/issue-sources`, polling
   bounded pages every 15 seconds. It requires no deploy lock or June process.
   Local recovery records are saved even without it; an old `issueTracker` config
   does not enable any HTTP. Existing incident ownership and locks are unchanged.
7. Verify site readiness/loaded revision, distinct credential boundaries, actual
   issue creation and comment/closure on an operator-approved test issue, the
   worker's durable receipt and Amp thread, and June's private inspection path.
   Verify a DEBUG creates **no investigation**, and DEBUGSHARE retains one.
   Enable/start the worker only with operator approval. Neither a mock test nor a
   configured endpoint proves live GitHub/Amp access.

### Renewable GitHub App credentials

Use the existing root-only App key **in place on June's host**, not on amp-runner,
in the debug-site environment, or in Amp. The independently installed
`june-issue-credentials` service verifies the configured installation and requests
only `lordbagel42/agent`, `issues:write` and `contents:read` (implicit metadata read
is allowed). Broader returned grants, wrong repositories and invalid expiry fail
closed. It neither changes the App installation nor runs the deployment controller.

Provision root `0600` `/etc/june-issues/credentials.json` and its separate token file
under root-controlled directories. Example paths/IDs, **not credentials**:

```json
{
  "origin": "https://debug.raygen.dev",
  "tokenFile": "/etc/june-issues/refresh-token",
  "githubApp": {
    "appId": 123456,
    "installationId": 789012,
    "privateKeyFile": "/etc/june/github-app.pem"
  }
}
```

The token file contains the same random credential as the site's
`JUNE_DEBUG_GITHUB_REFRESH_TOKEN`, distinct from **all** viewer, ingest, operations,
automation and reconciliation credentials. Do not give it to agents or the source
exporter. `POST /api/issue-github-token` authenticates before reading at most 8 KiB
within two seconds. It accepts only `{version:1, token, expiresAt}`, rejects browser
origins, and returns an empty 204; other capabilities cannot call it. Tokens remain
in memory, never SQLite, argv, tools or receipts. Disable core dumps for both services.

Install/update this service through `companions.py --role credentials` on June,
using the same ownership/lock procedure below. It redelivers about every 60 seconds
and renews ten minutes early using both wall and monotonic clocks. Site restarts
start empty and recover on the next delivery. Identical grants cannot extend expiry;
stale/altered deliveries cannot replace a newer grant. The site stops using a token
two minutes early, also reserving the full ten-second GitHub request budget. Missing
or expired credentials pause polling/writes but do not prevent archive readiness,
sign-in or reads. June's `inspection:"debug-issues"` exposes only
`credentials.state` (`waiting|usable|expired`), receipt time and expiry. This is
**delivery evidence, not verified GitHub access**; check polling and issue receipts.
Failures retry at the next service poll and never fall back to personal credentials.

**Review the complete credential transport before enabling renewal.** HTTPS at the
public hostname is not necessarily end-to-end TLS: TLS terminators, reverse proxies
and any plaintext LAN hop become part of the credential trust boundary. Verify live
header/body logging, buffering, managed WAF/request capture and access restrictions;
disable secret capture and do not assume provisioning source proves live settings.
Use only independently verified operator access, never weaken SSH/TLS validation.
The renewer uses certificate validation, no environment proxy or redirects, and an
explicit `june-issue-renewer` User-Agent; 403 fails closed. Do not send credentials
to test an unreviewed path. If protections cannot be established, leave renewal and
issue automation disabled and report the specific transport gap.

### Unknown outcomes and recovery

Creation, comment and close intents commit before remote writes. Source IDs and
per-action UUID keys are stable. After response loss, repeat only the **identical**
action/key to reconcile its marker or closed state by read; never use a new key,
source or transport to replay an unknown effect. The inspector returns bounded
effect phases (`pending`, `commenting`, `commented`, `closing`, `done`). Only a
locally proven credential absence **before HTTP dispatch** leaves the same write
retryable (`pending`, or `commented` when only close is pending). Reuse its identical
action/key after renewal. Provider authentication or transport failures keep the
unknown fence because dispatch may have happened; token rotation never clears it.

The worker writes `active.json` before claiming or launching, retains a process
lock, and never automatically relaunches after `launching`, `running` or `unknown`
survives restart. An unknown launch fences the worker, including later issues.
Inspect the saved issue/claim and existing thread; do not delete the journal.
Pre-launch runner failures keep the same claim pending and retry on the next
15-second worker poll. A returned receipt releases the worker but does not close
the issue.

**Reconciliation requires exclusive launcher control.** The endpoint trusts the
operator to establish this exclusion; it cannot verify a remote host lock:

1. With operator authorization, stop/fence `june-issues.service` on amp-runner,
   then acquire and hold the existing root-private `<stateDirectory>/.worker.lock`
   using an exclusive flock. Never replace the lock inode or delete `active.json`.
2. Re-read the exact journal under that lock. Check the runner and any remote
   Amp thread: stopping the local observer does **not** prove the remote attempt
   did not launch or has settled. Keep the fence if evidence remains ambiguous.
3. Submit settlement while holding the lock. Only after its receipt is verified,
   release the lock and resume the worker; it clears its own settled journal.

An operator may settle the fenced attempt with the **operator token** at
`POST /api/issue-reconciliation/<number>` and an exact `claimId`, bounded
public-safe `evidence` of their checks, and either `resolution:"no_launch"` (only
after proving no launch/thread exists) or `resolution:"settled"` with a verified
`threadId` (after the existing process/thread is settled). Never fabricate a thread
or returned turn. Identical settlement retries are idempotent; different evidence
or identity conflicts are rejected. This terminal `reconciled` receipt releases
later jobs without relaunching or closing the original issue. Late automation
callbacks cannot undo it. The worker persists settlement before clearing only its
own journal, so a cleanup crash remains recoverable. Agents cannot access this
endpoint through the automation MCP/tools or installed CLI helper.

### Updating the issue companion services

Raygen's standing authorization in `AGENTS.md` covers deployment/configuration
needed to finish requested June/debug work; do not request the same permission
again. It does not transfer another operator's ownership, expand permissions or
permit deleting state. Coordinate a handoff and the host's existing locks first.

Install reviewed `scripts/deploy/companions.py` and its matching `issues.py` as
root-owned 0644 policy files in `/usr/local/lib/june-companions` (0755). This policy
is installed explicitly, never self-replaced from main. The updater manages only
the issue worker, source exporter and credential renewer, not June, the website, deployment policy,
DEBUGSHARE/SSH launchers, credentials, sudo grants or other services.

On **amp-runner**, stop the debug-site timer, let any active poll settle, and
invoke the following outside an already-held flock. On **June**, coordinate the
current operator, stop/settle the deployment poller and use `--role sources` or
`--role credentials`. Any unresolved recovery or operator hold blocks both updates. Resume the
original poller/timer after verification; do not stop an issue observer to force
a maintenance window.

```sh
sudo /usr/bin/python3 -I /usr/local/lib/june-companions/companions.py \
  --role worker --revision <exact-reviewed-current-main-SHA> --start
```

`--start` explicitly opts into first activation. Omit it for a staged, stopped
installation; later updates preserve the last verified running state. Enable the
appropriate unit at boot separately after the first workflow verification. The
same command without `--start` performs future updates; an unchanged revision
only verifies the installed files and process. It fetches only the fixed public
repository and requires exact current main with forward ancestry. It extracts a
fixed file list, checks Python syntax/systemd units, seals per-file hashes under
`/opt/june-issues/releases/<SHA>`, pins the unit's ExecStart to that release and
switches only the stable tool-helper link. Renewal uses its own
`/opt/june-issues/credentials/releases/<SHA>` and `credentials/current`, preserving
the worker/source file manifest and link when services are updated separately.
No build scripts or fetched Python
run in the installer. The configuration and issue journals remain in their
existing private paths and are never rewritten or restored.

The updater takes the existing host installation/operator lock (plus June's inner
deployment lock for `sources` and `credentials`). The worker holds a shared `.maintenance.lock`
through each claim, launch and full observation; updates require its exclusive
lock and no `active.json`. A busy or unresolved worker blocks an update without
stopping it. Lock inodes are preserved. Each service update records `applying`
before effects in `/var/lib/june-companions/<role>.json`, requires a fully stopped
cgroup, reloads the pinned unit and verifies exact process argv, MainPID and
InvocationID for five seconds. This proves loaded code/process stability, **not**
GitHub access, healthy polling or successful source export: verify those receipts
separately through June's private `inspection:"debug-issues"` and actual workflows.

Interrupted/failed updates retain `applying` and never retry or roll back
automatically. Under exclusive ownership, settle all service jobs and finish the
recorded reviewed installation, preserving data and unknown issue effects. Then
run the same role/revision with `--reconcile`: it only verifies the recorded
installation and process before marking ready; it does not replay stop/start,
change files, clear issue fences or accept a different revision. Do not delete
the updater state or fabricate a ready receipt to make a retry pass.

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
`src/diagnostics/store.ts`, `src/diagnostics/operations.ts` and
`src/diagnostics/issue-tracker.ts` (nullable when absent at the pinned revision). They are
conservative review gates, not a proof that arbitrary trusted-main code cannot
change data. Moving storage responsibilities requires reviewing these pins too.
The controller/preflight never update themselves from main. No automatic release,
failed-build, cache or archive deletion is performed; monitor disk usage.

`/health` reports the loaded website revision separately from an optional,
bounded `deployment` receipt containing only phases, fixed reasons, revisions
and a timestamp. Missing/unreadable receipts do not fail website health. They
contain no archive data, credentials or build output. Historical receipts do
not prove timer enablement/liveness; use systemd for that. June's exposed
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
       "src/diagnostics/operations.ts": null,
       "src/diagnostics/issue-tracker.ts": null
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
