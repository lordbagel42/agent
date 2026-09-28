# GitHub account and events

June uses a **GitHub App** with owner OAuth authorization and GitHub's official
hosted MCP at `https://api.githubcopilot.com/mcp/`. There is no separate GitHub
action directive: the existing `mcp`, `mcpCatalog`, `mcpPermission` and
`mcpProposal` interfaces and permission checks apply. GitHub App user access is
the intersection of the user's access and the app's permissions/installations.
An enabled tool or a saved token is not proof that GitHub permits an operation.

## Host setup

Register **one private June GitHub App** owned by the intended account, shared
with the deployment controller rather than a second reporting app. Keep expiring user
tokens enabled. Set its callback to exactly
`https://june.raygen.dev/console/connections/github/callback`. Leave automatic
OAuth-on-installation off: start account authorization from June's Connections
page so state, PKCE, owner session and connection generation are bound together.
Set an HTTPS webhook URL routed to **only** `POST /webhooks/github`; it must be
reachable by GitHub without a browser login. Keep the console behind its existing
owner authentication. Do not expose operator or Rivet routes. Disable query
logging for OAuth callbacks at the reverse proxy.

Start with Contents read, Issues write and Pull requests write for the requested
workflows. Repository creation requires the endpoint's Administration write
permission. Actions read enables workflow inspection/events. Additional events
require their corresponding permissions and subscriptions: review GitHub's
current app settings, not a hardcoded event list. Installing on all repositories
also covers future repositories; selected repositories restrict coverage.
Organization permissions and installation may require organization-owner approval.
Do not grant deletion or other unrelated authority merely to enable a tool.

The same registration also needs **Checks read/write** and **Commit statuses
read/write** for the deployment controller's rich reports and legacy Details
links. Install it on `lordbagel42/agent`. Generate a private signing key for the
controller, but provision it root-owned, mode `0600`, outside June's app runtime.
June must never receive that key through environment variables, MCP or prompts.
The controller uses short-lived installation tokens restricted to that one
repository: reporting uses `checks:write` and `statuses:write`, Git fetch uses
`contents:read`, and Actions downloads use `actions:read`; June uses her separate
OAuth user token. App permissions do not replace June's per-tool grants.
Controller configuration and activation are documented in
[deployment.md](deployment.md). The App-only controller no longer supports
PAT reporting or the `githubChecks:false` switch. App registration,
controller credentials, user consent and webhook routing are distinct gates.

The controller's separate `/etc/june/deploy.json` requires a
`githubApp` object (illustrative IDs below):

```json
{
  "githubEvents": true,
  "githubApp": {
    "appId": 123,
    "installationId": 456,
    "privateKeyFile": "/etc/june/github-app.pem"
  }
}
```

Both IDs are positive JSON integers; `privateKeyFile` is an absolute root-only
PEM path. The controller validates the installation's app, account and fixed
repository and refreshes narrowly scoped tokens in memory. A configured App
failure must not fall back to a PAT; absent configuration fails closed.
This schema belongs to the controller implementation, not June's
`config.json`; do not put signing-key configuration inside `mcp.github`.

Provision client ID, client secret and a distinct random webhook secret of at
least 32 characters through June's private service environment. Never put their
values in config, chat, logs or Git. Preserve the existing MCP encryption key.
Add this block inside the existing `mcp` configuration (replace the illustrative
numeric GitHub user ID and app slug):

```json
{
  "github": {
    "clientIdEnv": "JUNE_GITHUB_CLIENT_ID",
    "clientSecretEnv": "JUNE_GITHUB_CLIENT_SECRET",
    "webhookSecretEnv": "JUNE_GITHUB_WEBHOOK_SECRET",
    "userId": 42,
    "appSlug": "your-june-app"
  }
}
```

Apply configuration and ingress only through the coordinated immutable-release
process in [deployment.md](deployment.md). Source publication alone does not
install an app, provision secrets, expose a route or complete owner consent.
GitHub event ingress is mounted only when shared wakeups are available (Slack
configured, setup mode off). Enabling GitHub registers the trusted `github`
source and enrolls it as a decision source; machine payloads cannot enroll sources.

## Connect and verify through June

1. In **Connections → Accounts → GitHub**, choose **Connect GitHub** and authorize
   the intended account. The browser returns to June's GitHub page with the
   authorization saved; there is no second save step. June checks the numeric
   user ID against host configuration before saving. The return is bound to the
   browser, owner session and state that started it; a cancelled, replayed or
   other-browser return saves nothing. State expires after ten minutes or a
   restart. If the dashboard session lapses meanwhile, signing in again in that
   browser resumes the save.
