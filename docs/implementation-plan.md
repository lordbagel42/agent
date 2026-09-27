# June: implementation and activation evidence

Goal: one conversational identity with durable work, usable Amp access, an
iterable global personality, and scoped memories. The accepted design is in
[architecture.md](architecture.md). Slack is the selected messaging rollout;
WhatsApp is shelved and the Linq spike is not a production integration.

## Five independent states, not a completion checkbox

This source audit was made on September 27, 2026 against fetched GitHub `main` at
[`6d6164cb`](https://github.com/lordbagel42/agent/commit/6d6164cbff88d387bfeec5c866fe4d37d44032dd).
It replaces the September 26 worktree ownership/completion board. Assigned work,
worker reports, local branches, and unmerged changes are not landed evidence.
The source table describes that revision, not a continuously updated deployment report.

Each field is independently **yes / no / unknown**:

- **Implemented:** source support exists for the named operation, not the whole
  architectural ambition or every edge case.
- **Host-integrated:** a production entrypoint wires the implementation. Here
  `yes` means the source mounts it when its prerequisites are met; it does not
  attest that a deployed process has mounted it.
- **June-callable:** a direct model action route exists in a fresh eligible turn.
  Private operations require an owner-private, non-synthesis turn. Automatic
  prompt enrichment and operator-only APIs do not count. Metadata inspection is
  a separate operation from recall, mutation, or execution.
- **Enabled:** configuration and required host activation gates are satisfied in
  the observed process. Defaults, example config, and route existence are not
  evidence. Enabled is neither healthy nor approved for a particular action.
- **Live-verified:** a dated, revision-bound observation exercised this specific
  capability against its actual service boundary. Unit/fixture tests, a main
  push, a historical healthy release, or generic process health do not establish it.

No current production configuration or capability attestation was collected for
this documentation audit. **Enabled and live-verified are therefore unknown in
every row**, including source-integrated features. `No` below is an observed
source gap at the pinned revision, not a claim about a future release.

## Source-backed capability matrix

Evidence links below are relative for browsing the checkout. Read them at the
pinned revision above when comparing historical states. This is a selected
inventory, not a claim that every planned rollout task is represented.

| Capability / operation at the audited revision | Implemented | Host-integrated | June-callable | Enabled | Live-verified | Evidence and boundary |
| --- | --- | --- | --- | --- | --- | --- |
| Slack conversation, text/reaction/silence and durable delivery | yes | yes | yes | unknown | unknown | [Slack adapter](../src/channels/slack.ts), [registry](../src/runtime/registry.ts), [delivery](../src/runtime/delivery.ts), [host](../src/main.ts). Channel/model credentials and owner identity are prerequisites; an uncertain send is not retried as a fresh effect. |
| Persistent execution agents for research/coding preparation | yes | yes | yes | unknown | unknown | [Execution actors](../src/runtime/execution.ts), [prompt](../src/runtime/prompt.ts), [host](../src/main.ts): `execution` run/cancel, gated by `executionEnabled` and setup mode. They are not native coding workers. |
| Native Amp/Codex/Claude/Pi coding proposals | yes | yes | yes | unknown | unknown | [Adapters](../src/coding), [coding actor](../src/runtime/coding.ts), [registry](../src/runtime/registry.ts), [host](../src/main.ts): `coding` requires an activated runtime and a configured workspace. Owner `!approve` and confirmed-stopped reconciliation are separate authority. |
| Coding job status and cancellation | yes | yes | yes | unknown | unknown | [Registry](../src/runtime/registry.ts), [prompt](../src/runtime/prompt.ts): `codingJob` list/inspect/cancel does not require enabled native coding. Cancelling an admitted job requests abort; it does not prove settlement or release uncertain admission. |
| Native coding prerequisite inspection | yes | yes | yes | unknown | unknown | [Preflight](../src/coding/preflight.ts), [inspection](../src/runtime/inspection.ts): `inspection: "native-coding"` works even when coding is disabled. Configuration/local checks do not verify login or isolation. |
| Encrypted evidence graph and explicit owner-private recall | yes | yes | yes | unknown | unknown | [Store](../src/memory/store.ts), [registry](../src/runtime/registry.ts), [reply contract](../src/core/contracts.ts): `recall` provides bounded retained-evidence retrieval, distinct from automatic prompt enrichment and metadata inspection. It cannot search a live account, accept claims or change permissions. |
| Live owner-private Slack source capture and extraction | yes | yes | no | unknown | unknown | [Host source filter](../src/main.ts), [extractor](../src/models/extraction.ts), [store](../src/memory/store.ts). Capture is direct owner-private Slack only, with a verified `slack.workspaceUrl`; extraction additionally requires `memory.extraction`, reviewed provider access and non-setup mode. |
| Authenticated owner correction evidence | yes | yes | no | unknown | unknown | [Correction handler](../src/memory/correction.ts), [registry](../src/runtime/registry.ts), [prompt](../src/runtime/prompt.ts). The owner sends `!memory-correct` as a standalone Slack DM command. June explains the command but cannot submit/approve it; recording provenance does not apply a personality revision. |
| Pending memory claim inspection | yes | yes | yes | unknown | unknown | [Pending view](../src/memory/pending.ts), [registry](../src/runtime/registry.ts): `pendingMemory: true` returns bounded private pending-claim text/IDs and uncertainty. It is not acceptance, deletion, raw-source recall or a fresh extraction. |
| Memory proposal review and source forgetting | yes | yes | no | unknown | unknown | [Memory routes](../src/http/memory.ts), [store](../src/memory/store.ts), [registry](../src/runtime/registry.ts). Authenticated operator routes exist; the owner can also send an exact `!memory-accept` command in a fresh Slack DM. Model output and metadata inspection cannot accept/forget. Tombstones are not physical purge of all history/backups. |
| Grounded private personality revisions, rollback and operator inspection | yes | yes | no | unknown | unknown | [Curated store](../src/memory/curated.ts), [personality domain](../src/reflection/personality.ts), [operator routes](../src/http/memory.ts). Fresh turns use the global style. Configured curated traits also reach owner-private prompts as evidence-revalidated `ownerPrivatePreferences`, subordinate to the global profile. Only legacy journals project them under `style`. Private learned-pattern context is separate. |
| One public-safe global personality with revision/history/rollback | yes | yes | no | unknown | unknown | [Global actor](../src/runtime/personality.ts), [registry](../src/runtime/registry.ts), [prompt](../src/runtime/prompt.ts). A shared closed-vocabulary style snapshot reaches conversation prompts independently of retained memory. June can describe it and suggest commands; only authenticated owner-private `!personality` commands publish revisions. There is no direct model mutation route. |
| Approved Slack/Gmail historical import pages | yes | yes | no | unknown | unknown | [Import service](../src/imports/index.ts), [routes](../src/http/imports.ts), [host](../src/main.ts). Exact selected coverage and page confirmation precede each fetch. Status inspection cannot start/cancel imports; selected-window exhaustion is not complete account history. |
| Reflection requests, scheduling and provisional candidates | yes | yes | yes | unknown | unknown | [Reflection actor](../src/runtime/reflection.ts), [registry](../src/runtime/registry.ts), [prompt](../src/runtime/prompt.ts). `reflectionRequest` queues bounded existing evidence under host-bound scope. A queued receipt is not completed reflection, candidate approval, memory/personality mutation or outbound delivery. |
| Bounded private jury deliberation | yes | yes | yes | unknown | unknown | [Jury tool](../src/reflection/jury.ts), [evaluator](../src/reflection/evaluator.ts), [host](../src/main.ts), [registry](../src/runtime/registry.ts): `jury` uses already supplied owner-private evidence and two configured first-pass jurors using the same model, plus critic and synthesis. Shared capacity limits, failures or timeouts may yield abstention. Its advisory result is not verified evidence, unanimity or action approval. |
| Typed Jev observations | yes | yes | yes | unknown | unknown | [Jev provider](../src/models/jev.ts), [host](../src/main.ts), [prompt](../src/runtime/prompt.ts): `jevObservation` observes the bounded current owner-private message under a fixed configured rubric. Observations are not jury verdicts, calibrated truth or action approvals. |
| Memory/import/reflection metadata inspection | yes | yes | yes | unknown | unknown | [Inspection reader](../src/runtime/inspection.ts), [prompt](../src/runtime/prompt.ts), [host](../src/main.ts): `inspection` returns bounded private metadata without evidence bodies or new model synthesis. Disabled dependencies report unavailable. |
| MCP catalog and permission-gated tool calls | yes | yes | yes | unknown | unknown | [Connections](../src/tools/connections.ts), [broker](../src/tools/broker.ts), [host](../src/main.ts): `mcpCatalog` / `mcp`. Requires enrollment and per-tool permissions; newly discovered tools are disabled. Catalog visibility is not execution approval. |
| Generic capability operator routes | yes | yes | no | unknown | unknown | [Capability routes](../src/tools/routes.ts), [HTTP host](../src/http/app.ts), [startup](../src/main.ts). Optional `capabilities.directory` mounts bearer-protected proposals/grants/receipts; mounting does not register tools or grant execution. |
| Generic broker/browser configuration inspection | yes | yes | yes | unknown | unknown | [Inspection reader](../src/runtime/inspection.ts), [host](../src/main.ts): `inspection: "capabilities"` reports broker mounting and browser prerequisites without granting capabilities, launching Chromium or resolving credentials. |
| Anonymous browser read recipes | yes | yes | no | unknown | unknown | [Browser adapter](../src/tools/browser.ts), [host](../src/main.ts), [browser guide](browser.md). Opt-in named GET recipes have no interaction steps or vault access. Exact recipe-digest/account/item/origin grants authorize operator execution; results are receipts, not webpage content or a direct June browser action. |
| Browser mutation and credentialed-operation proposals | yes | yes | yes | unknown | unknown | [Proposal tool](../src/tools/browser-proposals.ts), [host](../src/main.ts), [prompt](../src/runtime/prompt.ts): `browserProposal` discovers names or proposes one configured recipe. It performs no browser/network action, reads no vault secret and grants nothing. Exact owner grant and execution are separate operator actions; a read grant cannot authorize mutation. |
| Generic opaque action links | yes | yes | no | unknown | unknown | [Action-link routes](../src/links/routes.ts), [HTTP host](../src/http/app.ts). Requires generic capabilities plus private console. Bearer-authorized issuance and authenticated exact-action confirmation remain separate from inspection; opening a link does not execute it. These are not dashboard sign-in links. |
| Vault-backed browser execution | yes | yes | no | unknown | unknown | [Browser worker](../src/tools/browser.ts), [Bitwarden resolver](../src/credentials/bitwarden.ts), [host](../src/main.ts). Separately configured credential recipes bind account/item/origin and kind; only approved execution can resolve their secret. Anonymous recipes do not use the vault, even with the same scope. Metadata and proposals neither read secrets nor prove vault authentication. |
| Private console and owner dashboard sign-in link | yes | yes | yes | unknown | unknown | [Console](../src/console), [HTTP host](../src/http/app.ts), [prompt](../src/runtime/prompt.ts): `dashboardLogin` issues a short-lived, single-use private sign-in link, not approval for a tool action. Requires `console.origin`. |
| Public Slack real-time search | yes | yes | yes | unknown | unknown | [Search transport](../src/channels/slack-search.ts), [registry](../src/runtime/registry.ts), [config](../src/config.ts): `search` requires `slack.searchEnabled`, actual platform authorization and a fresh message action token. Private/DM search is not this capability; manifest scopes are not grants. |
| Deployment evidence inspection | yes | yes | yes | unknown | unknown | [Feed and release tool](../src/deployment/feed.ts), [host](../src/main.ts): `release: {"action":"inspect","revision":null}` reads controller evidence. It cannot deploy or attest the installed controller version from application source. |

The initial audit baseline
[`50d27fe`](https://github.com/lordbagel42/agent/commit/50d27fe20b495c7f3058a015e69a0bb72948fdcb)
already contained storage, automatic scoped retrieval, private curation and
inspection. Explicit recall landed in
[`692b1e0`](https://github.com/lordbagel42/agent/commit/692b1e0), and authenticated
correction provenance in
[`64298b3`](https://github.com/lordbagel42/agent/commit/64298b3). Global personality
landed in [`30077f1`](https://github.com/lordbagel42/agent/commit/30077f185fa332de164864b7dfa158b7be2c002f),
and pending-claim inspection in
[`ddd20aa`](https://github.com/lordbagel42/agent/commit/ddd20aaab3adf8a0cbf24084d70dacad01b4ffc6).
Generic broker routes landed in
[`3918a3d`](https://github.com/lordbagel42/agent/commit/3918a3d62c92273abdebeeb7440e36b1e9120920),
and opt-in anonymous browser reads in
[`4340ce3`](https://github.com/lordbagel42/agent/commit/4340ce37f1045bcf8e21d3a051e603a4168dc9b6).
Later landed paths include [action links](https://github.com/lordbagel42/agent/commit/19725beaffcfa4f6e2a37c16303ce0d03f55647c),
[Jev observations](https://github.com/lordbagel42/agent/commit/a9c4c2f85accf2aaec666515d67b297672b08058),
[owner claim acceptance](https://github.com/lordbagel42/agent/commit/e3f98d47a3d4b6f8768cb312ef8314cf2588aae9)
and [reflection requests](https://github.com/lordbagel42/agent/commit/29c4bdcdf14bbcfbcf201d58fc8fb6b171fe19b5).
The refreshed audit also includes landed
[browser mutation proposals](https://github.com/lordbagel42/agent/commit/ca5c0cc)
and [private jury requests](https://github.com/lordbagel42/agent/commit/93dc746),
then [approved vault-backed browser execution](https://github.com/lordbagel42/agent/commit/69f99557).
These are source changes, not evidence of activation or live exercise.

## June can inspect the responding runtime

The runtime matrix landed in
[`6d6164cb`](https://github.com/lordbagel42/agent/commit/6d6164cbff88d387bfeec5c866fe4d37d44032dd).
In a fresh owner-private, non-synthesis turn, June can request:

```json
{"text":"","inspection":"capability-matrix"}
```

Leave every other action unset/null. Setup mode suppresses model invocation.
[Prompt discovery](../src/runtime/prompt.ts), the [inspection dispatcher](../src/runtime/inspection.ts)
and the [host callback](../src/main.ts) expose nine selected host capabilities,
not an exhaustive inventory. Each row independently returns `implemented`,
`hostIntegrated`, `juneCallable`, `enabled` and `liveVerified` as `yes`, `no` or `unknown`.

Unlike the static source table, this snapshot describes the answering process's
mounted dependencies and configuration/host gates. It performs no provider,
tool or health probes and returns no secrets or evidence bodies. All nine
`liveVerified` values remain `unknown`: no general capability attestation is
wired. Enabled is not action approval, provider authorization or health.

Imports remain operator-only even when enabled. Mounted memory supplies the
direct `recall` route; mounted memory plus reflection supplies `reflectionRequest`,
which queues work rather than proving completion. MCP per-tool callability and
activation remain unknown when the broker is mounted/configured because this
view does not read the catalog or permissions. Per-turn guards still apply.
The existing `inspection: "capabilities"` is a separate generic broker/browser
metadata view; it is not an alias for `capability-matrix`.

## Activation and delivery remain separate work

The [config schema](../src/config.ts) and [startup checks](../src/main.ts) are the
source of activation requirements. At the audited revision:

- Native coding defaults off and requires explicit runtime/workspace isolation
  configuration and `JUNE_ALLOW_NATIVE_CODING=1`. These checks do not create a
  sandbox or validate a provider login. Each job still needs authorization.
- Retained memory requires `memory`, `JUNE_ALLOW_MEMORY=1`, private storage and
  a key; with Slack configured, `slack.workspaceUrl` is required. Private
  personality revisions additionally require `memory.curated` and its directory/key.
- Extraction and reflection require their own `memory.extraction` / `reflection`
  configuration, `JUNE_ALLOW_MEMORY_MODELS=1` and provider credentials. Imports
  require configured `imports`, `JUNE_ALLOW_HISTORY_IMPORTS=1`, account-bound
  selected coverage and authenticated page confirmation. Setup mode rejects
  extraction, reflection and imports; base memory activation does not enable them.
- Jury mounting additionally requires `reflection.juryEnabled` and positive
  configured background capacity (`totalCapacity - liveReserve`). Each invocation
  requires valid, already supplied owner-private evidence. Jurors, critic and
  synthesis share the reflection executor; configuration does not prove calls ran.
- Jev requires `jev` configuration with an HTTPS endpoint, provider credential,
  bounded observation rubric and `JUNE_ALLOW_JEV=1`, outside setup mode.
- MCP requires private console/configuration, encryption material, account
  enrollment and tool permissions. Browser/vault activation is not established
  by MCP enrollment. No credential values belong in status reports.
- Browser operations require `capabilities.directory`, `browser.enabled`, named
  recipes, explicit isolated-execution configuration and
  `JUNE_ALLOW_ISOLATED_BROWSER=1`, plus the host's environment/directory checks.
  Credential recipes additionally require protected `credentials` configuration
  and exact account/item/origin/kind bindings; configuration does not prove login.
  Operator isolation acknowledgments are not sandbox verification; an exact
  grant is still required for each execution. See [browser.md](browser.md).
- Deployment inspection requires `deployment` configuration and the read-only
  controller feed. Feed availability does not attest the installed controller.
- A trusted main push and automatic deployment are different observations.
  Follow [deployment.md](deployment.md): identify the loaded process revision,
  controller evidence and relevant capability result independently. Installing
  a changed controller is separate from publishing application code.

## Verification and future updates

Source inspection establishes only the first three columns. Existing focused
checks such as [inspection privacy/runtime coverage](../src/runtime/inspection.test.ts),
[coding lifecycle checks](../src/runtime/coding.test.ts) and the [test harness](../tests/rivet.ts)
exercise disposable/fake boundaries; their presence is not a claim they were
rerun by this docs-only audit or that production was exercised.

For every status update, record the exact landed source revision and operation.
For live evidence, also record observation time, loaded application revision,
relevant controller/runtime identity, prerequisites, exercised path and result.
Keep private source bodies, credentials and login links out of the evidence.
Missing, stale or wrong-revision evidence stays unknown. A historical successful
synthetic Slack send does not prove human-origin ingress or a later deployment.

Further reviewed learning actions, optional host mounts and independently
verified activation must each earn their own capability-local state changes.
Do not interpret this list as proof that another worker's in-flight change landed.
Preserve journal compatibility, audience filtering before retrieval, deletion
revalidation before projection/delivery, and held uncertain external outcomes.
Extended recovery, retention/restore and resource/isolation checks remain
separate from a generic health probe. Follow `AGENTS.md` for minimal tests and
normal formatter/linter/typechecker verification when changing code.
