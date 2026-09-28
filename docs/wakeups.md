# Durable wakeups

June can save one-time timers, cron schedules, and event watches from the owner's
private Slack DM. A match queues a new model turn and a reply to that same DM,
even after a restart. No human message is needed to restart the timer loop.
This is a notification capability, not arbitrary shell cron or unattended tool
execution: automated turns can produce text, but cannot invoke MCP, coding,
workers, web search, change permissions/schedules, or choose another recipient.

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

## Durability and limits

One owner-keyed Rivet actor stores jobs, due times, a deployment cursor, bounded
deduplication and pending runs. Its queue timeout drives polling, including after
restart. Stable occurrence IDs feed the existing conversation journal/outbox.
Admission participates in deployment drain; accepted events stay durable while
turn execution is fenced.

- One outstanding run per job. Missed cron ticks and events arriving while busy
  coalesce rather than creating an unbounded backlog; `coalesced` counts dropped
  matching events/ticks observed while a run is outstanding.
- Up to 100 retained jobs, 100 terminal run records, and the newest 4,096 event
  IDs for at most seven days. Duplicate protection is bounded, not an unlimited
  exactly-once guarantee. Terminal jobs age out seven days after their last state
  change, once no run is outstanding.
- Pause/cancel prevent unstarted runs. Already-running work may finish; sent
  messages cannot be retracted. Forgetting conversation evidence revokes its
  saved wakeups, including instructions derived from earlier context. Stored
  evidence references are rechecked even if a crash interrupted actor cleanup.
- An interrupted model call or ambiguous send is recorded `unknown`, not blindly
  repeated; this includes a completed model response lost before its workflow
  receipt was saved. Failed runs are inspectable; one-shot watches do not automatically
  retry failed/unknown outcomes. `completed` permits intentional model silence
  and is not proof of delivery/read receipt.
- Delivery targets the registering private Slack DM, never an expired WhatsApp
  messaging window. No polling system guarantees exact wall-clock delivery or
  recovery of events already aged out of an upstream bounded feed.

Operators can inspect `GET /operator/wakeups` with the existing private operator
bearer token. This contains private instructions/event data; it is not public
diagnostics and is not a substitute for June's own list/inspect actions.
