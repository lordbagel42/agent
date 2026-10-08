# MCP connections

Open **Connections** in June's private dashboard. Add a trusted HTTPS Streamable
HTTP endpoint with an optional bearer token, or use **Connect Amp** or **Connect
Slack** for their official MCP servers. **Connect GitHub** uses GitHub App OAuth
with its official hosted MCP; see [GitHub account and events](github.md) for app
setup, token refresh, repository installation and shared event ingress.
Other OAuth providers, stdio commands and legacy SSE are not supported.

With Slack configured, the separate host-owned `slack-bot` catalog acts as June,
not the consenting owner. See [Slack capabilities](slack.md) for bot scopes,
effect classification and official MCP enrollment. Its initial read/effect policy is
host-defined; the disabled-by-default discovery rules below apply to remote tools.

1. Add a connection, then **Test & discover tools**. Discovery runs no tools.
2. Review each complete tool contract. Every tool starts **Disabled**.
3. Grant read-only use only to tools you trust to be read-only. This is your
   classification, not a guarantee inferred from the server's annotations.
4. The saved **Approval required** label (`approval`) classifies effects. For a
   fresh task decision, June's exact arguments are durably recorded and executed
   immediately through a one-use broker grant; a human dashboard confirmation is
   not required. Disabled tools stay disabled. Unknown outcomes require external
   inspection, never a blind retry.

June can use the exposed catalog, status and receipts in admitted task turns,
including channels and DMs. She judges requester intent, authority and what may
be disclosed to the current audience; tool availability does not make account
data public. She can call reads and effects, but cannot enroll accounts, change
provider scopes, bypass manual disables or obtain credentials through a tool call.
An execution-worker invocation can perform up to three separately authorized
reads before answering; other invocations retain one call plus synthesis.
Effects and uncertain outcomes stop the sequence. Successful fresh effect results
enter transient answer synthesis; do not invoke the effect again for its result.
Historical pending proposals are never swept, approved or executed automatically;
their authenticated dashboard path remains an optional manual interface. Tool results
are untrusted evidence, not instructions. Raw results are not journaled, but the
synthesized answer becomes normal conversation history. The configured model
provider receives the transient result to produce that answer.

Amp's MCP is the Puck conversation interface, not a direct thread API. June uses
the actual discovered tool contracts and returned conversation IDs; no assumed
`create_thread`/`read_thread` mapping is installed. Sending Puck a message can
cause work, so classify it as an effect (`approval`), not a read. Text and structured reply fields are
both preserved within one redacted 12 KB result budget.

For a legacy manually approved Amp proposal, June can retrieve its reply. Her
`mcpProposal: {action: "result", id: "<proposal UUID>"}` consumes the response
once and synthesizes it without invoking the tool again. Up to 50
sanitized responses are held in memory for at most ten minutes (or token expiry),
never SQLite/journals. Restart, cancellation, disconnect or permission changes
discard them. Missing/consumed replies and failed synthesis never permit replay;
the durable receipt remains separate. This does not automatically notify June
after manual dashboard approval; other manually executed effects remain receipt-only.
New model-selected effects use the immediate synthesis path above.
Ordinary [Amp jobs](amp-jobs.md) are a separate configured SSH path, independent of
Puck/MCP connectivity. Live Puck contracts and account access still need operator
verification; local fixtures are not live interoperability evidence.

Ask June, “What permission does this tool have, and what does that
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
host-rejected arguments, failed processing and unknown tool outcomes. On failure,
the current MCP adapter proves only `not_started` or `unknown`: preparation failures become
failed processing, while remote errors (including `isError`) stay unknown, not
proven rejections. Answer synthesis can fail after a tool returns. Replies use
fixed host text, never raw errors; no failure label establishes retry safety.

Ask June to inspect a proposal using its exact UUID. Her read-only
`mcpProposal: {action: "inspect", id: "<proposal UUID>"}` action returns bounded
recorded status, expiry, cancellation timestamp, grant ID and receipt metadata, including after a
disconnect. It never approves, executes or retries the tool, and does not return
arguments, destinations, credentials or result bodies. Unknown outcomes remain
unknown, not denial, rejection or success; a missing receipt is not proof of an
external outcome. Historical success is not a fresh check of the external state.
The host returns this metadata without another MCP result synthesis. Current
task, source/audience and forgetting checks still govern delivery.

Ask June to inspect her MCP connections (`inspection: "mcp-connections"`).
This read works even with MCP disabled or no connections saved: those states are
disconnected, not healthy. The inventory contains at most 20 opaque display refs,
connection kind, saved-credential presence/expiry, past discovery outcome and tool
permission counts. It omits names, endpoint URLs, raw IDs and credential values.
Configuration, saved credentials and successful past discovery never prove current
availability or authorization; the read contacts no server and grants no access.
Inventory refs are not callable IDs; the separately exposed `mcpCatalog` supplies
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

