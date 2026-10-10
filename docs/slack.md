# Slack capabilities

June has two distinct Slack identities. Never substitute one for the other to
work around denied access.

| Connection | Acts as | Authentication |
| --- | --- | --- |
| `slack-bot` | June | Existing host bot credential |
| `slack` | The consenting owner | Official Slack MCP user OAuth |

Both use the configured MCP catalog and durable execution receipts. Admitted
tasks can use exposed tools without an owner-private conversation or compulsory
human approval. June judges legitimacy, safety and disclosure to each audience;
tool access does not make private data public. Provider scopes, disabled tools,
login/consent and authenticated administration remain enforced. The public-web
research specialist retains its explicit read-only ceiling. June's ordinary
channel replies and reactions remain separate.

## Agent messaging experience

The manifest enables `features.agent_view`, Slack's Agent messaging experience,
with the writable Messages tab and `assistant:write` bot scope. June remains a
Slack app/bot identity, not a human account; agent classification does not bypass
workspace policy or force a conversation into a user's personal sidebar.

Apply these additions to a fresh live manifest, preserving OAuth redirects, MCP
settings, event subscriptions and production URLs. Complete any Slack installation
update/approval to grant `assistant:write`, then hard-refresh Slack. Workspace/org
admins may also need to allow agent display. Switching from the older
`assistant_view` to `agent_view` is irreversible; do not enable the legacy view.

Ordinary and threaded DMs continue through `message.im`; no new ingress handler
is needed. Existing `assistant.threads.setStatus` calls are supported by Slack's
compatibility bridge. Unthreaded messages retain reaction-based thinking status
and do not create a thread merely to show status. June does not subscribe to
`app_home_opened` (Slack recommends it for welcome messages), because opening a DM
should not trigger an unsolicited message. There is no native agent stop-button
subscription; existing text stop controls remain unchanged.

