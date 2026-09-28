# MCP connections implementation plan

**Goal:** Manage remote MCP connections through June's private dashboard, connect Slack's official MCP, and serve the dashboard at an operator-configured origin such as `https://june.example.com`.

**Design:** Owner-managed HTTP connections, explicit tool selection, native Slack OAuth, and dashboard-only ingress. Connecting never automatically grants tools or external writes. No stdio execution or marketplace.

**Architecture:** A private SQLite connection store holds encrypted credentials, discovered tool contracts and explicit permissions. The existing MCP transport enforces contracts. A model wrapper exposes tools only in host-authenticated owner-private turns; reads feed one transient synthesis invocation, writes become exact dashboard approvals. Existing session and CSRF protections guard all configuration writes. Slack uses its fixed official endpoint and confidential user OAuth.

**Tech stack:** TypeScript, Node 24, Hono, MCP SDK, SQLite, existing Rivet workflow and private console; Pulumi/Consul/Cloudflare for ingress.

## Constraints

- Preserve existing conversation journals and no-retry external-effect semantics.
- Credentials stay encrypted outside Git and conversation storage. Never echo credentials or remote errors.
- Tool descriptions/results are untrusted. Pin reviewed contracts; changed contracts require fresh review.
- Use current GitHub main, preserve concurrent changes, format/lint/typecheck, focused safety tests and manual browser verification. Higher-effort review before push.
- Infrastructure changes require separate operator authorization. Preserve Slack webhook routing and unrelated DNS records; do not run legacy application provisioning.

## Tasks

- [x] Extend `src/tools/mcp.ts` to share bounded discovery with tool invocation and support public endpoints without credentials. Preserve all invocation protections.
- [x] Add `src/tools/connections.ts`: encrypted credential/configuration persistence, bounded discovery, per-tool denied/read/approval policy, contract revisions, durable single-use mutation intents, disconnect and model wrapper.
- [x] Add `src/tools/slack-mcp-oauth.ts`: fixed confidential user OAuth endpoints, one-use expiring owner-bound state, identity verification, safe token handling. No PKCE-setting mutation or inherited management tokens.
- [x] Add `src/console/connections.ts`, wire `src/http/app.ts`, navigation and `src/main.ts`/`src/config.ts`. Review forms bind current revisions and exact mutation arguments; additions cannot run tools.
- [x] Extend `src/core/contracts.ts`, `src/models/provider.ts` and `src/runtime/prompt.ts` for a private MCP directive. Wrap actual configured models without adding journal steps; stop after one tool and one synthesis call.
- [ ] Configure dashboard-only ingress and coordinate any console-origin change with the deployment controller. Inspect the scoped infrastructure preview before applying an authorized change.
- [ ] Run existing MCP/broker/console/model/privacy checks, focused new authorization tests, manual discovery and approval failure probes; inspect desktop/mobile rendered connection pages.
- [ ] Obtain expert review, fix findings, format/lint/typecheck, publish current-main-compatible commits and verify actual running revision and HTTPS access. Report any remaining owner OAuth action honestly.

## Verification boundary

This historical implementation checklist is not a current deployment attestation.
Check desktop/mobile layout, persisted tool selection, exact-argument confirmation,
owner-private model use and channel exclusion with a fixture MCP. Live routing,
configuration and the owner's Slack consent remain separate activation steps;
mock checks do not establish them. See the [connection guide](../../mcp-connections.md).
