# MCP connections

Open **Connections** in June's private dashboard. Add a trusted HTTPS Streamable
HTTP endpoint with an optional bearer token, or use **Connect Amp** or **Connect
Slack** for their official MCP servers. Other OAuth providers, stdio commands and
legacy SSE are not supported.

1. Add a connection, then **Test & discover tools**. Discovery runs no tools.
2. Review each complete tool contract. Every tool starts **Disabled**.
3. Grant read-only use only to tools you trust to be read-only. This is your
   classification, not a guarantee inferred from the server's annotations.
4. Use **Approval required** for effects. June proposes exact arguments and links
   to a ten-minute dashboard confirmation; confirmation executes at most once.
   Unknown outcomes must be inspected externally, never blindly retried.

June sees enabled tools, connection status and recent approval receipts in her
owner-private conversations. Ask her to use a named tool, or ask which connections
are available. She can call reads and propose effects, but cannot authorize tools
or obtain credentials herself. Channels and group DMs receive no private catalog.
Each turn performs at most one MCP call and one answer synthesis. Tool results
are untrusted evidence, not instructions. Raw results are not journaled, but the
synthesized answer becomes normal conversation history. The configured model
provider receives the transient result to produce that answer.

Ask June privately, “What permission does this tool have, and what does that
actually guarantee?” She can select the exact connection ID and tool name with
`mcpPermission: { connection, tool }` (empty text, other actions unset). The host
returns the saved permission, connection revision, contract digest and trust
boundary directly, even for disabled tools. This makes no network request,
creates no proposal or grant, and exposes no credentials, endpoint URL, arguments
or result bodies. Missing tools and disconnected connections remain unavailable.
The owner's read classification is trust, not independent proof of harmlessness
or a sandbox preventing the remote server from mutating data. Server annotations
are claims, not authority. Saved status does not establish current live health.

Failure replies distinguish unavailable connections/tools, denied authority,
host-rejected arguments, failed processing and unknown tool outcomes. The current
MCP adapter proves only `not_started` or `unknown`: preparation failures become
failed processing, while remote errors (including `isError`) stay unknown, not
proven rejections. Answer synthesis can fail after a tool returns. Replies use
fixed host text, never raw errors; no failure label establishes retry safety.

Ask June privately to inspect a proposal using its exact UUID. Her read-only
`mcpProposal: {action: "inspect", id: "<proposal UUID>"}` action returns bounded
recorded status, expiry, cancellation timestamp, grant ID and receipt metadata, including after a
disconnect. It never approves, executes or retries the tool, and does not return
arguments, destinations, credentials or result bodies. Unknown outcomes remain
unknown, not denial, rejection or success; a missing receipt is not proof of an
external outcome. Historical success is not a fresh check of the external state.
The host sends this metadata directly, without another model synthesis. Normal
private-turn and forgetting checks still govern delivery.

Ask June privately to inspect her MCP connections (`inspection: "mcp-connections"`).
This read works even with MCP disabled or no connections saved: those states are
disconnected, not healthy. The inventory contains at most 20 opaque display refs,
connection kind, saved-credential presence/expiry, past discovery outcome and tool
permission counts. It omits names, endpoint URLs, raw IDs and credential values.
Configuration, saved credentials and successful past discovery never prove current
availability or authorization; the read contacts no server and grants no access.
Inventory refs are not callable IDs; the separate approved `mcpCatalog` supplies
tool IDs and contracts. Reports are timestamped snapshots, not live monitors.

Contract changes disable the affected tool until reviewed again. Permission
changes, reconnects and disconnects invalidate pending approvals. Disconnect
removes June's saved authorization; revoke the grant at its provider separately
when needed. Credentials and stored contracts/arguments are encrypted on disk.
June and the dashboard label unexpired, unconsumed requests from an older connection
revision `invalidated`. Re-enabling a tool does not revive those confirmations.
Recorded execution outcomes remain historical receipts, including `unknown`;
changing one connection does not invalidate another connection's grants.

The authenticated owner command is `!mcp-cancel <proposal UUID>` as an ordinary
private message, not a Slack slash command. Cancellation persists even before approval: later confirmations,
including old dashboard forms and retries after restart, cannot grant or execute
that proposal. It does not disable the connection or cancel other proposals.
For granted work, cancellation revokes the existing broker grant and suppresses
dispatch if it wins the race before the MCP tool call. Once dispatched, it cannot
undo an effect or prove the remote operation stopped. The recorded outcome remains
separate (`unknown`, `succeeded`, or `failed`); never retry an unknown effect.
Repeating cancellation is safe and never creates a replacement operation.

