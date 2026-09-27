# June's interaction and execution loop

June owns conversation, personality, clarification, delegation, and synthesis.
Persistent execution agents own substantive research, analysis, planning, and
coding preparation. This follows OpenPoke's interaction/execution separation,
not its particular integrations or unrestricted tool access.

## June-facing interface

The model schema and prompt expose this owner-only action:

```json
{"text":"I'll compare both options.","coding":null,"reaction":null,"execution":[
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

## Boundaries and recovery

- Each request reads June's approved global public-safe personality once and uses
  that snapshot for every worker model step. Reusing a worker for a new task or
  follow-up picks up the latest revision automatically; June needs no extra action.
  Only validated style and the generated self-description are projected, never
  private revision explanations or owner memory. Style cannot override worker
  instructions, concise reporting to June, JSON output, or permission boundaries.
- Enabled by default outside setup mode; workers use `deepModel ?? model`.
  Search availability is explicitly disclosed; configuration is not a health check.
- Workers reason and iterate through configured public web search. They cannot
  read files/credentials/Slack history, send messages, run code, call MCP, deploy,
  or spawn workers. Non-retainable Slack search remains a direct host operation.
- Linked owner DMs share a roster. Channel/thread workers remain in the originating
  scope even if June's reply starts a new thread; follow up in the original scope
  to reuse them. Guests keep their existing explicitly granted capabilities and
  cannot dispatch execution workers.
- Different workers run independently; one worker processes tasks serially and
  retains history (last 40 entries in its prompt). Limits are four pending requests
  and 32 worker names per conversation, six model steps/five searches per request,
  and a five-minute abort signal (including capacity wait time).
- Workers share the process-local conversation priority queue: two active slots,
  at most one guest or background worker combined, and owner turn waiters first.
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
- Cancellation suppresses late answers but waits for the underlying provider to
  settle. Workers participate in deployment draining. Forget revokes workers and
  clears live history/reports; transitive provenance prevents reuse after deletion.
  Journals/backups and already-sent model requests retain their existing retention
  rules; clearing live state is not secure erasure. Worker history is not encrypted
  by the optional evidence store.

## Verification

Real Rivet integration tests exercise the model-facing interface, bounded work
alongside chat, follow-ups, synthesis, guest isolation, bounded searches, cancellation,
deletion, and coding approval. A separate-host hard-kill test checks uncertainty
without replaying a model call. Controlled provider/transport boundaries verify
the host contract, not live model quality or deployment. For a live check, ask June
for two independent tasks, keep chatting, ask for status and a related follow-up,
then cancel one task. Do not expect unavailable search/coding tools to run.
