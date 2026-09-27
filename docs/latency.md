# Measuring reply latency

`GET /operator/latency` uses the existing owner bearer credential. Never expose
it publicly. It holds at most 128 process-local traces, each with at most 128
stage observations and 16 delivery observations. Restart and eviction lose
observations; absence does not mean no work occurred. Nothing is added to Rivet
journals or usage accounting. Replayed sends/models are not reissued to measure
them. Content, platform IDs, names, URLs, credentials, and provider errors are
not retained. A random trace ID correlates stages; only an exact `ping <UUIDv4>`
message additionally exposes that nonsecret probe UUID.

## Genuine Slack ping/pong

After deploying instrumentation, run this on a trusted operator machine with
`JUNE_OPERATOR_TOKEN` supplied through the existing private credential mechanism.
`JUNE_URL` is the private listener or an authorized tunnel, not the public webhook.

```sh
JUNE_URL=http://192.168.0.215:3080 \
  JUNE_LATENCY_OUTPUT=.amp/in/artifacts/human-ping.json \
  pnpm exec tsx scripts/latency.ts watch
```

Send the printed `ping <UUID>` **yourself from the allowlisted human account**.
June asks her usual model for `pong <UUID>` through the normal context, queue,
model, journal, outbox and Slack transport. This is not a hard-coded reply or
model bypass. The watcher checks the accepted text against that UUID. A failed
or timed-out probe is never automatically resent. Bot/App/Amp-authored messages
remain ignored even when their `user` field equals the owner. Fabricated signed
callbacks are not genuine Slack end-to-end probes.

Test top-level and existing-thread messages separately. Collect one first
post-startup sample, then at least five serial warm samples per condition. Use
fresh UUIDs, the same surface/configuration/model settings, similar history,
and no concurrent turns. Record the running revision, sample count and failures.
First actor use is not proof of a cold provider cache; Codex starts a new child
for every invocation. Never restart production merely to label a sample cold.

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
- `typing_accepted`: Slack accepted the thread status, not proof the client
  rendered it. New top-level DMs use the initiating message as the reply/status
  thread root; status starts before context loading. `ack_sent`: accepted textual
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
