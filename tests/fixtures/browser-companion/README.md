# Browser companion fixture

`src/browser/session.test.ts` serves a disposable loopback-only PIN gate, a
cookie-protected response, blocked-write and redirect probes, an unconfirmed
submission, and this three-second video. The fixture PIN is synthetic, not a
credential for any deployed service.

`asymmetric.webm` is 320×180 at 10 fps: red from 0–1 seconds and blue from 1–3
seconds, with a yellow 60×90 rectangle at (20, 30). It has no audio. Reproduce it
with ffmpeg (write to a new path, or explicitly approve replacing the fixture):

```sh
ffmpeg -f lavfi -i 'color=c=red:s=320x180:d=1:r=10' \
  -f lavfi -i 'color=c=blue:s=320x180:d=2:r=10' \
  -filter_complex '[0:v][1:v]concat=n=2:v=1:a=0,drawbox=x=20:y=30:w=60:h=90:color=yellow:t=fill[v]' \
  -map '[v]' -c:v libvpx -b:v 100k asymmetric.webm
```

Run `pnpm exec vitest run src/browser/session.test.ts`. Tests launch real,
sandbox-enabled Playwright Chromium; they do not fall back to `--no-sandbox`.

## Session integration contract

- `navigate({url})`, `observe({})`, `scroll({deltaY})`, `discover_media({})`,
  `video_frame({ref,timeSeconds})`, and `request_pin({inputRef,submitRef})`
  are the only tool operations. Unknown keys or operations fail closed.
- `observe` issues element refs. Navigation and subsequent observations make
  previous refs stale. PIN entry is host-only, consumes a pending challenge once,
  and supports numeric PINs on same-origin native POST forms, not arbitrary
  JavaScript login APIs. Uncertain submission remains private until closed.
- The owner must authorize the challenge before calling `enterPin`. Never send
  the secret through a model tool. The session itself is not an owner verifier.
- `epoch` changes before privacy/closure; consumers must also check epoch/state
  before publishing a returned frame. Previously delivered frames cannot be
  recalled. The approved destination can reflect secrets, an unavoidable trust
  boundary rather than a redaction guarantee.
- This backend does not implement expiry timers, viewer authentication, task
  persistence, evidence retention, or global session limits; its owner must.
  Caller-controlled abort closes only this session and `close()` awaits settlement.
- External process/resource/egress isolation is a deployment prerequisite.
  Playwright routing is not a network sandbox, and GET/HEAD are allowed reads
  only under the configured trusted-origin policy. Production activation must
  remain gated outside this module. Loopback HTTP is exclusively a trusted test
  option. Use isolated disposable browser HOME/temp paths without host secrets.
- Media inspection is bounded visual evidence, not audio or full coverage.
  Protected video, embedded players, unavailable seeks and unconfirmed frame
  presentation return unavailable instead of invented timestamps/images.
