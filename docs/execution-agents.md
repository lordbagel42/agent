# June's interaction and execution loop

June owns conversation, personality, clarification, delegation, and synthesis.
When authorized dispatch is available, persistent execution agents own essentially
all task work: research, writing, editing, summarization, calculations, analysis,
planning, and coding preparation. Small, familiar, or tool-free tasks still go to
execution agents. Ordinary conversation, synthesis of supplied results, and explicit
direct-action exceptions stay with June. Execution agents do their assigned work
and cannot dispatch further execution workers. This follows OpenPoke's
interaction/execution separation, not its particular integrations or unrestricted
tool access.

June treats those capabilities as her own: a clear request such as "research
xyz" starts authorized work, not a discussion of who will do it. She acts as
though she is capable of anything: assume the task is achievable, investigate
available routes, and try suitable permitted alternatives before reporting a
concrete blocker. This does not grant access, bypass approvals, repeat uncertain
effects, or extend a turn's budget.

Workers and handoffs stay internal unless someone explicitly asks about them
or an actual execution failure makes them relevant. Acknowledgments, requested
progress and completion replies describe the task and findings in June's voice.
Internal reports and required approval/diagnostic records retain their evidence
and exact identifiers; this is not an output keyword filter. The shared policy
reaches conversation, execution and automated-event prompts. Completion turns
still synthesize evidence without starting more work. Requested deliverables retain
their wording, capitalization and formatting; June's conversational voice applies
to surrounding commentary, not the draft or result itself. This does not bypass
privacy or verification limits or forward internal report framing.

## June-facing interface

The model schema and prompt expose this owner-only action:

```json
{"text":"I'll compare both options.","execution":[
  {"agent":"trains","action":"run","task":"Compare the requested public train options; cite sources and uncertainty."},
  {"agent":"hotels","action":"run","task":"Compare the requested hotels; cite sources and uncertainty."}
]}
```

Reuse a name to follow up with the same worker. Read the supplied scope-local
roster for pending counts, status, and latest reports without launching work.
Reuse a suitable general-purpose worker for small or one-off tasks rather than
creating a name for every request; names persist and are capped at 32 per
conversation. Separate workers can handle independent parallel tasks.
Keep each task brief within 2,000 characters. Workers receive the current request
text in full, so reference it instead of copying it. Earlier context needs a
necessary authorized excerpt or targeted authorized recall when available.
Cancel with `{"agent":"trains","action":"cancel","task":""}`. The host reports
admission failures rather than silently accepting a false success claim.
Worker completions wake June to synthesize findings or stay silent if redundant.
Completion turns cannot dispatch new actions. Coding proposals retain the existing
private `/approve` requirement; coding results return to June and worker history.

The host's coding preview names the exact workspace alias, canonical repository
path, configured native runtime, and task. `/approve ID` authorizes only that
local task in an isolated checkout—not pushing, deploying, publishing, shared
infrastructure changes, or credential access. Native execution is not a sandbox.
Changed tasks or workspaces get a fresh proposal and approval ID; changed runtime
or execution policy cannot reuse the old approval. June must not present a coding
approval or a passing verifier result as delivery authority.

June delegates reviewed, evaluated skill candidates to an execution worker.
The worker can return this request for the same unapproved proposal in an
owner-private scope; it is not an interaction-model directive:

```json
{"text":"","skillCodingProposal":{"candidateId":"<64-character reflection alias>","workspace":"june"}}
```

The host receives the worker's separate proposal after completion, preserving
its original delegation and evidence. It resolves the immutable skill and copies
its exact proposed behavior,
never a model-supplied replacement task, digest or approval. It checks the current
settled all-yes held-out evaluation after inference settles and again before
queueing; original training, held-out and conversation evidence remain deletion
dependencies. The receiving job rechecks evaluation and the frozen originating
deletion revision immediately before accepting the proposal, including after
queue delays. A historical evaluation is not permission. The skill gets one job
ID across retries: the first workspace, task, preview and runtime binding stay
frozen, and a different workspace is refused. Existing `codingJob` inspection and
cancellation apply. The owner must separately send `!approve ID` as an ordinary
private message before local execution. This bridge cannot approve, run, resume,
install, push or deploy anything, or enable dormant coding/reflection integrations.

## Per-worker command environments

`environment` gives each authorized owner-private execution worker its own
command workspace. The model loop remains in June; shell commands run in the
isolated environment. BoxLite is the default workspace provider; E2B remains
available through its independent one-shot tool. Neither is enabled just by
publishing this code. No automatic provider fallback, VM provisioning, or live
configuration change is implied.

