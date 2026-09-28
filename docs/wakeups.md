# Durable wakeups

June can save one-time timers, cron schedules, and event watches from the owner's
private Slack DM. A match queues a new model turn and a reply to that same DM,
even after a restart. No human message is needed to restart the timer loop.
These explicit watches are notification-only: they cannot invoke tools or change
permissions/schedules. Separately, host-enrolled event awareness wakes June to
decide what to do without requiring a watch.

## Event awareness

Connected deployment and signed generic webhook sources automatically get an
awareness subscription, such as `decision:deployment` or `decision:webhook.build`.
Provider adapters can enroll their source through the same `decisionSources`
host option. June receives the event as machine evidence, not an owner message.
She can use configured public web search and owner-enabled MCP tools, prepare an
approval-required proposal, send useful news to Raygen, or choose silence. An
MCP `read` grant is the owner's standing trust classification, not proof the
remote tool cannot have effects. Disabled tools remain unavailable; approval
tools never run without separate human approval. Events cannot approve actions,
change grants, execute owner commands, or choose the private reply destination.

With activity sessions enabled, decisions use the assigned activity actor and
the same standing grants. MCP and public-search outcomes are accounted for
separately from model termination: an uncertain tool outcome holds the activity
and is never automatically replayed. June can inspect the `tools` hold through
the existing operations/session inspection. Decision archives contain receipts,
not provider payloads, fetched tool results, or decision text; this also means
decision text is not searchable through session archives.

Ask June to list wakeups, inspect `decision:deployment`, or pause/resume awareness
for a source. `list` distinguishes `decision` and `notification` modes; `inspect`
shows recent run outcomes and bounded event previews. Cancellation is persistent,
not silently undone on restart. Prefer pause/resume for reversible control.
Explicit matching notification watches take precedence over unsolicited
commentary so “DM me after the next successful deploy” does not also generate a
second awareness notification. June must save that one-shot watch and return its
receipt rather than merely promise to remember.

Awareness subscriptions do not backfill historical deployment events when first
enabled or resumed. New deliveries from providers use local receipt time.
Pause/cancel intentionally suppress new decisions; accepted events while paused
are not replayed on resume. Deployment payloads include `data.commit` only when
the controller snapshot contains the event's exact revision, along with
`metadataObservedAt`. Missing titles/descriptions remain unknown. Commit text is
untrusted and a historical `healthy` event does not prove current process health.

Ask June, for example:

- “DM me after the next successful deploy.”
- “Remind me at 17:00 UTC tomorrow.”
- “Every weekday at 09:15 America/Boise, remind me to check my tasks.”
- “When webhook.build reports finished with result equal to failed, DM me.”
- “List my wakeups,” then “inspect/pause/resume/cancel wakeup <id>.”

The prompt and structured `wakeup` action expose these operations to June. A
saved receipt includes the real ID and schedule; a conversational promise or a
deployment inspection does not register anything. Management is denied outside
an owner-private Slack turn and during synthesis or an automated turn. General
machine payloads are untrusted evidence, never fresh owner authorization.

## June's action contract

```json
{
  "text": "",
  "wakeup": {
    "action": "create",
    "name": "Next successful deploy",
    "instruction": "Tell me which revision the controller verified healthy.",
    "once": true,
    "trigger": {"kind": "event", "source": "deployment", "type": "healthy", "filters": []}
  }
}
```

Other triggers are `{"kind":"at","at":"2027-01-01T17:00:00Z"}` and
`{"kind":"cron","expression":"15 9 * * 1-5","timezone":"America/Boise"}`.
Timers always run once. Cron accepts five deterministic fields, with an explicit
IANA timezone; calendar/DST calculation uses cron-parser. The receipt gives the
next UTC deadline so the owner can check the interpretation.

`{"action":"list"}` returns IDs, summaries, connected sources and feed issues.
`{"action":"inspect","id":"..."}` returns the trigger and last three run
previews. `pause`, `resume` and `cancel` use the same `id` shape. Leave other
directives unset/null and `text` empty. Terminal jobs cannot be resumed; create a
new watch instead. To edit a schedule, cancel it and create its replacement.

Connected native sources are advertised only when their integration is enabled:

| Source | Types | Useful `data` filters |
| --- | --- | --- |
| `deployment` | Controller statuses: `healthy`, `failed`, `activating`, etc. | `revision`, `branch`, `reason` |
| `slack`, `whatsapp` | Accepted `message`, `reaction`, `receipt` events | `address.conversationId`, `senderId`, `emoji`, `status` |
| `coding` | `result` | `jobId`, `attempt` |
| `execution` | `result` | `agentId`, `requestId`, `status` |
| `webhook.<name>` | Publisher-supplied type | Publisher-supplied scalar fields |

Filters are ANDed exact equality checks on dotted paths, with at most eight
filters. `type:"*"` matches all types from one specific source. Existing ingress
authentication, opt-outs and audience routing still apply; rejected Slack events
are not a second path around those rules. Old events predating registration are
not backfilled. Webhook occurrence time is June's receipt time.

