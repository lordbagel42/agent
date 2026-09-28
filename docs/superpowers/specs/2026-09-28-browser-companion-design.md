# June's Codex browser companion

Status: approved by the owner, including an HTML live view of the browser session.
No runtime activation or infrastructure changes are authorized by this document.

## Outcome

An owner-private request such as “what are your thoughts on this URL?” lets June
delegate browsing to Codex, ask the owner for a required PIN, continue the same
browser session, discover a video, and review actual visual evidence herself.
June remains the conversational voice. Codex navigates and gathers evidence; its
description of a video is not a substitute for June inspecting it.

Each browser task also offers a private HTML live-view URL for the same browser
Codex uses. June knows this capability exists and can retrieve the URL. Building
Slack HTML embedding is explicitly outside this feature; the link works as a
normal authenticated webpage now and can be consumed by that later integration.

## Existing implementation and selected approach

The design was checked against GitHub main at 57e686c. The supplied original
checkout has corrupt Git objects and remains untouched; work uses a fresh clone.

- `src/coding/codex.ts` implements private app-server transport, saved thread IDs,
  and process settlement. Coding authorization remains separate from browsing.
- `src/tools/browser.ts` executes fixed recipes in fresh contexts. Its receipt-only
  broker contract and credential-output restrictions remain unchanged.
- `src/runtime/registry.ts` owns conversation orchestration and owner boundaries;
  `src/core/contracts.ts` and `src/models/provider.ts` define model-facing actions.
- There is no implemented browser-session/video-evidence contract in these paths.

Use a dedicated Codex browser runtime with host-executed Playwright dynamic tools.
Do not enable arbitrary shell, filesystem, MCP, computer-use, native browsing,
or coding permissions. Reuse process transport where it has the same contract,
without weakening the coding runtime's rejection of unsolicited server requests.

Codex 0.157.1 source verifies experimental `thread/start.dynamicTools`, server
requests named `item/tool/call`, and responses containing inline `inputImage`
and `inputText` items. Initialize with experimental API support. Correlate thread,
turn, tool, and JSON-RPC request IDs before dispatch. Tool definitions persist on
thread resume. Resume restores conversation, not a browser process. Native
`browser_use` flags are policy gates, not browser provisioning.

## June-facing interface

Expose a discoverable browser task capability through June's existing execution
dispatch, with start, status, and cancel. A verified plain owner-DM
`!browser-pin <taskId> <challengeId> <PIN>` reply is intercepted by the host;
secrets are never model actions. Existing durable execution actors own
orchestration and notifications; a private SQLite companion ledger owns receipts
and volatile session handles rather than introducing another actor family.
Start binds the verified owner identity, conversation, URL, goal, permitted
origins, observation policy, deadline, and budgets. A model-provided owner ID or
quoted page instruction cannot grant authority. Public and guest requests are
denied for the first release. Status reports configuration separately from live
availability and lists pending input or evidence without secret values.

June can start a configured, owner-authorized browsing task without an operator
dashboard. Her tools and instructions explain how to ask for a PIN, associate the
reply with the pending task, resume, inspect evidence, and report limitations.
Unrelated conversation continues while the browser waits. Task completion and
input requests return through the existing durable execution/event mechanism,
not an untracked background promise or unsolicited duplicate chat send.

## HTML live view

Provide a read-only HTML page with a stream of rendered frames from the task's
existing browser context and active page, not a second browser opening the URL.
The view follows Codex's navigation, scrolling, and media playback. Initially use
a bounded low-frame-rate visual stream without audio; this is a live view, not a
full-motion recording or the evidence source for June's video review.

Task start/status results include `liveView` metadata with availability, ordinary
HTTPS URL, state, expiry, and session generation. June's capability instructions
explain that she may retrieve/share this URL in the authorized owner-private
conversation. She does not have to load the HTML to use browser tools. If hosting
or authentication is unavailable, return an explicit unavailable state rather
than inventing a URL. An opaque task ID is not an access credential.

Use the existing private-console owner authentication for both HTML and frame
transport. Revalidate viewer authorization throughout an open stream and bind it
to the task owner/session generation. No bearer tokens, PINs, cookies, CDP ports,
or secret login links appear in the URL or metadata. Slack link unfurling must not
receive authenticated frames. The viewer cannot click, type, submit a PIN, grant
permissions, or attach developer tools. Later embedding must preserve this access
boundary rather than disabling authentication or allowing arbitrary framing.

