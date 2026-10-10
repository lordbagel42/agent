# Shared artifacts

June can create hosted HTML documents, shared Excalidraw boards, and live,
read-only workflow views through `artifact` in admitted conversations where it is
exposed, without an owner/private-DM task gate or compulsory human approval. June
judges the request, authority and appropriate publication audience; availability
does not authorize disclosure of unrelated private material. This is opt-in source support,
not evidence that a presentation host or Slack inline rendering is enabled.

## Configure

June builds the board/workflow browser client from the running release's own
source at startup (about two seconds, into a private temporary directory), so
releases need no separate asset step. `assets` is optional and only overrides
this with a prebuilt `pnpm artifacts:build` directory. Install the matching
Playwright Chromium (`pnpm exec playwright install chromium`) in the service
user's browser cache (`/var/lib/june/.cache/ms-playwright` for the slot units).
The renderer requires Chromium's sandbox; it never uses `--no-sandbox`. The slot
units set `NoNewPrivileges`/`PrivateDevices`, so the sandbox needs unprivileged
user namespaces in the container. If Chromium cannot start, artifacts still work
and Slack gets the text link without an image; capability-matrix inspection
reports `last preview render: failed`. Review the host's resource and network
isolation before serving untrusted HTML.

Add an `artifacts` object to the deployment's reviewed configuration:

```json
{
  "origin": "https://artifacts.example.org",
  "port": 3086,
  "directory": "/var/lib/june/artifacts",
  "encryptionKeyEnv": "JUNE_ARTIFACT_KEY",
  "pepperEnv": "JUNE_ARTIFACT_PEPPER",
  "experimentalSlackEmbed": false
}
```

The port must differ from June's own port and, with blue-green, from the slot
and intake ports (3081–3083). Only the active slot opens the store and binds this
port, after activation, so one fixed port serves both slots. The directory must
be persistent and writable by the service (`/var/lib/june` for slot units).

Use independent random secrets of at least 32 characters. Keep the SQLite file,
keys and backups private. Route a **dedicated HTTPS origin** only to this
loopback listener, never to June's console/operator API. Disable proxy caching
and allow SSE without buffering. Do not log request bodies, cookies or PINs.
Do not share this origin with unrelated apps or parent-domain cookies. The
socket peer is used for throttling; forwarded headers are not trusted, so users
behind the same proxy share a per-artifact attempt budget. Apply additional
edge-level rate limits. Slack must be able to fetch `preview.png` from this
origin for image blocks. No proxy, service, app scopes or secrets are
provisioned by this feature.

Private artifacts currently require a Slack creator and the bot's `im:write`
and `chat:write` permissions. Other clients get public images/links; they cannot
create private artifacts until a safe creator-DM transport exists.

### Blue-green durable intake