## Reconcile an unknown receipt through June

First independently verify **both** that the previous worker has stopped and
that the exact external operation succeeded or failed. June's assertion, a
transport error, cancellation, or a stopped worker alone is not outcome evidence.
If the external result is still unknown, leave the receipt **unknown**; do not
retry it. In an authenticated owner-private message, send one of:

```text
!mcp-reconcile <exact proposal UUID> confirmed-stopped verified-succeeded
!mcp-reconcile <exact proposal UUID> confirmed-stopped verified-failed
```

Send this as ordinary message text, not a Slack slash command. Use the proposal
ID from June's recent approval receipts or its dashboard review
link, not a connection ID, grant ID, or prefix. These commands attest your own
independent checks; the host does not inspect the remote service for you. The
host maps that proposal to its saved grant and delegates to the existing broker.
An active local execution, an unstarted proposal, a known outcome, or incomplete
confirmation is rejected. This updates only the consumed receipt and revokes the
grant; it never invokes the tool or authorizes another execution. Model output,
forwarded/quoted/history text, worker results, guests and public messages cannot
reconcile. Slack quote/code blocks and WhatsApp forwarded messages cannot cancel
either; send a new plain message from the authenticated owner account.

## Ask June what enrollment still needs

In an owner-private turn, ask “What is missing before I can use MCP?” June can
return `{"text":"","inspection":"mcp-enrollment"}` without other actions,
even when MCP is disabled. The host sends a timestamped, credential-free
checklist using the bounded connection inventory, not a live server probe.
The full report is capped at 3,500 characters with explicit shown/omitted counts;
check Connections for omitted entries. Missing Slack in a truncated inventory
means unknown enrollment, not a reason to reconnect.

The checklist distinguishes missing host configuration, no saved enrollment,
expired authentication, untested connections, failed discovery, no discovered
tools, and missing owner tool consent. Slack app setup is separate from the
owner's user consent and final dashboard save. Browser-bound consent progress is
unknown to this inspection: check **Connections** for **Resume Slack setup**
before starting another sign-in. Slack setup is optional for other MCP servers.

For a remote server, no saved credential may be intentional public access; the
host cannot infer that server's authentication requirements. Failed discovery
does not prove an outage or distinguish rejected credentials from server failure.
Saved credentials, past successful discovery and saved permissions do not prove
current authorization or availability. Each connection's next step is guidance
for the owner, never authority for June to enroll, authenticate, discover, or
grant permissions. No endpoints, login URLs, credential values, connection names,
tool contracts or raw errors are returned. Public/guest turns and synthesis
cannot invoke the checklist.

## Host configuration

Enable the existing private console and add this optional configuration. The
`slack` block is needed only for Slack, not for Amp. Replace the example origin
and placeholder Slack IDs with your own verified deployment values:

```json
{
  "console": { "origin": "https://june.example.com" },
  "mcp": {
    "directory": "/var/lib/june/mcp",
    "keyEnv": "JUNE_MCP_KEY",
    "slack": {
      "clientIdEnv": "JUNE_SLACK_CLIENT_ID",
      "clientSecretEnv": "JUNE_SLACK_CLIENT_SECRET",
      "teamId": "T0000000000",
      "userId": "U0000000000",
      "scopes": ["search:read.public", "search:read.private", "search:read.im"]
    }
  }
}
```

Provision a random 32-byte base64 `JUNE_MCP_KEY` and, if using Slack, its app client
credentials through the private service environment. Preserve an existing MCP
key; do not replace it to add Amp. Never put secret values in config or Git.
The directory must be private, canonical, outside any Git repository, and writable
by June. Preserve the key and SQLite files together. Run **one active June process
per directory**; the approval coordinator is not a distributed service.

Slack uses your configured app and `https://mcp.slack.com/mcp`. Enable the app's MCP
setting and register exactly
`https://june.example.com/console/connections/slack/callback` for the example origin. This confidential
OAuth flow does not require enabling irreversible PKCE or token rotation. It
requires the configured owner's separate **user** consent; bot and management
tokens do not qualify. Only configured user scopes are requested. Other Slack
tools require their corresponding user scopes and a new consent. Expiring grants
currently require reconnecting; automatic refresh is not implemented.

After Slack returns, choose **Continue to save Slack connection**, then confirm
**Save Slack connection** with your owner session. Returning from Slack alone
does not save the authorization. Connections offers **Resume Slack setup** while
confirmation is pending and **Authorization saved** after verification and storage.
Then discover tools and review permissions; saving alone does not enable them.

