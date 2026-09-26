# June: Rivet messaging foundation implementation plan

Goal: deliver the first runnable, self-hostable increment of the approved agent
architecture. The initial increment implemented WhatsApp and Slack. The owner
subsequently shelved WhatsApp; Slack is the active rollout, with Linq being
evaluated for Android/RCS messaging instead.

Spec: [architecture.md](architecture.md).

## Constraints

- TypeScript, Node 24, pnpm. No changes to shared runner services.
- Keep messaging/model/coding interfaces independent of Rivet.
- Authenticate webhook bytes before parsing; ignore unknown identities and bots.
- Persist ingress before acknowledging; serialize conversation turns.
- Never silently retry an externally ambiguous send or coding launch.
- Keep engine/operator endpoints private; never log credentials or message bodies.
- Native Amp access is explicitly opt-in and is not advertised as sandboxed.
- Follow the current minimal-testing policy in `AGENTS.md`: new tests only for
  core permission, privacy, or duplicate-effect invariants. Keep existing tests;
  run formatter, linter, typechecker, and relevant combined checks before commits.
  No push authorization. The owner previously authorized a scoped
  `pulumi-homelab` deployment, ChatGPT browser sign-in, Slack installation, a hello
  DM, live messaging checks, and search permission requests. Do not repeat sends.

## LEGION integration board (2026-09-26)

Parallel worktrees start from local checkpoint
`ba4c19725e2834ab379d9cd962a741fc68655e96`, not `origin/main`. The integration
checkout is `/home/raygen/Projects/agent`. No worker pushes or deploys independently.
Module presence is not completion: each stream needs review, host wiring, and
combined verification. Thread links below identify the sole write owner.

