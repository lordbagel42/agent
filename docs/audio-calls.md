# Conversational audio calls

June's owner-private execution workers use `audioCall`:

```json
{"text":"","audioCall":{"action":"status"}}
```

`call` takes a configured `endpoint` name and a short `reason`; `hangup` takes
the returned call UUID as `id`. Use one action with empty text. Interaction
agents delegate to execution workers. Automated events, completion synthesis,
guests and shared conversations do not gain calling authority. The host
rechecks the current owner, private audience, captured capability ceiling,
source validity and abort signal at dispatch. There is no additional per-call
approval requirement. Unknown outcomes must not be retried with a new operation.

Status remains discoverable when audio is disabled or its prerequisites are
missing. Configuration and a dialing receipt do not prove connected media.

## Host configuration

`audio` defaults to enabled, voice `cove`, 600 seconds, and no endpoints. A
placeholder configuration for the independently operated Switchboard service:

```json
{
  "audio": {
    "enabled": true,
    "voice": "cove",
    "maxDurationSeconds": 600,
    "endpoints": {
      "desk": {
        "kind": "switchboard",
        "origin": "https://switchboard.example.invalid",
        "tokenEnv": "JUNE_SWITCHBOARD_AUDIO_TOKEN",
        "trustedOwnerDevice": true
      }
    }
  }
}
```

Replace the example origin with the provisioned service and inject the token
privately. Endpoint names are opaque configuration labels, not phone numbers or
caller IDs. `trustedOwnerDevice: true` is explicit owner-device trust, never
inferred from speech, caller ID or an arbitrary incoming destination. The host
adds `{channel:"audio", accountId:"audio", senderId:"desk"}` to its owner
identities automatically. This is not an administrative `agent` identity and
does not expose operator APIs. No `/webhooks/audio` endpoint is mounted.

Switchboard owns Cisco extension 333, handset ringing, busy/quiet-hours policy
and phone-side media conversion. June's transport abstraction remains independent
of those details. The service owns incoming polling and detached media; model
workers must not implement another poller or repeat the delegated task.

The host selects `model.home` when the current model is Codex, otherwise
`deepModel.home` when the deep model is Codex. Without either, it passes no
`codexHome`: status must explain the missing auth-only ChatGPT home. It does not
borrow a browser-companion or coding home, copy credentials, use an API-key speech
fallback, or initiate login. Existing Codex clean-config/login checks still apply.

Call metadata belongs in `RIVETKIT_STORAGE_PATH/audio/calls.sqlite`; the calling
service owns creation and protection of this directory/database. Audio,
transcripts, caller IDs and private task contents must not enter this metadata
store or operational logs. Delegated task text follows ordinary June retention.
Stock Codex's ephemeral threads still write process-level SQLite diagnostics.
Audio redirects `sqlite_home` and `log_dir` into a mode-private directory on
verified Linux `/dev/shm` tmpfs and disables command history. It deletes that
directory only after clean child shutdown. A process crash can leave private
tmpfs diagnostics until operator cleanup or reboot; there is no disk fallback,
and June never deletes the shared authentication home.
The host creates an empty private `june-audio-work-*` directory beneath its
configured temporary directory, validates that it is owned by the process,
canonical, mode-private and outside repositories, and passes it as `cwd`.
It removes that directory only after `close()` has settled. Provider-specific
transient audio/diagnostics storage remains the service's responsibility.

## Service integration contract

`createCalling({config, directory, cwd, codexHome, ownerId, runtime, ready, submit})`
returns `Calling["Service"] & {adapter: ChannelAdapter}`. The shared Effect
runtime executes `command(command, operationId, current)` with the worker's
abort signal; preserve the exact operation ID and recheck both `current()` and
`ready()` immediately before new effects. Do not create a second runtime.

`start()` is called only after registry recovery and the HTTP listener are ready.
`ready()` becomes false during deployment drain and before shutdown. Active or
uncertain calls must make `isSettled()` false. Shutdown awaits `close()` before
disposing actors, clients, providers or the process Effect runtime.

The exact existing `MessageEvent` shape for a voice-delegated task is:

```ts
{
  type: "message",
  id: stableTaskUUID,
  messageId: stableTaskUUID,
  address: {
    channel: "audio",
    accountId: "audio",
    conversationId: callUUID,
  },
  senderId: endpointName,
  text: task,
  occurredAt: Date.now(),
  direct: true,
}
```

Use `occurredAt` and `direct`, not `timestamp` or `isDirect`; `messageId` is
required. Do not set Slack command-eligibility flags or a thread ID. Reuse this
event's IDs and timestamp on uncertain submission. Host submission goes through
the ordinary routing, retention and durable admission path. Replies arrive via
`adapter.send(OutboundMessage)` with the original call UUID in
`message.address.conversationId`; reject stale calls rather than rebinding them.
Do not source-invalidate a task merely because its call hung up: it may continue
and produce a normal retained result, even though audible delivery is no longer
possible. No automatic replacement call is authorized by that rejection.

This documents source integration, not a live subscription, transport or handset
verification. Inspect real status and connected-media receipts before claiming
the deployment can make or answer calls.