The blue-green Slack responder persists raw event bodies, so before storing an
event it replaces every string containing `!artifact-pin`, `Access PIN: <8
digits>` or the private-notification marker with `!artifact-pin [removed by
durable intake]`. That covers chosen-PIN commands, their edits/blocks, and the
bot's own PIN DM echoes. Each delivery carries `x-june-intake-redaction:
artifact-pin-v1`. June allows private creation and `change_pin` only while the
latest authenticated intake delivery carried that header; until the updated
responder is installed, public artifacts work and private requests fail with an
explicit reason. Chosen PINs are therefore never accepted under blue-green: the
host tells June the command was removed, and `change_pin` sends a new random PIN.
Install the updated `slack_responder.py` before or with enabling artifacts.

## June-facing actions

`artifact` accepts `action`, `id`, `title`, `kind`, `visibility`, `content`, and
`runId`; unused fields are null. Creation requires explicit public/private
visibility, which June chooses based on the request and sensitivity. HTML is
self-contained; the browser isolates it in an opaque-origin sandbox with a
restrictive CSP. Arbitrary HTML JavaScript, forms and external resources are
blocked: use native details/summary, CSS and anchor navigation. This deliberately
narrows the original scriptable-HTML design; HTTP interception alone cannot block
WebRTC network traffic. The host-authored board and workflow clients remain live.
Boards accept vector/text Excalidraw elements, not image files or external
links. June supplies shape fields; the host fills omitted `id`, `index` (array
order is layer order), `version`, `versionNonce` and `isDeleted`. Board collaborators merge changes using element versions;
deletions remain as tombstones. Reconnect retries scene writes, not external
effects. This is shared drawing, not a presence/cursor service or workflow editor.

`inspect` reads an existing creator/owner-managed artifact. `update` edits its
title/content. Creating a workflow artifact requires the run's original
authenticated requester and source scope (audience, channel/account and
conversation/thread), not merely knowledge of its ID or owner identity. The host
passes the actual originating event for that check; unbound legacy runs cannot
be shared through a newly admitted source. Existing artifact viewers instead use
the artifact's own public/PIN access controls. For an authorized run,
the projection exposes only name, revision, status and operation names/statuses,
never raw inputs, source, results or signal payloads. Deletion-revision changes
or revoked runs invalidate its data and previews. Workflow pages cannot execute,
cancel or modify workflows. Viewer SSE refreshes every two seconds.

Private creation generates eight random digits. The host DMs only the stored
creator, never the shared channel, and does not return the PIN to either model.
The pending notification is encrypted at rest and expires after a day. An
interrupted/ambiguous send becomes `unknown`, never an automatic resend. Inspect
the receipt, then request a **new** PIN if needed. `change_pin` is available to
the owner or creator; it generates a new PIN, revokes sessions and DMs the creator
even if the owner requested it. A chosen PIN uses a fresh plain Slack DM:
`!artifact-pin <artifact-id> <eight digits>`. The host strips it before memory,
history or model input. Host PIN notifications are marked private and redacted
on Slack context, import, search/history and recursive tool-result readback.
Quotes, stale events and other people's requests cannot
rotate it. Historical reads redact the command too.

Unlock sessions last one hour. Ten attempts per peer/artifact and thirty per
artifact are allowed per fifteen minutes, persisted across restarts. Changing
the PIN invalidates old sessions and open clients. A PIN grants collaboration,
not administration or June tool permissions. There is no switch back to public;
create a new public artifact when disclosure is intended. Existing screenshots
or copied content cannot be revoked. Storage is bounded to 500 artifacts and
20,000 management receipts; reaching capacity requires operator maintenance,
not automatic removal of deduplication records.

## Chat delivery and limitations

**Supported:** in Slack, the artifact reply lands in the requesting conversation
or thread as a real PNG preview (image block) plus an **Open shared space**
button to the canonical browser link; WhatsApp receives an image with that link
in its caption. The live board is the browser page, where everyone with the link
(or PIN) draws together. Private unauthenticated previews show only a generic
lock screen. Authenticated viewers can obtain the actual PNG. Rendering failure
preserves the artifact and returns text/link with an explicit unavailable
preview notice. Rendering is serialized, timed, network-intercepted and cached
in a bounded in-memory cache; screenshots contain no credentials or live cookies.

**Experimental:** `experimentalSlackEmbed: true` replaces the image with a Slack
`video` block whose iframe is the live page, the technique seen in
[Kyto](https://github.com/Devansh-awat/kyto). Its source was studied, not copied;
June uses the MIT Excalidraw package directly (license in
`src/artifacts/EXCALIDRAW-LICENSE.txt`, served with the client). Slack documents
video blocks for embeddable players, not arbitrary pages. They require the app's
`links.embed:write` scope and the artifact origin in the app's unfurl domains,
which are owner-authorized Slack app changes not made by this feature. Rendering
also depends on the client. If Slack definitively rejects the video block (for
example `invalid_blocks` without the scope), nothing was posted, so June resends
once with the supported image block; unknown or retryable failures are never
resent. PIN cookies may be blocked in an embedded third-party frame; use **Open
shared space** in the browser. A live Slack embed/DM must be verified after
separately authorized configuration and deployment.
