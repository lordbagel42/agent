# Shared artifacts

June can create hosted HTML documents, shared Excalidraw boards, and live,
read-only workflow views through `artifact` in admitted conversations where it is
exposed, without an owner/private-DM task gate or compulsory human approval. June
judges the request, authority and appropriate publication audience; availability
does not authorize disclosure of unrelated private material. This is opt-in source support,
not evidence that a presentation host or Slack inline rendering is enabled.

## Configure

Build the client with `pnpm artifacts:build` and install the matching Playwright
Chromium (`pnpm exec playwright install chromium`) in the service user's browser
cache. The renderer requires Chromium's sandbox; it never uses `--no-sandbox`.
Review the host's resource and network isolation before serving untrusted HTML.

Add an `artifacts` object to the deployment's reviewed configuration:

```json
{
  "origin": "https://artifacts.example.org",
  "port": 3081,
  "directory": "/absolute/persistent/artifacts",
  "assets": "/absolute/release/dist/artifacts",
  "encryptionKeyEnv": "JUNE_ARTIFACT_KEY",
  "pepperEnv": "JUNE_ARTIFACT_PEPPER",
  "experimentalSlackEmbed": false
}
```

Use independent random secrets of at least 32 characters. Keep the SQLite file,
keys and backups private. Route a **dedicated HTTPS origin** only to this
loopback listener, never to June's console/operator API. Disable proxy caching
and allow SSE without buffering. Do not log request bodies, cookies or PINs.
Do not share this origin with unrelated apps or parent-domain cookies. The
socket peer is used for throttling; forwarded headers are not trusted, so users
behind the same proxy share a per-artifact attempt budget. Apply additional
edge-level rate limits. No proxy, service, app scopes or secrets are provisioned
by this feature.

Private artifacts currently require a Slack creator and the bot's `im:write`
and `chat:write` permissions. Other clients get public images/links; they cannot
create private artifacts until a safe creator-DM transport exists. Artifacts
currently reject blue-green configuration: its raw durable Slack intake must
not persist chosen-PIN commands. Deployment of that combination needs a separate
secret-safe intake design, not disabling the guard.

## June-facing actions

`artifact` accepts `action`, `id`, `title`, `kind`, `visibility`, `content`, and
`runId`; unused fields are null. Creation requires explicit public/private
visibility, which June chooses based on the request and sensitivity. HTML is
self-contained; the browser isolates it in an opaque-origin sandbox with a
restrictive CSP. Arbitrary HTML JavaScript, forms and external resources are
blocked: use native details/summary, CSS and anchor navigation. This deliberately
narrows the original scriptable-HTML design; HTTP interception alone cannot block
WebRTC network traffic. The host-authored board and workflow clients remain live.
Boards accept indexed vector/text Excalidraw elements, not image files
or external links. Board collaborators merge changes using element versions;
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

Slack defaults to a real PNG plus canonical browser link; WhatsApp receives an
image with that link in its caption. Private unauthenticated previews show only
a generic lock screen. Authenticated viewers can obtain the actual PNG. Rendering
failure preserves the artifact and returns text/link with an explicit unavailable
preview notice. Rendering is serialized, timed, network-intercepted and cached
in a bounded in-memory cache; screenshots contain no credentials or live cookies.

`experimentalSlackEmbed: true` uses the video-block iframe technique seen in
[Kyto](https://github.com/Devansh-awat/kyto). Its source was studied, not copied;
June uses the MIT Excalidraw package directly (license in `docs/licenses`). Slack
does **not** support arbitrary message HTML as a stable API. Inline behavior
depends on app approval/scopes and the client. PIN cookies may be blocked in an
embedded third-party frame; use **Open shared space** in the browser. Keep the
default image mode unless inline behavior has actually been tested. Rejected or
unknown Slack sends are reported normally; no speculative duplicate send is
performed. A live Slack embed/DM must be verified after separately authorized
configuration and deployment.
