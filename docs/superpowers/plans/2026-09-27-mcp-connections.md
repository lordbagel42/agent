# MCP connections implementation plan

**Goal:** Manage remote MCP connections through June's private dashboard, connect Slack's official MCP, and serve the dashboard at june.raygen.dev.

**Approved design:** Owner-managed HTTP connections, explicit tool selection, native Slack OAuth, and dashboard-only ingress. Connecting never automatically grants tools or external writes. No stdio execution or marketplace.

**Architecture:** A private SQLite connection store holds encrypted credentials, discovered tool contracts and explicit permissions. The existing MCP transport enforces contracts. A model wrapper exposes tools only in host-authenticated owner-private turns; reads feed one transient synthesis invocation, writes become exact dashboard approvals. Existing session and CSRF protections guard all configuration writes. Slack uses its fixed official endpoint and confidential user OAuth.

**Tech stack:** TypeScript, Node 24, Hono, MCP SDK, SQLite, existing Rivet workflow and private console; Pulumi/Consul/Cloudflare for ingress.

## Constraints

- Preserve existing conversation journals and no-retry external-effect semantics.
- Credentials stay encrypted outside Git and conversation storage. Never echo credentials or remote errors.
- Tool descriptions/results are untrusted. Pin reviewed contracts; changed contracts require fresh review.
- Use current GitHub main, preserve concurrent changes, format/lint/typecheck, focused safety tests and manual browser verification. Higher-effort review before push.
- Infrastructure scope is June only. Preserve Slack webhook routing and DNS TXT records; do not run legacy application provisioning.

## Tasks

- [x] Extend `src/tools/mcp.ts` to share bounded discovery with tool invocation and support public endpoints without credentials. Preserve all invocation protections.
- [x] Add `src/tools/connections.ts`: encrypted credential/configuration persistence, bounded discovery, per-tool denied/read/approval policy, contract revisions, durable single-use mutation intents, disconnect and model wrapper.
- [x] Add `src/tools/slack-mcp-oauth.ts`: fixed confidential user OAuth endpoints, one-use expiring owner-bound state, identity verification, safe token handling. No PKCE-setting mutation or inherited management tokens.
- [x] Add `src/console/connections.ts`, wire `src/http/app.ts`, navigation and `src/main.ts`/`src/config.ts`. Review forms bind current revisions and exact mutation arguments; additions cannot run tools.
- [x] Extend `src/core/contracts.ts`, `src/models/provider.ts` and `src/runtime/prompt.ts` for a private MCP directive. Wrap actual configured models without adding journal steps; stop after one tool and one synthesis call.
- [ ] In homelab infrastructure, adopt existing June CNAME, add dashboard-only ingress and coordinate the live console-origin change with June's controller. Inspect scoped preview before applying.
- [ ] Run existing MCP/broker/console/model/privacy checks, focused new authorization tests, manual discovery and approval failure probes; inspect desktop/mobile rendered connection pages.
- [ ] Obtain expert review, fix findings, format/lint/typecheck, publish current-main-compatible commits and verify actual running revision and HTTPS access. Report any remaining owner OAuth action honestly.

## Verification before publication

Oracle approved the security fixes and integration with current main. Formatter,
linter, types and 74 focused checks passed. Browser checks covered desktop/mobile
layout, persisted permission selection and successful exact-argument confirmation.
Owner-private model use and channel exclusion are exercised with a fixture MCP.
The broader runs exposed reflection and release-workflow polling timeouts; both
were reproduced on untouched corresponding main baselines. No unrelated fix was
included. Live routing/configuration and the owner's Slack consent remain rollout
steps, not evidence supplied by mock tests.
