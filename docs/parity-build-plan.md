# June capability parity: parallel implementation plan

> For agentic workers: take one stream and one ready feature slice, not an entire
> wave. Use the executing-plans workflow, adapted to [AGENTS.md](../AGENTS.md):
> real-workflow verification, no new ordinary tests, small commits directly to
> remote `main`, and owned deployment follow-up. This document is a plan, not
> authorization to enroll accounts, expand permissions, or start all 30 agents.

**Goal:** turn the [18-epic, 108-feature research report](research/personal-agent-parity.md)
into independently owned increments that save the owner's attention without
weakening June's source scopes, current-intent checks or uncertain-effect holds.

**Architecture:** keep the conversational June, bounded execution workers, Rivet
workflows and host-enforced authority. Two wave-0 streams own shared integration;
28 domain streams own disjoint modules. Add narrow registration seams to the
existing architecture, not a second scheduler, permission store or plugin engine.

**Stack inspected:** Node 24.21.0, pnpm 10.33.0, TypeScript 5.9, Zod 4.6, Hono 4.13,
RivetKit 2.3.21, Node SQLite, existing MCP/Slack/browser/environment adapters.
Provider choices, dependencies and durable migrations still need their own review.

**Source baseline:** fresh remote `main` at
[`a449de9`](https://github.com/lordbagel42/agent/commit/a449de9), inspected on
10 October 2026. The research baseline is older and includes then-uncommitted
edits; its 102 source capabilities are not current live attestations. Read current
source before each assignment. Proposed paths and interfaces below do not exist
merely because this plan names them.

## Owner policy override — 10 October 2026

Raygen clarified at 13:47:13 UTC that the restriction concerns autonomous
purchases, such as ordering DoorDash, not limits on June's built-in tools.
Configured inference and built-in tools, including TinyFish, Tavily and E2B,
may operate under their existing grants without a funding classification,
account-by-account audit or no-charge attestation. Remove the newly introduced
billing denials rather than replacing them with another billing limit. Useful
background inference remains uncapped; keep honest usage analytics (unknown is
not zero), actual provider quotas/rate limits/backoff, bounded concurrency,
cancellation/recovery fences and foreground responsiveness. Do not create
purposeless busy loops.

June must not autonomously place purchases or orders, transfer money, buy quota
or enter new financial commitments. Existing configured tool/model use is not
such a purchase, even when the provider meters usage. This correction supplies
no transaction authorization, new account enrollment or expanded permissions.
Future owner-funded transactions still require fresh explicit authorization and
the existing approved payment route; a saved payment method is not consent.
No production `budgets.sqlite` schema is approved.

This override governs every K4/F013/P0/D3 reference and downstream dependency in
this plan and supersedes the earlier overbroad funding/attestation requirements.
The historical research report is unchanged: its model-spend-cap
recommendations are research findings, not current implementation requirements.

### June's self-development authorization — 13:04:23 UTC

Raygen explicitly authorized June to develop her own identity and values without
owner-only editing or a proposal-only approval step, and instructed testing,
functional verification, rebasing and shipping in the
[existing Mind implementation thread](https://ampcode.com/threads/T-01a124b2-bc2f-713f-9020-770fefbe0e2b).
This supersedes that task's earlier architecture/publication hold, not external
authority, privacy, retention, spending or live-operator boundaries. Self-authored
values cannot change host permissions or authorize effects. The existing Mind
owner retains the single Mind/skill-store implementation; S06/S08/S13 remain
queued rather than creating competing writers or stores.

Primary/deep, Mind's separate general provider, and the default Codex sentinel
route may use their configured model/account routes under existing permissions.
The former exact-route billing-attestation prerequisite is withdrawn, not deferred.
No new numerical quota, billing admission limit or production budget database follows.
This records the owner's decision, not publication, activation or feature proof.

## Global constraints and definition of done

- Preserve the report's priorities, dependencies, qualifications, granular
  coverage register and entire **Do not copy** exclusion list. F001, F002, F003,
  F007, F008, F010 and F013 are the seven P0 gates, not seven optional projects.
  F013 means truthful usage and safe resource handling for configured inference
  and built-in tools, not billing-based admission. Autonomous purchases, orders,
  transfers and new financial commitments remain prohibited. Monetary reservations
  confer no authority; missing budgets must not block configured tools/model work.
- New capabilities are enabled by default when their prerequisites and existing
  grants permit them. An explicit user disable stays disabled. Missing keys,
  accounts, eligible plans, processors, hardware or consent produce a discoverable
  blocked state with the exact missing prerequisite and a permitted resolution
  route. June may request enrollment/help; she may not impersonate OAuth consent,
  widen permissions, fish for OTPs, self-deploy or defeat a manual disable.
- Enabled software is not standing permission to capture ambient audio, purchase,
  send messages, publish private data or install an imported template. Such
  actions remain gated. F058's unapproved imported instances stay inactive even
  though the template capability itself is enabled.
- Work stays behind workers and host brokers. Notification/completion turns
  remain notification-only. Explicitly enrolled event-decision capabilities are
  narrower than interactive capabilities. A prompt or skill cannot grant tools.
- Keep evidence provenance, audience filtering before retrieval, deletion
  ancestry and immutable approval artifacts. Unknown external outcomes retain
  their operation IDs, reservations and reconciliation holds; no blind replay.
- Reuse existing wakeups, workflow journals, evidence memory and recovery. Native
  coding/worktrees are not sandboxes. No engine replacement is part of parity.
- Do not request Slack `links:write`. Slack app scopes/features/subscriptions,
  new provider accounts, published API changes and irreversible migrations need
  specific owner approval. Repository shipping permission is not that approval.
- No feature/bugfix test expansion. Use disposable verification scripts and real
  workflows; keep new tests only when otherwise silently breaking recovery,
  rollback or redeployment, as allowed by AGENTS.md.

Every stream incorporates this completion checklist; its brief adds concrete
cases rather than replacing these requirements:

- [ ] Read its report feature rows, current source analogues, consumed contracts
  and applicable guidance. Record prerequisites and owner decisions before work.
- [ ] Deliver a thin callable slice through the real host, not an unused library,
  dashboard-only control or optimistic stub. For administrative functions, expose
  June-callable preparation/status and retain authenticated human execution.
- [ ] Include module-local runtime knowledge and action help in the same change:
  triggers, configuration gates, continuation owner, budgets, retry/unknown
  rules, approvals, inspection, stop/revoke and what June must not duplicate.
- [ ] Inspect actual `buildModelRequest` output for interaction, execution and
  enrolled event-decision paths, plus notification-only negative control. Then
  exercise the allowed June-facing path on the real channel/service with
  disposable authorized data; knowledge must arrive even when a tool is blocked.
- [ ] Exercise success, missing prerequisite, stale intent/approval, wrong audience,
  stop/revocation and an ambiguous outcome where applicable. Compare provider
  IDs and receipts, not just a worker's claim. Keep private evidence outside Git.
- [ ] Run `pnpm format`, `pnpm lint`, `pnpm typecheck` and affected companion checks;
  inspect formatter changes. UI work requires rendered desktop/mobile or relevant
  non-default states and inspected screenshots; interaction-only changes require
  DOM/accessibility checks. Do not weaken failing checks.
- [ ] Obtain Oracle review for a larger or high-impact change, and for every
  security, durable-state, money, retention, control-plane or deployment change.
  A small copy/adapter presentation fix need not create a review bottleneck.
- [ ] Publish an atomic Conventional Commit, follow deployment to the loaded
  process and each affected companion, then record dated feature-specific live
  evidence. A passing build, source registration or health check alone does not
  establish that the feature works.

## The layout determines ownership

The main conflict is not 108 independent algorithms. New actions currently touch
the same schema, capability flags, dispatch and prompt assembly:

| Observed source | Existing responsibility; consequence for this plan |
| --- | --- |
| `src/config.ts`, `src/main.ts`, `src/http/app.ts` | Strict configuration, startup/mounting and public/private listeners. Only C01 integrates here. |
| `src/core/contracts.ts`, `src/models/provider.ts` | `Channel`, `CompanionReply`, `ModelRequest`, Zod reply parsing, JSON schema and role filtering. C01 preserves old fields/readers while adding a bounded registration seam. |
| `src/runtime/registry.ts`, `capabilities.ts`, `execution-capabilities.ts` | Durable actors, dependency ports and effect dispatch. C02 owns integration, not every domain implementation. |
| `src/runtime/prompt.ts`, `execution-context.ts`, `execution.ts` | Shared `buildModelRequest`, `PromptCapabilities`, host-created execution ceilings and worker ownership. C02 owns plumbing; domain streams own separate knowledge sections. |
| `src/tools/broker.ts`, `connections.ts`, `routes.ts`; `src/credentials/` | Exact grants, no-replay receipts, account enrollment and credential release. S03 owns policy; S09 owns MCP wire compatibility, not a competing grant store. |
| `src/wakeups/`, `src/workflows/`, `src/research/` | Existing timers/events, durable JS and ongoing public research. S02 owns low-level timers/intent; S14 composes routines and monitors. |
| `src/memory/`, `src/sessions/`, `src/imports/`, `src/reflection/` | Evidence/archive, imports and learning are distinct. S06 owns evidence/deletion, S07 ingestion, S13 reflection, S27 backup/restore. |
| `src/browser/`, `src/environments/`, `src/coding/`, `src/apps/`, `src/artifacts/` | Separate browser, VM, coding and hosted-output lifecycles. Preserve those boundaries; do not collapse them into a general host shell. |
| `src/console/`, `src/diagnostics/`, `debug-site/`, `sandboxes-site/` | User console and independently deployed companions differ. UI features do not inherit operator credentials. |

Use the closest existing pattern: domain Zod schema plus inferred types and
`*_KNOWLEDGE`/`*_HELP` exports as in `src/settings/contracts.ts` and
`src/environments/contracts.ts`; bounded service ports as in
`src/runtime/capabilities.ts`; Hono route factories as in `src/console/README.md`.
Do not copy today's giant action switches into each new module.

## Wave 0 establishes contracts, not speculative infrastructure

Only **C01 and C02** edit shared integration files. They remain available in later
waves for small contract changes. All other streams consume these contracts or
submit a concrete change request to the named owner; they never edit the shared
file opportunistically. No whole-runtime rewrite is required to begin wave 1.

### Shared contract register

These are proposed internal contracts. C01 owns their wire/type definitions in
`src/capabilities/contracts.ts`; domain services own their implementations. Derive
types from Zod and reuse `MessageEvent`, `Address`, `SendResult`, `ExecutionContext`,
`ToolAction` and `Receipt` rather than copying their shapes. Neither payloads nor
returned text can set trusted scope, credentials or role.

| ID / steward | Contract to freeze in wave 0 | Consumer rule and later provider |
| --- | --- | --- |
| K0 / C01 | `CapabilityDefinition`: stable `id`, strict `commandSchema`, effect class, allowed turn classes, safe availability reader, knowledge/help, factory receiving only named host ports. Explicit source-controlled registrations and schema-derived reply validation. | All streams. Reserve one `src/capabilities/modules/sNN.ts` slot per domain stream; initially an empty definition list, not a fake enabled feature. These files become exclusively domain-owned after C01 creates them. |
| K1 / C02 | `CapabilityContext` integration: existing host-authenticated source/audience/worker ceiling, stable operation ID, abort signal, intent reference, deletion revision and `canStartAction`/`canDeliver` checks. | All streams. C02 wires current-ceiling intersection into every new dispatch; no model-selected principal, role or operation ID. Preserve terminal/report-only outcomes and old action paths. |
| K2 / C01 → S02 | Source-bound `IntentPort.inspect/current/begin/settle/stop`, intent `{id, version}` and terminal effect outcome vocabulary; `AttentionPort.decide` returns deliver/suppress/defer plus reason/deadline; deterministic `TimePort.preview`. | Existing owners durably claim first admission before dispatch; lost acknowledgments and unknown receipts never grant replay. Async `begin/current` do not replace the owner's synchronous fence immediately after preparation and before dispatch. C02 owns root worker hooks; S02/S14/S19 own their durable consumers, not a new journal. Settle original outcomes even after intent changes; terminal receipts remain immutable and unknowns held. Stop distinguishes fenced from fully settled, never undone. |
| K3 / C01 → S03 | `PolicyPort.admit/recheck/revoke/inspect` binds source, account, audience, operation, destination, artifact digest and expiry. Credential use is a one-use host callback, never a JSON result. | All effectful streams. Adapt existing broker/connection receipts; do not replace legacy grants or reinterpret old unknowns. S03 owns enrollment/revocation and processor/entitlement metadata. |
| K4 / C01 → S04 | Inert future-transaction `BudgetPort.reserve/settle/inspect`: stable operation ID, immutable host scope/task/price policy, integer currency micro-units, maximum cost, category and period. First reservation differs from an existing held/settled operation; outcomes distinguish known charge, confirmed no-charge and unknown. | Never an admission gate for configured inference or built-in tools; those require no billing classification or no-charge attestation. Autonomous purchases/orders/transfers/new financial commitments remain prohibited, and a reservation is never transaction authorization. Unknown transaction outcomes keep their hold, never a new attempt. No production budget-store schema is approved. |
| K5 / C01 → S06 | `EvidencePort` scoped source/reference operations plus `DeletionParticipant.preview/apply/status`; derivative owners register source IDs and deletion revision. | S06 integrates with the existing ledger and tombstones. S07/S20/S22/S27 implement their own deletion participant; no cross-scope query then post-filter. Registration does not start a new retention policy. |
| K6 / C01 → S20 | `FilePort.ingress/read/deliver/forget`: opaque file reference with hash, size, media type, source/audience, expiry and derivative provenance; bounded stream access in host code. | Documents, audio, media, mail, apps and clients. No raw local path, bearer URL or arbitrary URL fetch in model payloads. S20 owns quotas, transfer settlement and private delivery. |
| K7 / C01 → S01/S05 | `CapabilityStatus` separates implemented, host-integrated, June-callable, enrolled, enabled, ready and live-verified; each is yes/no/unknown with revision/time/scope. `TaskView` projects owners/receipts, not a second job store. | S01 supplies readiness; S05 supplies lifecycle/audit/value projection. Prerequisite records name blocker, resolver (June/owner/operator), safe next action and evidence freshness. Never include secret values. |
| K8 / C02 | `CapabilityKnowledge` has interaction, execution, event-decision and notification-only sections, assembled at the actual `buildModelRequest` boundary. Unknown/unavailable modules can explain setup without exposing actions. | Each stream owns `src/runtime/prompt-sections/sNN.ts`; C02's loader imports them once in wave 0. Host role/schema checks remain independent of prose. No unrestricted dynamic prompt/file loading. |
| K9 / C01 | Config composition from each module's strict schema, default behavior and prerequisite validator; protected activation/authority versus ordinary `settings` preferences remain separate. Mount/start/stop hooks obey standby and lifecycle admission. | Each stream owns its schema in its K0 slot or domain contracts file. C01 alone edits root config, examples, root package/lock/build manifests, route mounting and provider reply schema. No secret defaults or generic `Record<string, unknown>` config escape hatch. |

K0 is a **compile-time allowlist of trusted source modules**, not a runtime directory
scan or permission for installed skills/plugins to register privileged handlers.
C01 creates the 28 empty module slots and static imports once; C02 creates the 28
empty prompt sections and imports once. Domain owners later fill their own files
without touching a central registry. Existing capability fields remain valid;
new commands use a strict schema-derived, role-filtered additive action union.
If that cannot preserve persisted replies or a published MCP contract, stop for
an explicitly reviewed compatibility change rather than silently migrating it.

**K1/K7 first-publication guard:** the optional readonly invocation `outputGuards`
exposes only `CapabilityOutputGuards.register(result, current)`. S05 registers the
final fresh TaskView object; C02 claims that exact object once and owns checks
through the first synchronous worker history insertion, then clears the local
collector before persistence. Empty/prior registrations cannot certify a non-null
view. The admitted minimized text remains ordinary historical evidence with its
original observation times, not continuing freshness or provider-dispatch
authorization. Source-only invalidation preserves it; actual forgetting/deletion/
revocation keeps existing cancellation/history clearing. No serialized guards,
raw presentation retention, new persistence policy or TaskView/Promise ABI change.
The collector, projection and runtime knowledge remain C02/S05 work; root task
mounting waits for their reviewed boundary checks, not this declaration alone.

Wave 0 lands in two small steps: C01 establishes types/empty slots without changing
behavior, then C02 wires the bounded host/prompt hooks and migrates **one existing
metadata-only inspection** as a real vertical slice. Unimplemented K2–K7 services
remain unavailable, never permissive no-op implementations. Wave 1 installs them
one at a time. Do not build a generic extension marketplace here.

### C01 — contracts, schemas and composition (wave 0, then integration service)

**Goal/scope:** freeze K0/K2–K7/K9 shapes, reserve stream namespaces and preserve
existing config/action compatibility. Own only cross-cutting composition, not
domain business logic, runtime policy decisions or new provider accounts.

**Exclusive paths:** `src/capabilities/{contracts,catalog,config}.ts` (new),
`src/config.ts`, `src/main.ts`, `src/http/app.ts`, `src/core/contracts.ts`,
`src/models/provider.ts`, `src/settings/`, `config.example.json`, `.env.example`,
root package/lock/workspace/TypeScript/Biome manifests, and
`scripts/{build-artifacts,build-debug-site}.ts`. Deployment build/preflight scripts
and Actions workflows belong to S01, not C01; companion-local manifests belong
to their directory owner, with lockfile changes requested from C01.
Create the K0 slots then transfer each to S01–S28. Own this plan and contract
version notes; other streams do not all append to this file.

**Consumes/provides:** consumes current source contracts; provides K0/K2–K7/K9
and typed host factories to C02. Other-file changes go through K1/K8 or the
domain contract owner. C01 alone handles new dependency requests after approval.

**Acceptance:** parse current example/config shapes unchanged; preserve legacy
reply parsing/role denials; absent services yield actionable unavailable metadata
without starting I/O; exercise the real metadata slice with C02. Existing
standby/startup checks still pass. Oracle required for this contract seam and
any later durable/protocol/permission change. No owner decision blocks the
non-mutating scaffold; a required migration does.

### C02 — runtime dispatch and prompt integration (wave 0, then integration service)

**Goal/scope:** connect modular actions to existing durable ownership and every
prompt path without broadening the interaction agent or notification turns.
Do not take over module logic, invent a second worker queue or rewrite journals.

**Exclusive paths:** `src/runtime/{registry,prompt,capabilities,execution-capabilities,execution-context,execution,inbox,priority}.ts`,
new `src/runtime/{capability-dispatch,capability-prompts,capability-mounts}.ts`.
Create K8 sections then transfer each to S01–S28. No other runtime ownership
except the narrow lease below.

**10 October scope-catalog lease:** C02 may edit `ScopeCatalog`,
`ScopeExecutionHost`, `dispatchScopeExecution` and necessary imports/types in
`src/runtime/scope-catalog.ts` only to capture the original
`CapabilityIntentBinding` and route root/descendant cancellation. No queue, journal
step/order, migration or legacy backfill changes. S06 remains queued and retains
all other code, including `createScopeCatalogAuthority` and forgetting policy.
C01 retains shared contracts; S02 owns intent/activity callers and S14/S19 own
descendant bodies. This authorizes implementation, not F002 acceptance or live
mutation.

**Consumes/provides:** depends on C01/K0; provides K1/K8 and actor/worker hook
integration. C01 supplies schema/startup changes through K9. Domain owners submit
exact hooks for old timers, coding and effect paths; C02 does not waive their fences.

**Acceptance:** real existing inspection works through worker delegation; captured
requests show all four turn classes with correct knowledge and action denial;
newly enabled tools cannot expand an already queued worker's ceiling. Stop/drain
still owns in-flight calls and late results. Oracle required. No owner choice
blocks compatibility-preserving wiring; no further streams start against an
unreviewed permissive stub.

## Waves are dependency frontiers, not big-bang releases

Feature dependencies in the coverage register are **release gates**, including
dependencies within a wave. A stream may draft its bounded interface or implement
an independent slice while a supplier works, but cannot claim end-to-end completion
against a mock. Land callable increments as soon as ready. Do not wait for every
feature in a supplier's stream, which would create artificial cycles.

The contracts listed in a brief describe its full lifetime, not prerequisites for
every tranche. F001 uses existing inspection and labels unimplemented services
unknown; it does not wait for K2–K4 or S05. F002 uses the current policy boundary
while S03 extends it. F019 read/search precedes S11 contact resolution; F020 adds
contacts where recipient ambiguity requires them. F027 does not wait for later
reflective coaching, and F094/F095 do not wait for audio/mobile. Apply the same
feature-level rule to the other briefs; a new cross-stream dependency must be
recorded against the affected F-ID rather than the whole stream.

| Wave | Report phase | Work allowed and exit gate |
| --- | --- | --- |
| 0 | Phase 0 preparation | C01 then C02. Two owners only; shared schemas/slots, one real inspection, correct role/default/blocked behavior. No new persistent or consequential authority. |
| 1 | Phase 0 safety floor | F001 → F002; then F003 and F013 can proceed alongside F007 → F008 → F010. Supporting F004/F005/F011/F012/F018/F101 complete as their edges permit. S01–S05 own this critical path. No expanded retention or effects before all seven P0 receipts pass. |
| 2 | Phase 1 and low-risk Phase 2 foundations | Files, deletion/recall, skills, read-only mail/calendar, tasks, voice notes, docs, setup/accessibility, verified VMs and export/restore. F031 waits for mail/calendar/tasks; broader personal retention waits for F097/F098. Each concrete feature waits for the register, not for an entire wave to finish. |
| 3 | Phase 2 admin and Phase 3 reuse | Exact send/calendar writes, triage, scheduling, recipes, reviewed skills, monitors, shared knowledge, browser pilot, panels, specialists, clients and selected connectors. Finish Phase 2's failure cases before enabling Phase 3 reuse of those actions. |
| 4 | Phase 4 concierge | Calls and bounded checkout precede bookings/disputes. Voice conversation may advance only after its client/consent prerequisites. Separate provider receipt from counterpart fulfillment. |
| 5 | Phase 5 demand-led branches | Desktop/sensors, ambient capture, tenancy, broad transport SDK, managed packaging, human services, paid APIs, specialist packs and creator economics. Explicit need/support/cost/privacy decisions precede implementation; they are not automatic commitments. |

Wave 2 offers **18 domain lanes** over its dependency pipeline: S01, S04, S05,
S06, S08–S14, S16, S17, S19–S21, S26 and S27; C01/C02 service integration requests.
An owner-selected S15 transport adds a nineteenth lane. Not all are ready on day
one: files precede audio/documents and mail precedes contacts. Use roughly
**15–21 active agents when those frontiers and owner decisions permit**, not 30
agents writing blocked stubs. Wave 3 adds S07/S15/S22–S24, plus S18/F064 and
S25/F030 after their decisions, as lanes free up. S28 and other optional tranches
remain parked until their gates pass. Thirty is the stable ownership roster,
not a promised minimum instantaneous width or license to ignore dependency edges.

## Domain ownership and executable briefs

Ownership notation: a directory owns its descendants **except explicit exclusions**;
brace lists enumerate exact files, not prefix guesses. `(new)` means create only
when that stream starts. Every SNN additionally owns exactly
`src/capabilities/modules/sNN.ts`, `src/runtime/prompt-sections/sNN.ts` and
`docs/parity/streams/sNN.md` after wave 0. That per-stream document records the
active agent/worktree, feature slice, decisions, provided contract version and
public-safe verification/deployment receipts. It must not contain private data.

All unlisted existing paths are read-only. A new path outside a stream's ownership
requires C01 to assign it before editing. Root docs such as `docs/usage.md` are
integrated by C01 from stream notes; runtime instructions are never postponed to
that documentation integration. **Shared-only access for every stream:** K0/K9
through C01; K1/K8 runtime wiring through C02; K2–K7 through their named providers.

### S01 — readiness, recovery and installation

- **Features/waves:** F001 (1), F006 (2), F096 (3), F100 (5).
- **Owned paths:** `src/operations/` (new), `src/runtime/{inspection,lifecycle}.ts`,
  `src/deployment/`, `scripts/deploy/` except `restore/`, `.github/workflows/`.
  Existing mandated recovery tests remain protected, not a license for general tests.
- **Brief:** first extend capability inspection with independent status/freshness
  and named prerequisites; then exercise restart/overload/companion skew; finally
  offer checked pairing/setup and demand-led packaging. No self-authorized repair,
  engine migration, tenant hosting or config mutation through an inspection tool.
- **Contracts/deps:** provides K7 readiness and recovery evidence; consumes C01/C02,
  K2/K3/K4 and S05 task views. F096 waits for S26; F100 also waits for S19/S27.
- **Acceptance:** June reports source-only, disabled, expired-account, missing-KVM
  and wrong-companion-revision states differently. Run actual isolated restart,
  drain and overload cases; observe MainPID/readiness/intake and preserved unknown
  effects. A missing prerequisite tells June who can resolve it. Follow global
  prompt/callability checks. Oracle required for lifecycle/deploy/packaging.
- **Decisions:** D5 for a changed execution host; D8 before F100. Existing health
  inspection and recovery verification are not blocked on selecting new hosting.

### S02 — intent, time and attention

- **Features/waves:** F002/F003/F005 (1).
- **Owned paths:** `src/intent/`, `src/attention/`, `src/time/` (new), `src/wakeups/`,
  `src/runtime/{delivery,social,typing,session-controls}.ts`, `src/core/social.ts`.
- **Brief:** extend current durable cancellations into versioned intent fences;
  apply silence/deduplication/snooze at delivery; expose deterministic date/DST
  previews and missed-run policy. Do not replace journals or let a quiet-policy
  decision authorize a send. Preserve mandatory host controls and current group
  conversation behavior unless an explicit policy change is agreed.
- **Contracts/deps:** provides K2; consumes F001 and K1/K3/K7. C02 installs worker
  checks; S14/S19 integrate workflow/coding checks in their owned files. F003
  waits for F002, not for all calendar work.
- **Acceptance:** stop before dispatch, during provider wait, after acceptance
  and across restart; prove no new effect after fence, no late duplicate message,
  and honest irreversible/unknown status. Preview both DST boundaries in
  America/Boise, annual/interval rules, missed ticks and run-now versus dry-run.
  Exercise quiet and urgent cases through June, including automated prompts.
  Oracle required for fences/delivery/durable changes.
- **Decisions:** D7 for new quiet/catch-up policy; retain current behavior while
  adding inspection and preview, rather than inventing urgency exceptions.

### S03 — authority, credentials and processor policy

- **Features/waves:** F007/F008/F010/F012/F101 (1); F065 (3).
- **Owned paths:** `src/policy/` (new), `src/credentials/`,
  `src/tools/{broker,connections,routes}.ts`, `src/core/{routing,private-input}.ts`,
  `src/console/{connections,connection-oauth}.ts`, `src/tools/*-oauth.ts`, `src/links/`.
  Narrow 10 October policy lease: `src/tools/web-search.ts` to remove the newly
  introduced Tavily/TinyFish funding denial; no provider replacement/enrollment.
- **Brief:** extend existing grants, exact artifacts, credential custody and
  disconnect/revocation; inventory processors/entitlements and enforce untrusted
  content barriers. Later add exact one-use credential-provider/2FA handoff.
  No generic vault search, model-held tokens, subscription entitlement assumptions,
  blanket owner-private gate or forced approval for every already-granted read.
- **Contracts/deps:** provides K3 and privacy/entitlement metadata; consumes F002,
  F001, K1/K2/K4/K7. Broker → account lifecycle → content barriers is ordered;
  F065 additionally waits for S17/F062. S09 consumes connection APIs, not internals.
- **Acceptance:** current-grant read succeeds; modified recipient/body hash,
  revoked queued operation, cross-account source and hostile mail/skill instructions
  fail at the host. Revoke during credential resolution; confirm no secret in
  model/receipt/log and explain disconnect versus retained data. June can inspect
  the blocker and request the correct human step. Oracle required on all authority
  and credential changes; global prompt checks apply.
- **Decisions:** D2/D4/D6 constrain new grants/processors/accounts; existing-policy
  hardening and safe metadata do not wait. D5/D6 gate new vault providers.

### S04 — budgets, models and backpressure

- **Features/waves:** F013 (1), F015/F016 (2), F014/F017 (3 or demand-led earlier).
- **Owned paths:** `src/budgets/` (new), `src/models/` except `provider.ts`, including
  new provider adapter modules. C01 owns their root configuration and schema wiring.
- **Brief:** truthful model-usage accounting and bounded resource/backpressure
  first, then measured task-class routing/cache efficiency and compatible providers.
  Configured model use, including useful background work, is uncapped. Configured
  inference and built-in tools do not require billing classification or no-charge
  attestation. Autonomous purchases/orders/transfers/new financial commitments
  remain prohibited; ordinary configured tool use is not such a transaction.
  Future monetary reservations need separate policy and storage approval.
  No invoice accuracy claims, unapproved provider enrollment, pooled-account terms
  evasion, context deletion disguised as compaction or blind retry of unknown IO.
- **Contracts/deps:** provides K4 and normalized provider readiness/usage; consumes
  F001/F002, then K3 privacy/entitlement and S05 task views. S19 owns idle VM
  implementation; C02 owns prompt/roster optimizations under K1/K8.
- **Acceptance:** configured inference and built-in tools proceed without token
  quotas, dollar caps, billing classifications or no-charge attestations;
  unknown usage/cost stays unknown rather than
  zero. Actual provider backoff, bounded concurrency, cancellation and foreground
  responsiveness still apply. Measure prompt/latency/cost before/after through real
  provider paths with injected non-spending transports for billing-correction proof.
  Preserve existing permission and privacy denials. For future authorized transactions, competing reservations
  cannot over-admit; only first admission can dispatch, confirmed no-charge releases
  and unknown holds. Global prompt checks and Oracle cover fallback/state changes.
- **Decisions:** D3 prohibits autonomous purchases/orders/transfers/new financial
  commitments, not configured tools or inference. D4/D6 still gate new processors,
  accounts and subscription adapters. No new transaction authority or durable
  budget-store migration is implied by the unlimited-model policy.

### S05 — task views, audit and work coordination

- **Features/waves:** F004/F011/F018 (1–2), F080/F081 (3).
- **Owned paths:** `src/tasks/` (new), `src/telemetry/`,
  `src/runtime/{latency,diagnostics}.ts`, `src/diagnostics/`, `debug-site/`,
  `src/console/usage.ts`.
- **Brief:** project existing jobs/receipts into readable status/audit/value views;
  later add dependency/resource cards and safe queue steering. No duplicate
  scheduler, new authority from a board, stored private tool bodies, or inferred
  attention savings from token counts alone. Archiving/hiding does not cancel.
- **Contracts/deps:** provides K7 TaskView and scoped audit/value queries; consumes
  K2/K3/K4, S01 readiness, S13 goals and S24 handoff/ownership for F080/F081.
  C02 performs actual execution-queue changes; this stream owns their projection.
- **Acceptance:** queued/blocked/unknown versus complete and delivery failure are
  distinguishable to June and UI; revoke/steer invalidates stale work. Two workers
  cannot hold one resource; reassignment waits for settlement. Collect measured
  interruptions/corrections and explicit usefulness feedback. Inspect UI states;
  independently verify debug-site deployment. Oracle for leases/audit/storage;
  routine presentation-only increments use normal review.
- **Decisions:** D3 for value targets, D8 before new operational support obligations;
  source-scoped status is independently buildable.

### S06 — retention, recall and memory workspace

- **Features/waves:** F009/F049/F050 (2), F051 (3).
- **Owned paths:** `src/memory/` except `backup.ts`, `src/sessions/`,
  `src/runtime/{continuity,scope-catalog,conversation-storage}.ts`, `src/http/memory.ts`.
  C02's narrowly scoped scope-catalog lease above is the only exception there.
- **Brief:** extend current forgetting to registered derivatives, then measured
  hybrid recall and editable projections, then reviewed shared facts/tables.
  Keep the evidence ledger authoritative; no new opaque memory service, raw prompt
  editing, automatic private-to-shared publication or physical-erasure promise.
- **Contracts/deps:** provides K5, scoped recall/projection APIs; consumes K3/K4
  and F008/F012/F013. S27 owns backup bytes/tombstone replay; other derivative
  owners implement K5 participants rather than editing the evidence store.
- **Acceptance:** June previews deletion, confirms exact impact and inspects
  incomplete cleanup. Correction/contradiction/time queries use real sources;
  lexical fallback survives absent embedding credentials. Wrong audiences never
  enter ranking. Deleted evidence disappears from projections/derivatives and
  shared membership changes trigger revalidation. Global prompt checks and Oracle
  required for retention/index/storage boundaries.
- **Decisions:** D4 before new retention/embedding processors; D2 for shared
  publication. F009 local deletion work can proceed with existing enrolled data.

### S07 — imports and personal knowledge sources

- **Features/waves:** F052/F053/F099 (3).
- **Owned paths:** `src/imports/`, `src/knowledge/` (new),
  `src/runtime/{import-task,import-approval}.ts`, `src/http/imports.ts`.
- **Brief:** add bounded authorized continuation and selected notes/files/photos;
  import assistant exports into quarantine with gaps/provenance. Keep live Gmail
  separate from its historical importer. No autonomous collection by reflection,
  executable imported instructions, auto-enabled schedules or lossless-import claim.
- **Contracts/deps:** consumes K2–K6, S06/F050, S20 files, S21 parsers, S08 skills/
  templates and S27 export formats. Provides source cursors/gap/deletion receipts.
- **Acceptance:** June inspects partial progress, stops a page sequence, handles
  a repeated page and deleted source without resurrection; malformed archives,
  foreign-account exports and embedded instruction attacks remain inert. Inspect
  imported proposals before any activation. Global prompt checks; Oracle required
  for standing import grants, retention and migration semantics.
- **Decisions:** D4/D6 selected source/coverage/processors; D8 priority of competitor
  formats. Do not promise all catalog-listed note services in the first adapter.

### S08 — reviewed skills, extensions and templates

- **Features/waves:** F055 (2), F056–F059 (3), F108 (5).
- **Owned paths:** `src/skills/`, `skills/` (both new, June runtime library, not
  the coding-agent `.agents/skills/` directory), excluding reserved `skills/packs/`
  owned by S28. No ownership of reflection internals.
- **Brief:** worker-only progressive skill loading and immutable versions, then
  learn/evaluate/curate, private catalog, safe sharing and a typed extension SDK.
  Public creator economics comes last. No arbitrary control-plane imports,
  automatic generated-skill installation or trust inferred from a scanner/popularity.
- **Contracts/deps:** consumes K0–K5, S06/F050, S13 reflection proposal APIs,
  S14/F034 and S27/F097; provides `SkillCatalog.discover/load/propose/review/revoke`
  and pinned template/extension contracts. S13 owns changes to existing evaluation.
- **Acceptance:** June discovers only eligible skills, reads a bounded version,
  runs scripts only through an admitted VM, and reports missing tools. Held-out
  real cases reject a bad learned procedure; revocation blocks reuse. Export
  removes private state/accounts; imported instances await authorization. Global
  prompts and Oracle required for loading, execution, sharing and supply chain.
- **Decisions:** D5 for scripts, D8 before public catalog/payouts; private reviewed
  text library can start without deciding marketplace economics.

### S09 — MCP and work-tool adapters

- **Features/waves:** F060 (2–3), F103 (3).
- **Owned paths:** `src/tools/mcp.ts`, `src/connectors/mcp/`,
  `src/connectors/packs/` (new). Account/policy/OAuth files belong to S03.
- **Brief:** negotiate actual MCP capabilities and catalog search, then supervised
  STDIO/safe elicitation only for selected services; package exact scoped work-tool
  adapters. Unsupported sampling/roots/SSE/tasks remain explicit. No host-global
  authority, arbitrary executable startup or connector-count compatibility claim.
- **Contracts/deps:** consumes K3/K4/K5, S26/F095, S08/F055; provides adapter
  discovery/execution contracts via K0. S03 integrates connection enrollment and
  C01 handles any approved process/dependency changes.
- **Acceptance:** June discovers an enrolled service, performs one authorized
  operation and explains disabled/expired/scope-missing cases. An unsupported
  protocol fails honestly; revoke during execution prevents the next effect;
  unknown external write is held. Global prompt checks; Oracle for new transports,
  OAuth/elicitation and any authority boundary.
- **Decisions:** D6 for provider scopes/enrollment; D8 for maintained service list.
  Existing HTTPS discovery improvements do not require building every pack.

### S10 — live mailbox and exact mail actions

- **Features/waves:** F019 (2), F020/F021/F022/F024 (3).
- **Owned paths:** `src/mail/` (new). Do not edit `src/imports/gmail.ts` to pretend
  historical import is live mail, or S15's email transport.
- **Brief:** Gmail search/thread metadata and incremental watch first; then exact
  immutable drafts/send/reply/forward, reversible triage, explicit provider/account
  lanes and a delegated sender identity. No guessed recipients, rewritten approved
  text, bulk destructive cleanup by read grant or arbitrary account merging.
- **Contracts/deps:** provides `MailService.search/thread/draft/send/inspect` and
  checkpointed mail events; consumes K2–K7, S05 audit, S11 contacts, S20 files.
  F024 waits for S15/F040. Read-only ephemeral mail can precede new retention;
  retained indexes require S06/S27's data-protection gate.
- **Acceptance:** June reads a selected account, reports stale/missing sync, then
  sends only an exact approved draft to a disposable authorized recipient. Edit
  invalidates approval; network loss after provider acceptance holds the same ID.
  Duplicate push, disconnect and cross-account threading cannot duplicate effects.
  Global prompts; Oracle for send, watch retention and delegated identity.
- **Decisions:** D2/D4/D6 for mail authority, coverage, account/scopes; no production
  send or mailbox enrollment implied by this plan.

### S11 — contacts and life-admin records

- **Features/waves:** F023 (2), F029 (3).
- **Owned paths:** `src/contacts/`, `src/life-records/` (new).
- **Brief:** sourced identity/alias resolution, reviewed merges and quiet relationship
  commitments; then explicit household records. No name-only merge, family-wide
  consent inference or hidden relationship outreach.
- **Contracts/deps:** provides `ContactService.resolve/proposeMerge/inspect` with
  ambiguous outcomes and scoped record references; consumes S10/F019, K2/K3/K5,
  S12 calendar, S13 tasks and S06 recall for F029.
- **Acceptance:** two same-named contacts remain distinct, shared sources cannot
  resolve private addresses, birthday timezone and completed-follow-up suppression
  work. June asks about ambiguity instead of guessing. Global prompts; Oracle for
  merge/publication/retention changes, not routine formatting.
- **Decisions:** D2/D4/D6 for sources/sharing; existing explicitly supplied records
  can be used without new contact-account access.

### S12 — calendar, scheduling and meeting preparation

- **Features/waves:** F025 read (2), F025 write/F026/F028 (3).
- **Owned paths:** `src/calendar/`, `src/meetings/` (new; excludes audio joining).
- **Brief:** Google Calendar availability first, then version-bound writes,
  recurrence exceptions/attendee notifications and bounded negotiation/prep.
  No treating reminders as bookings, holding stale slots, implied recording or
  third-party replies as permission to expand owner scope.
- **Contracts/deps:** provides `CalendarService.availability/preview/commit/inspect`
  and scoped agenda references; consumes K2/K3/K5, S10 mail, S11 contacts and
  S21 documents. Provider-specific Outlook/CalDAV follows selected demand.
- **Acceptance:** DST crossing and recurring single-instance edit/cancel preserve
  the rest of the series; changed attendees/version invalidate approval; concurrent
  slot change blocks stale booking. June returns external event IDs and separates
  draft minutes from verified commitments. Global prompts; Oracle for invitations,
  recurrence mutations and personal-data boundaries.
- **Decisions:** D2/D6 provider/write scopes, D7 timezone/focus/catch-up preferences.

### S13 — lists, goals and reflective coaching

- **Features/waves:** F027 (2), F033/F054 (3).
- **Owned paths:** `src/lists/`, `src/goals/` (new), `src/reflection/`,
  `src/runtime/reflection.ts`, `src/runtime/personality*.ts`.
- **Brief:** canonical personal task capture and provider IDs, then bounded goals
  and opt-in journaling using existing reflection/evaluation. No second scheduler,
  unlimited goal recursion or diagnostic coaching. June may develop her own
  identity and values under the owner's self-development authorization above;
  those changes cannot revise host policy or expand external authority. Coordinate
  with the existing Mind owner; this queued stream does not duplicate its store.
- **Contracts/deps:** provides `ListService.capture/complete/inspect`, goal state
  and reflection skill-proposal/evaluation ports for S08; consumes K2–K5, S06/F050.
  S02 owns deadlines, S14 owns routine scheduling, S05 owns workboard views.
- **Acceptance:** voice/text repeated capture refers to one task, completion
  cancels related future work, a goal expires or reaches an applicable external-
  effect limit (not an inference cap), and hypotheses
  retain uncertainty/provenance. June can inspect/stop learning and edit her own
  identity/values, without claiming those edits grant tools, change retention or
  authorize spending. Global prompts and Oracle for durable learning/authority.
- **Decisions:** D1 pilot chores; D4 journaling retention; D2 shared task writes.
  Explicit single-scope list operations are independently buildable.

### S14 — briefings, monitors and reusable routines

- **Features/waves:** F031/F034 (2), F032/F035/F036 (3).
- **Owned paths:** `src/routines/` (new), `src/workflows/`, `src/research/`.
- **Brief:** compose existing workflow/timer services into a sourced brief and
  deterministic recipes, then useful-change monitors, planner/ICS and reviewed
  demonstration. No new timer engine, idle model polling, duplicate notifications
  from an existing companion, or implicit browser recording/reuse.
- **Contracts/deps:** provides `RoutineService.preview/define/run/inspect/pause`
  and monitor cursors; consumes K2–K5/K7, S10/S12/S13 sources, S08 learned skills,
  S17 browser/takeover and S23 artifact APIs for optional planner rendering.
- **Acceptance:** June sets one routine; quiet/no-change day sends nothing; missing
  calendar/mail is labeled; duplicate event/restart does not duplicate the digest.
  Changed recipe affects future runs only; run-now effect is not called dry-run.
  Stop/revoke prevents continuation. Demonstration yields a reviewed draft, not
  installed authority. Global prompts; Oracle for journal/continuation changes.
- **Decisions:** D1 chores, D3 external-charge allowance only, D7 digest/quiet/missed-run rules;
  D2/D5 before recording and reusing browser demonstrations.

### S15 — channels and agent entry points

- **Features/waves:** F039 (optional 2), F037/F038/F040/F042 (3), F041 (5).
- **Owned paths:** `src/channels/` except existing `slack*.ts`; includes
  `whatsapp.ts` and new per-transport modules. Also `src/agent/`.
- **Brief:** implement one chosen transport with explicit authenticated identity,
  audience, threading/media and receipts; add email conversations and scoped agent
  entry points separately. No owner status from display names, inherited private
  mail access, universal MCP-client tenancy or weakened OS protections.
- **Contracts/deps:** consumes C01's `Channel`/`ChannelAdapter` extension through K9,
  K2/K3/K6, S10 mail, S11 contacts and S24/S05 handoff/steering for F042. Provides
  normalized ingress/delivery and negotiated unsupported semantics.
- **Acceptance:** June responds through real selected channel; spoof/loop/replay,
  DM→group change, media limit and uncertain send stay scoped. Telegram precedes
  Discord; email CC creates a requester task, not mailbox authority. Global prompts;
  Oracle for identity/authentication, ingress and per-client principals.
- **Decisions:** D1/D6 select and authorize the first non-Slack provider/account;
  D8 before broad channel SDK. No new transport implementation until selected;
  do not activate dormant WhatsApp without current terms/region eligibility.

### S16 — voice and language

- **Features/waves:** F043 (2), F044/F047 (3), F045 (4), F046/F048 (5).
- **Owned paths:** `src/audio/` (new). Slack ingestion hooks are supplied by S26;
  other transport hooks by S15; video container processing belongs to S22.
- **Brief:** bounded voice-note transcription/capture with text fallback, then
  exact-response TTS/translation and optional realtime/meeting/ambient modes.
  No automatic always-listening, unconsented voice cloning or calling authority.
- **Contracts/deps:** consumes K2–K6, S26 accessibility/mobile, S12 meeting context,
  S15 Discord for voice rooms and S06 deletion/recall; provides timestamped audio
  evidence/transcript references and stop-aware speech sessions.
- **Acceptance:** June captures a real authorized note; ambiguous amount/name/date
  requires clarification before an effect. Verify unsupported/long audio, missing
  STT account, deletion, barge-in/reconnect and chosen output audience. Transcript
  is not source truth. Global prompts; Oracle for capture/retention/streaming effects.
- **Decisions:** D3/D4/D6 STT/TTS provider, price, retention; D8 participant/recording
  rules before meetings/ambient. Text fallback remains available while blocked.

### S17 — browser execution and secure takeover

- **Features/waves:** F062 (2), F061 (3).
- **Owned paths:** `src/browser/`, `src/tools/{browser,browser-proposals}.ts`.
- **Brief:** fix secret-safe takeover/PIN intake compatibility first, then one
  task-bound browser pilot with origin/account/effect restrictions. No unrestricted
  owner's desktop, public admin preview, automatic bot-wall bypass or shopping
  permission inferred from login.
- **Contracts/deps:** consumes K2–K6, S01 readiness, S19 verified VM, S20 transfer;
  provides `BrowserTask.preview/run/inspect/takeover` and exclusive session lease.
  S01 owns durable-intake changes, C02 runtime command routing, C01 HTTP mounting,
  S03 secret-input/credential handling and S23 artifact-PIN behavior.
- **Acceptance:** human takeover suspends automation, secret fields never enter
  intake/journals/screenshots, redirect/cross-origin submission is rechecked,
  uncertain form submission cannot retry. June explains missing auth/help state
  without seeing secrets. Inspect safe UI captures; global prompts and Oracle
  required for browser/takeover/security changes.
- **Decisions:** D2/D5/D6 pilot origins/accounts/host; no personal browser attachment
  or credential import without explicit authorization.

### S18 — devices and developer-facing clients

- **Features/waves:** F064 (3), F063/F066/F093 (5).
- **Owned paths:** `src/devices/`, `clients/desktop/`, `clients/cli/`,
  `clients/editor/` (new).
- **Brief:** exact enrolled remote resource leases first; only then purpose-limited
  desktop/sensor access and authenticated CLI/editor clients. No treating SSH as
  isolation, hidden screen access or unauthenticated localhost control plane.
- **Contracts/deps:** consumes K2–K6, S17 takeover, S19 provider lifecycle, S26
  mobile/web APIs, S15 external entry points and S19 coding handoff. Provides
  signed device identity/presence and revocable resource leases.
- **Acceptance:** real paired disposable device can be revoked; wrong host key,
  replayed lease and unselected window/resource fail. June sees blocked prerequisites
  and purpose/expiry; emergency stop fences new effects. Inspect affected client
  states. Global prompts; Oracle required for pairing, sensors and host access.
- **Decisions:** D5/D8 gate the entire new device-control implementation; D4 for
  sensor retention. Dedicated surfaces recommended, not assumed authorization.

### S19 — environments, terminal jobs and coding handoff

- **Features/waves:** F067/F071 (2), F068/F070 (3).
- **Owned paths:** `src/environments/`, `src/coding/`, `src/runtime/coding.ts`,
  `src/tools/e2b.ts`, `sandboxes-site/`.
- **Brief:** prove the existing reusable environment on the chosen host; improve
  verified coding handoff; then provider lifecycle and worker-owned terminal jobs.
  No native-host sandbox claim, provider fallback after unknown cleanup or
  workspace checkpoint presented as rollback of external effects.
- **Contracts/deps:** provides environment/resource lifecycle and job artifact
  references; consumes K2–K7, S01/F006, S20 files and S05 audit/views. Idle compute
  tuning for S04 stays in this stream's files.
- **Acceptance:** real VM command and browser output survive disk reuse, not live
  process persistence; stop proves descendants/cgroup settlement and billing
  ownership. Missing KVM and teardown uncertainty stay visible to June. Deliver
  a real diff/report/file via the coding path without automatic push authority.
  Global prompts, companion verification and Oracle for lifecycle/isolation.
- **Decisions:** D5 host/provider, D3 spend, D6 credentials; no enabling reusable
  E2B until its actual teardown contract qualifies.

### S20 — private file ingress and delivery

- **Features/waves:** F069 (2).
- **Owned paths:** `src/files/` (new), `src/tools/slack-bot.ts`.
- **Brief:** bounded checksummed signed transfer and source-bound storage/delivery
  beyond 48 KiB, with quotas, retention and derivative registration. Preserve the
  rest of Slack bot tools; no arbitrary path/URL read, public download shortcut or
  authorization from possession of a file reference.
- **Contracts/deps:** provides K6; consumes K2–K5/K7, with root/Slack ingress wiring
  through C01/S26. Domain modules own parsers, not this storage service.
- **Acceptance:** June receives and returns an actual >48 KiB file; wrong audience,
  expired link, checksum mismatch, interrupted upload, quota limit and malware/type
  rejection fail clearly. Deletion reaches derivatives; a lost delivery response
  retains one operation. Global prompts and Oracle for transfer/storage boundaries.
- **Decisions:** D4 retention/processor policy, D3 quota/cost; use owner-approved
  disposable files until backup/restore gate permits expanded personal retention.

### S21 — documents and Office deliverables

- **Features/waves:** F073/F074 (2, creation after skill/file prerequisites).
- **Owned paths:** `src/documents/` (new).
- **Brief:** sandboxed PDF/OCR/document/EML/archive extraction with citations, then
  DOCX/XLSX/PPTX/PDF/CSV creation/edit/export with real render/formula checks.
  No treating document text as instructions, successful serialization as good
  layout, silent decryption or unsafe archive extraction.
- **Contracts/deps:** consumes K3–K6, S08/F055, S19 isolated parser execution;
  provides bounded cited document fragments and versioned deliverable manifests.
  S23 owns HTML/board rendering; C01 approves dependency additions.
- **Acceptance:** June processes a scanned page, an ordinary document and an
  unsupported/encrypted file honestly; oversized/traversing archives remain
  bounded. Return actual edited files, independently check formulas/citations
  and inspect rendered pages/slides. Global prompts; Oracle for parser/execution/
  disclosure boundaries, normal review for narrow output formatting.
- **Decisions:** D4/D6 OCR processors/licenses, D5 parser environment; no new
  parser package selected just because the research mentions a competitor skill.

### S22 — image and extended media

- **Features/waves:** F075/F076 (3, need-led earlier only after prerequisites).
- **Owned paths:** `src/media/` (new).
- **Brief:** provider-neutral bounded image generation/editing, then timestamped
  long audio/video processing and optional video/music synthesis. Distinguish
  current keyframe vision from full transcription/comprehension. No silent paid
  fallback, copied credentials, fabricated coverage or publication without authority.
- **Contracts/deps:** consumes K3–K6, S16/F043; provides generated assets and
  timestamp/coverage manifests. Uses S16 audio transcription rather than duplicating
  STT. C01 owns runtime registration of any provider mechanism.
- **Acceptance:** June can generate/edit through the owner's authorized mechanism,
  inspect cost/prerequisites, return real files and report omitted media intervals.
  Inspect images/video outputs, alpha if relevant, and unsupported-provider paths.
  Global prompts; Oracle for paid effects, provider disclosure and retention.
- **Decisions:** D3/D4/D6 select permitted providers/entitlements; runner `paint`
  preference is not proof that June's deployment has that subscription/runtime.

### S23 — hosted apps, artifacts and panels

- **Features/waves:** F072/F077/F078 (3).
- **Owned paths:** `src/apps/`, `src/artifacts/`, `src/core/web-embed.ts`.
- **Brief:** extend current verified HTTP app lifecycle and private visual outputs;
  add typed action panels only behind host-confirmed intents. Preserve CSP,
  blocked external resources and audience-bound assets. No engine-wide credentials,
  implicit public publication, or WebSocket/actor support without isolation review.
- **Contracts/deps:** consumes K2–K7, S19 VM, S27 backup, S21 documents; provides
  render/deployment/action-card interfaces consumed by S14/S26. S17 supplies
  secret-safe takeover pattern; this stream owns artifact-PIN implementation.
- **Acceptance:** June creates/queries/updates a panel, sees stale data and exact
  action confirmation; unauthorized viewers/actions fail. Real app unknown/rollback/
  expiry cases preserve data and receipts. Inspect private previews and verify
  separate app-host readiness. Global prompts; Oracle for hosting/isolation/actions.
- **Decisions:** D2/D4/D5 for data, publication and hosting; do not call current
  node-local storage durable disaster recovery before S27's proof.

### S24 — specialists, shared authority and optional tenancy

- **Features/waves:** F079/F083/F084 (3), F082 (5).
- **Owned paths:** `src/specialists/`, `src/tenancy/` (new).
- **Brief:** typed bounded specialist roles/handoffs/fan-in and explicit shared
  identities, then capability negotiation; true multi-owner isolation only after
  a separate decision/design. Profiles cannot expand tools or alter June's global
  public-safe personality. No free-spawning swarm or tenants sharing private stores.
- **Contracts/deps:** provides specialist ownership/result/lease contracts; consumes
  K1–K5/K7, S08 skills/templates, S06 shared knowledge, S27 export. C02 alone edits
  execution actors/queues; S03 alone changes principals/policy.
- **Acceptance:** June assigns two distinct tasks, receives attributable fan-in,
  cancels descendants and cannot reassign unsettled resources. Role activation
  cannot broaden grants; shared membership revocation blocks later disclosure.
  Before F082, prove separate principals/stores/credentials/quotas in staging.
  Global prompts and Oracle required for ownership, identity and tenancy.
- **Decisions:** D2/D6 group/service-account authority; D1/D8 block F082, not the
  single-owner bounded specialist improvements.

### S25 — calls, commerce and human handoff

- **Features/waves:** F030 read-only (3), F085–F088 (4), F089/F090 (5, separate pilots).
- **Owned paths:** `src/concierge/` (new), with call/payment/case adapters kept separate.
- **Brief:** first compute sourced financial/admin summaries from selected
  statements/invoices without payment APIs. Narrow calls and exact checkout precede shopping,
  booking, refund/dispute cases and optional human/API-payment escalation. No
  unrestricted bank credentials, invented dispute facts, trading/lending authority,
  large-scale outreach or human work labeled autonomous AI.
- **Contracts/deps:** consumes K2–K7, S10/S11 mail/contacts, S12 calendar, S16
  voice, S17 browser, S21 financial documents, S05 workboard and S08 catalog.
  Provides call/charge/order/case/handoff receipts with distinct unknowns.
- **Acceptance:** for F030, June inspects sourced summaries; independently check
  calculations and prove the same read grant cannot send money. For later slices,
  June previews exact recipient/objective/recording or price/fees/
  recurring terms; permitted disposable/low-value pilot yields provider and
  counterpart receipts. Lost charge or call response blocks retry; cancel/refund/
  human-return is tracked separately. Global prompts and Oracle required throughout.
- **Decisions:** D2/D3/D4/D6/D8 block live consequential work and provider-specific
  implementation until ceilings, recipients, disclosures, recording rules, merchant
  scope and service ownership are chosen. F030 needs only its separate D4/D6
  data-enrollment decision, not a call/payment mandate. No pilot budget is invented.

### S26 — accessible clients, enrollment and discovery

- **Features/waves:** F094/F095/F102 (2), F091/F092 (3).
- **Owned paths:** `src/onboarding/`, `clients/web/`, `clients/mobile/` (new),
  `src/console/` except `connections.ts`, `connection-oauth.ts`, `usage.ts`, and
  existing `src/channels/slack*.ts`.
- **Brief:** first useful read-only task, actionable missing-prerequisite cards,
  accessible/localized interaction and truthful generated discovery docs; then
  authenticated conversation workspace and PWA-first mobile capture. No duplicate
  operator console authority, secret notification previews or native app by default.
- **Contracts/deps:** consumes K0–K9, S05 economics/status, S20 files and S16 voice;
  provides `OnboardingService.inspect/nextStep` and authenticated client views.
  S03 owns OAuth/consent; C01 integrates root docs, listeners and manifests.
- **Acceptance:** from Slack June explains one missing key/account and leads to
  authorized setup without receiving a secret; cancellation/denial stays blocked.
  Real voice/file/task route works after enrollment. Check keyboard/screen reader,
  locale/timezone, reduced motion, hidden push previews and offline deduplication.
  Inspect UI captures. Global prompts; Oracle for client auth/enrollment/data flow.
- **Decisions:** D1 pilot, D6 enrollment, D8 native-app versus PWA; Slack-first
  accessibility and truthful docs do not wait for a mobile-product decision.

### S27 — export, off-host backup and restore

- **Features/waves:** F097/F098 (2, ordered after retention/files).
- **Owned paths:** `src/portability/` (new), `src/memory/backup.ts`,
  `scripts/deploy/restore/` (new).
- **Brief:** scoped versioned exports distinct from encrypted off-host backup;
  then isolated restore drills with deletion replay and unknown-work reconciliation.
  No secrets by default, public-link substitute for transfer, live replacement by
  a model or conversation rollback to roll back code.
- **Contracts/deps:** consumes K3/K5/K6/K7, S06/F050, S01/F006. Provides
  `ExportService.prepare/inspect` and `RestoreService.preflight/inspect` plus
  versioned manifests that S07/S08/S23 use. Operator replacement stays separate.
- **Acceptance:** June requests selected export and inspects checksums/coverage;
  restore into isolated staging proves authenticity/version compatibility,
  deletion tombstones and held active/unknown work. Wrong key/corruption/old schema
  fails closed. Verify actual off-host recovery, not a second local file. Global
  prompts and Oracle required for backup/storage/migration.
- **Decisions:** D4 data scope/retention and D5 approved off-host destination/key
  custody; production replacement needs explicit operator ownership/authorization.

### S28 — household, health, learning and specialist packs

- **Features/waves:** F104–F107 (5).
- **Owned paths:** `src/packs/`, `skills/packs/` (new). `skills/packs/` is explicitly
  excluded from S08's `skills/` ownership from the start.
- **Brief:** build only selected reviewed packs: reversible household/media state,
  explicitly selected health metrics, cited learning, or validated professional/
  creative workflows. No automatic locks/alarms, diagnosis, trading, refusal-removal
  skill or heavy compute without distinct authority.
- **Contracts/deps:** consumes K2–K6, S08 SDK/library, S18 devices/sensors, S12
  calendar, S06/S07 knowledge, S19 VM, S21 documents and S22 media as applicable.
  Provides versioned pack manifests using the same grants, not core bypasses.
- **Acceptance:** June discovers a selected pack, explains each missing prerequisite,
  runs one real authorized chore and honors revoke/delete/budget. Validate computed
  claims/citations and physical-action confirmation, not just catalog installation.
  Global prompts; Oracle for health/device/security/financial boundaries.
- **Decisions:** D8 recurring use and maintainer blocks each pack; D2–D6 apply to
  its actual actions/data/providers. No automatic commitment to the entire catalog.

## Feature coverage and precise release dependencies

Exactly one primary stream owns each F-ID. Helpers keep their own files and
provide contracts; they do not become additional feature owners. Dependencies
below preserve the report's edges; `base` means verified existing infrastructure.
Every feature also consumes C01/C02, the global completion contract and the P0
floor before **expanding** authority or retention. An entry spanning waves is a
deliberate read/preview first, consequential action later, not an omitted feature.

Every F013 dependency below inherits the owner override: it requires honest
usage/resource behavior for configured inference and built-in tools, not a model
cap, price estimate, billing attestation or new budget database. Autonomous
purchases/orders/transfers/new financial commitments remain prohibited.

| Feature | Primary | Wave | Feature prerequisites |
| --- | --- | --- | --- |
| F001 | S01 | 1 | base |
| F002 | S02 | 1 | F001 |
| F003 | S02 | 1 | F002 |
| F004 | S05 | 1 | F001, F002, F003 |
| F005 | S02 | 1 | F002 |
| F006 | S01 | 2 | F001, F002, F004 |
| F007 | S03 | 1 | F002 |
| F008 | S03 | 1 | F007 |
| F009 | S06 | 2 | F008 |
| F010 | S03 | 1 | F007, F008 |
| F011 | S05 | 1 | F004, F007 |
| F012 | S03 | 1 | F001, F008 |
| F013 | S04 | 1 | F001, F002 |
| F014 | S04 | 3 | F008, F012, F013 |
| F015 | S04 | 2 | F013 |
| F016 | S04 | 2 | F013, F004 |
| F017 | S04 | 3 | F013, F014 |
| F018 | S05 | 1–2 | F004, F011, F013 |
| F019 | S10 | 2 | F007, F008, F010, F013 |
| F020 | S10 | 3 | F019, F011, F069 |
| F021 | S10 | 3 | F019, F020, F003 |
| F022 | S10 | 3 | F019, F020, F008 |
| F023 | S11 | 2 | F019, F007, F003 |
| F024 | S10 | 3 | F020, F023, F040 |
| F025 | S12 | 2 read / 3 write | F005, F007, F008 |
| F026 | S12 | 3 | F020, F023, F025 |
| F027 | S13 | 2 | F002, F005, F007 |
| F028 | S12 | 3 | F019, F023, F025, F073 |
| F029 | S11 | 3 | F023, F025, F027, F049 |
| F030 | S25 | 3 read-only | F019, F073, F074, F012 |
| F031 | S14 | 2 | F003, F019, F025, F027 |
| F032 | S14 | 3 | F003, F013, F019 |
| F033 | S13 | 3 | F002, F007, F013, F027 |
| F034 | S14 | 2 | F002, F005, F007, F013 |
| F035 | S14 | 3 | F004, F005, F034 |
| F036 | S14 | 3 | F055, F056, F061, F062 |
| F037 | S15 | 3 | F001, F002, F007 |
| F038 | S15 | 3 | F037 |
| F039 | S15 | optional 2 | F001, F002, F007, F008 |
| F040 | S15 | 3 | F019, F020, F023 |
| F041 | S15 | 5 | F037, F038, F039 |
| F042 | S15 | 3 | F007, F008, F081, F084 |
| F043 | S16 | 2 | F069, F012, F007 |
| F044 | S16 | 3 | F043, F013, F094 |
| F045 | S16 | 4 | F002, F043, F044, F092 |
| F046 | S16 | 5 | F028, F038, F043, F007 |
| F047 | S16 | 3 | F043, F044, F094 |
| F048 | S16 | 5 | F009, F012, F043, F049, F092 |
| F049 | S06 | 2 | F009, F012, F013 |
| F050 | S06 | 2 | F009, F049 |
| F051 | S06 | 3 | F007, F009, F050 |
| F052 | S07 | 3 | F002, F009, F013, F050 |
| F053 | S07 | 3 | F008, F009, F069, F073 |
| F054 | S13 | 3 | F033, F050, F003 |
| F055 | S08 | 2 | F007, F010, F013 |
| F056 | S08 | 3 | F055, F050, F034 |
| F057 | S08 | 3 | F010, F055, F056 |
| F058 | S08 | 3 | F034, F055, F057, F097 |
| F059 | S08 | 3 | F007, F010, F055 |
| F060 | S09 | 2–3 | F007, F008, F010, F095 |
| F061 | S17 | 3 | F007, F008, F010, F067, F069 |
| F062 | S17 | 2 | F008, F001 |
| F063 | S18 | 5 | F007, F008, F010, F062 |
| F064 | S18 | 3 | F007, F008, F067, F068 |
| F065 | S03 | 3 | F008, F062 |
| F066 | S18 | 5 | F009, F012, F063, F092 |
| F067 | S19 | 2 | F001, F006, F010, F013 |
| F068 | S19 | 3 | F067, F013 |
| F069 | S20 | 2 | F007, F009, F010, F013 |
| F070 | S19 | 3 | F002, F067, F069 |
| F071 | S19 | 2 | F004, F011, F069 |
| F072 | S23 | 3 | F007, F010, F013, F067, F097 |
| F073 | S21 | 2 | F010, F069 |
| F074 | S21 | 2 | F069, F073, F055 |
| F075 | S22 | 3 | F008, F012, F013, F069 |
| F076 | S22 | 3 | F043, F069, F075 |
| F077 | S23 | 3 | F069, F074 |
| F078 | S23 | 3 | F007, F011, F072, F077 |
| F079 | S24 | 3 | F002, F007, F013, F055 |
| F080 | S05 | 3 | F004, F033, F079 |
| F081 | S05 | 3 | F002, F004, F079 |
| F082 | S24 | 5 | F007, F008, F009, F097 |
| F083 | S24 | 3 | F007, F008, F051 |
| F084 | S24 | 3 | F055, F058, F079, F083 |
| F085 | S25 | 4 | F007, F013, F023, F043, F044 |
| F086 | S25 | 4 | F007, F008, F010, F011, F013 |
| F087 | S25 | 4 | F025, F061, F085, F086 |
| F088 | S25 | 4 | F020, F030, F085, F086 |
| F089 | S25 | 5 | F007, F011, F013, F080 |
| F090 | S25 | 5 | F013, F057, F086 |
| F091 | S26 | 3 | F007, F011, F069, F095 |
| F092 | S26 | 3 | F091, F043, F007 |
| F093 | S18 | 5 | F091, F064, F071, F042 |
| F094 | S26 | 2 | F003, F005 |
| F095 | S26 | 2 | F001, F007, F008, F018 |
| F096 | S01 | 3 | F006, F091, F095 |
| F097 | S27 | 2 | F009, F050, F069 |
| F098 | S27 | 2 | F006, F009, F097 |
| F099 | S07 | 3 | F052, F055, F058, F097 |
| F100 | S01 | 5 | F006, F067, F096, F098 |
| F101 | S03 | 1 | F008, F012, F013 |
| F102 | S26 | 2 | F001, F095 |
| F103 | S09 | 3 | F060, F007, F055 |
| F104 | S28 | 5 | F007, F059, F064, F066 |
| F105 | S28 | 5 | F009, F012, F025, F066 |
| F106 | S28 | 5 | F049, F053, F055, F074 |
| F107 | S28 | 5 | F055, F057, F067, F074, F076 |
| F108 | S08 | 5 | F057, F058, F011, F101 |

Additional integration gates are intentional: F061 waits for F062's safe takeover;
document parsers/scripts require a verified isolated execution path (F067 or a
separately reviewed existing equivalent), and **expanded retained personal data**
requires F097/F098. That last gate does not make F009/F049/F050/F069 impossible:
develop and verify them against existing enrolled evidence and disposable selected
files, then prove export/restore before retaining additional real personal sources.
No stream waits for all 108 features or all of another stream's later tranches.

F030 belongs to S25 as a **separate read-only wave-3 slice**: use S21's verified
statement/invoice extraction to compute sourced subscription/anomaly summaries;
expose June-callable inspection with K3/K4/K5 and no payment APIs. Independently
check calculations against a selected statement and prove that the same grant
cannot send money. D4/D6 gate financial-data enrollment; D2/D3 call/payment choices
must not unnecessarily block this read-only work. Oracle reviews data boundaries.

## Owner decisions are scoped blockers, not silent defaults

The report's five ranked questions are D1–D5. D6–D8 retain its follow-up choices.
Recommendations below are proposals, not decisions already made by Raygen. Record
an authenticated decision in the relevant stream note without copying private
answers or credentials into Git. A decision can name a private policy reference.

| ID | Decision needed | Recommended starting point; affected blocked slices |
| --- | --- | --- |
| D1 | Three real chores, primary channel, single-owner versus team success | Voice capture → list, inbox/calendar brief, reviewed follow-up; Slack-first single owner. Gates pilot definition in S10/S12/S13/S14/S16/S26, all new transport choice in S15, and S24 tenancy. Does not block P0 hardening. |
| D2 | Standing authority and exact-approval/forbidden actions | Preserve existing grants; new accounts start read-only/drafts, then narrow recipients/resources/effects. Gates new S03 grants, S10 send/triage, S11 sharing, S12 writes, S17 browser effects, S23 panel actions, S24 service identities and S25 transactions. |
| D3 | Transaction authority versus configured tool use; latency quality floor | Corrected at 13:47:13 UTC: prohibit autonomous purchases/orders/transfers/new financial commitments, such as DoorDash. Configured inference and built-in tools (including TinyFish/Tavily/E2B) are permitted under existing grants, without billing classification, account audits or no-charge attestation. No new account, transaction authority or budget database is approved. Keep actual provider quotas/rate limits, bounded concurrency, honest analytics, privacy, cancellation and foreground responsiveness. |
| D4 | Source retention, processors/regions/training policy, deletion and backup limits | Selected sources, minimal retention, no ambient capture, approved processors, tombstones. Gates new retained data/embeddings/voice/financial/health inputs in S06/S07/S10/S16/S20/S22/S27/S28 and provider choices in S03/S04. |
| D5 | Trusted execution location, personal-device reach, API versus browser fallback | Verify existing isolated host and recovery first; no personal desktop by default. Gates changed S01/S19 infrastructure, S17 browser pilot, S18 device implementation, S21 parser backend, S27 off-host restore target and concierge execution route. |
| D6 | Exact provider accounts, OAuth scopes, entitlements and first non-Slack transport | Select Gmail/Calendar scopes explicitly; preserve Slack manifest restrictions; credential values use existing private enrollment. Gates provider-specific enrollment/implementation in S03/S04/S09/S10/S12/S15/S16/S22/S25, and selected knowledge/financial sources in S07/S25. |
| D7 | Timezones, quiet/urgent policy, missed runs and useful notification cadence | Confirm the owner's IANA zone, retain per-schedule zones, preview DST and explicitly choose catch-up/urgent rules. Gates changed defaults in S02/S12/S14, not deterministic previews or existing behavior. |
| D8 | Which optional branches have a real use case, maintainer, total cost and removal path? Include recording/recipient disclosure, human escalation, private catalog versus public creators, payouts/managed hosting and PWA versus native | Private reviewed library and PWA before marketplace/native product. Blocks S18 device-control scope, S28 packs, S25 human/paid-service pilots, S16 meeting/ambient capture, S24 tenancy, S08 creator economics, S01 managed packaging and S15 broad SDK until specifically chosen. |

**Whole lanes initially parked for owner scope:** S15 new transports, S18 devices,
S28 specialist packs, and S25 consequential/provider-specific work. S25/F030 may
proceed once its separate financial-data decision exists. All other streams can
start their nonblocked foundations when technical dependencies land, but affected
subfeatures cannot ship on guessed consent/budget/privacy. Missing API keys are
resolvable prerequisite blocks, not a reason to hide a shipped capability.

Uncertain competitor claims are not implementation requirements. Before selecting
an adapter/workflow, verify its current authoritative API, account/region/plan and
license. The report's unresolved Muse calling, Gemini rollout, Copilot entitlement,
Poke channels, Instinct API, Hark voice, OpenAI task/portability and OpenBot drift
questions stay research qualifications; no worker should build parity with an
unverified marketing claim or silently assume all named catalog services work.

## Coordination and shipping protocol

1. **One worktree and one writer per stream.** Follow current AGENTS.md startup:
   inspect status, fetch, create a fresh isolated worktree from remote main and
   fast-forward its configured upstream. Never switch another session's checkout.
   Linked worktrees may need a uniquely named local tracking branch because Git
   cannot check out `main` 30 times; it is a disposable checkout label, not a
   feature-branch/PR workflow. Publish only with `git push origin HEAD:main`.
   An explicitly provisioned clean tracking worktree is already isolated.
2. **Claim a slice, not the entire roadmap.** Record agent/worktree, exact owned
   paths, F-ID, consumed contract versions and deployment owner in the stream note.
   C01 owns this index; per-stream notes avoid a shared status-table conflict.
   Do not launch replacement workers while a prior operation/agent is unknown.
3. **Cross-owner changes are requests.** Send the file owner the required symbol,
   input/output, reason, compatibility impact and reproducing acceptance case.
   They land the smallest backward-compatible contract update; consumer rebases.
   If one atomic commit needs both owners, explicitly lease the exact paths to
   one writer, inspect the combined diff, and record return of ownership. No
   concurrent edits, opportunistic formatting or silent ownership transfer.
4. **Publish vertical increments.** Module code, registry slot, runtime knowledge,
   prerequisites, manual verification and required configuration form one usable
   slice. Avoid publishing unavailable implementations as complete. Missing
   credentials must still have a real callable inspection/setup journey. Do not
   batch unrelated finished increments or alter all prompts for one feature.
5. **Rebase, do not freeze main.** Format/lint/typecheck and relevant real checks;
   inspect `git diff --check` and changed paths; commit a small Conventional Commit.
   Immediately fetch remote main and rebase the unpublished commit onto it; rerun
   affected checks. Normal push only. If rejected, fetch/rebase again, never force
   push or impose a publication hold. Do not include another session's work.
6. **Review where risk lives.** Oracle reviews the intended behavior and exact
   diff for larger/high-impact increments and mandatory domains above. A changed
   durable schema needs forward/backward-reader/rollback discussion before code;
   obtain owner approval for irreversible migrations or published API changes.
   Fix material findings before shipping, without adding arbitrary review gates.
7. **The publisher owns deployment follow-up.** Record exact SHA, push time,
   affected services and feature evidence source. Immediately inspect `june/deploy`
   and controller receipts, not only `june/build`. If not verified, load
   `building-schedules`, read the same thread's schedule, prefer an available
   deployment event, otherwise persist a five-minute follow-up preserving every
   unverified SHA. Do not overwrite unrelated scheduled work or delegate by silence.
8. **Verify actual activation.** Follow [deployment.md](deployment.md) and
   `debugging-june`: fresh HTTP 200 `ready:true`, loaded revision matched to
   MainPID/release directory, settled cutover and intake forwarding to that slot.
   A verified descendant may deliver a superseded SHA; prove ancestry. Verify
   debug/apps/sandbox/controller companions independently. An unchanged-input
   skip needs actual inputs and receipt; never relabel an old process new.
9. **One live operator at a time.** S01 coordinates shared app/controller windows;
   the affected stream owns its companion result. Obtain explicit handoff from
   any recovery/operator owner and use documented locks. Never change config
   concurrently with deployment, clear another hold, restart unrelated services,
   restore old conversation data or bypass a failed policy pin. Deployment locks
   serialize live mutation, not Git publication.
10. **Close on evidence or a concrete owner blocker.** Record live feature outcome,
    actual revision/time and companion results; clear deployment-only schedules
    after verified completion. At failure/block or 30 minutes pending, investigate
    and report the next action while preserving recovery ownership. Continue while
    progressing; stop only under AGENTS.md's completion/cancellation/handoff/owner-
    blocker rules. Public notes exclude credentials, private conversations,
    signed login URLs and raw snapshots.

## Pilot exits make the plan falsifiable

- **Safety exit (wave 1):** dated F001 ledger; stopped/revoked work cannot start
  another effect; ambiguous effects stay held; quiet policy suppresses duplicate
  noise; configured tools/inference work without billing-attestation gates while
  autonomous purchases/orders/transfers/new financial commitments remain prohibited;
  hostile source/recipient substitution
  fails; all actual prompt paths carry correct knowledge and no extra authority.
- **Day-assistant exit (wave 2):** after D1–D7 and export/restore, run the report's
  proposed two-week owner pilot: real voice note → one task → sourced brief/prep.
  Include missing-source days, correction, quiet day, stop and actual cost. Owner
  decides whether attention saved justifies expansion; no universal numeric SLA.
- **Admin exit (early wave 3):** draft edit/send, recurring-event exception,
  attendee change, duplicate webhook, mailbox disconnect, expired OAuth,
  malformed file, post-send network loss and ambiguous browser submission all
  have honest receipts. Source/recipient disclosure is host checked.
- **Reusable-work exit (later wave 3):** one reviewed learned procedure passes
  held-out real cases, pins a revision, survives restart/correction and can be
  disabled/exported. Specialists have no resource collision; shared templates and
  panels contain no private state. No duplicate continuation owner.
- **Concierge/long-tail exit (waves 4–5):** an owner-selected real chore completes
  within chosen authority/cost/disclosure rules, with provider/counterpart and
  cancellation/refund evidence. Each optional branch has a maintainer/removal
  path; a successful demo alone does not authorize expansion.

This plan's publication changes documentation only. It does not implement any
feature, enroll any provider, decide the open questions or certify current live
capabilities. Its own deployment follow-up is separate from the future streams'
feature acceptance and must not be reused as their evidence.
