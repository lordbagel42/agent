# Measuring reply latency

`GET /operator/latency` uses the existing owner bearer credential. Never expose
it publicly. Its live view holds at most 128 process-local traces, each with at most
128 stage observations and 16 delivery observations. Production also saves every
observed stage/delivery to `RIVETKIT_STORAGE_PATH/diagnostics/logs.sqlite` (normally
`/var/lib/june/rivet/diagnostics/logs.sqlite`), outside release directories.
`GET /operator/logs` returns the latest 128 persisted traces and 100 redacted
lifecycle/Slack ingress events, including previous processes. Both routes require
the owner operator credential; do not share it or route these endpoints publicly.
Raw observations are not
added to Rivet journals or usage accounting. Replayed sends/models are not reissued to measure
them. Content, platform IDs, names, URLs, credentials, and provider errors are
not retained. A random trace ID correlates stages; only an exact `ping <UUIDv4>`
message additionally exposes that nonsecret probe UUID.

SQLite is already part of June's Node runtime: no new dependency, daemon, external
account, network export or extra model pass is required. WAL with `synchronous=NORMAL`
commits each update before returning, without an fsync per stage. Committed records
survive June process crashes/restarts, including abrupt termination. **Host/OS
crashes, power loss or disk failure can still lose recent records.** This is not an
audit log or backup. OTel alone would not supply durable storage; a collector with
persistent queues and a backend would add operational overhead for this single host.

The private directory is mode 0700 and SQLite file is 0600. The log refuses a
nonprivate/noncanonical directory. If initialization fails, June emits a fixed
warning and continues with volatile observations; `/operator/logs` reports
`unavailable: true`. It never relaxes permissions or deletes a corrupt database
to recover. Retention is 30 days with caps of 10,000 traces
and 20,000 events; pruning runs at startup and every 128 writes (up to 128 extra
rows between passes). Reads enforce the age limit even before pruning. SQLite
reuses freed pages; retention does not guarantee physical erasure from disk/backups.
Storage failures emit one fixed warning and increment a process-local counter;
they never retry a model call or delivery. Check `writeFailures` in `/operator/logs`.
No attempt is made to recover observations from before this feature was enabled.

## June can inspect her timings privately

In an owner-private conversation, ask June to "show your recent reply timings"
or "check the timing for ping <UUID>", including after a restart. Ask "show your
logs" for recent lifecycle and Slack ingress records. Her output schema and
instructions expose the read-only `latency` action (`"logs"`, `"recent"` or a UUIDv4).
Only the configured owner's linked user accounts may request it privately. It is unavailable in
channels, group conversations, and synthesis passes; the host independently
checks private scope before reading diagnostics. Another user's DM is not an owner
DM. June is instructed never to relay logs to another user or a shared channel,
even if the owner asks there. No general filesystem, SQL or external log access is granted.

The host sends up to five recent samples (or the requested probe), excluding
the request in progress, through the ordinary durable reply/outbox. This needs
no additional model invocation, external tool call, ping, or credential in the
prompt. It neither changes settings nor retries original work. June sees the
report in subsequent conversation history; she does not receive a same-turn
synthesis pass and must not invent an interpretation before seeing the report.
The requested human-readable report is ordinary conversation content and is
retained as such. Raw observations remain in the private diagnostic database, not
conversation history. Historical traces retain their original process UUID,
start time and release revision; they never reconnect to the new process's clocks.

Reports include revision/process identity, missing/ambiguous/incomplete states,
queue/context/provider/send spans and separate acknowledgments. They do not
establish provider-only inference time, live model settings, or a cold cache.
The same private report separates provider answer readiness from cleanup for
the first observed provider call in each sample: submitted→terminal,
terminal→validated (validation), submitted→validated, arrival→validated, and
validated→retired (cleanup). Missing stages are explicitly unobserved, never
zero. A report requested before retirement can show cleanup as unobserved;
request timings again later without resending the original message. Unsupported
providers, failed calls, restarts, eviction, and observation limits also leave
stages missing. Missing retirement is not proof the answer failed.

## Genuine Slack ping/pong

After the intended revision and model settings are verified live, run this on a
trusted operator machine with
`JUNE_OPERATOR_TOKEN` supplied through the existing private credential mechanism.
`JUNE_URL` is the private listener or an authorized tunnel, not the public webhook.
The CLI runs from a source checkout; it is not installed in production releases.
Set `REVISION` to the full verified running SHA, not the checkout's HEAD.

```sh
JUNE_URL=http://192.168.0.215:3080 \
  JUNE_LATENCY_OUTPUT=.amp/in/artifacts/human-ping.json \
  pnpm exec tsx scripts/latency.ts watch --revision "$REVISION"
```

