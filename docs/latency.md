# Measuring reply latency

`GET /operator/latency` uses the existing owner bearer credential. Never expose
it publicly. It holds at most 128 process-local traces, each with at most 128
stage observations and 16 delivery observations. Restart and eviction lose
observations; absence does not mean no work occurred. Raw observations are not
added to Rivet journals or usage accounting. Replayed sends/models are not reissued to measure
them. Content, platform IDs, names, URLs, credentials, and provider errors are
not retained. A random trace ID correlates stages; only an exact `ping <UUIDv4>`
message additionally exposes that nonsecret probe UUID.

## June can inspect her timings privately

In an owner-private conversation, ask June to "show your recent reply timings"
or "check the timing for ping <UUID>". Her output schema and instructions expose
the read-only `latency` action (`"recent"` or a UUIDv4). It is unavailable in
channels, group conversations, and synthesis passes; the host independently
checks private scope before reading diagnostics.

The host sends up to five recent samples (or the requested probe), excluding
the request in progress, through the ordinary durable reply/outbox. This needs
no additional model invocation, external tool call, ping, or credential in the
prompt. It neither changes settings nor retries original work. June sees the
report in subsequent conversation history; she does not receive a same-turn
synthesis pass and must not invent an interpretation before seeing the report.
The requested human-readable report is ordinary conversation content and is
retained as such. Raw diagnostic observations remain process-local.

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
permission to resend. A restart's lost observations cannot be recovered later.

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
  `released`. It does not delay or change those existing stages. Volatile numeric
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
