# Parity implementation roster

Coordinator: [parity implementation thread](https://ampcode.com/threads/T-01a124f5-c5f2-73d6-88dc-f3674cfba9a2).
Last reconciled: 10 October 2026, 11:55 UTC.

The owner authorized implementation of the [build plan](../parity-build-plan.md)
with GPT-6 Astra Max stream owners. This roster records dispatch and evidence;
it does not grant provider consent or replace the plan's exact path ownership,
feature dependencies, acceptance checks or D1–D8 decisions.

## Current funding policy overrides earlier D3 proposals

Existing authorized subscription/included inference has no artificial token quota,
model-use dollar cap or missing-price gate, including useful background work.
Provider limits/backoff, bounded concurrency, cancellation, recovery fences and
foreground responsiveness still apply. Do not create purposeless model loops or
report unknown usage/cost as zero.

Owner-funded external spending is prohibited now, including through Stripe Link.
Future owner-funded transactions require Stripe Link **and** fresh explicit
authorization; availability or login is not approval. No alternate saved cards,
paid fallback, quota purchases, top-ups, paid tool/compute provisioning, phone
charges, purchases or financial commitments are authorized. Separately metered
API billing ambiguity must be surfaced before charging; uncapped tokens do not
make those calls free. June-earned funds are only a possible future policy, not
permission to earn, transact, spend or relabel owner funds/credits now.

The proposed production `budgets.sqlite` schema is not approved. S04 implements
shared static funding policy and honest inspection, not that ledger. Actual route
guards belong to C01 (model provider), S03 (broker/MCP and a narrow Tavily search
lease) and S19 (E2B allocation). No global spending fence is accepted until the
actual dispatch paths are verified. Other scoped consent/retention/device/provider
decisions remain; lack of new D3 limits does not block included inference.

## Delivery states are separate

For each shipped slice, the stream note records the implemented F-ID subset,
published commit, enrolled prerequisites, enabled configuration, loaded service
revision and dated June-facing workflow evidence separately. A source registration,
passing build, healthy process or worker assertion is not feature acceptance.
Partial coverage stays partial. An existing capability is not a new parity delivery.

Eight implementation threads have launched. C02 published the inert K8 knowledge
slots in [`5d4cacd`](https://github.com/lordbagel42/agent/commit/5d4cacdb49d041e019aaf0743eb1ff8b12fd7ee0);
C01 published the strict contracts/configuration and 28 inert module slots in
[`74fdcef`](https://github.com/lordbagel42/agent/commit/74fdcefd3345addab273d9e4945416c7d25cc6ac).
Both source publications are verified; their publishers retain deployment
follow-up. All 108 F-IDs remain unaccepted by this implementation team. The earlier
plan/research commit was deployment-verified; that is not implementation proof.

## Launches and working arrangements

All builders use `gpt-6-astra-max` on `homelab-amp`, one isolated worktree
each. Worktrees were created from freshly fetched remote `main`: the first at
[`d231f30`](https://github.com/lordbagel42/agent/commit/d231f3027c4ecca02d05cdb4dfac54f9f691820b)
and S02/S04 at [`073ff35`](https://github.com/lordbagel42/agent/commit/073ff35c4f13b146362e81b38eb427607c3b92a1);
S14/S19 subsequently confirmed clean startup against current remote `main`,
not from the shared checkout's local `main` or another session's unpublished work.
Their local branches track `origin/main`; publication uses normal
`git push origin HEAD:main` after fetch/rebase and verification.

| Stream | Builder | Worktree suffix under `/home/amp/workspaces/` | Current slice |
| --- | --- | --- | --- |
| C01 | [contracts](https://ampcode.com/threads/T-01a1258c-a582-775f-902f-f9d0c03bcf89) | `agent-parity-c01-01a124f5` | Contracts/module slots published; additive model reply/root wiring and funding integration next. |
| C02 | [runtime](https://ampcode.com/threads/T-01a1258c-ae10-74e0-893b-da2169a07f1d) | `agent-parity-c02-01a124f5` | K8 slots published/handed off; C01 contracts now unblock bounded dispatch. |
| S01 | [readiness](https://ampcode.com/threads/T-01a1258c-b622-71e3-9bd3-54c461dca806) | `agent-parity-s01-01a124f5` | F001 truthful inspection using current evidence; no lifecycle/recovery rewrite. |
| S02 | [intent](https://ampcode.com/threads/T-01a12593-906a-73f6-8635-622f413619e6) | `agent-parity-s02-01a124f5` | Wakeup generations and truthful queued-only stop metadata; intent-only session hooks leased. |
| S03 | [authority](https://ampcode.com/threads/T-01a1258c-c2ca-77ec-8d87-00df03836d2d) | `agent-parity-s03-01a124f5` | Reviewed credential/action hardening; separate funding guards, no new grants or enrollment. |
| S04 | [funding policy](https://ampcode.com/threads/T-01a12593-978f-7054-afe7-27b0b3caf9c4) | `agent-parity-s04-01a124f5` | Static no-spend policy, uncapped included inference and honest provider coverage; no new store. |
| S14 | [workflow/research](https://ampcode.com/threads/T-01a125a1-4116-75d8-a052-220d1369fee1) | `agent-parity-s14-01a124f5` | F002 consumer support before later workflow/routine features. |
| S19 | [coding/compute](https://ampcode.com/threads/T-01a125a1-4b85-7079-811e-1abaad094046) | `agent-parity-s19-01a124f5` | Deny paid E2B allocation; coding F002 consumer support before later compute features. |

At launch the runner had 3 CPUs, 12 GiB RAM and about 1.2 GiB free disk. Matching
existing dependency trees are shared through local, Git-excluded symlinks and
treated as immutable. Heavy checks/builds serialize through one local resource
lock. Dependency changes require C01 coordination, renewed fingerprints and a
headroom check. This is not a Git publication lock. No other worktree, cache,
service or operator fence may be removed to make room.
At 11:46 UTC the coordinator measured 528 MiB free and load about 20 on 3 CPUs;
further launches/downloads await verified capacity. The parent subsequently
reported owner authorization for disk-only online growth using existing storage,
assigned to a [dedicated infrastructure owner](https://ampcode.com/threads/T-01a125a7-2e90-7701-8e72-6bf4eec43bbf).
This covers runner CT214, not June CT215, and authorizes no purchase, CPU change,
restart or shared cleanup. Parity does not perform that infrastructure work.

Start later owners when their first real slice is ready, not 30 agents producing
unavailable stubs. Existing non-parity owners retain their work. Each publisher
owns deployment follow-up until verified completion or an explicit handoff.

## All 30 streams retain one primary owner

`Queued` means not dispatched, not implementation-complete. Dependencies below
name the next frontier, not a requirement to finish a supplier's entire stream.
The build plan remains authoritative for all 108 feature edges and exact paths.
Every domain owner also gets its own module slot, prompt section and stream note
after C01/C02 handoff. The coordinator alone edits this roster.

| ID | Waves | Features | State / next technical frontier | Scoped decisions or ownership boundary |
| --- | --- | --- | --- | --- |
| C01 | 0, integration | K0/K2–K7/K9 | Inert contracts/slots published; root/model integration running. | No migration, dependency or provider decision implied. |
| C02 | 0, integration | K1/K8 | K8 published; K1 can consume published C01 contracts. | Preserve concurrent additive mind/WhatsApp/Slack integration. |
| S01 | 1/2/3/5 | F001/F006/F096/F100 | Running F001; then F002/F004 for recovery tranche. | D5/D8 for new hosting/packaging; existing recovery owners keep their fence. |
| S02 | 1 | F002/F003/F005 | Running intent tranche; consumes real F001 and K1, not an optimistic stub. | D7 gates changed quiet/catch-up defaults, not deterministic previews. |
| S03 | 1/3 | F007/F008/F010/F012/F065/F101 | Running existing-policy slice; F002 gates full new authority path. | D2/D4/D6 for new authority/accounts/processors; F065 also needs takeover. |
| S04 | 1/2/3 | F013–F017 | Running funding-policy/coverage slice; full claims need actual route guards. | Current D3 prohibits owner spend, not included inference; no ledger approval. |
| S05 | 1/2/3 | F004/F011/F018/F080/F081 | Queued after F001/F002/F003; source-scoped task projections first. | Do not take over debug incident; D3/D8 for new value/support commitments. |
| S06 | 2/3 | F009/F049–F051 | Queued; F008 then scoped deletion. | Existing mind owner review pending; D4 for expanded retention, D2 for sharing. |
| S07 | 3 | F052/F053/F099 | Queued behind deletion/recall and bounded files/parsers. | D4/D6 source/processor choice, D8 format priority. |
| S08 | 2/3/5 | F055–F059/F108 | Queued behind F007/F010/F013; reconcile mind skills boundary first. | D5 scripts, D8 public catalog/payouts; do not duplicate unpublished mind work. |
| S09 | 2/3 | F060/F103 | Queued behind authority/enrollment; existing HTTPS discovery first. | D6 provider scopes, D8 maintained adapter list. |
| S10 | 2/3 | F019–F022/F024 | Queued behind authority/spending-policy P0; ephemeral read before writes. | D2/D4/D6 account, scopes and retention; no mailbox enrollment inferred. |
| S11 | 2/3 | F023/F029 | Queued behind F019/F007/F003; ambiguous identity remains unresolved. | D2/D4/D6 sources/sharing. |
| S12 | 2/3 | F025/F026/F028 | Queued behind F005/F007/F008; availability before invitations. | D2/D6 provider/write scopes; D7 changed time defaults. |
| S13 | 2/3 | F027/F033/F054 | Queued behind F002/F005/F007; explicit local lists first. | Mind/reflection owner received included-inference policy; review hold and D1/D2/D4 remain. |
| S14 | 2/3 | F031/F032/F034–F036 | Running F002 workflow/research support; later routines still depend on intent/time/policy. | Preserve Rivet wrappers and uncertain receipts; no paid/background quota added. |
| S15 | 2/3/5 | F037–F042 | No parity builder; existing WhatsApp owner continues separately. | WhatsApp provider selected in its own task, enrollment missing; other transports D1/D6, SDK D8. |
| S16 | 2/3/4/5 | F043–F048 | Queued behind private files and policy/processor metadata. | D3/D4/D6 audio provider/cost/retention; D8 recording/ambient. |
| S17 | 2/3 | F061/F062 | Queued behind F008/F001; secret-safe takeover first. | D2/D5/D6 pilot origins/accounts/execution host. |
| S18 | 3/5 | F063/F064/F066/F093 | Parked for owner scope before device implementation. | D5/D8; D4 before sensor retention. |
| S19 | 2/3 | F067/F068/F070/F071 | Running E2B spending denial and coding F002 support; later compute remains gated. | Local BoxLite is separate; no paid fallback/provisioning, D5/D6 still scoped. |
| S20 | 2 | F069 | Queued behind F007/F009/F010/F013; disposable selected files first. | External storage spending prohibited; D4 retention/processors, no expanded retention before restore proof. |
| S21 | 2 | F073/F074 | Queued behind files/content barriers and verified isolated parser execution. | D4/D6 processor/license, D5 execution; dependency approval through C01. |
| S22 | 3 | F075/F076 | Queued behind policy/spending-denial/files; reuse S16 transcription. | D3/D4/D6 provider/entitlement/retention; runner image tools do not prove June eligibility. |
| S23 | 3 | F072/F077/F078 | Queued behind files/documents, VM and export prerequisites. | D2/D4/D5 actions/data/publication/hosting. |
| S24 | 3/5 | F079/F082–F084 | Queued behind intent/policy/spending-denial/skills; bounded roles first. | D2/D6 shared identities; D1/D8 before tenancy. |
| S25 | 3/4/5 | F030/F085–F090 | Parked; read-only F030 is distinct from consequential work. | Owner-funded spending prohibited even through Link; future Link + fresh approval, no earnings authorization. |
| S26 | 2/3 | F091/F092/F094/F095/F102 | Queued behind readiness/authority/time; Slack-first setup can precede mobile. | Preserve existing Slack owner's narrow hunks; D1/D6 enrollment, D8 native versus PWA. |
| S27 | 2 | F097/F098 | Queued behind deletion/recall/files and recovery evidence. | D4 data policy; D5 off-host destination/key custody. |
| S28 | 5 | F104–F107 | Parked until a pack/use case/maintainer is selected. | D8 plus each pack's actual D2–D6 actions/data/providers. |

## Existing owners are not duplicate parity builders

These are owner reports, not independently verified feature receipts. No local
commits or data from those threads have been imported by the parity coordinator.

- [Memory/mind owner](https://ampcode.com/threads/T-01a124b2-bc2f-713f-9020-770fefbe0e2b):
  local-only `src/mind/` and additive core/model/config/runtime integration;
  architecture review explicitly blocks publication. Reconcile S06/S08/S13
  boundaries after that review. Do not publish it under parity authorization.
- [WhatsApp owner](https://ampcode.com/threads/T-01a12483-df20-749d-8c00-1b0044114aa2):
  official API selected; source/drain/setup work remains local at this checkpoint.
  Owns narrow channel, config/startup, HTTP limit, inspection, prompt/registry and
  proxy-documentation hunks. Enrollment, credentials, webhook subscription and a
  real message remain missing; source support will not establish live parity.
- [Slack agent owner](https://ampcode.com/threads/T-01a1253a-9607-742f-a58a-5945ddfa021f):
  published manifest, Slack documentation and one shared operating-knowledge
  paragraph in [`52d965b`](https://github.com/lordbagel42/agent/commit/52d965ba128acb0026c48952d8cddc07e8d8f470).
  Reports live agent-view enablement, but `assistant:write` still needs installation
  approval. Runtime deployment monitoring stays with that owner; S26 onboarding
  is unclaimed and may proceed without touching the live Slack installation.
- [Rivet hardening owner](https://ampcode.com/threads/T-01a124a8-2974-728a-948f-47dc6b0b74d7):
  reports no live lock/fence or host mutation. Reserves timeout options, retry
  classification, lifecycle failure guard and serializer admission/lifetime
  wrappers; names/order and raw settlement stay intact. S02 owns intent-only
  `src/sessions/{catalog,runtime,state}.ts` body hooks outside those wrappers.
  S14/S19 coordinate their workflow/research/coding bodies directly. The separate
  archive prototype remains unshippable and has not been imported. A newly
  observed live failure has been escalated, not taken over by parity.

## Progression and evidence log

- **11:23 UTC:** C01/C02/S01/S03 launched; direct contract-owner communication
  established. Existing owner boundaries recorded. Next launch frontier is
  S02 intent and then S04 budget enforcement once the reviewed seams are usable.
- **11:27 UTC:** S03 narrowed its first increment to frozen exact broker actions
  across credential awaits and live connection rechecks before dispatch/result
  release. C02 and S01 requested concrete contracts directly from C01. These are
  implementation reports, not completed feature receipts. Coordinator format,
  lint and typecheck passed on the updated remote baseline.
- **11:31 UTC:** S02/S04 launched after the first contract agreement. K2 v1 uses
  scoped intent `{id, version}`, preserves unknown outcomes and distinguishes
  fenced from settled. S02 starts with existing wakeup generations, not a new
  store/scheduler. C01 reports strict static slots and protected module config in
  review; C02 is landing inert prompt slots before dispatch.
- **11:32 UTC:** fresh deployment observation for roster commit
  [`073ff35`](https://github.com/lordbagel42/agent/commit/073ff35c4f13b146362e81b38eb427607c3b92a1)
  still showed preparation; `june/build` passed, `june/deploy` remained pending.
  Old green June was ready and intake was settled/unpaused to that old revision.
  Coordinator retains a five-minute deployment-only follow-up; no success claimed.
- **11:35 UTC:** S03 reports disposable real MCP SDK/HTTPS reproduction of action
  mutation across credential waits and expiry-before-dispatch/disclosure defects,
  with hardening and compatibility controls in review. No source publication or
  feature completion claimed yet. Remaining F001 work is the truthful live ledger
  workflow and dated evidence, not making all future capabilities healthy.
- **11:40 UTC:** C02 published K8 v1 in
  [`5d4cacd`](https://github.com/lordbagel42/agent/commit/5d4cacdb49d041e019aaf0743eb1ff8b12fd7ee0).
  Coordinator inspected the actual 28 static slots and all-path loader changes;
  this is an inert extension point, not F001 completion. C02 owns deployment.
- **11:45 UTC:** coordinator observed roster revision
  [`073ff35`](https://github.com/lordbagel42/agent/commit/073ff35c4f13b146362e81b38eb427607c3b92a1)
  loaded in blue MainPID 1659647 but HTTP 503, `ready:false`. Config-derived intake
  was HTTP 200, unpaused/settled and forwarding to that nonready slot. Historical
  controller `healthy` is not fresh readiness. Parent/Rivet owner notified;
  coordinator and C02 retain their respective deployment follow-ups, no mutation.
- **11:48 UTC:** S14/S19 confirmed clean starts for assigned F002 support. S01
  reports real-reader missing-prerequisite/freshness controls, encrypted-store
  renewal control and seven prompt-path cases. C02 reports a real disposable
  durable-worker legacy baseline with one observation/delivery and settled work.
  S03 reports 53 disposable real-MCP controls and no Oracle blockers; publication
  remains pending. These local reports do not constitute production worker proof.
- **11:49 UTC:** latest funding policy distributed to the foundation owners and
  mind/reflection owner; S25 remains unlaunched with that policy recorded above.
  C01 owns plan/provider enforcement; S04 static policy; S03 Tavily/broker/MCP;
  S19 E2B. The production ledger and monetary effects remain unauthorized.
- **11:53 UTC:** roster revision's exact `june/deploy` check reports
  `action_required`. The existing downtime investigator's 11:52 controller read
  identifies incident 1022, `current_unhealthy`, phase `spawned`, assigned to
  [its recovery thread](https://ampcode.com/threads/T-01a125a6-e03b-7009-a278-4161faa850f6).
  Empty operator-hold/cutover fields do not remove that recovery fence. Parity
  remains read-only; settlement, readiness restoration and deployment are unproven.
- **11:55 UTC:** C01's published
  [`74fdcef`](https://github.com/lordbagel42/agent/commit/74fdcefd3345addab273d9e4945416c7d25cc6ac)
  was fetched and inspected. Domain module handoff now unblocks consumers; its
  inert budget contract is external-money-only, not an inference gate or a store.
  Fresh 11:54:48 UTC host observation still has the same nonready loaded revision
  and intake route, with controller `blocked:true` / `current_unhealthy`.
- **Pending:** C01 root/model wiring; C02 new dispatcher proof; S01 combined
  F001 receipt; first S03 hardening receipt; actual paid-route guards. Full F002
  requires consumer admission/settlement evidence, not merely queued-stop metadata.
  A production Slack worker probe still needs owner-authorized conversation/action.
  No P0 exit or global spending-enforcement claim is accepted.

The coordinator reconciles returned evidence with the actual commits, affected
paths, shared contracts and live receipts before accepting a feature or releasing
its dependents. A publisher's deployment-only timer stays with that publisher;
child completion messages, not duplicate polling schedules, advance this roster.