Send the printed `ping <UUID>` **yourself from the allowlisted human account**.
June asks her usual model for `pong <UUID>` through the normal context, queue,
model, journal, outbox and Slack transport. This is not a hard-coded reply or
model bypass. The watcher checks the accepted text against that UUID and waits
for durable completion and status cleanup before allowing the next serial probe.
A failed or timed-out probe is never automatically resent. Bot/App/Amp-authored messages
remain ignored even when their `user` field equals the owner. Fabricated signed
callbacks are not genuine Slack end-to-end probes.

### Respond later without losing the probe

The watcher authenticates before displaying the ping and pins the revision and
process `startedAt`. It waits 15 minutes by default (`--wait-seconds 1–3600`).
It also prints a `collect` command for late readback. `watch <UUID>` resumes
watching an existing probe; **do not resend a ping that was already sent**.
Both `collect` and `watch <UUID>` require the original `--revision` and
`--started-at`. Do not substitute the current values after a restart.

```sh
# Keep the same private JUNE_URL/JUNE_OPERATOR_TOKEN environment.
# Use the exact UUID, revision and startedAt printed by the original watcher.
JUNE_LATENCY_OUTPUT=.amp/in/artifacts/human-ping-late.json \
  pnpm exec tsx scripts/latency.ts collect "$PROBE" \
    --revision "$REVISION" --started-at "$STARTED_AT"
```

Every capture needs a fresh output path: existing files are never overwritten.
`collect` makes one read-only request, accepts up to 20 UUIDs, and does not send
Slack messages or call a model. Exit codes are **0** for completed matching pongs,
**2** for pending observations, and **1** for failed verification, interrupted
observation or command errors.
A finished/released turn without an accepted matching pong fails verification.
An unseen or incomplete trace stays pending: it may be unfinished, evicted, or
lost on restart, not necessarily an unanswered message. Inspect `pending` and
`traces` in the capture. Repeated UUIDs or multiple messages using one UUID are
rejected as ambiguous. Revision/restart mismatches fail instead of mixing runs.
If a watch is interrupted by a restart or failed read, it captures only the last
same-process observations with `outcome: interrupted` and a fixed reason. It
also retains partial traces evicted while watching; `unavailable` lists UUIDs
whose current state could not be confirmed. Such evidence is incomplete, not
permission to resend. The watcher intentionally stays process-pinned; after a
restart, read persisted evidence through June or `/operator/logs` instead of
adopting a new process for the same measurement. Only stages recorded before the
interruption can be recovered; replay does not manufacture missing stages.

### Prepare a serial comparison

Generate six UUIDs up front so the human need not respond within a short watcher
window. Treat the first as first-observed, and the remaining five as serial warm
samples. `plan` is offline and does not assert anything about the running model.

```sh
JUNE_LATENCY_OUTPUT=.amp/in/artifacts/human-plan.json \
  pnpm exec tsx scripts/latency.ts plan 6

# Repeat for each planned UUID, with a new output filename each time.
JUNE_LATENCY_OUTPUT=.amp/in/artifacts/human-01.json \
  pnpm exec tsx scripts/latency.ts watch "$PROBE" \
    --revision "$REVISION" --started-at "$STARTED_AT"
```

Record `REVISION` and `STARTED_AT` from authenticated diagnostics after the
deployment operator verifies the intended settings. Send only the current
UUID, wait for its pong and successful watcher/readback, then continue. Stop on
failure or rollout; preserve partial captures and read back the same UUID later.
Do not batch-send the plan. Keep the separately verified model, reasoning and
speed policy with the comparison: revision alone cannot prove a configuration.

Test top-level and existing-thread messages separately. Collect one first
post-startup sample, then at least five serial warm samples per condition. Use
fresh UUIDs, the same surface/configuration/model settings, similar history,
and no concurrent turns. Record the running revision, sample count and failures.
First actor use is not proof of a cold provider cache; Codex starts a new child
for every invocation. Never restart production merely to label a sample cold.
The recovered 8.615 s human ping on `fea6f41` used the previous model policy;
it is one baseline observation, not evidence for later model settings
or an end-to-end improvement. Start a new comparison at a settings transition.

## Disposable local pipeline

```sh
JUNE_LATENCY_OUTPUT=.amp/in/artifacts/local-top.json \
  pnpm exec tsx scripts/latency.ts local 6
JUNE_LATENCY_OUTPUT=.amp/in/artifacts/local-thread.json \
  pnpm exec tsx scripts/latency.ts local 6 --threaded
pnpm exec tsx scripts/latency.ts report .amp/in/artifacts/local-thread.json
```

The harness creates and removes its own real Rivet engine/storage. It exercises
the real signed webhook handler, owner guards, Slack normalization/context,
prompt builder, serial workflow, durable outbox and response parsing. Slack HTTP
is fake with known delays (50 ms context reads, 200 ms status calls, 30 ms send);
the default model is a 100 ms fake. This is a **local pipeline fixture**, not
Slack-to-Slack evidence. Its printed platform delta is synthetic. Rivet may emit
its known shutdown warnings; use `JUNE_LATENCY_OUTPUT` for clean JSON rather than
redirecting mixed native stdout. Output files are created exclusively, mode 0600.

