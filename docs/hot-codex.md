# Hot Codex inference

Every `protocol: "codex"` inference provider uses one persistent official Codex
0.157.1 app-server and a pool of three **single-use ephemeral threads**. This
applies to the interaction and deep models and their execution-agent consumers.
The old per-reply `codex exec` inference path and its opt-in flag are removed.
Existing Codex model configuration needs no change. Setup mode does not start
providers or prewarm. The separately approved native coding runtime is unchanged.

## Why threads, not three exec processes?

Pinned official source, tag `rust-v0.157.1`:

- [Exec reads stdin before creating its embedded app-server/thread](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/exec/src/lib.rs#L953-L990).
  Three exec processes waiting for stdin would not prewarm inference.
- [Session initialization schedules startup prewarm](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/core/src/session/session.rs#L1860-L1870).
  [It builds a prompt with no conversation input](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/core/src/session_startup_prewarm.rs#L262-L327).
  The model client/WebSocket belongs to each thread, not the server process.
- `thread/start` schedules prewarm; its response **does not confirm completion**.
  `ready()` means the three threads exist, not that authentication or the network
  has succeeded. Inspection explicitly reports `scheduled_not_confirmed`.
- [The official structured-request helper](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/tui/src/temporary_structured_request.rs#L47-L158)
  supplies the tool-disabling configuration and per-thread MCP disabling pattern.
- [Unsubscribe does not unload an active thread](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L20-L63).
  With `thread_unload_delay_secs=0`, the adapter waits for `thread/closed` before
  replacing it. Archive is not used for pathless ephemeral sessions.

## Bounds and failure semantics

- Three live thread slots per configured hot provider, including active and
  initializing slots. No unbounded request queue. Exhaustion fails before
  submitting inference (`provider_busy`, safe to retry).
- Each real request gets an unused thread. No resume, fork, steering, shared
  conversation, or reuse after success, cancellation, or failure. The prompt and
  output schema are supplied only when consuming the thread.
- At most one unused session older than 60 seconds rotates every 20 seconds.
  Replacement follows confirmed unload, including after cancellation.
- Completed, validated answers return before thread disposal. Disposal stays
  tracked in the background and occupies its slot until confirmed closure;
  only then can replenishment start. Late usage is still recorded. Cleanup
  failure disables the provider but cannot retract or replay a delivered answer.
  Private latency inspection separates submission, terminal, validated-answer,
  and confirmed-retirement observations. Usage-ledger duration includes disposal;
  the reply's provider span ends when the answer is available.
- Cancellation waits for the `turn/start` response, then interrupts the identified
  turn only if no validated terminal event has arrived, then unloads it. Failed
  and interrupted terminal turns do not trigger another interrupt. An interrupt
  error racing completion requires a matching terminal notification within a
  bounded deadline; otherwise the provider fails closed. Ambiguous RPC timeout, malformed protocol, unexpected tool
  requests, subprocess death, or failed cleanup kills the process and fails all
  its outstanding calls, without replay. This sacrifices availability rather
  than risk unknown/orphaned generations. An operator restart is needed after
  a process-level failure; there is no restart loop or fallback to exec.
- The application drains its workflows before closing providers. Explicit close
  stops admission and terminates remaining work, waits for process close, and
  settles tracked cleanup/accounting before removing the empty temporary
  workspace. Startup failure also closes providers.
- One MiB framing/per-turn output bound, 64 KiB final-message bound, existing
  structured reply validation, bounded RPC/turn/cleanup deadlines. Diagnostics
  are drained but not retained. Usage records contain only numeric accounting;
  latest measured usage is retained for failed/cancelled calls too, including
  usage notifications received during cleanup.
- No adapter retry after inference submission. Codex's own built-in provider
  transport retries still apply: in this pinned release, user provider entries
  [cannot override built-in OpenAI retry settings](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/model-provider-info/src/lib.rs#L679-L719).
  This is not a promise of exactly one upstream HTTP/WebSocket request.
  Idle rotation performs real official prewarm requests; no claim is made that
  maintaining warm sessions has zero subscription quota or network cost.

## Isolation and inspection

Stock app-server does not expose exec's ignore-user-config/rules switches.
The adapter requires an auth-only home and rejects nonempty home config/global
instructions or `/etc/codex/{config,managed_config,requirements}.toml`.
Before every thread creation/prewarm, it also reads effective configuration,
all configuration layers, and managed requirements. Unsupported cloud/MDM/legacy
layers, managed requirements other than supported login restrictions and
`chronicle: false` (optionally accompanied by `ultrafast_mode: false`),
nonempty inherited layers, changed disabling
settings, custom provider definitions/endpoints, MCP servers, hooks, or inherited
instructions fail closed. Administrative policy is never rewritten or bypassed.
These RPCs are not an atomic configuration lock: operator-owned files/policy
must remain stable while the provider runs. `project_doc_max_bytes=0` alone does **not** remove
[global AGENTS instructions](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/codex-home/src/instructions/mod.rs#L40-L85).
It overrides base/developer instructions, pins the official OpenAI provider,
disables extensions/tools/hooks/notify, requests read-only/never-approve, and checks
the returned provider, policy, sandbox and empty instruction-source list. A private
empty cwd and allowlisted environment keep June's application secrets out of Codex.
This is not an OS security boundary or a guarantee about arbitrary modified Codex binaries.

In an owner-private turn June can return `{"text":"","modelStatus":true}`.
The host supplies current sanitized pool counts, model/tier labels, failure code,
timestamp, and the explicit prewarm uncertainty. The action cannot mutate anything.
Both schema validation and the runtime enforce its private audience, including
when a nonconforming provider tries to emit the action publicly.

## Synthetic benchmark, 2026-09-27

Six alternating pairs per model, low effort and fast tier, using June's existing
official login as the service user. Each call requested only `hello`; no private
messages were used. Hot initialization was followed by a three-second idle dwell.
Durations include adapter completion/validation/unload; they exclude Slack/Rivet.

| Model | Cold exec milliseconds | Hot pool milliseconds | Median cold → hot |
| --- | --- | --- | --- |
| `gpt-5.6-terra` | 7936, 4681, 4636, 4110, 4318, 4188 | 1637, 1481, 1511, 2563, 1432, 1507 | 4477 → 1509 (66% lower) |
| `gpt-6-astra` | 4769, 4876, 8024, 5470, 6914, 6218 | 1994, 3790, 2104, 2695, 2205, 2041 | 5844 → 2155 (63% lower) |

Pool initialization took 1.87 seconds for Terra and 2.78 seconds for Astra.
Both measured batches ended with three unused threads and zero active calls.
All responses passed structured validation. These small samples measure the whole
adapter change, including its smaller tool-free base instructions, not solely
WebSocket reuse. They do not establish long-prompt or end-to-end DM latency.
These timings precede the review hardening (extra policy reads and terminal/usage
handling); they are not a benchmark of the final revision. The final cutover
passed three synthetic authenticated replies on each configured Astra provider
(fast and default tiers), including strict policy validation and cleanup.
An earlier Astra attempt lost runner connectivity and yielded no usable results;
the reported Astra values are from a separate recorded batch, not inferred data.

A separate live Terra probe returned three distinct markers correctly from
concurrent calls, returned `NONE` when a new thread was asked about prior markers,
cancelled an in-flight generation, then successfully answered after a 65-second
idle interval/rotation. The test process closed cleanly. These synthetic probes
used only disposable workspaces and the existing official login.