June delegates through the existing roster. Granted workers can emit:

```json
{"text":"","environment":{"action":"status"}}
{"text":"","environment":{"action":"exec","command":"printf 'hello' > greeting.txt; cat greeting.txt"}}
```

The host chooses the VM from the authenticated actor key, not a model-provided
ID. A worker reuses its VM across commands. Commands use non-root Bash in
`/workspace`; each invocation starts a new shell. Use files and explicit `cd`,
not shell variables, for continuity. BoxLite retains the worker's disk across
assignments but stops compute before completion is recorded. Revocation requests
destruction of all its policy generations after confirmed teardown. Background
processes do not survive assignment completion.

The supplied image preloads **Vercel agent-browser 0.38.2, Chromium, Node 24,
Python, Git, curl, jq and ripgrep**. Use a unique browser `--session` for the
task, inspect `snapshot -i` before interacting, and close only that session.
Read the bundled CLI guide in bounded sections rather than overflowing the
tool's output budget. Offline local pages work without network access. VM files
and screenshots are not automatically delivered to the user, and this is not
the separate browser companion's live-view/PIN workflow.

Interaction, execution and automated-event prompts carry this knowledge;
repository/research specialists and text-only workflow steps are told about it
without gaining a shell. Guests, shared channels, automated events, synthesis
and legacy requests lacking the saved grant cannot use it. Commands do not grant
host access, credentials, coding approval, publication or deployment authority.
QuickJS remains preferable for small pure calculations. The existing one-shot
`e2b` action is unchanged and independent of this provider selection.

### Build and validate the browser image

On a disposable image builder, from the repository root:

```sh
docker build -t june-environment:reviewed src/environments/image
docker run --rm --network none --shm-size=256m --memory=2g --cpus=2 \
  --pids-limit=128 june-environment:reviewed june-environment-smoke
```

The smoke check verifies non-root execution, writable workspace, Python, Node,
Git, Chromium, a real agent-browser click and screenshot. An optional absolute
argument saves the screenshot outside its temporary directory. A container pass
is **not** a BoxLite boot/teardown test. Build for the execution host's architecture;
publish only with registry authorization. Configure the resulting **digest-pinned**
image reference, not the mutable build tag. Alternatively export an OCI layout:

```sh
docker buildx build --platform linux/amd64 \
  --output type=oci,dest=/tmp/june-browser.oci.tar src/environments/image
mkdir /tmp/june-browser-oci
tar -xf /tmp/june-browser.oci.tar -C /tmp/june-browser-oci
```

`rootfsPath` means an **OCI layout directory** containing `oci-layout`, `index.json`
and `blobs`, not `docker save` output or an unpacked Linux root. Provision it at
an immutable, versioned path readable by June, outside Git and separate from VM
state. Never overwrite that directory in place: BoxLite caches layers and retained
disks by declared image identity. The build fetches packages; guest boot does not
install packages or download a browser. Rebuild/review regularly for security
updates; a pinned browser CLI is not an indefinite browser-security guarantee.

### Operator activation is separate

After host, retention and network review, provision a new empty canonical mode-0700
directory owned by June, outside any Git checkout, and an immutable image/layout.
The disabled example is:

```json
"environments": {
  "enabled": false,
  "provider": "boxlite",
  "directory": "/var/lib/june-environments",
  "rootfsPath": "/var/lib/june-images/browser-v1",
  "allowedHosts": []
}
```

Set `enabled: true` **and** `JUNE_ALLOW_AGENT_ENVIRONMENTS=1` only in a separately
authorized deployment/configuration window. Execution workers must be enabled
and setup mode off. Linux x64/arm64 with usable read/write `/dev/kvm`, the optional
pinned native SDK, and BoxLite's Linux jailer prerequisites are required. A VM
host needs working nested virtualization, not merely a device pathname.

The service must also support BoxLite's dedicated cgroup-v2 placement and allow
targeted reads of its launcher `/proc` identity and cgroup. BoxLite 0.10.5 uses
`/sys/fs/cgroup/boxlite/<id>` for root or the matching systemd user-service base
for non-root; setup and joining are best-effort upstream. June requires actual
membership before admitting a command, and observes the **same cgroup subtree
empty** after SDK stop before freeing capacity. Missing permissions, failed
placement, replaced/missing groups or remaining compute fail closed. Do not run
June as root or relax its sandbox to work around this; provision and validate a
dedicated execution account/cgroup policy under operator control. No other
process may manage these boxes or migrate their host processes.