Deployment events are read from the existing protected controller feed every
five seconds. The consumer cursor persists across releases; missing sequences
are exposed as `feed_gap`, and an unreadable feed as `feed_unavailable`.
`healthy` is a historical verification event, not a guarantee of current health.
This feature cannot publish, activate, approve, retry, or otherwise control a
deployment.

## Signed external events

Timers/native watches need no extra configuration when Slack is enabled outside
setup mode. An external publisher requires an operator-installed secret and an
immutable-release config change, following [deployment coordination](deployment.md):

```json
{"eventWebhooks":{"build":{"secretEnv":"JUNE_BUILD_WEBHOOK_SECRET"}}}
```

Use a random signing secret of at least 32 characters, separate from every
operator/deployment credential. Never give June or a tool call the secret. Source
names use lowercase letters, numbers and hyphens, starting with a letter.
June discovers `webhook.build` through her source catalog once configured.

Send `POST /webhooks/events/build` over HTTPS with a bounded JSON body:

```json
{"id":"build-1234-finished","type":"finished","data":{"result":"failed","revision":"example"}}
```

- `x-june-timestamp`: current Unix seconds, accepted within five minutes.
- `x-june-signature`: `v1=` followed by lowercase hex HMAC-SHA256 of
  `timestamp + "." + rawRequestBody`, using the source's secret.
- Maximum body/envelope: 16 KiB. IDs must be stable and unique per source.
- `202` means durable acceptance, **not** notification completion. Retrying with
  the same source/ID returns `duplicate:true` while retained.
- `401` means signature/freshness failure, `400` invalid event, `413` too large,
  and `503` temporarily unavailable/fenced; respect `Retry-After` and retain the
  same event ID when retrying. Re-sign expired retries with a fresh timestamp.

The path fixes the identity to `webhook.build`; a publisher cannot impersonate
`deployment` or a native channel. Providers with their own webhook formats need
a trusted adapter to verify/translate them to this contract. Merely knowing a
public URL grants no ability to wake June.

Provider adapters publish `{id, source, type, occurredAt, data}` through the same
durable publisher. The full serialized envelope must fit 16,384 UTF-8 bytes;
reserve room for identifiers and truncation metadata before bounding payloads.
Retain provider field names/timestamps, explicitly mark omissions, and exclude
credentials. Source identity is adapter-controlled. Authentication establishes
provenance, never owner intent. For GitHub specifically, HMAC authenticates the
body, not delivery/event headers; those are validated HTTPS transport metadata.
`accepted:false` is never HTTP success. A retryable response is not a guarantee
the provider will retry: GitHub requires explicit redelivery tooling or operator
handling for failed deliveries.

## Durability and limits

One owner-keyed Rivet actor stores jobs, due times, a deployment cursor, bounded
deduplication and pending runs. Its queue timeout drives polling, including after
restart. Stable occurrence IDs feed the existing conversation journal/outbox.
Admission participates in deployment drain; accepted events stay durable while
turn execution is fenced.

- One outstanding run per notification job. Missed cron ticks and events arriving while busy
  coalesce rather than creating an unbounded backlog; `coalesced` counts dropped
  matching events/ticks observed while a run is outstanding.
- Awareness does not silently coalesce distinct events: up to 100 decisions may
  be pending across sources. Overflow is rejected before deduplication records
  acceptance; retry the same event ID when capacity is available. Deployment
  polling retains its cursor at the unaccepted event until space is available.
- Up to 100 retained jobs, 100 terminal run records, and the newest 4,096 event
  IDs for at most seven days. Duplicate protection is bounded, not an unlimited
  exactly-once guarantee. Terminal jobs age out seven days after their last state
  change, once no run is outstanding. Host-enrolled awareness subscriptions are
  retained so pause/cancel decisions survive restarts and retention cleanup.
- Pause/cancel prevent unstarted runs. Already-running work may finish; sent
  messages cannot be retracted. Forgetting conversation evidence revokes its
  saved wakeups, including instructions derived from earlier context. Stored
  evidence references are rechecked even if a crash interrupted actor cleanup.
- An interrupted model call or ambiguous send is recorded `unknown`, not blindly
  repeated; this includes a completed model response lost before its workflow
  receipt was saved. Failed runs are inspectable; one-shot watches do not automatically
  retry failed/unknown outcomes. `completed` permits intentional model silence
  and is not proof of delivery/read receipt.
- Notification delivery targets the registering private Slack DM; awareness
  uses the configured owner's Slack user ID as a private post destination.
  Neither uses a provider-supplied destination or an expired WhatsApp
  messaging window. No polling system guarantees exact wall-clock delivery or
  recovery of events already aged out of an upstream bounded feed.

Operators can inspect `GET /operator/wakeups` with the existing private operator
bearer token. This contains private instructions/event data; it is not public
diagnostics and is not a substitute for June's own list/inspect actions.
