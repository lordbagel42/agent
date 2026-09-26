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
- Test behavior before implementation; formatter, linter, typecheck, and full
  tests must pass before any commit. No push authorization. The owner subsequently
  authorized a scoped `pulumi-homelab` deployment, ChatGPT browser sign-in, Slack
  installation, a hello DM, live messaging checks, and search permission requests.

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
