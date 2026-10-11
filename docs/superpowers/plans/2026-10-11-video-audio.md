# Grounded video/audio inspection

## Design and constraints

Extend the existing initiating-attachment-only `readVideo` flow, not a new URL
fetcher, phone call, provider, or permission. Preserve the existing eight
keyframes / first 120 seconds limits. Extract at most the first 30 seconds of
the first audio track as stereo 16-kHz signed 16-bit PCM (1,920,000 bytes).
Accept mono/stereo sources only: a mono downmix can cancel opposite-phase stereo;
surround inputs remain explicitly unavailable rather than lose channels.
Report separate audio and video timebases; neither sampled frames nor a bounded track prefix proves
complete or synchronized coverage. No private media enters durable diagnostics.

Use the configured Codex provider's ordinary native audio input only after
`model/list` advertises audio for that exact model. Do not override metadata:
Codex 0.157.1 otherwise replaces audio with unsupported-media text. Other current
providers fail closed for native audio. Keep visual review usable with a precise
audio limitation. The current live catalog advertises only text/image, so actual
listening remains blocked on a compatible configured model. Realtime phone audio
is not a substitute: it has VAD/pacing and no bounded end-of-clip barrier.

## Implementation and verification

- [x] Reproduce dropped audio with a synthetic audiovisual clip through the
  existing Slack reader. Keep probes under ignored `.amp/in/`, not in Git tests.
- [x] Extend host-only contracts, decoder, native provider validation/transport,
  and wrapper capability forwarding. Bound PCM and preserve cancellation and
  provider settlement; do not retry uncertain inference.
- [x] Include attachment identity, sampled frame timestamps, audio prefix length
  and modality status in host-generated review receipts and runtime guidance.
- [x] Probe authorized audiovisual, no-track, digital silence, metadata-only,
  partial coverage, denied access, cancellation and malformed media. Check the
  real selected model catalog without modifying account/configuration.
- [x] Run formatter, lint, types and installed preflight safety checks; obtain
  Oracle review. An isolated, tool-free probe using the real configured login
  confirmed visual inference still works and audio is rejected before dispatch.
- [ ] Rebase, rerun affected checks and publish a normal push to main.
- [ ] Follow deployment receipts, actual loaded revision/readiness and routed
  intake. Respect the existing audio migration hold; no competing activation.

The current model limitation is an explicit incomplete part of the requested
improvement, not a claim of live audiovisual understanding. This increment
provides truthful per-modality evidence and a gated native transport without
making unsupported acoustic claims.