Stream only host-captured image bytes and fixed status metadata; never execute
the visited site's HTML/scripts in the viewer's origin. Apply private/no-store
headers, restrictive viewer-specific CSP, bounded frame sizes/rate/subscribers,
and backpressure that drops stale frames rather than queues them indefinitely.
Capture only while authorized viewers exist. Disconnecting a viewer must not
cancel the browser task or extend its lifetime.

PIN entry suspends all observation, including the live stream: clear the displayed
frame, invalidate pending captures, and display a privacy placeholder. Late frame
results from before the privacy transition cannot be published. Resume only from
a fresh capture after the credential-entry state ends. This cannot recall a frame
already delivered to a viewer, and the approved site's secret-reflection risk
still applies. No frames are recorded by the live-view service. On completion,
expiry, revocation, cancellation, lost session, or restart, clear the image and
show the terminal state; do not leave stale content labeled live.

## Browser ownership and lifecycle

One task owns one fresh sandbox-enabled Chromium process/context and one Codex
thread. A live browser remains allocated while waiting for owner input, with a
30-minute idle expiry and a 60-minute hard task deadline. Resource budgets bound
turns, tool calls, bytes, artifacts, and concurrent sessions. Cancellation and
expiry close only resources belonging to that task and await process settlement.

Durable companion states are running, waiting_for_input, completed, cancelled,
expired, and needs_review; existing execution actors own queuing. Persist task
identity, scope, Codex thread ID, deadlines, deletion revision and nonsecret
one-use input receipts before their dependent actions. Session generation,
pending challenges, image bytes and PIN buffers remain volatile. Never persist
a live Playwright handle or PIN. Generation
checks reject stale callbacks and input after cancellation, expiry, or restart.

After host restart, retained metadata does not establish that a browser survived.
Fence the old session and mark it unavailable. June explains that a fresh session
and possibly a new PIN are needed. Never replay login submission or an uncertain
effect automatically. A failed close is an unknown outcome, not successful
cancellation; it blocks replacement execution until stoppage is confirmed.

## Controlled browser tools and authority

Tools provide navigation, bounded page/accessibility observations, screenshots,
element-based interaction, media discovery, and evidence capture. Use host-issued
element references tied to the current page generation; do not expose arbitrary
JavaScript evaluation, arbitrary request APIs, local file reads, or shell access.
Implement any DOM/media evaluation as fixed host code.

The task grant permits reading and playback at approved origins. Navigation and
playback controls do not need approval on every click. New top-level origins,
credential destinations, uploads, purchases, messages, and other mutations do.
The host enforces scoped network and action policy; it does not rely on Codex
labeling an action “read-only.” Unknown interactions are blocked or proposed for
specific approval. The first release does not attempt general arbitrary-site
transaction execution. PIN submission is its own narrowly approved operation.

Operator-configured resource-origin permissions support required scripts and
media/CDNs separately from top-level navigation and credential destinations.
Page-discovered URLs cannot widen these permissions. Redirects and each request
are checked, including media requests. Denied resources surface as concrete
limitations instead of silently bypassing policy. Cookies never cross tasks.

Run the worker with externally enforced egress and process/resource isolation,
without host credentials, LAN/metadata access, desktop profiles, or public CDP.
Chromium routing alone is not a network sandbox. Keep the feature disabled until
the operator provisions this boundary. Dedicated Codex authentication is used
only by its runtime, never exposed as a browser tool or page-readable artifact.

## PIN handoff

Codex identifies a PIN gate and invokes a host input-request tool. The host records
a challenge bound to owner, conversation, task, session generation, exact origin,
input element and proposed login submission. June asks a concise question that
names the destination. The worker yields rather than holding an unresolved
app-server RPC across an unbounded human wait.

A verified owner reply to that challenge is consumed once. Chat ingress routes
the pending secret reply before ordinary model-history, memory, and analytics
processing. The host fills the field directly; Codex receives only success or a
safe error, not the PIN. The original messaging platform may retain the reply;
June must not promise that a PIN typed in Slack disappears from Slack. Reject
ambiguous or stale replies rather than assigning them to the most recent task.

