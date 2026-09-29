# Shared HTML, workflow views, and collaborative boards

Status: written design approved by the owner on 2026-09-29.
Source implementation is in place; live activation remains separate. No live
infrastructure or Slack configuration changes are authorized by this document.

Implementation adjustment after security review: generated HTML uses an empty
sandbox and script-src none, not the arbitrary script support proposed below.
Native details/summary and CSS remain available; the host-authored Excalidraw and
workflow clients remain live. Browser HTTP interception does not contain WebRTC.
Private creation currently requires Slack DM delivery, and blue-green intake is
rejected until chosen-PIN commands can bypass its raw durable queue. Current
behavior and setup are documented in `docs/shared-artifacts.md`.

## Outcome and decisions

June can create and share interactive HTML pages, workflow visualizations, and
collaborative Excalidraw boards. Slack receives an image and browser link, with
its existing video-block iframe workaround available as an experimental enhanced
presentation. Other clients receive HTML when explicitly supported, otherwise
image plus link, or text plus link when images are unavailable. June explains
that snapshots are static and inline HTML may not work in a particular client.

June chooses public or private access using the request and information being
shared. Private means an automatically generated eight-digit PIN, not Slack
sign-in. The host delivers that PIN to the authenticated creator's DM, never to
the originating shared thread. The configured owner or the original creator can
request a PIN change through June. PIN possession grants artifact access, not
management authority or authority over June's workflows and other tools.

## Existing implementation and reference

The task branch was rebased onto fetched origin/main on 2026-09-29. The original
shared checkpoint and its uncommitted work remain untouched.

- `src/core/web-embed.ts` and the Slack adapter already support approved-origin
  public video-block embeds. They neither host HTML nor establish client support.
- `src/apps` deploys verified Fetch applications behind bearer authentication.
  Do not weaken its deployment gates or expose its control/viewer credentials.
- `src/workflows` owns actual execution and receipts; views must not invent a
  second workflow engine or infer executed steps from model-authored diagrams.
- `src/core/social.ts` supplies authenticated owner identity checks. Creator
  identity must likewise come from inbound context, never model arguments.
- Runtime capabilities, model schemas, and runtime prompts must all expose the
  new capability; a developer-only route or dashboard is insufficient.

Kyto demonstrates hosted HTML inside Slack video blocks and a shared Excalidraw
room with WebSocket synchronization. Its public slug-based access, placeholder
thumbnail, and lack of participant authentication are not suitable defaults for
private artifacts. Its AGPL implementation will not be copied. Integrate the
MIT-licensed Excalidraw package independently with required notices.

## Artifact service and interface

Use a dedicated artifact module and isolated public presentation origin, not
the administrative console or unrestricted Dynamic Apps deployment. Persist an
opaque artifact ID, type, title, creator identity, source conversation/thread,
visibility, content revision, access generation, content, and delivery receipts.
Names are display labels, not room identities or authorization secrets.

Expose discoverable create, inspect, update, and change-PIN operations to June.
Creation takes typed HTML, board scene, or authorized workflow-view content and
an explicit public/private choice. Inspection reports canonical URL, revision,
visibility, render availability, and delivery status, never a PIN. Changes to
canonical content/access require creator or owner authority; board collaborators
can edit the shared drawing but cannot change access or manage the artifact.

Change-PIN supports generating a fresh random PIN or setting an explicitly
requested eight-digit value. Random generation uses the host CSPRNG and preserves
leading zeroes. Any supplied secret must be received privately and redacted from
model/history/log storage; June's public tool arguments must not contain it.
The host checks the authenticated caller and explicit request before mutation.
Changing a PIN on a public artifact makes it private. Existing private artifacts
are never made public merely by updating their contents or presentation.

Persist mutation intent and stable operation IDs. Repeated tool invocations must
not create extra artifacts, regenerate PINs, or send duplicate notifications.
Unknown external delivery remains unknown, without automatic replay. Artifact
URLs are returned only after durable creation, not predicted by the model.

## PIN access and delivery

Store a salted, slow PIN verifier, not plaintext. Use a host-secret pepper kept
outside the artifact database to limit offline attacks on the small PIN space.
Apply bounded per-artifact and per-client failed-attempt throttling that survives
restarts; trust forwarded client addresses only from configured proxies. PINs go
in HTTPS POST bodies, never URLs. Redact request bodies and secret-bearing sends.

