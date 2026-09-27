# MCP connections

Open **Connections** in June's private dashboard. Add a trusted HTTPS Streamable
HTTP endpoint with an optional bearer token, or use **Connect Slack** for Slack's
official MCP. Generic OAuth, stdio commands and legacy SSE are not supported.

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

Contract changes disable the affected tool until reviewed again. Permission
changes, reconnects and disconnects invalidate pending approvals. Disconnect
removes June's saved authorization; revoke the grant at its provider separately
when needed. Credentials and stored contracts/arguments are encrypted on disk.

## Host configuration

Enable the existing private console and add this optional configuration:

```json
{
  "console": { "origin": "https://june.raygen.dev" },
  "mcp": {
    "directory": "/var/lib/june/mcp",
    "keyEnv": "JUNE_MCP_KEY",
    "slack": {
      "clientIdEnv": "JUNE_SLACK_CLIENT_ID",
      "clientSecretEnv": "JUNE_SLACK_CLIENT_SECRET",
      "teamId": "T0266FRGM",
      "userId": "U08R4KDL6UF",
      "scopes": ["search:read.public", "search:read.private", "search:read.im"]
    }
  }
}
```

Provision a random 32-byte base64 `JUNE_MCP_KEY` and Slack app client credentials
through the private service environment. Never put their values in config or Git.
The directory must be private, canonical, outside any Git repository, and writable
by June. Preserve the key and SQLite files together. Run **one active June process
per directory**; the approval coordinator is not a distributed service.

Slack uses app `A0C4749KM3R` and `https://mcp.slack.com/mcp`. Enable the app's MCP
setting and register exactly
`https://june.raygen.dev/console/connections/slack/callback`. This confidential
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
