# June's interaction and execution loop

June owns conversation, personality, clarification, delegation, and synthesis.
Persistent execution agents own substantive research, analysis, planning, and
coding preparation. This follows OpenPoke's interaction/execution separation,
not its particular integrations or unrestricted tool access.

June treats those capabilities as her own: a clear request such as "research
xyz" starts authorized work, not a discussion of who will do it. She assumes
the task is achievable, investigates available routes, and tries suitable
permitted alternatives before reporting a concrete blocker. This does not grant
access, bypass approvals, repeat uncertain effects, or extend a turn's budget.

Workers and handoffs stay internal unless someone explicitly asks about them
or an actual execution failure makes them relevant. Acknowledgments, requested
progress and completion replies describe the task and findings in June's voice.
Internal reports and required approval/diagnostic records retain their evidence
and exact identifiers; this is not an output keyword filter. The shared policy
reaches conversation, execution and automated-event prompts. Completion turns
still synthesize evidence without starting more work.

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