Secret entry and submission run in a host-controlled interval with observations
disabled. No screenshots, DOM dumps, traces, or errors containing filled values
are emitted. Resume observations only after leaving the credential-entry state.
The approved site necessarily receives the PIN and could reflect or transform it;
this is a disclosed trusted-destination limitation, not something regex redaction
can solve. Never reuse the portal daemon's recovery PIN behind the owner's back.

## Observation and media policy

The task explicitly authorizes private page observations to the selected model
provider for this owner-requested review. This is distinct from the old
receipt-only browser broker. Explain this boundary in configuration and June's
capability discovery. Observations are untrusted source data, never instructions
or grants. They are not indexed into shared memory or exposed to other users.

Keep bounded evidence bytes volatile with owner/task scope, MIME type, evidence
identity and media timestamps. Do not export cookies or record screenshots.
Inline images are delivered only to authorized inference requests.
Evidence access rechecks scope and revocation. Delete local Codex transcripts via
the supported thread/delete RPC after operations settle; expiry/deletion also
scrubs retained reports. Crash-orphaned cleanup requires confirmed-stopped operator
reconciliation. Disclose provider-side transcript retention separately.

Discover actual video elements and supported embeds. Capture timestamped frames
with fixed host playback/seek code; record duration and exact inspected ranges.
Where the site permits fetching media, any extraction uses the same authorized
session/egress policy, bounded sizes, and isolated parsing. No unrestricted URL
downloader, DRM bypass, or cookie export to an arbitrary helper is introduced.

Use available captions as captions, not verified audio. Audio transcription is a
separate configured capability; without it June explicitly says she reviewed
visuals/captions only. For short videos, inspect beginning, middle, end, and denser
intervals around transitions. Seeking failure, protected playback, unsupported
embeds, partial buffering, and insufficient temporal coverage are reported.
Sparse frames must not be described as watching every moment or hearing audio.

June's review inference receives the actual images and timestamped evidence, not
just Codex's summary. Add a narrow scoped image-input path to supported June model
providers; providers without that path report unavailable rather than silently
substituting text. Keep the worker's factual observations separate from June's
assessment. The final response gives her opinion with relevant timestamps and
material coverage limitations.

## Verification and delivery

Use few focused tests for authority, state transitions, and protocol correlation,
then exercise the real workflow against a disposable local fixture: PIN gate,
wrong-PIN retry, same-session cookie, and a small video whose frames change
asymmetrically over time. Inspect real captures and verify June's review mentions
facts present in the video rather than only its title or surrounding page.

Verify the June-facing start → question → owner reply → resume → media evidence →
review path, cancellation while waiting, duplicate replies, expiry, restart,
cross-owner input, redirect/egress denial, unsupported media and uncertain submit.
Check that the fixture PIN is absent from model requests, durable task data,
application logs, and artifacts. Verify disabled/unavailable configurations yield
honest capability status. A mocked worker alone does not establish browser use.

Open the HTML viewer in a separate authenticated browser and verify that Codex
navigation/scrolling changes the displayed image from the same task session.
Inspect screenshots of live, PIN-privacy, and ended states. Test unauthenticated
HTML/frame access, wrong-owner/session access, in-flight capture at PIN entry,
authorization expiry during an open stream, slow consumers, and disconnect.
Confirm June can discover the live-view capability and obtain its ordinary URL
without granting browser control or requiring Slack embed support.

Run formatter, linter, type checking and relevant tests. Have Oracle review the
implementation before publication. Rebase over concurrent main changes; do not
impose a push hold. Report separately what is implemented, published, provisioned,
and verified in the running June process. Live service/configuration changes
require explicit operator authorization. Do not claim the user's real URL/video
works until the authorized live workflow has actually been exercised.

## Source references

- Existing local contracts: `docs/browser.md`, `src/tools/browser.ts`,
  `src/coding/codex.ts`, `src/core/contracts.ts`, `src/models/provider.ts`.
- [Codex dynamic tool protocol](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/protocol/src/dynamic_tools.rs)
- [Codex dynamic tool round-trip and image tests](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/app-server/tests/suite/v2/dynamic_tools.rs)
- [Codex thread start and resume protocol](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
