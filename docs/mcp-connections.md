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

Cross-site callbacks land on a non-sensitive continuation page; click through
with the existing owner session, then confirm saving. State is volatile, bound
to the owner and connection generation, single-use and ten-minute limited.
Restarting June during consent requires beginning again. Keep callback query
strings out of access logs. The hostname must expose only the private dashboard,
not operator, health, Rivet or webhook routes; Slack's webhook keeps its separate
signed ingress. Cloudflare Access supplements, not replaces, June's owner login.