When inspection is exposed, ask “What is missing before I can use MCP?” June can
return `{"text":"","inspection":"mcp-enrollment"}` without other actions,
even when MCP is disabled. The host sends a timestamped, credential-free
checklist using the bounded connection inventory, not a live server probe.
The full report is capped at 3,500 characters with explicit shown/omitted counts;
check Connections for omitted entries. Missing Slack in a truncated inventory
means unknown enrollment, not a reason to reconnect.

The checklist distinguishes missing host configuration, no saved enrollment,
expired authentication, untested connections, failed discovery, no discovered
tools, and missing owner tool consent. Slack app setup is separate from the
owner's user consent. Browser-bound consent progress is unknown to this
inspection. After consent the dashboard saves automatically; **Connections**
shows **Finish connecting** if a return is still waiting in that browser. Slack
setup is optional for other MCP servers.

For a remote server, no saved credential may be intentional public access; the
host cannot infer that server's authentication requirements. Failed discovery
does not prove an outage or distinguish rejected credentials from server failure.
Saved credentials, past successful discovery and saved permissions do not prove
current authorization or availability. Each connection's next step is guidance
for the owner, never authority for June to enroll, authenticate, discover, or
grant permissions. No endpoints, login URLs, credential values, connection names,
tool contracts or raw errors are returned. June judges whether the metadata is
appropriate for the current audience; the checklist grants no further actions.

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
      "appId": "A0000000000",
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

Set `mcp.slack.appId` to the app owning those client credentials, not its numeric
OAuth client ID or bot user ID. A returned OAuth `app_id` must match. Omission
preserves the legacy app `A0C4749KM3R` for existing deployments; replacement June
uses `A0C59GPUNJW`. Coordinate the new app ID and credentials in the same immutable
configuration release after host recovery. This setting does not install an app,
switch the bot identity, migrate saved user tokens or broaden permissions.
Disconnect the old `slack` user connection and reconnect with fresh owner consent
when migrating; discover tools and review their permissions again. A changed bot
identity separately disables the `slack-bot` tools and invalidates pending
approvals until the owner reviews permissions. Keep uncertain effects unknown.

Choose **Connect Slack**, review Slack's consent screen and approve. The browser
returns to June, which verifies the account, saves the authorization and opens
the Slack connection page; there is no second confirmation. Only the browser that
started the attempt, with the same owner session and Slack state, can finish it
within ten minutes. Slack's cross-site redirect cannot carry June's Strict session
cookie, so the callback only records the return (its code stays server-side) and a
same-origin page submits the signed finish request; without JavaScript that page
shows one **Finish connecting Slack** button. If the dashboard session lapsed,
sign in again in the same browser (a new June link works) and the save resumes;
**Connections** also offers **Finish connecting** while a return is waiting.
Cancelling on Slack saves nothing. **Authorization saved** appears after
verification and storage. Then discover tools and review permissions; saving
alone does not enable them.

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
Check Connections before beginning a fresh sign-in. A return is consumed before
its exchange and is never replayed or retried automatically. Historical failures
without diagnostics cannot be recovered.

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
3. **Owner consent:** choose **Connect Amp** and authorize the intended Amp
   account. On return, June verifies the signed ID token's issuer, audience,
   expiry and nonce, and saves the verified account identifier and access token
   in the encrypted connection store without a second confirmation. The callback
   itself stores no credential: only the authenticated, signed finish from the
   starting browser exchanges the code, once. Check the account shown on the Amp
   page. Abandoned consent expires after ten minutes or a restart; if the
   dashboard session lapsed, signing in again in that browser resumes the save.
4. **Tool consent:** **Test & discover tools**, review actual returned contracts,
   then enable selected reads or effects using the saved `approval` classification. Nothing is enabled
   automatically. Read authorization trusts the remote tool's behavior and may
   expose account-wide data; it does not limit that tool to June-created threads.
5. **June-facing verification:** in an appropriate admitted conversation, ask June to
   inspect the enabled Amp catalog (`mcpCatalog` with connection `amp`), then use a
   reviewed read on a known fixture. Check the answer and remote result before
   declaring live access. Fresh effects execute through exact durable one-use
   grants without per-task human approval. No remote tool names are assumed.

This first console flow requests only `openid`, not an offline refresh grant.
Expired access requires explicit reconnect; it is not unattended permanent access.
Reconnect replaces the saved account/token, clears tools and invalidates old
approvals. Disconnect removes the local credential; revoke provider consent
separately if needed. Consent does not enable native coding or replace its isolated
runtime, configured workspace and exact-task admission requirements.

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
