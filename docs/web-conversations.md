# June conversations

The private dashboard's **Conversations** action opens `/app`, a SvelteKit
conversation reader on the same authenticated origin. It is enabled whenever
the console is configured. There is no second service, participant enrollment,
new database, public share link or separate agent runtime.

This first increment is **owner-only and read-only**. Private means the configured
owner's one-to-one Slack DM with June. Channel threads and group DMs retain their
shared Slack audience. The thread list comes from June's existing subscriptions,
not all Slack conversations or June's worker context. Everyone's messages have
their own author and Slack-origin attribution. File metadata remains attached to
the source conversation; file contents and replies open in Slack. Attributed web
posting, participant accounts and artifact editing are not implemented.

## Authority and history

The existing 15-minute console session protects HTML, assets and every API read.
The reader uses only the configured bot token, validates its workspace and bot
identity, and checks the owner's DM identity or shared-channel membership on
each read. Shared threads must also be subscribed and accessible to the bot.
Transcript access is checked again after Slack responds; an expired session or
lost membership discards the result. Enterprise-wide installations are rejected
until a workspace-grant verification path exists. No owner-acting OAuth fallback
is used. No Slack permissions or installations are changed by this feature.

Discovery is bounded to 1,000 DM entries and 12 subscriptions per page. Membership
search is bounded to 1,000 members; if the owner is not found in that bound, the
thread is omitted/denied, not assumed public. Message pages contain up to 15
current Slack messages. Plain text and up to 10 filenames per message are shown,
not blocks, rich previews, private download URLs, removed content or reasoning.
Text is escaped, not interpreted as HTML. Edits/deletions are reflected on fresh
reads; there is no archival copy or promise of complete history. Pagination
replaces the visible page instead of retaining stale pages across access checks.

No transcript is persisted or cached by the app. Responses are no-store. Hiding
the tab clears content; returning performs a fresh read. The browser checks
session validity every 30 seconds without calling Slack, and clears content on
failure. There is no background Slack polling, automatic retry, message send,
worker dispatch or notification. Slack Retry-After is respected across readers.
Multiple concurrent reads return a bounded busy response instead of a burst.

Missing bot scopes, unavailable Slack, lost access and incomplete history are
shown explicitly. An empty list is not evidence that no conversations exist.

## June-facing use

The common runtime knowledge reaches interaction, execution, automated-event and
notification prompts, including legacy fallbacks. June's existing Slack/MCP
history tools remain her agent-facing read interface under each turn's grants.
Execution workers can use `inspection:"capabilities"` to inspect whether this
host has the console, Slack and an owner identity configured. That report does
not attest a successful frontend build or fresh Slack permissions. The existing
eligible `dashboardLogin` path gives the owner access; it does not enroll others.
June must not duplicate synchronization or retry jobs, infer shared authority
from owner web access, or request expanded permissions without owner approval.

## Build and verify

Run `pnpm web:check`, `pnpm web:lint` and `pnpm web:build`, plus the normal root
format/lint/typecheck commands. The build uses the workspace's existing Svelte 5,
SvelteKit 2 and Vite 7 versions. The custom Kit adapter only emits the prerendered
credential-free shell and browser assets; Hono owns authentication and IO.

On first authenticated use per process, June builds with release-local dependencies
in a disposable source workspace, with no runtime secrets in the builder's
environment. Its writable node_modules directory contains dependency symlinks;
Kit and Vite generate files only in that workspace. The immutable release is
not written. HTML/assets are retained in memory, temporary output is
removed, and only exact generated client paths are served. A failed build returns
503 for that process rather than repeatedly compiling. Slack remains unchanged.
This uses the existing app release source export and requires no companion updater.

Local acceptance uses a disposable synthetic Slack fixture through the real Hono
session bridge and reader, plus browser checks for desktop/mobile scopes, details,
pagination, unavailable/expired/empty states, escaped content and no browser
transcript storage (Kit may retain scroll positions and empty navigation snapshots).
Never put real conversation screenshots or credentials in Git. Live verification
must separately check the loaded release, readiness, routed intake and authenticated
`/app`/API responses; a build, screenshot or branch head alone is not deployment.
