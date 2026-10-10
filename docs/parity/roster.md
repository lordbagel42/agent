# Parity implementation roster

Coordinator: [parity implementation thread](https://ampcode.com/threads/T-01a124f5-c5f2-73d6-88dc-f3674cfba9a2).
Last reconciled: 10 October 2026, 11:27 UTC.

The owner authorized implementation of the [build plan](../parity-build-plan.md)
with GPT-6 Astra Max stream owners. This roster records dispatch and evidence;
it does not grant provider consent or replace the plan's exact path ownership,
feature dependencies, acceptance checks or D1–D8 decisions.

## Delivery states are separate

For each shipped slice, the stream note records the implemented F-ID subset,
published commit, enrolled prerequisites, enabled configuration, loaded service
revision and dated June-facing workflow evidence separately. A source registration,
passing build, healthy process or worker assertion is not feature acceptance.
Partial coverage stays partial. An existing capability is not a new parity delivery.

At this roster's initial checkpoint, four implementation threads have launched;
none has yet reported a published or live-verified parity increment. All 108 F-IDs
remain unaccepted by this implementation team. The earlier plan/research commit
was published and deployment-verified; that receipt is not implementation proof.

## Launches and working arrangements

All four builders use `gpt-6-astra-max` on `homelab-amp`, one isolated worktree
each. They were created from freshly fetched remote `main` at
[`d231f30`](https://github.com/lordbagel42/agent/commit/d231f3027c4ecca02d05cdb4dfac54f9f691820b),
not from the shared checkout's local `main` or another session's unpublished work.
Their local branches track `origin/main`; publication uses normal
`git push origin HEAD:main` after fetch/rebase and verification.

| Stream | Builder | Worktree suffix under `/home/amp/workspaces/` | Current slice |
| --- | --- | --- | --- |
| C01 | [contracts](https://ampcode.com/threads/T-01a1258c-a582-775f-902f-f9d0c03bcf89) | `agent-parity-c01-01a124f5` | Compatibility-preserving contracts, static module slots and strict composition. |
| C02 | [runtime](https://ampcode.com/threads/T-01a1258c-ae10-74e0-893b-da2169a07f1d) | `agent-parity-c02-01a124f5` | Agree contracts, then bounded dispatch/prompt slots and one real metadata inspection. |
| S01 | [readiness](https://ampcode.com/threads/T-01a1258c-b622-71e3-9bd3-54c461dca806) | `agent-parity-s01-01a124f5` | F001 truthful inspection using current evidence; no lifecycle/recovery rewrite. |
| S03 | [authority](https://ampcode.com/threads/T-01a1258c-c2ca-77ec-8d87-00df03836d2d) | `agent-parity-s03-01a124f5` | Existing-policy hardening and safe metadata; no new grants or enrollment. |

At launch the runner had 3 CPUs, 12 GiB RAM and about 1.2 GiB free disk. Matching
existing dependency trees are shared through local, Git-excluded symlinks and
treated as immutable. Heavy checks/builds serialize through one local resource
lock. Dependency changes require C01 coordination, renewed fingerprints and a
headroom check. This is not a Git publication lock. No other worktree, cache,
service or operator fence may be removed to make room.

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
| C01 | 0, integration | K0/K2–K7/K9 | Running; types and slots precede consumers. | No migration, dependency or provider decision implied. |
| C02 | 0, integration | K1/K8 | Running; consumes C01, then real inspection. | Preserve concurrent additive mind/WhatsApp/Slack integration. |
| S01 | 1/2/3/5 | F001/F006/F096/F100 | Running F001; then F002/F004 for recovery tranche. | D5/D8 for new hosting/packaging; existing recovery owners keep their fence. |
| S02 | 1 | F002/F003/F005 | Queued next after initial contracts/readiness; intent first. | D7 gates changed quiet/catch-up defaults, not deterministic previews. |
| S03 | 1/3 | F007/F008/F010/F012/F065/F101 | Running existing-policy slice; F002 gates full new authority path. | D2/D4/D6 for new authority/accounts/processors; F065 also needs takeover. |
| S04 | 1/2/3 | F013–F017 | Queued after F001/F002; fail-closed accounting first. | D3 for new paid/background activation; D4/D6 for providers. |
| S05 | 1/2/3 | F004/F011/F018/F080/F081 | Queued after F001/F002/F003; source-scoped task projections first. | Do not take over debug incident; D3/D8 for new value/support commitments. |
| S06 | 2/3 | F009/F049–F051 | Queued; F008 then scoped deletion. | Existing mind owner review pending; D4 for expanded retention, D2 for sharing. |
| S07 | 3 | F052/F053/F099 | Queued behind deletion/recall and bounded files/parsers. | D4/D6 source/processor choice, D8 format priority. |
| S08 | 2/3/5 | F055–F059/F108 | Queued behind F007/F010/F013; reconcile mind skills boundary first. | D5 scripts, D8 public catalog/payouts; do not duplicate unpublished mind work. |
| S09 | 2/3 | F060/F103 | Queued behind authority/enrollment; existing HTTPS discovery first. | D6 provider scopes, D8 maintained adapter list. |
| S10 | 2/3 | F019–F022/F024 | Queued behind authority/budget P0; ephemeral read before writes. | D2/D4/D6 account, scopes and retention; no mailbox enrollment inferred. |
| S11 | 2/3 | F023/F029 | Queued behind F019/F007/F003; ambiguous identity remains unresolved. | D2/D4/D6 sources/sharing. |
| S12 | 2/3 | F025/F026/F028 | Queued behind F005/F007/F008; availability before invitations. | D2/D6 provider/write scopes; D7 changed time defaults. |
| S13 | 2/3 | F027/F033/F054 | Queued behind F002/F005/F007; explicit local lists first. | Existing mind/reflection review boundary; D1/D2/D4 for broader pilot/sharing/retention. |
| S14 | 2/3 | F031/F032/F034–F036 | Queued behind intent/time/policy/budget; source integrations later. | D1/D3/D7 routines; D2/D5 browser demonstration. |
| S15 | 2/3/5 | F037–F042 | No parity builder; existing WhatsApp owner continues separately. | WhatsApp provider selected in its own task, enrollment missing; other transports D1/D6, SDK D8. |
| S16 | 2/3/4/5 | F043–F048 | Queued behind private files and policy/processor metadata. | D3/D4/D6 audio provider/cost/retention; D8 recording/ambient. |
| S17 | 2/3 | F061/F062 | Queued behind F008/F001; secret-safe takeover first. | D2/D5/D6 pilot origins/accounts/execution host. |
| S18 | 3/5 | F063/F064/F066/F093 | Parked for owner scope before device implementation. | D5/D8; D4 before sensor retention. |
| S19 | 2/3 | F067/F068/F070/F071 | Queued behind verified recovery, authority/budget and files. | D5 host/provider, D3 spend, D6 credentials. |
| S20 | 2 | F069 | Queued behind F007/F009/F010/F013; disposable selected files first. | D3 quotas and D4 retention/processors; no expanded personal retention before restore proof. |
| S21 | 2 | F073/F074 | Queued behind files/content barriers and verified isolated parser execution. | D4/D6 processor/license, D5 execution; dependency approval through C01. |
| S22 | 3 | F075/F076 | Queued behind policy/budget/files; reuse S16 transcription. | D3/D4/D6 provider/entitlement/retention; runner image tools do not prove June eligibility. |
| S23 | 3 | F072/F077/F078 | Queued behind files/documents, VM and export prerequisites. | D2/D4/D5 actions/data/publication/hosting. |
| S24 | 3/5 | F079/F082–F084 | Queued behind intent/policy/budget/skills; bounded roles first. | D2/D6 shared identities; D1/D8 before tenancy. |
| S25 | 3/4/5 | F030/F085–F090 | Parked; read-only F030 is distinct from consequential work. | F030 D4/D6; calls/payments/provider-specific work D2/D3/D4/D6/D8. |
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
  ownership/active-fence clarification requested; S01 starts read-only inspection
  and avoids lifecycle/deployment changes in the meantime.

## Progression and evidence log

- **11:23 UTC:** C01/C02/S01/S03 launched; direct contract-owner communication
  established. Existing owner boundaries recorded. Next launch frontier is
  S02 intent and then S04 budget enforcement once the reviewed seams are usable.
- **11:27 UTC:** S03 narrowed its first increment to frozen exact broker actions
  across credential awaits and live connection rechecks before dispatch/result
  release. C02 and S01 requested concrete contracts directly from C01. These are
  implementation reports, not completed feature receipts. Coordinator format,
  lint and typecheck passed on the updated remote baseline.
- **Pending:** C01 contract publication; C02 actual dispatch/prompt proof;
  S01 F001 readiness receipt; first S03 hardening receipt. No P0 exit claimed.

The coordinator reconciles returned evidence with the actual commits, affected
paths, shared contracts and live receipts before accepting a feature or releasing
its dependents. A publisher's deployment-only timer stays with that publisher;
child completion messages, not duplicate polling schedules, advance this roster.