`june-active` is a durable exclusive crash fence in the VM directory, created
before native SDK construction. It is removed only after verified environment
teardown and runtime shutdown. **Any ungraceful host exit requires operator
reconciliation before restart**, even if no command was recorded. Do not delete
the marker based on PID age, SDK `Stopped` status, or absence of a PID file;
independently establish that all prior compute is gone while holding exclusive
operator ownership. Retain disks and uncertain execution receipts. Never start a
second provider, change directories, or restore old conversation state to bypass
the fence. This intentionally conservative policy has no automatic crash recovery.
Shutdown/configuration changes must follow [deployment coordination](deployment.md).

The host persists a storage identity in `june-managed-v1`; workers save that
binding before their first command. Disabling or replacing that provider cannot
silently complete forgetting: the original storage must be available for verified
deletion. `june-boxes/<box-id>` records hashed ownership before VM boot, separately
from SDK metadata. SDK removal can succeed while leaving disk files; June checks
absence of `boxes/<box-id>` before retiring the record. Failed deletion retains
its concrete target across restart for operator reconciliation, not automatic
filesystem removal. No clone, export, snapshot, host-volume or external box
management is supported. Shared immutable image caches are not task data;
path deletion is not secure erasure of backups or underlying storage blocks.

Networking defaults **off**, with no host mounts, injected host environment,
secrets or exposed ports. `allowedHosts` enables outbound BoxLite hostname
routing only for reviewed domains; empty means explicitly disabled, not an empty
allowlist on an enabled network. Hostname filters are not a complete exfiltration
boundary (notably DNS); use independent egress controls when enabling networking,
and never place credentials or unrelated private context in these environments.
Guest network policy does not govern the host's initial image-registry fetch.

Limits: four active environments process-wide (the existing priority queue may
admit fewer), 30 seconds per command including first boot, 24 KB UTF-8 command,
8 KB combined retained stdout/stderr, and BoxLite defaults of two vCPUs, 2 GiB RAM
and an 8 GiB guest disk. The provider refuses new boxes at its retained-box cap
of 128; there is no automatic disk eviction. Provision a separate host storage
quota and monitor image caches/retained disks. Output limits bound retained text,
not native SDK transport buffers. Timeout/output/transport failures end tool use
for the assignment; late operations must settle and cleanup must be verified.
Unknown cleanup retains capacity and blocks safe drain. No uncertain command is
automatically replayed. Positive exit codes remain available for diagnosis;
negative SDK outcomes (including its synthetic `-1` on transport failure) are
treated as unknown, not a confirmed process exit.