For an explicitly authorized provider measurement, `JUNE_LATENCY_PROVIDER_MODULE`
can name a local module exporting `model: ModelProvider`. That code owns its
credentials and transport; the harness never loads production config or tokens.
Account separately for bridge/process startup costs. A remote provider called
over SSH is not a live June turn, even with the actual model and login.

## Reading stages

- `http_ack`: handler response after durable submission, **not** human-visible
  acknowledgment or proof Slack received the HTTP response.
- `accepted`: verified/normalized owner input since HTTP arrival. `transportMs`
  is Slack source timestamp → host arrival and depends on clock alignment.
- `submission_started` → `dequeued`: actor lookup, submission and queue wait;
  submission completion can race dequeue. `dequeued` → `admitted`: deployment
  admission. `admitted` → `context_started`: durable recording/plan/ingestion.
- `context_started` → `context_ready`: memory, platform context, prompt building,
  deployment-status read. `context_ready` → `fast_started`: invocation intent
  persistence and occupancy. No journal durability is skipped to save time.
- `fast/deep/synthesis_started` → corresponding `finished`: full provider call,
  not first-token time; SDK/subprocess overhead and accounting are included.
- Providers may invoke the optional host-only `ModelRequest.onProviderTiming`
  callback with `submitted`, `terminal`, `validated`, or `retired`. The runtime
  records distinct `provider_*` observations only inside live model effects;
  replayed receipts do not install callbacks or reconstruct timings. Submitted
  means the turn was submitted to the provider, terminal means its terminal
  result arrived, validated means the answer passed provider validation and is
  ready to return, and retired means provider resource cleanup completed.
  Retirement may arrive after model return, text delivery, `finished`, or
  `released`. It does not delay or change those existing stages. Per-trace numeric
  `providerCall` and fixed `providerPhase` labels prevent delayed cleanup from
  being paired with another call; raw observations retain later calls while the
  private summary reports only the first observed call. All provider observations
  share the existing 128-observation cap per trace and retain no content, errors,
  provider IDs, or credentials. Evicted callbacks cannot recreate traces.
- `typing_accepted`: Slack accepted the thread status, not proof the client
  rendered it. Existing-thread status starts before context loading; top-level
  input does not create a thread for status. June chooses reply placement
  separately. `ack_sent`: accepted textual
  deep-pass acknowledgment. These overlap work and must not be added to totals.
- `text_started` → `text_sent`: actual transport. `deliveries[].platformMs` is
  exact Slack message-to-message timestamp difference for accepted text/ack/search,
  not human read latency. Reactions have no new message timestamp.
- `finished`: durable turn completion, distinct from platform acceptance. Silence,
  failures, holds and eviction can lack a final answer; retain them in reports.
- `released`: the turn's admission lease is released after status cleanup. Ready
  replies do not wait for that cleanup, but the next status pulse/turn and a
  successful deployment drain do. Serial probes wait for release to avoid
  charging the previous turn's cleanup to the next sample's queue time.

The simple `report` table uses first fast/text spans; inspect the full observations
for multi-pass/search/retry turns rather than summing overlapping work. Compare
medians/ranges and sample counts, not one fastest response. Historical receipt
deltas without a controlled prompt, history and revision are not regression proof.

## Optional name enrichment budget

Slack display-name lookups share a 200 ms budget from context loading start,
including the later participant lookup wave. Conversation metadata and history
keep their one-second deadline. Cached names and names already supplied by Slack
remain usable; a slow uncached lookup leaves the exact sender ID without a display
name. Names never establish identity or permissions. No message content is dropped
to meet the name budget, and expired lookups are aborted rather than detached.

An isolated adapter comparison on 2026-09-27 used three fresh before/after pairs
per case, fake Slack HTTP with real cancellable timers, and unchanged message
content. Median context durations in milliseconds:

| Fixture | Before | After |
| --- | ---: | ---: |
| 50 ms history, 30 ms name requests | 83 | 82 |
| 50 ms history, 800 ms name requests | 1001 | 202 |
| 350 ms history, 800 ms name requests | 1002 | 352 |
| 350 ms history, previously cached names | 352 | 351 |

These are context-only synthetic measurements, not Slack end-to-end results.
The supplied human `ping 8743892` → June `pong 8743892` baseline was 5747.170 ms;
its per-stage traces were lost on restart, so slow names cannot be identified as
its cause. The under-two-second end-to-end goal remains unverified.

Two provider experiments were not shipped: a compact structured-output envelope
reduced output tokens but regressed exact-answer correctness, and moving dynamic
prompt fields after static instructions did not improve measured cache hits.
The latter's six alternating Astra/low/fast pairs all returned the requested
answer, but provider-only durations still ranged from 3.15–5.77 seconds before
and 3.23–5.58 seconds after. Neither experiment supports a production speedup
claim or replacing genuine human Slack measurements.