| Stream | Write ownership | State |
| --- | --- | --- |
| [Integration](https://ampcode.com/threads/T-01a0dd16-aab2-70fe-8983-280847bfa35e) | `main`, `config`, `core/*`, `http/app*`, `runtime/registry*`, `runtime/delivery*`, integration tests, root dependencies/config examples, aggregate docs | Shared wiring underway; initial 153 combined focused checks pass |
| [Slack ingress](https://ampcode.com/threads/T-01a0dd2a-9ad5-77c9-999f-d0b7ef1d453f) | `channels/slack.ts`, existing test, diagnostics | Integrated with private HTTP snapshots and lengthless-body correlation; not deployed; real DM ingress unproven |
| [Memory/personality](https://ampcode.com/threads/T-01a0dd2a-af57-72dd-bb92-2eb528286788) | `memory/*`, `reflection/personality*` | Reviewed and picked, including canonical Slack coverage; host wiring underway |
| [History imports](https://ampcode.com/threads/T-01a0dd31-0586-772f-a9a6-88e9ba842430) | `imports/*` | Baseline picked; shared Slack source builder and Gmail attachment-subtree fix pending |
| [Credentials/capabilities](https://ampcode.com/threads/T-01a0dd2a-c5b2-77c8-a444-1c5ab53831ef) | `tools/broker*`, `credentials/*`, separate capability routes | Fix for mutable registration after async credential lookup ready for review |
| [MCP](https://ampcode.com/threads/T-01a0dd2a-e9d9-749e-9f33-8666be803fe3) | `tools/mcp*` | Review reproduced async-schema bypass and premature cleanup; fixes required |
| [Browser](https://ampcode.com/threads/T-01a0dd2b-02ff-74bd-b545-25b4363c4c0d) | `tools/browser*` | Post-cancellation dispatch race fixed; awaiting combined integration |
| [Console/action links](https://ampcode.com/threads/T-01a0dd31-16b9-7100-a38a-163623e5e477) | `links/*`, separate console/router modules | Private session/form and immutable review checks under review |
| [Reflection workflow](https://ampcode.com/threads/T-01a0dd31-2c8d-7109-9b5b-18124d8442ee) | `reflection/domain*`, `runtime/reflection*` | Completed draft undergoing final review/commit; no outbound messages |
| [Typed deliberation](https://ampcode.com/threads/T-01a0dd31-3cef-724e-a440-170cc39bb6b7) | `reflection/evaluator*`, `models/decision*` | Reviewed and picked; raw provider settlement verified offline |
| [Coding supervisor](https://ampcode.com/threads/T-01a0dd31-52de-76f8-b656-9f40042f677c) | `runtime/coding*`, `coding/worktree*`, recovery worker fixture | Picked; combined hard-kill test passes; shared config/cancel wiring pending |
| [Codex worker](https://ampcode.com/threads/T-01a0dd31-6b3b-702e-943a-d6356e6edcf6) | `coding/codex*` | Supported app-server runtime and shutdown checks |
| [Claude worker](https://ampcode.com/threads/T-01a0dd31-82b1-7609-93dc-cfb3d08e93b2) | `coding/claude*` | Supported API-key SDK; tools denied by default |
| [Pi worker](https://ampcode.com/threads/T-01a0dd31-96dd-713d-b94d-0da3ac0e19d3) | `coding/pi*` | Operator-pinned RPC runtime; host sandbox prerequisite |
| [Private Slack RTS](https://ampcode.com/threads/T-01a0dd31-a8af-758c-ac80-5ec5bbb7f365) | `channels/slack-search*` | One-use volatile result contract agreed; actual user OAuth grant required |
| [Rivet reliability](https://ampcode.com/threads/T-01a0dd31-bb56-71ce-a99e-d74eb241a7ca) | Disposable reproductions only | Sleep/wake/alarm investigation; no dependency upgrade presumed safe |
| [Jev observations](https://ampcode.com/threads/T-01a0dd31-dbeb-745e-8c65-43a123126cda) | `models/jev*` | Separate typed observations, not fabricated rationale/citations |
| [Release supervisor](https://ampcode.com/threads/T-01a0dd31-ef99-7488-a4ad-f31b4ddd72da) | `deployment/*` | Independent artifact/verification authority; no activation in June process |

Shared host boundaries:

- Audience/scope comes from authenticated `routeEvent`: the canonical value is
  `JSON.stringify(scope.key)`. Owner-only APIs use the configured owner, not a
  request-provided principal. Imported data cannot create live inbox commands.
- Features remain absent/disabled by default. Config names secret environment
  variables; actual credentials remain in trusted adapters, never model context.
- Preserve existing `conversation-v1` journal names and send intents. Introduce
  `loop.getVersion("memory-dispatch", 2)` before queue receive; only new-version
  iterations gain new steps. Persist optional dispatch choices inside steps.
- Memory retrieval filters audience before matching and is bounded. Revalidate
  deletion before reflection output or personality can influence a new prompt.
  Search snippets and action tokens remain volatile and outside evidence stores.
- New routes share private operator authentication and body limits; browser forms
  also require exact origin and signed confirmation. No public inspector/console.
- Integration owns module shutdown ordering, dependency pins, recovery checks,
  deployment review, and activation. Known Rivet shutdown diagnostics remain a
  limitation, not evidence of hardened production behavior.

## Work and ownership

- [x] Tooling and shared contracts: parent owns root configuration and
  `src/core/contracts.ts`.
- [x] Slack adapter: parallel worker owns `src/channels/slack.ts` and its tests.
  Verify timestamped HMAC, parse DMs/mentions/reactions, send text/reactions,
  distinguish rejected requests from unknown outcomes.
- [x] WhatsApp adapter: parallel worker owns `src/channels/whatsapp.ts` and its
  tests. Verify challenge/HMAC/account binding, parse batched messages, reactions
  and receipts, enforce service window, send text/reactions.
- [x] Domain and model providers: parent owns owner/scope resolution, validated
  configuration, provider-specific wire formats, and their tests.
- [x] Rivet host: parent owns persistent workflow queues, conversation history,
  deduplication, outbox, private operator endpoints, and runtime integration tests.
- [x] Coding supervisor: parent owns separate job actor and Amp runtime adapter,
  opt-in execution, thread continuity, uncertain-run handling, and tests.
- [x] Integration: signed webhook fixtures through the real HTTP application,
  cross-channel continuity, scope isolation, duplicate delivery, restart/crash
  recovery, and fail-closed auth tests.
- [x] Documentation and final review: exact local startup/configuration steps,
  platform setup instructions, limitations, formatting, lint, types, and tests.

## Parallel interface agreement

Both channel workers consume `src/core/contracts.ts`; neither changes it or root
configuration. Both export a factory taking credentials, optional `fetch`, and
optional `now` for deterministic protocol tests. Factories return `ChannelAdapter`.
The parent owns ingress routing, identity authorization, and durable submission.
Adapters own signature validation, platform event semantics, and outbound API
serialization. Review both returned diffs before integration.

## Test targets

- Modified signed body and replayed Slack timestamp fail before dispatch.
- App mention stays in its thread; bot output cannot loop back into inference.
- One WhatsApp webhook containing multiple user messages preserves them all.
- At the 24-hour boundary, WhatsApp rejects free-form outbound messages locally.
- A sender from a different workspace/account cannot impersonate the owner.
- Two linked DMs share history, but a public Slack thread cannot access it.
- Duplicate webhook delivery produces one logical reply; a send interrupted after
  acceptance becomes unknown, never an automatic second send.
- An application and engine restart retains accepted events; a hard-killed host
  recovers unfinished sends and jobs without blindly repeating external effects.
- An Amp job has its own context and survives reconnection by stored thread ID;
  a result is clearly labeled as reported, not independently verified.

## Decisions

- Use one package with explicit module directories initially, rather than empty
  workspace packages. Extract packages when there are real independent consumers.
- Keep the existing WhatsApp adapter dormant and remove it from startup examples.
  Evaluate Linq Partner API V3 separately; do not connect an experimental adapter
  to live accounts or mistake fixture checks for Android/RCS verification.
- No browser/UI work in this increment; it is a headless messaging foundation.

## Production hardening and later integrations

- [ ] Resolve/characterize Rivet's native `transaction_closed` shutdown/alarm
  errors; soak-test idle sleep/wake, durable timers, and prolonged outages.
- [x] Complete an isolated Linq text/webhook feasibility spike and re-run its
  51 fixture tests, strict TypeScript, and lint. No production adapter was added.
- [ ] Confirm a Linq account/line, carrier capabilities, plan, and use eligibility
  before implementing durable integration and testing on the owner's Android phone.
- [x] Run a scoped Slack end-to-end check with configured platform/model accounts.
  One labeled synthetic operator event traversed the signed public webhook,
  durable inbox, real Codex inference, and Slack delivery; bot authorship/text and
  a native reaction were read back. This is not a human-originated inbound test.
  Automated tests still use controlled model/send/coding fixtures.
- [ ] Isolate native coding, credentials, and the deployment supervisor. A worker
  prompt and cwd allowlist do not enforce host permissions.
- [ ] Add retention/deletion, encryption, backup/restore, journal/state migration
  tests, and resource limits before sensitive historical imports.

## Private homelab setup deployment

- [x] Add the pinned official Codex CLI adapter, keeping inference separate from
  Amp jobs and using a dedicated credential directory. Browser OAuth callback
  only; no device-code login or imported sessions.
- [x] Test explicit channel-free setup mode, with coding disabled and operator
  authentication still required. No dummy Slack or WhatsApp account credentials.
- [x] Add `lxcs/june` in an isolated `pulumi-homelab` worktree, inspect targeted
  previews, and provision protected unprivileged LXC 215 on optiplex.
- [x] Enroll the SSH host key through the Proxmox console, install the reviewed
  source archive, and start the private systemd service on port 3080.
- [x] Complete the owner's browser sign-in and verify real model inference.
  The deployed Codex adapter returned a validated structured reply from
  `gpt-6-astra` under the service's systemd restrictions on 2026-09-26.
- [x] Configure June's actual Slack bot and owner identity; route only POST to
  `june-slack.bagelindustries.com/webhooks/slack`. Verify a signed challenge, reject
  unsigned POST, and keep GET, health, operator, and engine routes private.
- [x] Deploy conversational text/reaction/both/silence behavior, with no forced
  acknowledgment text and truthful delivery history.
- [x] Implement optional public-message RTS transport and model/runtime dispatch.
  Keep action tokens volatile and single-use; never journal search content or
  send it into model context. The transport is deployed but disabled; runtime
  dispatch is tested locally and awaits deployment.
- [x] Sync the app manifest requesting bot `search:read.public` and user
  `search:read.public`, `search:read.private`, and `search:read.im`; submit the
  updated app for admin approval (request `Ar0C5H1FS5MW`, 2026-09-26).
- [ ] Complete approval/reinstallation, verify actual granted search scopes, and
  activate public RTS with a fresh Slack-originated action token.
- [ ] Add user-authorized private/DM search with verified owner/workspace binding
  and private delivery. Configured scopes alone do not grant access.

Slack DMs and native reactions are live. Search remains disabled pending approval
and integration; no historical imports or native Amp execution are enabled.
Longer-term memory, personality, dreaming, and tool-plane work remains in the
architecture roadmap. The `agent-resources` comparison supports deterministic
orchestration, scoped provenance, bounded concurrency, and argument-bound
approvals; it does not replace the roadmap's privacy/deletion requirements.
