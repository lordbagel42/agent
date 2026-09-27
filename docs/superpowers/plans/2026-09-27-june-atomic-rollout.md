# June atomic rollout: 150 bounded assignments

Date: September 27, 2026. Coordinator: [parent rollout thread](https://ampcode.com/threads/T-01a0e3a3-6412-709e-8615-083e5b02fdd4).
Planning/capacity owner: [this planning thread](https://ampcode.com/threads/T-01a0e3ca-9b00-73e3-9a68-0304271e0545).
Source baseline: freshly fetched GitHub main at
[`34e7401`](https://github.com/lordbagel42/agent/commit/34e740110c2bf81f3104c1d00c6e8b7c4ee1c24b),
not the stale local checkpoint. Fetch again before starting or publishing work.

## Ship Amp, global personality, and memory first

The parent's audit and Raygen's latest request establish this order: June can use
Amp; June has one global, iterable personality; June can remember, inspect and
correct evidence. Ship small usable slices immediately, then extend them. Existing
privacy, replay and approval boundaries remain acceptance criteria. There is no
global publication freeze, exclusive subsystem ownership, or special worker veto.

Raygen subsequently required at least 150 workers. This plan has 150 durable task
IDs, plus the separate planning worker. **150 missing implementations would be
artificial:** several assigned safety properties are already implemented, and
some follow-ups may be absorbed by their prerequisite's smallest complete slice.
Those workers should report verified no-ops, not manufacture new helpers, tests,
features, or commits. No ID is recycled; a satisfied or subsumed ID retains its
evidence and owner. A task's acceptance work belongs to that task, not a new
tests-only task. The parent accepted the numbered families below while dispatching.

Each implementation is independently publishable **after its local prerequisites**;
this does not mean 150 independent interfaces can be designed simultaneously.
Do not ship dead helpers awaiting an unspecified caller. Include the smallest
June-callable path, host validation and instructions in each capability slice.
Backend-only safety changes preserve and exercise the existing June-facing path.

## Delivery contract applies to every numbered task

1. Use the isolated LEGION worktree and latest GitHub main. Preserve others' work.
   Use `amp.find_thread` with the unfiltered parent query and paginate all results;
   match the exact `June NNN` title (`June rollout NNN` for 001–008) locally.
   Keyword search can miss newly created threads. Coordinate blockers, contract
   changes and completion directly; avoid interrupting siblings with routine
   updates. Consume landed contracts; do not invent a second implementation or
   reserve shared files.
2. Inspect before editing. Reuse the source of truth. An implemented guard can be
   a verified no-op. Scope changes require coordination, not an unannounced new ID.
3. For code changes run the project's formatter, linter, typechecker and relevant
   existing tests, plus the row's discriminating acceptance check. Add minimal new
   tests only for core privacy/authority/external-effect invariants. Use disposable
   data and fake external boundaries. Do not send live messages or launch paid
   jobs merely to verify a change. UI changes require rendered inspection.
4. Get Oracle review of the actual diff and intended behavior; address findings.
   Rebase on freshly fetched main, rerun affected checks, use an atomic Conventional
   Commit, and normal-push `HEAD:main`. A rejected push means reconcile and retry,
   never force-push or demand a hold. Do not suppress known baseline failures.
5. Verify ancestry against freshly fetched main. Report scope, linked commit or
   evidenced no-op, checks, Oracle result, June-facing acceptance, activation state
   and limitations. The parent records the result and **archives the finished
   thread**, preserving its worktree. Do not archive a worker still awaiting a
   prerequisite or publication as though it completed.

Track five separate capability states: **implemented / host-integrated /
June-callable / enabled / live-verified**. A main push triggers existing automatic
deployment; it is not evidence of the loaded process revision. The live-verification
owner checks health and actual service-process cwd. Native coding, retained memory,
reflection, imports, browser/vault and controller installation have feature-local
activation requirements; do not bypass them or hold unrelated main pushes.

Every read filters audience before ranking, counting or relation expansion.
Memory and tool results are untrusted data, not instructions. Approval-required
actions bind authenticated owner confirmation to exact persisted scope; a
model-supplied `confirmed` field is not authorization. Preserve already-authorized
ingestion, staging and system writes without adding unnecessary confirmations.
Deletion is rechecked before projection, acceptance and delivery. Unknown external
outcomes are not automatically replayed.
Cross-revision journal compatibility is acceptance for every workflow modification.

## Existing main already supplies the foundations

These are source observations at the baseline, not claims that dormant features
are enabled or end-to-end verified live. The full audit covered
[`a79365e`](https://github.com/lordbagel42/agent/commit/a79365ed5055fff71e5c5b753afa4c724dbe60bc);
later main includes hot-model delivery and one-time dashboard-login work.

| Foundation already present | Evidence / consequence for this rollout |
| --- | --- |
| Signed ingress, durable serialized turns, durable delivery intent and unknown-send handling | `src/channels/slack.ts`, `src/runtime/registry.ts`, `src/runtime/delivery.ts`; do not build a second inbox/outbox. |
| Amp/Codex/Claude/Pi adapters, coding actors, private approval/resume, operator status/cancel | `src/coding/*`, `src/runtime/coding.ts`, `src/http/app.ts`; 001 adds usable conversational lifecycle, not another supervisor. |
| Encrypted evidence, immutable identities, scoped retrieval, pending review and cascading tombstones | `src/memory/store.ts`, `src/http/memory.ts`; 012, 014–016 and parts of 071/076 are baseline guards, not assumed missing features. |
| Grounded scoped personality revisions, immutable charter, rollback and deletion-aware projection | `src/memory/curated.ts`, `src/reflection/personality.ts`; private curation is not the global profile introduced by 002. |
| One-page approved imports, immutable coverage, canonical Slack/Gmail IDs and account cooldown | `src/imports/*`, `src/http/imports.ts`; 082–089 extend or verify these controls, never broaden historical access. |
| Reflection scheduling, live occupancy, quiet hours, uncertain attempts and provisional candidates | `src/runtime/reflection.ts`, `src/reflection/domain.ts`; missing reviewed incorporation/delivery is distinct from scheduler work. |
| Jury and typed Jev implementation | `src/reflection/evaluator.ts`, `src/models/jev.ts`; unmounted, not absent. Jev observations are not jury verdicts. |
| MCP discovery/catalog, approved effect broker and console enrollment | `src/tools/connections.ts`, `src/tools/broker.ts`, `src/console/connections.ts`, `src/models/provider.ts`; catalog inspection is already June-callable. |
| Browser, Bitwarden resolver, capability-route and opaque-link primitives | `src/tools/browser.ts`, `src/credentials/bitwarden.ts`, `src/tools/routes.ts`, `src/links/*`; generic host mounting/isolation remains separate. |
| Conversation owner priority, persistent execution workers, deployment inspection | `src/runtime/priority.ts`, `src/runtime/execution.ts`, `src/deployment/feed.ts`; no replacement queues or release supervisor. |
| Scoped metadata inspection, social forgetting and durable outreach recovery | `src/runtime/inspection.ts`, `src/runtime/social.ts`, `src/runtime/registry.ts`; metadata is not source recall. Preserve fresh/unrelated history after forgetting. |

Relevant landed audit fixes include
[`744072b`](https://github.com/lordbagel42/agent/commit/744072b) (same outreach delivery key),
[`1aa591a`](https://github.com/lordbagel42/agent/commit/1aa591a) (private inspection),
[`f3d7171`](https://github.com/lordbagel42/agent/commit/f3d7171) (social forgetting),
[`e507c71`](https://github.com/lordbagel42/agent/commit/e507c71) (Gmail label deduplication),
[`bf8401a`](https://github.com/lordbagel42/agent/commit/bf8401a) (connection command consumption),
and [`9bd5792`](https://github.com/lordbagel42/agent/commit/9bd5792) (bounded discovery).
Do not reimplement them. Installed controller bytes were older than controller
source in the audit; app publication does not install controller changes.

## Ownership and first waves

001–008 retain their existing owners:

| ID | Existing owner |
| --- | --- |
| 001 | [Amp lifecycle](https://ampcode.com/threads/T-01a0e3c9-7ec7-71be-b5a9-046657c17697) |
| 002 | [Global personality](https://ampcode.com/threads/T-01a0e3c9-882c-7385-9e7d-9bbdce15c38c) |
| 003 | [Explicit recall](https://ampcode.com/threads/T-01a0e3c9-91ba-76e6-ad45-bba8f118af4c) |
| 004 | [Trusted corrections](https://ampcode.com/threads/T-01a0e3ca-a4ba-740c-96bf-b53e4b00ed27) |
| 005 | [Import extraction](https://ampcode.com/threads/T-01a0e3ca-b4bf-765a-b72e-f2bc2f64beaf) |
| 006 | [Interrupted inference](https://ampcode.com/threads/T-01a0e3ca-bd61-70d9-84ca-67240da1388f) |
| 007 | [Reflection settlement](https://ampcode.com/threads/T-01a0e3ca-c676-7770-9bd2-b52b2901e785) |
| 008 | [Abandoned stages](https://ampcode.com/threads/T-01a0e3ca-d16f-760f-ae53-083a22f62437) |

The parent has launched all 001–150 plus this planner, verified by paginated
parent-thread discovery at 11:19 MDT with no missing task IDs.
Resolve the live thread index rather than guessing IDs. The local, untracked
`.rollout-worker-brief.md` carries execution guidance and a point-in-time sibling
index; it is not a second source of task scope.

Do not duplicate [Rivet workflow authoring](https://ampcode.com/threads/T-01a0e39c-70cd-73bf-b24a-ce36ef4705ba),
[dynamic apps](https://ampcode.com/threads/T-01a0e3ab-6f5f-77cb-8f5b-ac90ac091688),
[durable wakeups](https://ampcode.com/threads/T-01a0e369-588c-735e-83d3-c6488912a33f),
or [live deployment verification](https://ampcode.com/threads/T-01a0e380-cdc2-7371-b5ee-f2b3488d639a).
Wakeup ownership is last-known; confirm it before integrating. No new transport,
WhatsApp/Linq rollout, second graph database, custom workflow engine, or blanket
permission expansion belongs in this plan.

- **Wave A, ready against baseline:** 001–009, 011–017, 049–050, 052–054, 058,
  076–077, 079–081, 087, 096, 110, 121–128, 132, 136–138, 140, 142, 145, 148, 150. Prioritize
  001–005 and memory guards. Ready means prerequisites exist, not exclusive files
  or permission to run everything concurrently. Baseline rows may close no-op.
- **Wave B, after each row's own prerequisites land:** 021–029, 041–046, 051, 055, 060–072;
  018–020 follow their graph/review prerequisites. 017/018/019 are the single
  pending-memory-review family; later memory work must not duplicate them.
- **Wave C, reviewed learning:** 030–040, 073–075, 082–095, 101–120, following the
  row-level DAG. Preview/suggestion tasks must work before promotion tasks.
- **Wave D, optional host integrations and operations:** browser/vault 130–135,
  restore 078/097–100, capacity/drain 144–147, deployment feed 149. Implement locally
  and publish small slices; activation stays feature-local and explicitly verified.

The rows below override the broad wave labels where dependencies differ. A
dependency is satisfied by the landed contract, including existing baseline code,
not by waiting for its worker's archival. Consumers still exercise their own
boundary checks. Safety needed by an initial usable slice must ship in that slice;
a later hardening/inspection row is not permission to postpone it and may close
as subsumed.
`—` means current main supplies prerequisites. `BASE` means the assigned core
property already exists and a verified no-op is expected unless the named boundary
check finds a concrete defect. `EXT` means extend an existing contract. `NEW` means
the June-facing slice is not present at the inspected baseline. `OWN` means the
existing 001–008 worker owns it; no duplicate implementation. These are baseline
assessments, not live completion reports. Paths identify ownership, not file locks.
`G` below means the global-personality module/path chosen by 002; consume that
landed module rather than creating a competing `G` file or store.

### First-slice contracts clarified by Oracle review

- **029–040:** Suggestions, explanations and support remain private pending data.
  Revalidate evidence before every content read, evaluation, approval and projection.
  Public promotion requires confirmation of the exact public payload and its
  all-audiences destination; it does not declassify supporting records. Deletion-aware
  projection/rollback ships in 032/036, not later in 033/040. Direct owner-authored
  public traits need no invented private-evidence dependency.
- **061–072:** Consume 003's `recall?: string`, `recallAvailable` / `plan.recall`,
  receipt→`memoryContexts`/outbox contract. 003 broadcasts its final commit; avoid
  repeated prelanding questions. Basic deletion-safe recall is 003's requirement.
  072 may narrow conservative global invalidation only with equivalent validation
  of returned claims and relation-dependent deletions, not merely direct source IDs.
- **074/075:** Forgetting is one idempotent ledger-first decision with resumable
  cleanup and a content-free completion receipt. Its own confirmation turn may be
  invalidated by cleanup; plan for that. Retrying the same decision must not erase
  unrelated post-deletion work. 075 adds inspection, not basic recoverability.
- **078/098:** Authenticate restored inputs, validate schema and establish sufficient
  independently retained deletion coverage before exposing any restored reads in
  078. 098 adds offline preflight/status, not the first restore safety gate.
- **101/102:** A normal owner model turn calls reflection occupancy, advancing the
  epoch and clearing candidates; automatic extraction also acquires occupancy.
  Coordinate one authenticated review-command entry path that avoids both, or
  explicitly separate reviewable candidate state from interruption eligibility.
  Exercise a real private list/read followed by reject/stage/approval interaction.
  Review must not erase itself, and must not weaken unsolicited-send eligibility.
  103/105–108 consume this contract; 007 still owns cancellation settlement.
- **108/109:** 108 includes immediate pre-send quiet/live-attention, current candidate,
  approval, rejection and deletion checks. 109 verifies that behavior or adds a
  genuinely missing policy boundary, not the first enforcement after sends launch.
- **125/126:** Persist cancellation even before a proposal has a grant, and reject
  its later confirmation. For reconciliation bind exact grant, confirmed stoppage
  and independently established succeeded/failed outcome. Stopped plus unknown
  outcome remains unknown; no fabricated failure to clear the receipt.

## 001–020: usable core and evidence integrity

| ID | State | Small deliverable and owning paths | Depends on | Acceptance / focused verification |
| --- | --- | --- | --- | --- |
| 001 | OWN | June requests, inspects and cancels Amp jobs; `src/runtime/coding.ts`, `src/runtime/registry.ts`, `src/runtime/prompt.ts`. | — | Owner private request→approval→status→cancel; unavailable is explicit; cancellation is not proof of stop. No real paid launch needed. |
| 002 | OWN | Global public-safe versioned personality, read/revise/history/rollback and prompt projection; `G`, `src/runtime/prompt.ts`, `src/runtime/registry.ts`. | — | Owner revision survives restart and reaches private/channel/guest prompts; private curated evidence never enters global profile; charter cannot change. |
| 003 | OWN | Explicit bounded owner-private memory recall; `src/memory/store.ts`, `src/runtime/registry.ts`, `src/models/provider.ts`. | — | Explicit query returns scoped sources/claims with provenance; guest denied; deletion before reply blocks stale material. |
| 004 | OWN | Authenticated correction provenance feeding existing precedence; `src/runtime/registry.ts`, `src/memory/store.ts`, `src/reflection/personality.ts`. | — | Real owner correction wins; quoted, imported, guest and model assertions cannot set trusted correction provenance. |
| 005 | OWN | Approved imported sources stage bounded pending claims; `src/imports/index.ts`, `src/main.ts`, `src/models/extraction.ts`. | — | One approved page→pending claims; no autoaccept; interrupted paid call remains unknown, not relaunched. |
| 006 | OWN | Interrupted inference is unknown rather than intentional silence; `src/runtime/registry.ts`. | — | Kill between persisted invocation marker and result checkpoint; replay neither reinvokes nor records deliberate silence. Preserve old journal order. |
| 007 | OWN | Resolve reported reflection cancellation settlement failure; `src/runtime/reflection.ts`, `src/reflection/domain.ts`. | — | Overlapping live turns abort background work; actual provider settlement releases only its claim. If failure is not reproducible, report evidence without invented fix or timeout inflation. |
| 008 | OWN | Safe abandoned deployment-stage recovery; `scripts/deploy/deploy.py`. | — | Under controller lock, remove only owned abandoned stage after proving its process stopped; preserve active/unknown paths and releases. Source push is not controller installation. |
| 009 | EXT | Supply bounded same-scope existing claims to live extractor; `src/models/extraction.ts`, `src/runtime/registry.ts`. | — | Existing contradictory fact appears beside new source; another owner's fact never appears. 010 owns relation output. |
| 010 | EXT | Model proposes contradiction/supersession edges; `src/models/extraction.ts`. | 009 | Contradictory and replacement examples produce explicit validated edges; missing evidence abstains; claims remain pending. |
| 011 | BASE | Relation admission rejects invalid/self/cross-scope/cyclic replacement edges; `src/memory/store.ts`. | — | Existing immutable references to prior records structurally prevent cycles; verify invalid/self/foreign targets and valid backward contradiction. Do not add a graph validator without a reachable defect. |
| 012 | BASE | Retrieval scope isolation before ranking; `src/memory/store.ts`. | — | Unique high-scoring private phrase cannot alter another audience's result/excerpt/count; same-scope source still retrieved. |
| 013 | EXT | Bound recall query/count/serialized content with truthful omission metadata; `src/memory/store.ts`. | — | Existing character/count/query bounds remain intact; authorized omitted counts share the output budget. Do not silently reinterpret the character contract as UTF-8 bytes or count unauthorized/opt-out matches. |
| 014 | BASE | Forgotten-source suppression across relation expansion/index rebuild; `src/memory/store.ts`. | — | Delete one root in a mixed graph; descendants disappear before/after reopen while unrelated claims survive. Never add a cache solely to test invalidation. |
| 015 | EXT | Repeated source-revision extraction admission is idempotent; `src/memory/store.ts`. | — | Existing identical-grounding dedupe is insufficient for differing repeated output; first successful source-set receipt, including empty result, persists across reopen while review/deletion and owner boundaries remain intact. |
| 016 | BASE | Exact citation provenance validation; `src/memory/store.ts`, `src/models/extraction.ts`. | — | Fabricated quote or absent/foreign source rejected; valid multi-source quotations pass. Quotation membership is not a truth claim. |
| 017 | NEW | June privately lists pending claim content; `src/runtime/registry.ts`, `src/runtime/prompt.ts`, `src/http/memory.ts`. | — | Bounded candidate IDs/text/uncertainty/provenance, owner-only; generic inspection stays metadata-only. |
| 018 | NEW | Owner-confirmed promotion of one pending memory candidate; `src/runtime/registry.ts`, `src/http/memory.ts`. | 017 | Exact displayed candidate confirmation inserts once; guest/model self-approval, stale/deleted evidence and opposing prior review denied. |
| 019 | NEW | Durable owner rejection through June; `src/runtime/registry.ts`, `src/http/memory.ts`. | 017 | Same rejection repeats harmlessly; extractor retry cannot promote it; rejection does not tombstone original evidence. |
| 020 | EXT | Project uncertainty and unresolved contradiction into prompts; `src/runtime/prompt.ts`, `src/runtime/registry.ts`. | — | Existing stored relation/grounding contract suffices: opposing claims remain unresolved with source IDs; low confidence is not established truth. No dependency on new extractor output. |

## 021–040: iterate personality without making private memory public

| ID | State | Small deliverable and owning paths | Depends on | Acceptance / focused verification |
| --- | --- | --- | --- | --- |
| 021 | NEW | Revision diff/preview; `G`, `src/runtime/registry.ts`. | 002 | Preview shows only intended changed traits, leaves head unchanged, and cannot reveal private supporting text. |
| 022 | EXT | Expected-head compare-and-set for edits; `G`. | 002 | Two edits based on one head: first wins, second returns stale head without overwriting; retry of same command is idempotent. |
| 023 | EXT | Stable bounded revision-history pagination; `G`, `src/runtime/prompt.ts`. | 002 | A revision appended between pages does not duplicate/skip the pinned historical range; invalid cursor denied. |
| 024 | EXT | Pin profile revision per durable turn; `src/runtime/registry.ts`, `src/runtime/prompt.ts`. | 002 | Mid-turn edit affects the next turn, not replay of this turn; pin public profile ID, never persist a private evidence snapshot unnecessarily. |
| 025 | NEW | Global profile in execution-agent prompts; `src/runtime/execution.ts`, `G`. | 002 | Execution prompt receives same public-safe profile and stable identity, not owner-private overrides or new tool authority. |
| 026 | EXT | Global defaults versus private curated override precedence; `src/runtime/prompt.ts`, `src/memory/curated.ts`. | 002, 004 | A private owner correction overrides global tone privately but not for guest/channel; charter wins everywhere. |
| 027 | NEW | Reset one named trait without wiping profile; `G`, `src/runtime/registry.ts`. | 002, 022 | Reset humor leaves tone/interests and append-only history intact; stale-head reset rejected. |
| 028 | NEW | June explains effective trait origin; `src/runtime/prompt.ts`, `G`, `src/memory/curated.ts`. | 026 | Owner gets global-vs-private explanation; public explanation omits private trait existence, source IDs and quotations. |
| 029 | NEW | Stage grounded personality suggestions without applying; `G`, `src/reflection/personality.ts`. | 002, 004 | Valid suggestion persists pending; missing/foreign/deleted source rejected; no profile-head change or authority grant. |
| 030 | NEW | Private pending-suggestion inspection; `G`, `src/runtime/registry.ts`. | 029 | Bounded values/explanations with current provenance; other audiences see no candidate content. |
| 031 | NEW | Idempotent owner suggestion rejection; `G`, `src/runtime/registry.ts`. | 029 | Rejected suggestion stays rejected after replay/regeneration; unrelated pending suggestions remain available. |
| 032 | NEW | Owner approves exact suggestion/head/evidence; `G`, `src/runtime/registry.ts`. | 022, 029, 030 | Modified suggestion, moved head or deleted source invalidates confirmation; exact command applies once. Private support does not implicitly become public. |
| 033 | EXT | Forgetting invalidates pending personality suggestions; `G`, `src/main.ts`. | 029 | Forget root while suggestion pending/in flight; no later approval/projection restores its private data; unrelated suggestion survives. |
| 034 | NEW | Candidate personality held-out interaction preview; `G`, `src/models/provider.ts`. | 029 | Explicit bounded synthetic interaction shows candidate response without changing effective profile or sending externally. Actual provider attempts have durable unknown handling. |
| 035 | NEW | Compare candidate/current evaluation; `G`, `src/reflection/evaluator.ts`. | 034 | Same held-out inputs, recorded profile identities and explicit abstention; comparison never auto-promotes. |
| 036 | NEW | Bind reviewed promotion to exact evaluated candidate digest; `G`. | 032, 035 | Editing candidate after evaluation invalidates promotion; evaluated matching candidate can be deliberately approved once. |
| 037 | NEW | Bounded private learned-pattern projection; `src/memory/curated.ts`, `src/runtime/prompt.ts`. | 002, 018, 020 | Only accepted, current pattern claims shape private interaction; pending/dream/forgotten claims do not become facts or global traits. |
| 038 | NEW | Private relationship-context projection using existing entity IDs; `src/memory/curated.ts`, `src/runtime/prompt.ts`. | 018, 020 | Same display name for two authors stays separate; relationship assessment remains private and never creates permission. |
| 039 | NEW | Owner-approved public values/self-description; `G`, `src/runtime/prompt.ts`. | 002, 022 | Bounded owner-authored public text is explicitly approved for all audiences; cannot edit honesty/privacy/authority charter or fabricate consciousness. |
| 040 | EXT | Rollback evaluated/promoted personality after forgetting; `G`, `src/memory/curated.ts`. | 033, 036 | Rollback appends history but revalidates private evidence; forgotten traits do not reappear through old evaluated snapshots. |

## 041–060: Amp follow-ups on the one existing supervisor

| ID | State | Small deliverable and owning paths | Depends on | Acceptance / focused verification |
| --- | --- | --- | --- | --- |
| 041 | NEW | Bounded owner-private recent-job listing; `src/runtime/registry.ts`, `src/runtime/coding.ts`. | 001 | List stable job IDs/status only for authorized owner; limit/cursor does not expose other scopes. |
| 042 | NEW | Retrieve a bounded saved worker report; `src/runtime/registry.ts`, `src/runtime/coding.ts`. | 001 | Clearly label reported versus verified; no report from forgotten/private foreign task; giant report stays bounded. |
| 043 | NEW | Inspect verifier result independently of report; `src/runtime/coding.ts`, `src/runtime/registry.ts`. | 001 | Worker claims success but verifier fails: June reports disagreement, not verified completion. |
| 044 | NEW | Safe runtime-binding/recovery explanation; `src/runtime/coding.ts`, `src/runtime/prompt.ts`. | 001 | Changed runtime config yields explicit mismatch/manual recovery, without credentials or sensitive host paths. |
| 045 | EXT | Exact workspace/runtime/local-only approval preview; `src/runtime/registry.ts`, `src/runtime/prompt.ts`. | 001 | Owner sees actual bounded goal and local authority; approving work is not push/deploy authorization. |
| 046 | BASE | Ambiguous short job IDs fail closed; `src/runtime/registry.ts`. | — | Existing approval/resume requires exactly one eligible match; verify new 001 commands retain that rule and foreign jobs do not leak. |
| 047 | BASE | Durable deduplicated coding completion notification; `src/runtime/registry.ts`, `src/runtime/delivery.ts`. | — | Existing job/attempt identity and outbox prevent repeated notification intent; restart cannot resend unknown delivery. No exactly-once external delivery promise or second notification subsystem. |
| 048 | BASE | Forgetting suppresses pending completion notification; `src/runtime/registry.ts`, `src/main.ts`. | — | Existing validity checks block queued report after supporting source is forgotten; exercise completion-to-delivery race. |
| 049 | BASE | Failed verifier keeps optimistic worker report unverified; `src/runtime/coding.ts`. | — | Existing failed-verifier path remains needs-review with separate outcome; no implementation churn if satisfied. |
| 050 | BASE | Cancellation/unknown session retains admission through settlement; `src/runtime/coding.ts`, `src/coding/amp.ts`. | — | Provider ignores abort: second launch not admitted until settlement or trusted reconciliation; cancellation request is not stop proof. |
| 051 | EXT | Pre-ID interrupted launch gives manual reconciliation instructions; `src/runtime/coding.ts`, `src/runtime/prompt.ts`. | 001 | Worktree exists without saved session ID: no replacement run or automatic resume; explain exact unresolved state. |
| 052 | BASE | Restart preserves saved native session/runtime binding; `src/runtime/coding.ts`. | — | Reopen saved job under changed adapter config; cannot bind it to a fresh session or adapter. |
| 053 | BASE | Stale approval cannot change goal/workspace; `src/runtime/coding.ts`, `src/runtime/registry.ts`. | — | Proposal preview and executed goal/workspace remain exact; tampered request cannot reuse original authorization. |
| 054 | BASE | Duplicate approval/resume admits one external attempt; `src/runtime/coding.ts`, `src/runtime/registry.ts`. | — | Replay same approved command/attempt ID across restart; one launch, preserving uncertain state rather than trying again. |
| 055 | NEW | June reads bounded coding admission/queue reason; `src/runtime/coding.ts`, `src/runtime/registry.ts`. | 001 | Busy, disabled and unknown-occupancy reasons distinct; metadata cannot clear admission or reveal another owner. |
| 056 | NEW | Read-only job worktree diff summary; `src/coding/worktree.ts`, `src/runtime/coding.ts`. | 001, 058 | Fixed host operation returns bounded changed-path/stat summary, no shell tool; reject symlink/path escape and redact sensitive paths. |
| 057 | EXT | Artifact/revision identity accompanies verifier result; `src/runtime/coding.ts`, `src/core/contracts.ts`. | 043 | Result identifies what revision/worktree state was checked; later edits invalidate equivalence; no immutable deployment attestation claim. |
| 058 | EXT | Protected-host coding isolation preflight/status; `src/config.ts`, `src/coding/worktree.ts`, `src/main.ts`. | — | Missing isolation acknowledgment/configuration remains disabled with actionable reason; preflight does not enable coding or prove OS sandboxing. |
| 059 | NEW | Coding participates in deployment drain; `src/runtime/lifecycle.ts`, `src/runtime/coding.ts`. | 050, 052, 058 | New jobs fenced while draining; existing/unknown native worker prevents false drain certification; no automatic unknown release. |
| 060 | NEW | June-readable runtime readiness checklist; `src/runtime/prompt.ts`, `src/runtime/inspection.ts`. | 001 | Distinguish configuration, authentication-unverified and isolation prerequisites without reading/copying secrets or fabricating a successful launch. |

## 061–080: inspect, connect and forget scoped evidence

| ID | State | Small deliverable and owning paths | Depends on | Acceptance / focused verification |
| --- | --- | --- | --- | --- |
| 061 | NEW | Exact source-by-ID private recall; `src/memory/store.ts`, `src/runtime/registry.ts`. | 003 | Authorized source returns original observation/provenance; missing and unauthorized IDs have indistinguishable absence. |
| 062 | NEW | Exact claim with quotations and provenance; `src/memory/store.ts`, `src/runtime/registry.ts`. | 003 | Pending claim not represented as accepted; surviving authorized source chain is available without private foreign edges. |
| 063 | NEW | Bounded source-to-dependent-claim inspection; `src/memory/store.ts`, `src/runtime/registry.ts`. | 003 | Direct/derived dependencies distinguished, bound enforced before output, unrelated and foreign claims excluded. |
| 064 | NEW | Contradiction-neighbor inspection; `src/memory/store.ts`, `src/runtime/registry.ts`. | 003, 011 | Preserve both conflicting claims and relation direction/source; do not collapse them into consensus. |
| 065 | NEW | Supersession-chain inspection; `src/memory/store.ts`, `src/runtime/registry.ts`. | 003, 011 | Return bounded ordered chain with current/older distinction; corrupt/cyclic data cannot loop or widen scope. |
| 066 | NEW | Entity facts using existing stable entity IDs; `src/memory/store.ts`, `src/runtime/registry.ts`. | 003 | Platform/account/author tuple identifies facts; equal display names never merge identities. |
| 067 | NEW | Category-filtered recall; `src/memory/store.ts`, `src/models/provider.ts`. | 003, 013 | Preference/commitment/pattern filter excludes other categories, retains scope and bounds; unknown category rejected. |
| 068 | NEW | Observation-time and claim-validity filters; `src/memory/store.ts`, `src/models/provider.ts`. | 003, 013 | Original observation time differs from import time; inclusive start/exclusive end and unknown validity handled explicitly. |
| 069 | NEW | Stable bounded recall cursor; `src/memory/store.ts`, `src/runtime/registry.ts`. | 003, 013 | Mutation/deletion between pages either invalidates cursor or safely revalidates; no stale cross-scope results. |
| 070 | EXT | Safe no-match/oversized/omitted recall explanation; `src/memory/store.ts`, `src/runtime/prompt.ts`. | 003, 013 | Explain bounded omission without claiming absent evidence is false or exposing unauthorized existence/counts. |
| 071 | BASE | Quote-safe bounded source excerpts; `src/memory/store.ts`. | 003 | Existing omission of oversized records remains safe; no mid-quote truncation represented as original complete evidence. |
| 072 | EXT | Recall provenance survives synthesis and delivery checks; `src/runtime/registry.ts`, `src/runtime/delivery.ts`. | 003, 014 | Forget between explicit recall and final reply: copied text cannot be sent; unrelated current reply still allowed. |
| 073 | NEW | Forget-impact preview; `src/memory/store.ts`, `src/runtime/registry.ts`. | 063 | Owner sees source/derivative counts and logical-deletion limits; preview mutates nothing and leaks no foreign graph. |
| 074 | NEW | Owner-confirmed forgetting through June; `src/runtime/registry.ts`, `src/main.ts`. | 073 | Exact confirmation creates one ledger-first idempotent decision with resumable cleanup and content-free receipt; retry cannot erase unrelated new work; quoted/model commands cannot authorize it. |
| 075 | NEW | Forget-cleanup status and truthful purge limits; `src/runtime/registry.ts`, `src/runtime/inspection.ts`. | 074 | Interrupted cleanup remains actionable; `physicalPurge:false`, journals/backups and already-sent content never falsely reported erased. |
| 076 | BASE | Forgetting blocks late extraction staging; `src/memory/store.ts`, `src/runtime/registry.ts`. | — | Delete while extractor is pending; later valid-looking output cannot stage a claim. Coordinate imported execution with 005, do not relaunch it. |
| 077 | NEW | Bounded tombstone export for independent retention; `src/memory/store.ts`, `src/http/memory.ts`. | — | Owner-authorized export preserves deletion watermark/IDs without evidence bodies or keys; June can inspect export status, not unbounded payload. |
| 078 | NEW | Apply tombstone replay before restored memory becomes readable; `src/memory/store.ts`, `src/main.ts`. | 077 | Authenticate/validate disposable restored snapshot and independently retained deletion coverage first; replay tombstones before any reads. Incomplete coverage fails closed; no production restore. |
| 079 | NEW | June-readable source/claim/byte capacity; `src/memory/store.ts`, `src/runtime/inspection.ts`. | — | Scoped safe counts and supported bounds, not decrypted content; current size is distinct from maximum configured size. |
| 080 | NEW | Immutable-source conflict explanation/reconciliation request; `src/imports/index.ts`, `src/runtime/registry.ts`. | — | Changed source under same ID leaves old source and cursor intact; June reports conflict without inventing new ID/overwriting evidence. |

## 081–100: bounded import and honest retention

| ID | State | Small deliverable and owning paths | Depends on | Acceptance / focused verification |
| --- | --- | --- | --- | --- |
| 081 | NEW | June inspects exact configured import coverage; `src/http/imports.ts`, `src/runtime/registry.ts`. | — | Account, selected conversations and date interval accurately shown to owner; no token or whole-account completeness claim. |
| 082 | NEW | Request one-page approval bound to coverage digest; `src/runtime/registry.ts`, `src/http/imports.ts`. | 081 | Human confirms exact immutable scope; model cannot directly invoke raw `start`; digest mismatch blocks before credential/network lookup. |
| 083 | NEW | Owner-confirmed next-page continuation; `src/runtime/registry.ts`, `src/http/imports.ts`. | 082 | Expected page count/digest pin operation; repeating one command cannot consume the next page. |
| 084 | NEW | Durable import cancel defeats queued continuation; `src/imports/index.ts`, `src/main.ts`. | 083 | Cancel before queued page starts survives restart; new deliberate owner continuation is required. Do not confuse signal delivery with settled fetch. |
| 085 | NEW | June explains import gaps/completeness; `src/runtime/inspection.ts`, `src/runtime/prompt.ts`. | 081 | Traversal complete is not gap-free; selected thread versus channel timelines and platform retention exclusions remain explicit. |
| 086 | NEW | Inspect persisted import cooldown; `src/imports/index.ts`, `src/runtime/inspection.ts`. | 081 | Future `notBefore` and provider rate-limit cause visible; no timer or busy retry added by this read surface. |
| 087 | BASE | Same-account job serialization/cooldown; `src/imports/index.ts`, `src/imports/common.ts`. | — | Two jobs sharing account cannot fetch concurrently or evade persisted cooldown; different accounts remain independent. Multi-host enforcement is not assumed. |
| 088 | EXT | Known tombstones produce content-free import gaps; `src/main.ts`, `src/imports/index.ts`. | 082, 014 | Drop only proven tombstones; immutable conflict still rejects whole page without cursor advance; deletion race retries same page explicitly. |
| 089 | EXT | Coverage/account changes invalidate pending approval; `src/http/imports.ts`, `src/imports/index.ts`. | 082 | Changed selection digest or authenticated provider account fails before body fetch; no widening or token substitution. |
| 090 | NEW | Imported-page to pending-claim provenance inspection; `src/runtime/registry.ts`, `src/memory/store.ts`. | 005, 017, 081 | Owner traces pending claim to original page/source without implying import itself approved the claim. |
| 091 | NEW | Enforce source/claim/serialized-byte page budget; `src/memory/store.ts`, `src/imports/index.ts`. | 079 | Page crossing limit commits neither data nor cursor; replay of identical existing sources does not double-charge. |
| 092 | EXT | Bound imported extraction backlog/admission; `src/main.ts`, `src/imports/index.ts`. | 005 | Overflow/paused/unknown visible; no unbounded tasks or automatic repeat of persisted-started model attempt. Reuse 005's durable markers. |
| 093 | NEW | Safe ledger size/last-operation status; `src/memory/store.ts`, `src/runtime/inspection.ts`. | 079 | Disabled, empty, failed and unknown are distinct; no source text/keys in metadata. |
| 094 | NEW | Bounded retrieval-duration counters visible to June; `src/memory/store.ts`, `src/models/usage.ts`. | 093 | Known synthetic slow/fast operations counted without recording query or source text; retain bounded aggregates only. |
| 095 | NEW | Persistence duration/failure counters visible to June; `src/memory/store.ts`, `src/models/usage.ts`. | 093 | Failed write does not count as successful; bounded metrics disclose neither evidence nor crypto material. |
| 096 | NEW | Retained-copy inventory and deletion-limit status; `src/runtime/inspection.ts`, `src/memory/README.md`. | — | Distinguish ledger, journals, encrypted snapshots, backups, in-flight model input and delivered messages; unknown inventories stay unknown. |
| 097 | NEW | Encrypted backup command plus safe status/manifest; `src/memory/store.ts`, `src/http/memory.ts`, `src/memory/README.md`. | 077 | Disposable export/reopen preserves sources and tombstone watermark; copy existing authenticated ciphertext with established APIs, no custom cipher or key in manifest. No live backup mutation. |
| 098 | NEW | Offline restore validator before any replacement; `src/memory/store.ts`, `src/memory/README.md`. | 078, 097 | Wrong key, tampering, schema mismatch or stale deletion watermark rejected; only disposable restore exercised; June receives safe validation status. |
| 099 | NEW | Curated-snapshot retention dry-run report; `src/memory/curated.ts`, `src/runtime/inspection.ts`. | 096 | Report candidate retained copies without removing anything or implying Git revert is physical erasure; no secret names/content leakage. |
| 100 | EXT | Small-import supported-envelope ceiling and guidance; `src/config.ts`, `src/imports/README.md`. | 091, 094, 095 | Choose conservative measured source/byte ceiling using disposable data; configured cap enforced. If 091 already provides this exact outcome, mark subsumed instead of adding another limit. |

## 101–120: reviewed reflection, dreams and deliberation

| ID | State | Small deliverable and owning paths | Depends on | Acceptance / focused verification |
| --- | --- | --- | --- | --- |
| 101 | NEW | June lists bounded private reflection candidates; `src/runtime/reflection.ts`, `src/runtime/registry.ts`. | 007 | List current authorized candidate IDs, not raw private rationale in generic inspection; stale candidates excluded. |
| 102 | NEW | June inspects one candidate with current provenance; `src/runtime/reflection.ts`, `src/runtime/registry.ts`. | 007 | Recheck deletion, scope, epoch, live occupancy and quiet policy at read; authorized current rationale only. |
| 103 | NEW | Durable reviewed candidate rejection; `src/runtime/reflection.ts`, `src/reflection/domain.ts`. | 102 | Reject differs from cooperative cancellation and survives replay; same candidate cannot later be delivered/incorporated. |
| 104 | NEW | Explicit scoped reflection request using existing evidence; `src/runtime/registry.ts`, `src/runtime/reflection.ts`. | 007 | Owner request deduplicates canonical evidence set; no fabricated evidence or shortcut around idle/quiet/capacity rules. |
| 105 | NEW | Reviewed candidate stages a pending memory proposal; `src/runtime/reflection.ts`, `src/memory/store.ts`. | 102, 017 | Candidate rationale is hypothesis, original quoted evidence grounds proposal; 018 remains sole promotion path, no self-acceptance. |
| 106 | NEW | Reflection-to-personality suggestion bridge; `src/runtime/reflection.ts`, `G`. | 102, 029 | Valid current candidate stages once; it does not modify global profile or publicize private sources. |
| 107 | NEW | Candidate creates owner-reviewed interruption proposal; `src/runtime/reflection.ts`, `src/runtime/social.ts`. | 102 | Exact recipient/message privately previewed under existing outreach authority; candidate read is not permission to send. |
| 108 | NEW | Approved interruption uses candidate-keyed durable outbox; `src/runtime/registry.ts`, `src/runtime/delivery.ts`. | 107 | Recheck quiet/live attention, candidate authorization, approval, rejection and deletion immediately before send; repeated reads/restarts cannot resend unknown delivery. These checks ship atomically. |
| 109 | EXT | Verify or extend send-time quiet/attention boundaries; `src/runtime/registry.ts`, `src/reflection/domain.ts`. | 108 | Creation-eligible but send-time quiet/live candidate withheld; DST repeated hour handled conservatively. Close subsumed if 108 satisfies it; never defer initial safety here. |
| 110 | NEW | June explains unknown reflection and reconciliation; `src/runtime/inspection.ts`, `src/runtime/prompt.ts`. | — | Identify held request/turn safely; only authenticated operator confirmed-stopped reconciliation releases it, never model assertion. |
| 111 | NEW | Curiosity request over bounded authorized evidence/search; `src/runtime/reflection.ts`, `src/tools/web-search.ts`. | 104 | Current permitted sources only; approved public search cannot turn into private account crawling or tool execution. |
| 112 | NEW | Curiosity progress/provenance inspection; `src/runtime/inspection.ts`, `src/runtime/registry.ts`. | 111 | Owner sees pending/settled/unknown and source kind; failed search is not claimed as investigated evidence. |
| 113 | NEW | Deep-mode alternative-response simulation; `src/runtime/reflection.ts`, `src/models/decision.ts`. | 104 | Bounded synthetic alternatives remain hypothesis-only and cannot justify interruption as independent evidence. |
| 114 | NEW | Stage skill-change proposal from reflection; `src/runtime/reflection.ts`, `src/reflection/domain.ts`. | 113 | Store proposed behavior and grounded rationale, not executable code or changed permissions; bounded/idempotent candidate. |
| 115 | NEW | Held-out skill-candidate evaluation; `src/reflection/evaluator.ts`, `src/runtime/reflection.ts`. | 114 | Compare exact candidate on held-out cases, preserve failure/abstention; no skill promotion from its training evidence alone. |
| 116 | NEW | Reviewed skill candidate becomes existing Amp proposal; `src/runtime/registry.ts`, `src/runtime/coding.ts`. | 115, 001 | Exact evaluated change creates unapproved coding proposal once; no autoapproval, push or deployment grant. |
| 117 | NEW | Mount bounded explicit jury workflow; `src/reflection/evaluator.ts`, `src/main.ts`, `src/runtime/registry.ts`. | — | Independent first passes, shared bounded executor, durable per-attempt unknown handling; no duplicate provider calls on restart. Coordinate workflow host, do not write another engine. |
| 118 | NEW | June reads jury votes, abstentions and dissent; `src/runtime/registry.ts`, `src/reflection/evaluator.ts`. | 117 | Failed synthesis cannot erase dissent/abstention ledger; output remains scoped and not a permission grant. |
| 119 | NEW | Mount explicit typed Jev observations; `src/models/jev.ts`, `src/main.ts`, `src/runtime/registry.ts`. | — | Real typed observation or explicit abstention, bounded provider admission and durable unknown handling; never invent rationale/citations or jury authority. |
| 120 | NEW | Live decaying-drive priority for eligible reflection; `src/reflection/domain.ts`, `src/runtime/reflection.ts`. | 104 | Different drive ages alter ordering, but quiet hours, live reserve, dedupe and attempt bounds still dominate. Drives grant no tools. |

## 121–140: complete existing tool surfaces without widening authority

| ID | State | Small deliverable and owning paths | Depends on | Acceptance / focused verification |
| --- | --- | --- | --- | --- |
| 121 | EXT | June sees bounded MCP connection inventory; `src/tools/connections.ts`, `src/runtime/registry.ts`. | — | Zero configured/enrolled connections says disconnected, not healthy; safe metadata excludes credentials/private endpoints where unnecessary. |
| 122 | BASE | June per-connection catalog inspection; `src/tools/connections.ts`, `src/models/provider.ts`. | — | Existing `mcpCatalog` pages summaries/contracts only for approved discoverable tools; does not authorize execution. Verify existing path, do not add duplicate action. |
| 123 | EXT | Explain selected MCP permission/trust; `src/tools/connections.ts`, `src/runtime/prompt.ts`. | — | Owner read classification explicitly described as trust, not proof server cannot mutate; no model self-reclassification. |
| 124 | EXT | June inspects exact tool proposal receipt/outcome; `src/tools/connections.ts`, `src/runtime/registry.ts`. | — | Recent receipt statuses already reach model; add exact-ID/detail lookup only if needed. Read never invokes tool; unknown remains distinct from denial/success. |
| 125 | NEW | Authenticated MCP proposal cancellation bridge; `src/tools/connections.ts`, `src/tools/broker.ts`. | — | Persist ungranted-proposal cancellation and reject later/replayed confirmation; existing grants delegate broker cancel. An admitted effect is not claimed undone. |
| 126 | NEW | Confirmed-stopped MCP reconciliation bridge; `src/tools/connections.ts`, `src/tools/broker.ts`. | — | Bind exact grant, confirmed stoppage and independently verified succeeded/failed outcome; stopped+unknown remains unknown. No tool reinvocation or model-issued stop proof. |
| 127 | BASE | Revoked permission invalidates outstanding confirmations; `src/tools/connections.ts`, `src/tools/broker.ts`. | — | Existing connection revision change invalidates old confirmations. Grants on unchanged connections remain unaffected; other tools on a revised connection are not assumed unchanged. |
| 128 | NEW | Mount generic capability routes under existing auth/config; `src/tools/routes.ts`, `src/main.ts`, `src/config.ts`. | — | Optional disabled default; unauthenticated/cookie-only mutation rejected; mounted status discoverable without granting capabilities. |
| 129 | NEW | Mount generic opaque action-link routes; `src/links/routes.ts`, `src/links/opaque.ts`, `src/main.ts`. | 128 | Inspect is not redeem; exact owner confirmation, expiry, revocation and single-use proof enforced. Dashboard login links remain separate. |
| 130 | NEW | Opt-in brokered browser read capability; `src/tools/browser.ts`, `src/main.ts`, `src/config.ts`. | 128, 133 | Disabled until explicit isolated execution configuration; bounded safe read exercised locally, no ambient credential access or silent activation. |
| 131 | NEW | Per-action browser mutation proposal; `src/tools/browser.ts`, `src/tools/broker.ts`, `src/runtime/registry.ts`. | 130 | Exact operation/origin/action approved; read grant cannot authorize fill/click/send, replay cannot duplicate effect. |
| 132 | NEW | June reads credential-binding metadata only; `src/credentials/bitwarden.ts`, `src/runtime/inspection.ts`. | — | Configured/absent/unverified bindings visible without vault item values, session or secret material. |
| 133 | EXT | Exact host browser/vault account-origin binding; `src/credentials/bitwarden.ts`, `src/main.ts`. | 132 | Similar domain, changed origin/account and unbound item denied before secret resolution. Reuse existing resolver checks. |
| 134 | NEW | Resolve vault secret only inside approved browser operation; `src/credentials/bitwarden.ts`, `src/tools/browser.ts`. | 130, 133 | Secret not returned to June/logs/reports; explicit approved operation sees it only at exact origin; local fake vault verification. |
| 135 | EXT | Browser cancellation waits for cleanup settlement; `src/tools/browser.ts`, `src/tools/broker.ts`. | 130 | Abort requested while page operation hangs does not falsely release capacity; close only owned context, preserve other sessions. |
| 136 | NEW | June explains public Slack RTS readiness; `src/channels/slack-search.ts`, `src/runtime/inspection.ts`. | — | Scope, runtime flag and current-message token distinguished; configured scope alone does not mean live-verified search. |
| 137 | BASE | Expired/consumed RTS token requires fresh message; `src/channels/slack-search.ts`, `src/runtime/prompt.ts`. | — | Expired/used action token never retried after restart; June explains need for fresh message. No search bodies retained. |
| 138 | EXT | Safe tool outcome taxonomy for June; `src/tools/connections.ts`, `src/runtime/prompt.ts`. | — | Unavailable, denied, rejected, failed and unknown remain distinct; raw provider error/credential content never reflected. |
| 139 | NEW | Credential-free MCP enrollment readiness checklist; `src/console/connections.ts`, `src/runtime/inspection.ts`. | 121 | June identifies missing owner-consent/enrollment step without exposing token/login URL or asserting authorization exists. |
| 140 | EXT | Five-state capability matrix available to June; `src/runtime/inspection.ts`, `src/console/usage.ts`, `src/main.ts`. | — | Implemented/integrated/callable/enabled/live-verified independently derived; absent evidence remains unknown; config is not health. |

## 141–150: recover honestly and measure deployment separately

| ID | State | Small deliverable and owning paths | Depends on | Acceptance / focused verification |
| --- | --- | --- | --- | --- |
| 141 | NEW | June reads bounded interrupted inference history; `src/runtime/inspection.ts`, `src/runtime/registry.ts`. | 006 | Interrupted attempt discoverable with safe identity/time; do not reclassify it again or reveal private message body. |
| 142 | NEW | Outstanding durable-operation diagnostics after restart; `src/runtime/inspection.ts`, `src/runtime/registry.ts`. | — | Started-without-receipt operations listed as unresolved, not failed/successful; inspection cannot retry or release them. |
| 143 | EXT | Replace stale completion board with evidence-backed states; `docs/architecture.md`, `docs/implementation-plan.md`. | 140 | Accepted design changes and five-state matrix agree with actual source; links/evidence distinguish baseline, new code and live activation. No promises of undeployed features. |
| 144 | NEW | Separate process health from blocked/dormant workflow progress; `src/main.ts`, `src/runtime/inspection.ts`. | 142 | Healthy process with held workflow reports both truths; no claim all dormant actors replayed from one health probe. |
| 145 | NEW | Content-free subsystem capacity accounting for June; `src/runtime/inspection.ts`, `src/runtime/priority.ts`. | — | Conversation/execution/reflection/coding counts and unknown holds distinct; no job/private text exposed or admission changed by inspection. |
| 146 | EXT | Bounded background execution admission with owner reserve; `src/runtime/execution.ts`, `src/runtime/priority.ts`. | 145 | Saturated background work does not starve owner live turn; reuse existing queue, preserve active effects, bounded waiters and unknown holds. |
| 147 | NEW | Reflection joins deployment drain truthfully; `src/runtime/lifecycle.ts`, `src/runtime/reflection.ts`. | 007, 145 | Fence new reflection; ignoring abort prevents drain certification until provider settles; no silent enablement of optional feature. |
| 148 | NEW | Installed controller revision distinct from app revision; `scripts/deploy/deploy.py`, `src/deployment/feed.ts`. | — | Old/absent controller version is unknown/old, never inferred from app main; feed supports optional version without breaking old readers. Installation remains separate. |
| 149 | EXT | Superseded-build/staging recovery status in June feed; `scripts/deploy/deploy.py`, `src/deployment/feed.ts`. | 008 | Superseded target is not active release/failure; recovered abandoned stage event reports no private paths; current app remains correctly identified. |
| 150 | NEW | June-readable deployment phase latency; `scripts/deploy/deploy.py`, `src/deployment/feed.ts`. | — | Derive timings from matching revision/attempt events; missing/out-of-order phase is unknown, not zero; no obsolete 30-second claim. |

## LEGION capacity: many task threads, few expensive checks at once

Read-only observations from the planning worktree, September 27 (America/Boise):

| Measurement | 10:55 MDT | 11:04 MDT |
| --- | --- | --- |
| Host / effective user | LEGION / `amp` (UID 1001) | unchanged |
| CPU | Intel i9-14900HX, 24 physical cores / 32 logical CPUs | unchanged |
| RAM | 31 GiB total, 24 GiB available | 21 GiB available |
| Swap | none | none |
| Workspace disk | 576 GiB filesystem, 543 GiB used, 4.1 GiB available; `df` rounds to 100% | 544 GiB used, 3.2 GiB available |
| `/tmp` | 16 GiB tmpfs, 192 MiB used | not remeasured; consumes RAM |
| Load averages (1/5/15m) | 0.10 / 0.13 / 0.71 | 2.47 / 1.95 / 1.32 |
| Pressure | CPU/memory/I/O avg10/60/300 all 0.00 at first sample | not a sustained stress measurement |
| Git worktrees | 32 at first sample | increasing during parent dispatch |
| Runtime | plain host Node 22.23.2; `pnpm exec node` 24.21.0; pnpm 10.33.0 | matching project runtime verified |

**Recommendation: 8–12 actively executing implementation workers, at most four
concurrent one-worker focused test jobs, and one full-suite/build job at a time
when the initial resource margins are available.**
The parent may create all 150 assignment threads; thread count is not permission
to run 150 heavy jobs simultaneously. This is a resource recommendation, not a
Git hold or requirement that an already-verified worker wait to push. No process
was stopped, services restarted, or other worktree data cleaned for this plan.

**11:19 MDT update:** Available RAM fell to 5.4 GiB and workspace disk to 1.4 GiB,
with no swap; load was 10.91/8.56/4.96. `/tmp` used 710 MiB of its 16 GiB tmpfs.
CPU pressure avg10 was 0.49%, memory/I/O avg10 0.00%. Under this reduced margin,
recommend **at most two concurrent expensive focused checks**, matching disk-light
dependency links only, and no background full-suite fleet. Clean only each worker's
own disposable fixtures. Already-verified work may still publish normally.

Disk is the binding observed constraint, not measured CPU exhaustion. Prioritize
the three core workers and direct dependents. Watch available memory, filesystem
bytes and resource pressure between expensive runs. Reduce expensive-job fanout
if memory falls below roughly 8 GiB available, disk below roughly 2 GiB free, or
sustained pressure appears; this is an advisory operating margin, not an invented
benchmark or an enforced global lock. Do not use root-reserved disk or clean others'
work to make checks pass. Newly created tmpfs data still consumes available RAM.

### Validated lightweight dependencies; no 150 duplicate installs

Canonical existing installation: `/home/raygen/Projects/agent/node_modules`.
At baseline, both `package.json` and `pnpm-lock.yaml` exactly match this worktree
and worker 001. Lock SHA-256:
`99559a058674ef757f3e6373dbe7e03cefb5042abc8eba89912028313ce3e7ab`.
The pnpm store is `/home/amp/.local/share/pnpm/store/v11`; matching package files
across existing installs share device/inode (observed link count 55). Hardlinks
save package bytes but per-worktree generated files still cost disk. A combined
`du` reported canonical dependencies at 2.4 GiB and worker 001's additional
hardlink-deduplicated tree at 100 MiB; this is not a promise every install costs
100 MiB or zero bytes. A mass install is not justified by 3.2 GiB headroom.

Use a **real per-worktree `node_modules` directory** linking only package entries
and the existing wrappers/virtual store. Do not symlink the entire directory:
local `.vite`, `.cache`, `.vite-temp` and `.vitest-cache` must stay private. The
shared installation is read-only by agreement, not filesystem-immutable. Never
run install/rebuild/prune/cache-clear or edit packages through these links. Do
not replace an existing worker's dependency directory. If manifests differ, use
a separate matching installation, not the wrong shared tree.

```sh
set -eu
shared=/home/raygen/Projects/agent/node_modules
cmp package.json /home/raygen/Projects/agent/package.json
cmp pnpm-lock.yaml /home/raygen/Projects/agent/pnpm-lock.yaml
test ! -e node_modules && test ! -L node_modules
mkdir node_modules
for entry in "$shared"/* "$shared"/.bin "$shared"/.pnpm; do
  test -e "$entry" || continue
  ln -s "$entry" "node_modules/$(basename "$entry")"
done
pnpm exec node --version

# Substitute only the relevant existing test file(s).
pnpm exec vitest run src/memory/store.test.ts \
  --maxWorkers=1 --no-file-parallelism --maxConcurrency=1 \
  --no-cache --no-fsModuleCache --configLoader=runner
```

Executed in this worktree: links used 12 KiB; Node 24.21.0; the existing 11 store
tests passed. Canonical `.vite`/`.vite-temp` directory timestamps were unchanged.
Vitest 5.0.2 CLI help confirms these flags; `configLoader=runner` avoids temporary
bundled config output and is experimental. This proves the focused check, not
every test's isolation or a read-only mount. Existing real-engine tests create
unique temporary storage/ports; preserve those. One Vitest worker can still launch
its own child processes. Do not point any test at production or a shared engine.
The same recipe is in the parent's untracked common worker brief.

## Completion evidence and feature-local activation

The coordinator's completion record for each durable ID is:

```text
ID | owner thread | outcome (landed / verified-baseline / subsumed / blocked)
base revision | commit + fresh main ancestry | June-facing acceptance
formatter / lint / types / focused checks | Oracle findings resolved or limitation
implemented / integrated / callable / enabled / live-verified
dependency satisfied by | parent archive confirmation
```

The task-row classifications describe the inspected baseline; the following
point-in-time completion snapshot supersedes them for delivery status. The parent
continues recording results as they arrive. A verified no-op needs specific
source/runtime evidence and review, not an empty commit. Archival follows the
parent's recorded terminal result, not merely an idle agent.

### Completion snapshot reported by parent at 11:12–11:15 MDT

Checks/Oracle outcomes in this table are worker reports retrieved from the parent,
not tests rerun by the planner. The listed commits were present in freshly fetched
main. No row here establishes live activation or successful real-provider work.

| Task | Outcome / evidence | Verification and archive status |
| --- | --- | --- |
| 001 | Published [0ff7f00](https://github.com/lordbagel42/agent/commit/0ff7f00), private job inspection/cancellation. | Parent reports landed; worker still observing deployment, not recorded archived in this snapshot. |
| 007 | Published [d1b8b8f](https://github.com/lordbagel42/agent/commit/d1b8b8f28e56790896256bb7a1d66e5d24295e77); production logic unchanged, evidence-based settlement polling/assertions. | Format/lint/types and focused/repeated checks passed; Oracle no blockers; archived. Controlled state stop 1 ms versus RPC return 1561 ms explained original deadline. Separate recovery failure retained. |
| 009 | Published [5cb79e3](https://github.com/lordbagel42/agent/commit/5cb79e360cdc11ec7cd4082949e2a07df83c7b52), bounded existing-claim extraction context. | Format/lint/types, focused tests and synthetic real-Rivet/provider flow passed; Oracle no blockers; archived. |
| 011 | Verified baseline no-op at [3927553](https://github.com/lordbagel42/agent/commit/39275538729b2692ec1160804ca7485dda49404f), no commit. | Real-SQLite invalid/valid relation scenarios plus store tests/checks passed; Oracle confirms invariant; archived. |
| 012 | Verified baseline no-op at [34e7401](https://github.com/lordbagel42/agent/commit/34e740110c2bf81f3104c1d00c6e8b7c4ee1c24b), no commit. | Asymmetric scope/ranking/budget cases and store/routing/prompt/runtime checks passed; Oracle no blockers; archived. |
| 013 | Published [fbbe365](https://github.com/lordbagel42/agent/commit/fbbe365177bd34a64dbe7cc8cb2a6dcd56d7484f), budget-sharing omission metadata. | Format/lint/types, focused checks and exact JSON budget/privacy boundaries passed; Oracle no blockers; archived. |
| 015 | Published [6d36f36](https://github.com/lordbagel42/agent/commit/6d36f364ac86fd57fdfb8229d039afd733c6b6bd), first-successful source-set extraction receipt, including empty results. | Format/lint/types and focused restart/review/deletion/competing-completion checks passed; Oracle no blockers; archived. |
| 016 | Verified baseline no-op at [3927553](https://github.com/lordbagel42/agent/commit/39275538729b2692ec1160804ca7485dda49404f), no commit. | Invalid-output, unauthorized-source and valid multi-source scenarios plus store/checks passed; Oracle no bypass; archived. |
| 020 | Published [46df63f](https://github.com/lordbagel42/agent/commit/46df63f4e0c36435f5802f761738248f1ce8dd53), uncertainty/contradiction prompt guidance. | Format/lint/types, focused tests and synthetic store-to-prompt check passed; Oracle no blockers; archived. |

The plan itself received Oracle decomposition review. Its concrete corrections
are incorporated in the first-slice contracts and task rows above: private/public
personality publication, non-self-invalidating reflection review, resumable forget,
restore validation, atomic send policy, ungranted MCP cancellation, truthful MCP
reconciliation, baseline/no-op labels and local dependency ordering. The planner
also checked all 150 unique IDs, populated columns and an acyclic dependency graph.

Audit verification limits remain relevant: the earlier full run was 569 passing
and five failures; four affected files passed isolated/sequential rerun, while
reflection failed. A later separate batch reported 570/574 with known timing/
shutdown failures. These are not a clean-suite claim for this plan or current
main. Worker 007 later reported six standalone reflection passes; do not assume
the original diagnosis is established. Keep failure evidence and distinguish
timing contention from production logic before changing timeouts.

The audit found coding, retained memory/extraction, curated personality and
reflection disabled, no saved MCP connections, no configured imports, and public
Slack RTS disabled despite granted bot scope. Treat this as an audited snapshot,
not a live configuration probe performed by the planner. Browser/vault needs
protected execution acceptance; worktrees/prompts are not OS isolation. Import
activation needs actual account/scope/consent review. Backup/restore tooling here
uses disposable data, existing authenticated encryption and established APIs;
never create a homemade cipher or put keys in a manifest. Retention dry-runs do
not authorize physical deletion. Controller installation/configuration changes
must use their documented operator workflow, not an incidental application push.

Optional integrations can publish disabled code and truthful readiness while
their own activation evidence is gathered. They never block unrelated shipping.