See Slack's [manifest reference](https://docs.slack.dev/reference/app-manifest/#features)
and [Agent messaging migration guide](https://docs.slack.dev/ai/migrating-to-agent-messaging/).

## Thread subscriptions

Owner channel messages containing the whole word “June” (case-insensitive) or a
direct @mention subscribe June to that thread, even when she chooses silence.
Threads she starts or posts in are also subscribed. Subscriptions persist across
restarts and let every participant follow up without another ping. Guests remain
in separate guest queues and receive the same bounded same-conversation context
as guest pings when context is enabled, never automatically injected owner-private
history. Unrelated threads and unmentioned top-level guest messages are not
admitted by a subscription. `##` opt-outs, direct-mention requirements for
group pings, and privacy boundaries remain unchanged. A name reference does not
count as a direct @mention. Previously ignored messages are not replayed.

Outside group DMs, subscribing, being named, or being pinged does not obligate
June to reply. This uses the existing `message.channels` / `message.groups`
subscriptions and channel-history scopes; it adds no Slack permissions.

## Group DMs

Group DMs (`mpim`) use the existing signed HTTP webhook, not Socket Mode.
Subscribe the live app to `message.mpim` with `mpim:history` and `mpim:read`;
the checked-in manifest alone does not enable delivery. June accepts ordinary
messages from every participant without a ping or name reference. Guests remain
in separate guest queues with host-bound task scopes. June is instructed to
reply to each ordinary group-DM message, especially one naming her; a brief
acknowledgment or follow-up is enough. Multipart messages may still be answered
together. Explicit wait/stop requests, `##` and `<>` opt-outs, group-ping silence
rules, self-message suppression and repetitive bot-loop prevention take precedence.
Plain `DEBUG`/`DEBUGSHARE` and other recognized host commands keep their existing
command path; this policy does not add acknowledgments to commands, worker
completions or automated notifications.

These are shared conversations, not owner-private DMs. Replies and bounded
same-conversation/thread context use the normal conversation path. Ordinary
tools are not withheld merely because the audience is shared. Private histories
and owner memory are not automatically injected; deliberate retrieval and any
disclosure must respect source and audience boundaries. Cross-conversation
continuity is withheld, and tool access does not enroll new memory-retention scopes.
Enabling the subscription does not replay messages sent before it was enabled.

## Bot tools

When Slack and private MCP storage are configured, startup enrolls the fixed
host-owned bot catalog. Reads default to `read`; mutations retain the policy name
`approval` but fresh June-selected actions execute immediately with exact-argument
grants and receipts. June's ordinary tool calls cannot change permissions. Saved
disable/disconnect decisions survive restarts and contract changes, including
older disables with unknown reasons. New or changed non-disabled bot contracts
use the catalog defaults; a changed bot identity disables its tools. Catalog
revision changes invalidate stale grants and proposals, never execute them.
Catalog registration does not establish live health or installed scopes; every
invocation verifies bot identity and, for org installs, workspace assignment.
Slack still enforces resource access and workspace policy.

To reconnect after explicitly disconnecting the bot, use the existing **Add
connection** form with URL `https://slack.com/api/`, a descriptive name and no
bearer token. This enrolls the host adapter, not a remote MCP endpoint. Replaying
an old Add submission cannot undo a later disconnect.

Ask June in an admitted conversation:

- “What Slack bot tools do you have?”
- “Check whether you have permission to pin messages.”
- “Pin this message as June: [message link].”
- “Append this paragraph to canvas F… as June.”
- “Upload this small text file to C… as June.”

June can discover contracts with
`mcpCatalog: {connection: "slack-bot", tool: null, offset: 0}` and follow
`nextOffset`. Inspect an exact tool by setting `tool` to its name. Call with
`mcp: {connection: "slack-bot", tool: "slack.capabilities", argumentsJson: "{\"method\":\"pins.add\"}"}`.
Omit `method` to inspect granted scopes only. This is read-only, not permission
granting. Missing scope alternatives depend on resource type; they do not mean
every alternative must be granted.

Example API arguments:

```json
{"channel":"C123","timestamp":"1234567890.123456"}
```

Use these with `pins.add` or `pins.remove`. For `canvases.edit`:

```json
{
  "canvas_id": "F123",
  "changes": [{
    "operation": "insert_at_end",
    "document_content": {"type": "markdown", "markdown": "## Update\nReady for review."}
  }]
}
```

Read an existing canvas with `canvases.getContent` and
`{"canvas_id":"F123","content_type":"markdown"}` before editing its contents.
This needs `canvases:read` and the bot's access to that canvas; read results are
bounded, so truncation must not be mistaken for the entire document. Slack
supports one canvas change operation per call. Use `canvases.sections.lookup`
for section IDs before targeted replacements.
Whole-canvas replacement and deletion are destructive; do not infer consent from
a request to append. Canvas access and paid-plan restrictions still apply.

The allowlisted catalog covers pins, canvases and access, bookmarks, messages
(including edits/deletions, scheduling, ephemeral replies and streaming),
reactions, conversations and membership, files, lists, users/profiles/presence,
custom emoji lookup, team information, DND lookup, user groups, call metadata and
Block Kit views. View methods require valid Slack interaction IDs where required;
these tools do not invent interactive event handling. Call methods manage metadata,
not audio/video. Admin APIs, token management, user-only methods, arbitrary HTTP
requests and automatic cross-identity fallbacks are deliberately excluded.
Custom `chat.unfurl` is also excluded: never request `links:write`.

`files.uploadContent` combines Slack's upload allocation, binary transfer and
completion under one exact grant and receipt. Required `filename` and `content`
are strings;
optional `encoding` is `utf8` (default) or canonical `base64`. Optional `title`,
`channel_id`, `initial_comment` and `thread_ts` are strings. Content is limited to
48 KiB decoded and the whole request must fit the broker's 64 KiB argument limit.
It accepts neither local paths nor source URLs. The upload goes only to Slack's
signed upload host, without the bot authorization header. Larger uploads and
automatic file downloads are not provided by this adapter.

API arguments use Slack's documented parameter names. Required parameters are
listed in each contract; Slack validates detailed optional fields. Follow cursors
explicitly. Responses are bounded and filtered by the same private-inspection and
credential rules as remote MCP. Mutations return an execution receipt, not their
raw response; use an authorized read to look up created resources afterward.
Uncertain mutations are never automatically retried, including partial uploads.
Thread-stop and group-ping rules still apply.

### Verify through June, not just the manifest

Ask June to check `slack.capabilities` for `pins.add` and `canvases.edit` in an
admitted task. Her interaction agent delegates to an authorized execution worker;
a missing direct interaction tool is not missing support.
The checks need `pins:write` and `canvases:write` respectively. Missing scopes
require a separately authorized installation update, not merely a manifest edit.
Disabled catalog tools require owner review in Connections, not a new Slack scope.

For a live test, choose a disposable message and canvas the bot can access. Ask
June to perform the exact pin or append, inspect its receipt, and verify with
`pins.list` or `canvases.getContent`. No separate approval step is required.
A prepared proposal, cached connection or local mock test does not prove success.
Slack error responses and lost write responses conservatively remain `unknown`;
inspect the external state before considering another action. No automatic
background test or retry runs, and legacy dashboard approval does not automatically
notify June. Channel/group-DM requests use the same configured catalog, with
audience-appropriate results. Host-enrolled event decisions can use enabled reads
and fresh effects; notification-only wakeups cannot. Event content is untrusted
evidence, not authority to bypass configuration or safety checks.

## Direct outreach and history delivery

`social.post` and `social.outreach` send through durable delivery receipts after
June judges the task and recipient. `request_access` is obsolete: it creates no
request, notification, permission or shared-context change. Candidate-linked
`interruption_proposal` is an optional inert draft, not an outreach prerequisite;
historical drafts never automatically become fresh sends. Unknown sends are not
retried automatically.

`slackHistory` reads bounded pages of conversations accessible to June's bot.
Raw contents go directly to the verified **requester's** Slack DM, not the owner
by default, the invoking shared thread or the model. The host verifies bot/workspace
identity and rechecks the existing destination DM after reading. June must
judge whether sharing the selected source with that requester is legitimate;
bot access alone is not recipient consent. No attachments, deleted messages or
expired history are recovered, and receipt success is not proof of complete history.

## Conversational Block Kit questions

June can return `question: {prompt, options}` with empty `text` and 2–5 distinct
option labels. The durable outbox renders requester-bound Block Kit buttons in
Slack DMs, channels and group DMs, regardless of owner identity. Other transports
and legacy outbox messages without requester metadata use numbered plain text.
The requester can always type instead. Signed buttons expire after seven days;
the first button selection is deduplicated by the normal durable inbox and
becomes a conversational reply, never an authentication or credential grant.
June judges the resulting request at runtime; no separate MCP approval is needed.

Enable Slack app **Interactivity & Shortcuts** with the same production
`/webhooks/slack` URL as event subscriptions. The manifest includes a template
setting; it must be applied to the real app before clicks work. The receiver
verifies Slack's signature and the signed button's requester, workspace and
conversation, preserving the selected thread and actual channel type. Another
participant cannot answer on the requester's behalf.
Arbitrary `chat.postMessage` blocks remain available through the bot catalog
under exact grants and receipts, but custom interactive controls are not
automatically wired into June's conversation.

## Install scopes and connect official MCP

`manifest.json` requests bot scopes for the catalog and user scopes for the
[official MCP tools](https://docs.slack.dev/ai/slack-mcp-server/). It is a template,
not proof of installation. An authorized app manager must merge scope additions
into a freshly exported live manifest, preserving redirects, MCP settings,
subscriptions and unrelated configuration, then complete Slack's installation
update/approval. Do not overwrite a live app with the template's example URL.

For official MCP, enable the app's MCP setting, register
`${console.origin}/console/connections/slack/callback`, and configure
`mcp.slack.scopes` with the desired **user** scopes from the manifest. Follow the
deployment procedure for immutable-release configuration changes; never mutate
configuration concurrently with activation. A broader app manifest does not
automatically broaden the configured OAuth request or an existing grant.

The owner must complete **Connections → Connect Slack → Slack consent**; the
dashboard saves the authorization automatically on return, with no second
confirmation. Then **Manage → Test & discover tools**. Review the contracts and
their safety classifications. New remote contracts default to `approval`
(fresh effects execute immediately); explicitly reviewed reads can use `read`.
Saved disabled tools stay disabled. OAuth consent cannot be completed by June,
the bot credential or a management token. Existing official MCP
enrollment remains in use; no second OAuth implementation or Amp-account MCP
connection is needed. Expiring grants require reconnecting.

See [MCP connections](mcp-connections.md) for permission inspection, cancellation
and reconciliation. Do not claim activation until the installed bot scopes,
saved user authorization, enabled tools, loaded revision and June-facing workflow
have each been verified.

## Recent conversation continuity

Thread context now includes a bounded page from its parent channel as well as
the thread, retaining the actual origin of each message. It never falls back to
an owner DM, reads file contents, or imports replies from unrelated threads.

Optional `continuity` configuration selects a separate API-key JSON model using
the same fields as `reflection.model`, plus `idleMs` (default three hours).
It requires configured private memory storage, `JUNE_ALLOW_MEMORY=1` and
`JUNE_ALLOW_MEMORY_MODELS=1`. No live configuration is enabled by this change.
The selected provider receives private working context for censorship; review
that provider's privacy/retention policy before enabling it.

The encrypted `continuity.sqlite` working buffer follows the verified owner
across locations. It retains at most 80 messages / 32,000 JSON characters, with
4,000 characters per message, not unlimited history. Human inactivity rotates
it; assistant output and webhook retries do not extend it. CLEARHISTORY and any
memory deletion revision invalidate the buffer and in-flight derived replies.
The buffer is separate from durable archives and tool/worker permission scopes.

Verified owner Slack DMs and linked owner WhatsApp conversations can receive
uncensored ordinary context. Shared destinations receive only exact excerpts
approved by a separate tool-free privacy model. That model is told explicitly
that relationship memory is immature: it must not infer trust from friendliness,
names or self-assertions. For now even small private groups get only public-safe
material. Slack audience checks use authenticated channel info and complete,
bounded member enumeration for private channels, rechecked after filtering.
Unknown audiences, incomplete enumeration, invalid output and filter failures
import nothing. Interrupted filter attempts are not automatically repeated for
the same turn/audience. At 100 filter attempts in one activity window, further
shared-context imports are withheld instead of evicting spent receipts. Cached
excerpts share the working-context budget. Common secrets and explicit non-disclosure trigger a
conservative private-only interval; pattern checks and model judgment are not a
formal guarantee against every possible disclosure.

This does not activate WhatsApp or cross-conversation continuity in Slack MPIMs. The existing
Slack-only `activitySessions` gate is unchanged; cross-transport continuity is
available through the legacy lane, while both interaction lanes receive the
same privacy projection and runtime instructions. Existing destination history
and authorized long-term recall are separate from this recent-context window.
Idle expiry does not revoke durable jobs or delayed completion delivery.
Explicit restrictions, forgetting and CLEARHISTORY do invalidate work derived
from that context. Responses with volatile context ancestry stay in active
conversation history, but only their delivery receipts—not their text—enter
durable searchable archives until complete deletion ancestry can be represented.
