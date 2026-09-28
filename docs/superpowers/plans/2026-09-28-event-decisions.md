# Event decisions implementation plan

**Goal:** Authenticated provider events wake June without a pre-created watch;
June decides whether to use standing-grant tools, notify Raygen, or stay silent.

**Architecture:** Extend the durable wakeup actor with host-managed decision
subscriptions. Keep notification watches backward compatible. Machine-origin
turns use the existing conversation journal, tool authorization and outbox,
without becoming human messages or granting owner-command authority.

**Tech stack:** TypeScript, Rivet actors/workflows, Hono, existing MCP broker.

## Contract and constraints

- Retain `publish(WakeupEvent): Promise<{accepted:boolean;duplicate:boolean}>`.
- Provider adapters own authentication and bounded normalization. The serialized
  envelope is at most 16,384 UTF-8 bytes. Payload text never supplies authority.
- `decisionSources` is a host-configured subset of connected `sources`.
- Decision subscriptions are automatic, discoverable and pauseable through
  June's existing wakeup management; notification-only watches remain explicit.
- Replies target the configured owner's private Slack destination, never a
  provider-supplied recipient. Tool calls retain existing standing-read versus
  exact-approval permission checks. No automated permission changes or approvals.
- Persist event deduplication and dispatch intent together. Bound pending work
  and reject overflow before recording acceptance. Do not retry uncertain effects.
- Deployment events include exact-revision metadata when present; do not attach
  another revision's commit title or imply historical health is current health.
- GitHub adapter/OAuth/HTTP integration belongs to the cooperating thread.
  Shared decision policy and generic ingress belong here. No deployment restarts.

## Implementation and verification

- [x] Add a failing real-actor test: an unwatched provider event produces a
  decision turn; duplicate delivery does not redispatch; owner commands remain
  unavailable while MCP and configured public search are available.
- [x] Extend `src/wakeups/state.ts` and `runtime.ts` with automatic decision
  subscriptions, bounded non-coalescing event admission, pause/inspect behavior,
  host-selected destination and deployment metadata enrichment.
- [x] Extend `src/runtime/prompt.ts` and `registry.ts` to distinguish decision
  wakeups from notification-only wakeups. Preserve old workflow replay behavior.
- [x] Wire decision source defaults in `src/main.ts`, and reject false acceptance
  in `src/wakeups/webhooks.ts`. Document source enrollment and redelivery semantics.
- [x] Run focused actor, state, webhook, prompt and recovery tests; exercise
  the June-facing create/list/pause/inspect workflow, tool use and silence.
- [x] Format, lint and typecheck; obtain Oracle review and address findings.

Publication and running-revision verification are reported separately in the
[implementation thread](https://ampcode.com/threads/T-01a0e6b5-ff12-75ce-9564-0ab288223378).
The memory-enabled regression uses the real Slack source converter: host routing
context is not indexed as an original Slack message, while actual recalled
evidence retains its deletion checks.

## Existing live evidence

Read-only inspection found a healthy older deployed revision, one completed timer,
no deployment watch, and an up-to-date deployment-feed cursor. This does not
establish why Raygen's requested watch failed to register. Do not claim that
the original production failure is fixed without reproducing that boundary.
