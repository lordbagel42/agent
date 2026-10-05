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