Successful unlock issues a short-lived, artifact-scoped HttpOnly Secure session.
Sessions and streams are bound to the access generation. Rotation invalidates
old sessions, outstanding authentication, and open collaboration connections;
enforce generation checks on every read/write and stream publication. Protect
HTML, scene data, images, and subscriptions consistently with no-store responses.
Prevent CSRF and cross-artifact access. Browser or iframe cookie restrictions
fall back to opening the ordinary page, never to disabling authentication.

The host resolves the creator's DM using verified channel/account/user identity;
the model cannot choose another recipient. Owner-initiated rotation of someone
else's artifact still delivers the new PIN to that artifact's creator. Do not
include plaintext PINs in tool results, conversation history, analytics, URLs,
rendered content, or ordinary workflow journals. Durable delivery material, if
needed for recovery, is encrypted with a separate host-managed key and erased
after settlement or bounded expiry. Persist only content-free receipts afterward.

If DM delivery fails or is ambiguous, the artifact remains private and June
reports the delivery state without disclosing the PIN elsewhere. An explicitly
authorized new rotation is the recovery path; do not silently make it public.
When creator DM delivery is unavailable on a client, report that limitation and
do not pretend private creation was fully delivered.

## Shared presentation and workflows

All viewers of one artifact use the same board, including viewers arriving from
different clients. Public boards are editable by link holders; private boards
require PIN access. Persist validated scene revisions with bounded sizes and
update rates. Support reconnect/resync and acknowledged updates without
overwriting newer accepted edits. Presence/cursors are ephemeral. Initially
restrict boards to vector elements and text; reject unsupported binary assets
explicitly rather than silently losing them.

Workflow views project authorized, real state and recorded results. Separate
agent-authored planned steps from observed execution. Provide expandable details
and live status updates, while keeping private arguments, credentials, and
unapproved source data out of shared projections. Rendering grants no additional
workflow inspection or execution permissions. Board edits are annotations, not
workflow commands. The same artifact presentation and fallback pipeline serves
both workflows and boards.

Generated HTML runs in a sandboxed, opaque-origin frame without host credentials,
console access, external network requests, arbitrary navigation, or privileged
tools. Client-side interactivity is allowed within that boundary. Host-authored
board/workflow clients use narrowly scoped authenticated APIs; generated HTML
does not inherit those APIs. Render screenshots in a sandboxed browser with
network blocked, resource/time limits, and no local-file access or credentials.

## Image fallback and privacy

Generate a real bounded PNG from the same artifact revision, with accessible
summary and canonical web link. Cache only within the artifact's access boundary.
Debounce updates and label snapshots honestly; an already posted image cannot be
revoked by changing a PIN or access mode.

Public artifacts can use public thumbnails. Private artifacts use a non-sensitive
locked preview in shared conversations and for Slack's unauthenticated thumbnail
fetches. Their actual rendered image is available only after PIN access; private
delivery of that image must stay within the intended recipient's scope. Never
put a PIN or a bearer download token in an embed or image URL. June explains why
the shared preview is locked. On renderer failure, preserve the artifact and
send text plus link with an honest unavailable-preview status.

## Configuration and June's knowledge

Configure a dedicated HTTPS presentation origin, storage, secret keys, browser
renderer, and channel delivery prerequisites. Missing configuration disables the
corresponding operation explicitly. No implicit deployment or Slack scope change.
Keep existing public-only webEmbed validation intact; hosted protected artifacts
use their own typed, host-produced delivery contract, not arbitrary private URLs.

Update interaction, execution-worker, and automated-event instructions together:
creation and inspection tools; public/private choice; PIN delivery/rotation;
creator/owner management authority; shared-board behavior; workflow provenance;
client fallback and inline limitations; configuration versus live availability;
delivery uncertainty; and the prohibition on duplicating host notifications.

## Verification and delivery

Keep automated tests focused on core privacy/permission and duplicate-effect
boundaries: owner versus creator versus unrelated user (including cross-account
IDs), DM recipient binding, PIN handling, rotation/revocation races, protected
previews, and idempotent/unknown delivery. Exercise through June's actual model
action schema and dispatcher, not solely direct service calls.

Use two isolated browser sessions to verify shared edits, reconnect, persistence,
public/private views, failed PIN throttling, and immediate session invalidation.
Render and inspect representative workflow, board, locked preview, and PIN-entry
screenshots. Run formatter, linter, typechecker, and relevant existing tests.
Report unavailable live Slack/client checks honestly; API acceptance alone is not
proof of inline rendering. Obtain the required expert review before publication,
rebase over concurrent main changes, and follow repository publication guidance.
Live configuration/deployment remains a separately authorized step.
