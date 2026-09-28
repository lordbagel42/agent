# Slack capabilities

June has two distinct Slack identities. Never substitute one for the other to
work around denied access.

| Connection | Acts as | Authentication |
| --- | --- | --- |
| `slack-bot` | June | Existing host bot credential |
| `slack` | The consenting owner | Official Slack MCP user OAuth |

Both use the existing owner-private tool catalog and approval receipts. Public
channels and group conversations do not receive these catalogs. June's ordinary
channel replies and reactions remain separate and unchanged.

## Thread subscriptions

Owner channel messages containing the whole word “June” (case-insensitive) or a
direct @mention subscribe June to that thread, even when she chooses silence.
Threads she starts or posts in are also subscribed. Subscriptions persist across
restarts and let the owner follow up without another ping. Guest access, `##`
opt-outs, direct-mention requirements for group pings, and privacy boundaries
remain unchanged. A name reference does not count as a direct @mention.

June is instructed that subscribing, being named, or being pinged never obligates
her to reply. This uses the existing `message.channels` / `message.groups`
subscriptions and channel-history scopes; it adds no Slack permissions.

## Bot tools

When Slack and private MCP storage are configured, startup enrolls the fixed
host-owned bot catalog. Initial trusted reads are enabled and all mutations
require exact-argument owner approval. June cannot change permissions. Owner
disable/disconnect decisions survive restarts. Changed tool contracts are disabled
until reviewed again. Catalog registration does not establish live health or
installed scopes; every invocation verifies bot identity and, for org installs,
workspace assignment. Slack still enforces resource access and workspace policy.

To reconnect after explicitly disconnecting the bot, use the existing **Add
connection** form with URL `https://slack.com/api/`, a descriptive name and no
bearer token. This enrolls the host adapter, not a remote MCP endpoint. Replaying
an old Add submission cannot undo a later disconnect.

Ask June privately:

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

Slack supports one canvas change operation per call. Use
`canvases.sections.lookup` for section IDs before targeted replacements.
Whole-canvas replacement and deletion are destructive; do not infer consent from
a request to append. Canvas access and paid-plan restrictions still apply.

The allowlisted catalog covers pins, canvases and access, bookmarks, messages
(including edits/deletions, scheduling, ephemeral replies, streaming and unfurls),
reactions, conversations and membership, files, lists, users/profiles/presence,
custom emoji lookup, team information, DND lookup, user groups, call metadata and
Block Kit views. View methods require valid Slack interaction IDs where required;
these tools do not invent interactive event handling. Call methods manage metadata,
not audio/video. Admin APIs, token management, user-only methods, arbitrary HTTP
requests and automatic cross-identity fallbacks are deliberately excluded.

`files.uploadContent` combines Slack's upload allocation, binary transfer and
completion under one approval. Required `filename` and `content` are strings;
optional `encoding` is `utf8` (default) or canonical `base64`. Optional `title`,
`channel_id`, `initial_comment` and `thread_ts` are strings. Content is limited to
48 KiB decoded and the whole request must fit the broker's 64 KiB argument limit.
It accepts neither local paths nor source URLs. The upload goes only to Slack's
signed upload host, without the bot authorization header. Larger uploads and
automatic file downloads are not provided by this adapter.

API arguments use Slack's documented parameter names. Required parameters are
listed in each contract; Slack validates detailed optional fields. Follow cursors
explicitly. Responses are bounded and filtered by the same private-inspection and
credential rules as remote MCP. Mutations return an approval receipt, not their
raw response; use an authorized read to look up created resources afterward.
Uncertain mutations are never automatically retried, including partial uploads.
Thread-stop and group-ping rules still apply.

## Conversational Block Kit questions

June can return `question: {prompt, options}` with empty `text` and 2–5 distinct
option labels. In the verified owner's Slack DM the durable outbox renders a
Block Kit question with buttons. Other surfaces receive numbered plain text.
The owner can always type instead. Signed buttons expire after seven days;
the first button selection is deduplicated by the normal durable inbox and
becomes a conversational reply. It never confirms a protected tool action.
These conversational messages do not need a separate MCP mutation approval.

Enable Slack app **Interactivity & Shortcuts** with the same production
`/webhooks/slack` URL as event subscriptions. The manifest includes a template
setting; it must be applied to the real app before clicks work. The receiver
verifies Slack's signature and the signed button's owner, workspace and DM.
Arbitrary `chat.postMessage` blocks remain available through the bot catalog
under exact approval, but custom interactive controls are not automatically
wired into June's conversation.

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
confirmation. Then **Manage → Test & discover tools**. Review the discovered contracts
and enable trusted reads; keep writes approval-required. OAuth consent cannot be
completed by June, the bot credential or a management token. Existing official MCP
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

This does not activate WhatsApp or unsupported Slack MPIMs. The existing
Slack-only `activitySessions` gate is unchanged; cross-transport continuity is
available through the legacy lane, while both interaction lanes receive the
same privacy projection and runtime instructions. Existing destination history
and authorized long-term recall are separate from this recent-context window.
Idle expiry does not revoke durable jobs or delayed completion delivery.
Explicit restrictions, forgetting and CLEARHISTORY do invalidate work derived
from that context. Responses with volatile context ancestry stay in active
conversation history, but only their delivery receipts—not their text—enter
durable searchable archives until complete deletion ancestry can be represented.