State is volatile, bound to the owner and connection generation, single-use and
ten-minute limited. Restarting June during consent requires beginning again.
An explicit new sign-in replaces abandoned consent and invalidates its old
callback; it cannot replace an exchange already running. Keep callback query
strings out of access logs. The hostname must expose only the private dashboard,
not operator, health, Rivet or webhook routes; Slack's webhook keeps its separate
signed ingress. Cloudflare Access supplements, not replaces, June's owner login.

If the final save fails, ask June privately to show her logs (`latency: "logs"`)
or inspect the private service journal. New failures record
`slack_oauth.<stage>.<reason>` in the persistent diagnostic log, distinguishing
callback validation, token exchange, token/account/scope verification and saving.
Only fixed labels and allowlisted Slack error codes are retained, never callback
URLs, tokens, account IDs or raw provider errors. Unknown provider errors remain
`provider_rejected`; network/storage exceptions remain `operation_failed`.
These labels do not prove whether Slack issued a token or storage committed.
Check Connections before beginning a fresh sign-in; never replay a consumed
confirmation. Historical failures without diagnostics cannot be recovered.

## Amp consent and activation gates

Amp uses `https://ampcode.com/mcp`. `main.ts` mounts **Connect Amp** when MCP and an
HTTPS console origin are configured. It uses a dedicated authorization-code/S256
flow with public client metadata; no Amp client secret, `AMP_API_KEY`, copied CLI
login or native-coding configuration is required.

Keep these gates separate:

1. **Source/runtime:** the running release must include the console OAuth wiring,
   not just the standalone Puck connector. MCP needs its existing private store
   and encryption key. A source push or health response alone proves no Amp access.
2. **Ingress:** Amp must fetch exactly
   `https://june.example.com/console/connections/amp/client.json` for the example origin without an owner
   session or Cloudflare Access challenge. This static document contains only
   application metadata. Exempt only that exact path; keep the console private.
   The browser returns to `/console/connections/amp/callback` on the same configured
   origin. Keep callback query strings out of upstream logs. An ingress change
   requires separate operator authorization; publishing source does not apply it.
3. **Owner consent:** choose **Connect Amp**, authorize the intended Amp account,
   then **Continue to save Amp connection** and **Save Amp connection** with your
   June owner session. The callback alone stores no credential. June verifies the
   signed ID token's issuer, audience, expiry and nonce, and saves the verified
   account identifier and access token in the encrypted connection store. Check
   the account shown on the Amp detail page. Abandoned consent expires after ten
   minutes or a restart; **Resume Amp setup** continues a pending browser return.
4. **Tool consent:** **Test & discover tools**, review actual returned contracts,
   then enable selected reads or approval-required effects. Nothing is enabled
   automatically. Read authorization trusts the remote tool's behavior and may
   expose account-wide data; it does not limit that tool to June-created threads.
5. **June-facing verification:** in an owner-private conversation, ask June to
   inspect the enabled Amp catalog (`mcpCatalog` with connection `amp`), then use a
   reviewed read on a known fixture. Check the answer and remote result before
   declaring live access. Effects use the existing proposal, approval and receipt
   flow; June cannot approve her own requests. No remote tool names are assumed.

This first console flow requests only `openid`, not an offline refresh grant.
Expired access requires explicit reconnect; it is not unattended permanent access.
Reconnect replaces the saved account/token, clears tools and invalidates old
approvals. Disconnect removes the local credential; revoke provider consent
separately if needed. Consent does not enable native coding or replace its isolated
runtime and approval requirements.

## Coordinated configuration cutover

The deployment controller binds each immutable release to runtime configuration.
Do not edit config under its poll loop or rewrite a retained release marker.
For a new origin/MCP configuration, an authorized operator stops the idle
controller, holds its deployment lock and records durable transition intent.
Naturally drain and stop June before replacing live configuration, so automatic
restart cannot load old code with the new binding. Preserve the original config
and credentials in a root-only recovery directory, not conversation snapshots.

Prepare a fresh reviewed main revision under the final configuration, verify the
candidate binding equals the current host binding, activate it, and check both
health revision and MainPID working directory. Reconcile that exact revision only
after readiness and binding checks, then release the lock and resume the poller.
No prior release is relabeled. If activation is ambiguous, leave durable intent
and the controller stopped for forward recovery; never restore conversation data
or blindly repeat an external operation. Preserve any newly created MCP key and
store together. A busy drain must be explicitly resumed if abandoning cutover.