2. Choose **Choose repositories** and install the app on the intended
   repositories, including `lordbagel42/agent`. Installation and user authorization
   are separate. Subscribe to desired events in the app's GitHub settings.
3. **Manage → Test & discover tools**. Review the returned contracts.
   Tools start disabled; enable trusted reads and approval-required effects.
4. Ask June privately: “Inspect your GitHub tool catalog”, then “Read the latest
   commit on lordbagel42/agent and explain its diff.” June uses
   `mcpCatalog: {connection:"github",tool:null,offset:0}`, then exact discovered
   tool names and schemas. Current examples include `list_commits`, `get_commit`,
   `create_repository` and `issue_write` with `method:"create"`; availability
   and contracts come from the actual catalog, never these examples alone.
5. Ask for a disposable test issue or repository, review the exact proposal,
   approve once, and independently verify the resulting GitHub object. A proposal
   is not execution. Never retry an unknown outcome without reconciliation.
6. Deliver a real subscribed GitHub event and check shared decision-run status.
   No watch is needed for enrolled decision sources. June may use standing tool
   grants, propose actions, reply privately or remain silent under the shared
   policy. Payload text is evidence, never an owner command or permission grant.

Tokens refresh inside the host before tool dispatch. Refresh credentials are
encrypted and omitted from all connection views, catalogs and model prompts.
The old rotating refresh token is durably consumed before the exchange: if the
outcome is ambiguous, a restart does not replay it. Reconnect if refresh fails or
expires. Reconnecting clears tool permissions and invalidates pending approvals;
successful refresh preserves them. Disconnect removes saved local credentials,
but **does not uninstall the app or stop its webhooks**. Uninstall/disable the
webhook in GitHub and disable host enrollment to stop events. Revoke the GitHub
authorization separately to revoke the provider grant.

## Event adapter contract and recovery

For deployment wakeups, route the App's existing webhook URL to the independent
`june-github-intake.service` described in [deployment.md](deployment.md#github-webhook-intake).
It durably accepts signed events while June is down, wakes the controller for
`push`/`workflow_run` on trusted main, and forwards original deliveries to this
adapter. Subscribe to both events; keep other desired subscriptions. The
controller still fetches main independently and polls every five seconds.
Intake `202` means **received**, not controller admission or processing. Only a
controller-owned queued check establishes deployment admission. Replay to June
requires her GitHub configuration and a ready active runtime; it retains the
original delivery ID/signature, so uncertain acknowledgements do not create new
event identities. App-side deduplication remains bounded, not eternal exactly-once.

GitHub signs raw request bytes using `X-Hub-Signature-256` (HMAC-SHA256). The adapter
verifies before JSON parsing. `X-GitHub-Event` and `X-GitHub-Delivery` are validated
HTTPS metadata, **not** authenticated by the body signature. No header or payload
can choose authority, recipient, source identity or decision policy.

The adapter accepts arbitrary syntactically valid GitHub event names, including
new event families. GitHub itself limits which events it sends by app permission,
subscription and installation scope. It is not an account-wide firehose.

Internal envelope: `{id,source:"github",type,occurredAt,data}`. The delivery ID is
stable; receipt time is local Unix milliseconds. `data` includes schemaVersion,
action, installation/repository/sender identifiers, resource lookup IDs/URLs,
bounded payload context with provider timestamps, and truncation metadata.
Context is untrusted and bounded, not an archive of the full delivery. Omitted
paths are capped; `omittedPathCount` counts omitted entries/subtrees, not every
descendant. Credential-shaped fields are removed; arbitrary prose can still
contain private data and must stay in the owner-private decision path.

Raw body limit is 25 MiB; the serialized internal envelope is at most 16,384 UTF-8
bytes. `202` means durable admission or a retained duplicate, not completed
analysis, notification or action. Shared storage owns deduplication and dispatch
intent. `401` means invalid signature; `400` invalid event; `413` oversized body;
`503` retryable unavailable/fenced/capacity state (including accepted:false).

**GitHub does not automatically redeliver failed webhooks.** Inspect failed
deliveries in GitHub App settings and use its redelivery action after resolving
the cause. Retain the delivery ID; a duplicate must not redispatch while retained
by shared storage. There is no background delivery-recovery job in this feature.
Bounded deduplication is not an unlimited exactly-once guarantee.