The existing [one-shot E2B tool](usage.md#optional-e2b-execution) is unchanged and
can still be configured independently. `environments.provider: "e2b"` is refused:
the reviewed API acknowledges asynchronous deletion before guest termination,
so it cannot meet this workspace provider's strong teardown/drain contract.
Neither a successful DELETE, missing listing nor elapsed TTL establishes that
contract. A future adapter needs a verified completion guarantee or a separately
reviewed weaker lifecycle/accounting policy. Never use E2B to bypass uncertain
local cleanup.

Before live enablement, use disposable state on the intended KVM host: run the
smoke check through a real worker, isolate different values in two workers,
verify same-worker disk retention with no surviving background process, then
exercise cancellation, output overflow, revocation, clean restart and the crash
fence. Fixtures and Docker checks do not establish those native guarantees or
production performance. Observe June's receipts and loaded revision separately.

### Replacing the provider

`EnvironmentProvider` owns connect/destroy/close; `Environment` owns exec/stop.
The shared service owns authorization revalidation, output limits, capacity and
cleanup accounting. A new provider must preserve worker ownership, accurate
persistence semantics, a durable storage binding and confirmed teardown/deletion;
SDK objects, host paths, provider credentials and model-selected VM IDs never
cross into the tool schema.

[Cloudflare Computer](https://developers.cloudflare.com/changelog/post/2026-08-03-cloudflare-computer/)
is a researched future option, **not an implemented provider**. Its early-preview
`@cloudflare/computer` workspace uses SQLite in a Durable Object and offers
`read`/`write`/`edit`/`ls`/`exec`, with just-bash/Dynamic Worker isolates or a full
Linux Container backend mounted through FUSE. Native agent-browser/Chromium needs
the container backend. A future adapter needs remote authentication, ownership,
timeouts, cleanup and storage-contract validation; it is not a drop-in local
BoxLite replacement. No Cloudflare resources are provisioned by this feature.

## Boundaries and recovery

- Each request reads June's approved global public-safe personality once and uses
  that snapshot for every worker model step. Reusing a worker for a new task or
  follow-up picks up the latest revision automatically; June needs no extra action.
  Only validated style and the generated self-description are projected, never
  private revision explanations or owner memory. Style cannot override worker
  instructions, concise reporting to June, JSON output, or permission boundaries.
- Enabled by default outside setup mode; workers use `deepModel ?? model`.
  Search availability is explicitly disclosed; configuration is not a health check.
- For newly admitted owner turns, interaction output is restricted in both the
  schema and parser to text, reactions, reply placement and delegation/cancellation.
  The interaction prompt advertises capability names, not integration instructions.
  Casual conversation and synthesis stay with June; tools, research, analysis and
  planning belong to workers. Guests and legacy journaled turns keep their prior
  capability ceiling; disabling execution preserves the old direct path.
- Workers use the shared host capability runner for diagnostics/logs, memory recall,
  coding-job inspection, approvals/proposals, workflows, wakeups and configured
  integrations. MCP discovery and calls run inside the worker, not the interaction
  turn. Every operation keeps the original authenticated scope and its existing
  permission checks; delegation grants no new permission and workers cannot spawn
  workers or execute native coding without separate approval.
- Retainable tool output becomes a worker observation, followed by a model step to
  interpret it. June receives the findings for conversational synthesis, not a
  direct formatted-tool dump. Logs should produce relevant evidence, interpretation,
  uncertainty and blockers, with raw detail only when explicitly requested.
  Non-retainable Slack search/history stays host-delivered without entering a model.
  Dashboard credentials stay in guarded ephemeral delivery; workers get receipts.
  Rivet inspection keeps its separate transient read/interpret/delivery callback.
- Linked owner DMs share a roster. Channel/thread workers remain in the originating
  scope even if June's reply starts a new thread; follow up in the original scope
  to reuse them. Guests keep their existing explicitly granted capabilities and
  cannot dispatch execution workers.
- Different workers run independently; one worker processes tasks serially and
  retains history (last 40 entries in its prompt). Limits are four pending requests
  and 32 worker names per conversation, six model steps/five searches per request,
  and a five-minute abort signal (including capacity wait time).
- Workers share the process-local conversation priority queue: three active slots,
  at most two background workers/guests combined, at most one guest and two
  foreground conversations, and owner turn waiters first. Two independent workers
  can run while an owner conversation uses the reserved slot.
  At most 32 background workers wait for admission; overflow becomes `failed`
  with a no-launch report rather than starting another provider call. The roster
  stays `queued` while waiting and becomes `running` only after admission.
  Running work is never aborted to reclaim capacity. Cancellation does not free
  its slot until the raw provider callback and final state save settle. Unknown
  or abort-ignoring callbacks retain capacity; these counters reset on restart
  and do not certify remote-provider quiescence.
- Stable IDs deduplicate requests and completions. Interrupted calls and ambiguous
  search failures become `needs_review`, not automatic retries. Known-unsent search
  failures become `failed`. A fresh `run` is an explicit new attempt.
- A journaled capability ceiling is intersected with current availability before
  each worker step. The worker persists a started operation receipt before host IO.
  After an effect/proposal or uncertain external read, only a final reporting step
  remains; failures cannot chain into automatic retries. Plain local reads can
  supply evidence for another tool step within the existing bounded loop.
- Cancellation suppresses late answers but waits for the underlying provider to
  settle. Workers participate in deployment draining. Forget revokes workers and
  clears live history/reports; transitive provenance prevents reuse after deletion.
  Prompt-visible claim IDs (including reviewed patterns, explicit recall and pending
  review) are deletion dependencies, not independent corroboration. Ledger-only
  deletion blocks worker reads, reuse and pending delivery even before conversation
  cleanup. Legacy workers and saved context without complete deletion tracking are
  unavailable; fresh input cannot rehabilitate their old history. Start a new worker
  name for new work rather than inferring that a hidden report was verified.
  Journals/backups and already-sent model requests retain their existing retention
  rules; clearing live state is not secure erasure. Worker history is not encrypted
  by the optional evidence store.

## Private ongoing public research

An explicit ongoing-research request in the verified owner's one-to-one Slack DM
can create a durable research session. An ordinary one-off research question does
not authorize this loop. June delegates management to an execution worker, which
can emit `research` with `start`, `list`, `inspect`, `pause`, `resume`, or `stop`.
Shared conversations, guests, automated events, completion turns and synthesis
cannot manage or inspect sessions. Generic instructions reach all prompt paths;
private goals and findings do not.

```json
{"text":"","research":{"action":"start","id":null,"goal":"Find official public museum opening hours in the requested area.","connections":["<approved-public-search-connection-id>"],"intervalMinutes":null,"dailyBatches":null,"offset":0}}
```

Only exact selected connection IDs and already owner-approved `read` contracts
are available to each batch. Tavily or another public search/extraction MCP can
use this existing connection mechanism; this feature does not enroll providers,
grant permissions, or claim a particular live connection exists. Built-in Slack,
GitHub and Amp connections and their known endpoint aliases are excluded. Owner
read classification is trusted, not proof an arbitrary remote tool is effect-free
or public. Configured direct public web search is also available. No messages,
outreach, writes, private-account browsing, code execution or approval proposals
are available in the loop.

`start` returns a stable ID. Non-start commands set `goal:null`, `connections:[]`,
`intervalMinutes:null`, `dailyBatches:null`; they cannot change the saved scope.
`list` uses `id:null`; the other commands use the returned ID. Start at offset zero
and follow `nextOffset`. List pages contain five goal previews; inspect pages
contain a checkpoint and up to ten findings within 8,000 JSON characters.
The host owns continuation: do not add a duplicate wakeup, cron job or polling
worker. There are **no background messages or completion notifications**; ask
June privately for status/results. A management receipt proves only admission,
not useful research or delivery.

- Host wiring follows `executionEnabled` outside setup mode and uses
  `deepModel ?? model`. Publication alone does not activate the running process.
  Disabling pauses existing sessions without discarding their state; re-enabling
  does not resume them automatically.
- Defaults are a five-minute interval and 48 attempted batches per 24-hour quota
  window, starting at admission and reset when a due batch sees an expired window.
  Pause/resume does not reset the quota. Empty batches exponentially back off up
  to six hours, never shortening a longer configured interval. Each batch uses
  at most three MCP reads and one direct search, with a three-minute abort signal.
- Persist a started marker before provider IO. Keep priority/lifecycle admission
  until inference settlement. Interrupted, uncertain or invalid-result batches
  require review; startup recovery does not replay them. Only settled paused
  sessions can resume; stopped/completed sessions cannot. Pause/stop suppress late
  findings, request abort and prevent future batches, but cannot undo remote IO.
  Unknown IO keeps its priority slot and fails process lifecycle readiness.
  Content-free session identities keep durable drain holds discoverable after
  restart, disable and forgetting. There is no agent-callable reconciliation or
  automatic hold release; an operator must investigate unresolved work before
  deployment recovery. Neither `stop` nor `resume` attests provider retirement.
- Retain a bounded checkpoint and structured findings: title, detail, optional
  publicly listed professional email, source URL and observation time. Exact
  URL/email tokens must occur in a current tool response. This confirms observed
  text, **not** attribution, factual accuracy, public visibility or deliverability;
  the model must cite the matching source and express uncertainty. No guessed
  addresses. Deduplicate email case-insensitively, otherwise by URL/title.
- Raw MCP responses are transient. Stored findings are capped at 180,000 JSON
  bytes per session; the library retains at most 32 sessions within 120,000 bytes.
  Storage exhaustion pauses work. Session state is private Rivet state, not
  encrypted by the evidence store. Existing journal/backup retention still applies.
  Source deletion or changed owner authority revokes access and continuation;
  forgetting clears live session data. Stop is not deletion. Inspected results
  keep their source dependencies through worker synthesis and forgetting.

Disposable-engine tests cover private delegation, repeated batches, quotas,
deduplication, paging, cancellation/settlement, deletion and hard-kill recovery.
MCP transport fixtures cover selected-read enforcement and revocation. These
checks do not establish live provider quality, configuration or deployment.

## Session integration contract

`ExecutionContext` carries separate stable `scopeKey`/`audience`, originating
`conversationKey`, capability ceiling, personality digest and deletion dependencies.
`ExecutionRequest.id` and the execution actor key identify worker/task ownership;
`source` remains the original authenticated event with its original address, while
`replyAddress` records permitted delivery placement. Operation IDs derive from
request identity and step, never the current conversation key. Narrow conversation
RPCs expose authorized job metadata without running integrations in its inbox.

No session rotation is implemented here. A future router must preserve these
distinctions, relocate scope-owned catalogs/rosters, route late results deliberately,
and retain archive/deletion provenance. The current completion path targets the
originating conversation, not an inferred current session.

## Verification

Real Rivet integration tests exercise the model-facing interface, bounded work
alongside chat, follow-ups, synthesis, guest isolation, bounded searches, cancellation,
deletion, and coding approval. A separate-host hard-kill test checks uncertainty
without replaying a model call. Controlled provider/transport boundaries verify
the host contract, not live model quality or deployment. For a live check, ask June
for two independent tasks, keep chatting, ask for status and a related follow-up,
then cancel one task. Do not expect unavailable search/coding tools to run.
