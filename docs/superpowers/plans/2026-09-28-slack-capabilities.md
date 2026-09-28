# Slack capabilities implementation plan

**Goal:** Give June broad bot API access and retain a distinct official Slack MCP user connection.

**Approved design:** Native actions run as June; official MCP runs as the consenting owner. Reuse the existing owner-private catalog, permission inspection, encrypted proposals and at-most-once approval receipts. Do not expose owner credentials or private tools in public channels. Slack scope grants and personal OAuth consent remain separate from code publication.

**Architecture:** Register a host-owned `slack-bot` connection backed by a fixed Slack Web API adapter, not an arbitrary HTTP proxy. Its curated catalog covers messaging, pins, canvases, files, lists, bookmarks, conversations, users and other bot-compatible surfaces. Trusted read classifications are fixed in code; mutations require exact-argument owner approval. Keep `slack` for the existing official remote MCP connection.

**Tech stack:** TypeScript, existing MCP contracts, CapabilityBroker, native fetch, Vitest.

## Constraints

- Start from current GitHub main; preserve concurrent work.
- Never silently use owner OAuth for a bot action, follow redirects with credentials, or retry uncertain mutations.
- Preserve owner disable/disconnect decisions across restarts and invalidate approvals on catalog changes.
- Do not claim installed scopes, OAuth enrollment or runtime activation from repository configuration.

## Execution

- [x] Add focused failing integration tests in `tests/slack-bot.test.ts`: discovery, read synthesis, pin proposal/confirmation, canvas edit, revocation, credential/endpoint isolation and unknown outcomes.
- [x] Implement `src/tools/slack-bot.ts` with fixed methods, scopes, required arguments, bounded responses and credential-free capability reporting. Reuse MCP result privacy filtering.
- [x] Extend `src/tools/connections.ts` and `src/main.ts` to enroll and dispatch the host adapter through existing June-facing catalog and approval paths; preserve disconnects and permissions.
- [x] Update additive requested scopes in `manifest.json` and document agent usage and official MCP consent in `docs/slack.md`.
- [ ] Inspect live app and enrollment readiness without printing credentials. Apply only authorized additive app changes; coordinate any deployment configuration mutation separately.
- [ ] Run formatter, lint, types, focused and broader tests. Obtain Oracle review, fix findings, rebase concurrent main changes, publish, and report actual live activation and consent state.

## Discriminating checks

The key wrong implementations would execute a pin during proposal, permit mutation through a read classification, send a bot credential to an arbitrary URL, resurrect a disconnected connection, or use owner authorization for a bot request. Tests must distinguish each case with an observable request/receipt or catalog result, not just successful construction. Representative canvas payloads use one append operation with markdown, not an empty placeholder.

## Block Kit extension and verification

The owner additionally requested multiple-choice conversational questions. These
use signed owner-DM buttons, normal durable inbox deduplication and numbered text
fallback. Clicks do not authorize protected operations. Runtime verification
covers model output, durable outbox, fallback and removal on forgetting.

Oracle reviewed the implementation and confirmed fixes for identity-bound bot
permissions and structured-question forgetting. After reconciling concurrent
main changes, formatter, lint, types, 134 Slack/model checks, 95 MCP checks and
the native question workflow pass. Before the rebase, all 40 conversation tests
passed in isolation. The broad suite was not green (24 failures); isolated memory
failures reproduced on the unchanged baseline. This is not full-suite signoff.

Live app changes, expanded configured OAuth scopes, owner consent and end-to-end
Slack activation remain outstanding. No Slack management login was available,
and Block Kit Builder redirected to sign-in, so no real Slack rendering or
live mutation was verified. Durable question rehydration across a process restart
and deletion racing delivery were reviewed but not separately exercised.

Concurrent activity-session routing was integrated as well: catalog projections
retain questions, activity outboxes render the fallback and owner-DM metadata,
and forgetting/invalidation remove structured question content. The regression
failed before the fix and passed afterward; all 25 session catalog, runtime and
integration checks passed. Oracle cleared this specific integration fix.
