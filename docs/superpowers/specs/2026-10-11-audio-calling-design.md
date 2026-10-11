# June conversational audio

The owner selected stock Codex conversational speech, not the earlier proposed
speech-only fork or separate recognition/synthesis sessions. This supersedes
that proposal. Carrier numbers and ambient/wakeword capture are not provisioned.

## Boundaries

```
Cisco / future carrier / activated device
                 |
          CallTransport (duplex PCM)
                 |
          Calling Effect service
     receipts, device identity, lifetime
                 |
       stock Codex v3 conversational session
                 |
          ask_june dynamic tool
                 |
       normal June audio-channel event
       routing → interaction → execution → reply
```

Codex owns natural conversation; June's normal runtime owns actions, memory,
permissions and durable tasks. A backing Codex turn has only `ask_june`, no
execution environments, workspace roots or native tools. Native configuration
and authentication are checked using the existing restricted app-server policy.
Calls use the configured hot model's ChatGPT home; API-key fallback is forbidden.

WebRTC is required for subscription audio. The direct PCM app-server WebSocket
route requires an API key. `appendSpeech` produces conversational speech, not
verbatim synthesis; transcript completion is not audible completion.

Chromium/Playwright supplies WebRTC and an AudioWorklet. A bounded, nonce-bound
loopback WebSocket carries 48-kHz mono s16le in 20-ms frames. No physical
microphone, user browser profile, speaker or provider credential enters the
browser. The native `@roamhq/wrtc` alternative was rejected after its audio-source
teardown segfaulted on Node 24. The existing Playwright dependency avoids adding
another native ABI; it requires a provisioned headless Chromium installation.

## First adapter

The independently operated Switchboard provides the Cisco handset at a configured
HTTPS origin. It owns extension 333 and outbound quiet-hours/busy policy.
Its server-side bearer never enters Chromium. Telephone media is 8-kHz mono
s16le, 320 bytes/20 ms. Streaming interpolation and low-pass downsampling bridge
to the canonical media format; buffering is bounded at 500 ms.

Poll `/api/v1/calls/incoming` once per second. The same inbound UUID is offered
until accepted, expired or hung up. Prepare Codex before authenticated WSS
attachment: attachment explicitly accepts and permits Answer+AudioSocket.
Offers expire after 30 seconds without extending the original expiry for setup.
Inbound calls reflect deliberate handset intent and bypass outbound quiet hours.
The default conversation duration is 600 seconds.

Outbound POST reserves but does not ring. Attach media within 15 seconds to ring;
only `connected` establishes answered duplex media. Persist the operation and
UUID before POST. Lost replies or restarts never justify a new origination key,
reattachment or replayed speech. Hangup requests cleanup; only a terminal receipt
without `hangup_unconfirmed` proves remote settlement.

## Trust and lifetime

Only explicitly configured `trustedOwnerDevice: true` endpoints are implemented.
This is device-level trust, not speaker verification: anyone using that handset
has its configured owner authority. Caller ID, a wakeword or a spoken name cannot
grant it. Guest/PSTN callers need a different admission policy before an adapter
can expose them; do not map arbitrary external callers into this endpoint.

June selects configured names through execution-only `audioCall` status/call/
hangup commands. Current owner/private scope and the captured execution ceiling
are checked again immediately before external origination/acceptance. There is
no extra per-call approval because the owner requested autonomous calls.

One live call is admitted at a time. Metadata and speech-send dedupe receipts
live in a protected local SQLite journal, not a new Rivet actor. PCM, transcripts
and task bodies are absent from that journal. Delegated task text follows June's
normal retention. Tasks can continue after hangup; replies target only the
original call ID and never cause a replacement call. Both live and uncertain
calls participate in deployment drain.

## Verification and delivery

Use focused disposable probes, not committed tests. Validate duplex sample
content (different tones each direction), conversion, bounded buffers, teardown,
model/role denial, duplicate effects, stale-call delivery and lifecycle drain.
Then validate stock Codex audio and tool delegation with synthetic input before
ringing a person. Start acknowledgments and healthy HTTP endpoints do not prove
speech works. Oracle review, formatter, lint and typecheck precede publication.
Follow the pushed revision through deployment and provision the calls-only token
under a coordinated operator migration, not while the controller is activating.

Operational details and exact configuration: [audio-calls.md](../../audio-calls.md).

## Pinned upstream references

- [Codex realtime protocol](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/app-server-protocol/src/protocol/v2/realtime.rs)
- [WebRTC/authentication routing](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/core/src/realtime_conversation.rs)
- [V3 transcript events](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs)
- [Native speaker suppression](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/tui/src/chatwidget/realtime.rs)
