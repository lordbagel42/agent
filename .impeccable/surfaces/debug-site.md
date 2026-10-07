---
version: 1
slug: debug-site
primary_target: debug-site/src/App.svelte
related_targets: [debug-site/src/app.css, src/diagnostics/server.ts]
---

# June Debug

Mode: Operate. Owner-only diagnostic evidence, including while June is offline.
The owner explicitly requires a separate website, not main-dashboard navigation.

## Direction contract

THESIS: An independent operator home for captures, deployments, failures and Amp
activity, organized around recorded evidence rather than invented metrics.

OWN-WORLD: Extend June's dark neutral palette, system sans and exact-value mono.
Use shadcn-svelte controls, hairlines, small status labels and dense selectable
rows. No imagery, gradients, decorative charts or invented health signals.

STORY: Start with the archive's last observations, open a relevant operation or
DEBUG capture, and follow its exact evidence and recorded relationships. Make
unavailable sources and evidence boundaries explicit.

FIRST VIEWPORT: Independent June Debug header with Overview, Captures,
Deployments, Errors and Amp. A thin context bar holds the archive-not-health
notice, timezone and explicit Refresh. Overview leads with a fact row of real
archive totals and the latest archived record, then the failures to inspect.
A capture detail fits its ID, mode switch and export on one row, then compact
facts and a bounded reason, so evidence rows start near the top. On mobile, the
navigation scrolls in its own row, inspectors stack below their lists, and the
document never overflows horizontally.

FORM: RivetKit's dense collection/inspector model in June's established
Vercel/Cloudflare-like operational language. The standalone site has its own
navigation, not main-console navigation. Selecting an evidence row reveals its
exact retained payload without losing the surrounding chronology.

FINISH: Review actual desktop and narrow renders, authentication and evidence
workflows, and data-truth edge cases. No raster assets ship.

## Operations extension

The read-only Operations routes preserve the capture and passkey workflows. A deployment
observation strip leads with its timestamp and stale age, never invented health.
Below it, server-backed filters and dense operation rows sit beside the selected
immutable timeline and matching symptom history; narrow screens stack these
regions and let the operation list collapse without hiding the selection.

Refresh preserves the selected incident. Event time and source observation time
remain separate, including explicitly unknown historical times. Related-history
counts include the selected operation and link to all retained matches, not only
the bounded related list. Recorded terminal outcomes and Amp/capture links are
evidence, not claims of a shared root cause or verified recovery. No action
controls or private content are added. Verification uses labeled synthetic data.

## Console rebuild (2026-10-05)

Owner request: a denser home for DEBUG captures, deployments, error logging and
Amp, comparable to RivetKit's collection/inspector model. Decisions settled in
the brief: Overview comes first, with list/inspector layouts for investigation;
the Svelte, shadcn and auth stack is unchanged.

- Overview uses lists and fact rows, not metric cards or charts. Every count is
  a real archive total for a named scope, and every section links to its full
  list and records.
- Captures uses a full-width dense table. The capture detail page drops the
  old left rail, so the evidence table and its inspector are the only two
  columns (never three).
- Deployments, Errors, Amp and All operations share one list/inspector. The
  list is sticky on desktop and collapsible above the inspector on narrow
  screens. The inspector shows the outcome, recorded links, the exact failure
  event, same-signature history and the immutable timeline.
- The shared controller block keeps revisions distinct and shows hold, blocked,
  retry and queue as facts. Stale observations are labeled; there is no green
  health state.
- States use neutral, warn or danger tones only. The green `state-ok` tone stays
  limited to capture delivery receipts.

The lists require the backend's archive-wide `sources` and `failuresOnly`
filters (see `debug-site/README.md`); activation against an older server is not
supported. Source publication and runtime activation are separate.

## Rebuild finish verdict

Accepted after rendered desktop and narrow Chromium review. The selected evidence
inspector keeps exact payloads accessible while archive previews and table summaries
intentionally use ellipses. The page has no horizontal document overflow at 1440px
or 390px; narrow layouts stack the inspector and collapse archive navigation.
The actual Bits UI orientation/state attributes drive shadcn tab styling.

Reviewed empty-filter, delivery, expired-session, missing-capture and disconnected
states. Missing data stays explicit; no synthetic status, cost, spans or causal
conclusions are invented. Keyboard tab semantics and visible focus remain native.
The existing DESIGN.md remains the palette/type/spacing reference; advisory type
and radius differences in this dense standalone surface were reviewed deliberately.

The rebuilt shell was inspected at 1440×960 and 390×844 using labeled synthetic
evidence, never production conversations. The last row and pagination in the
left scrolling list are fully reachable; no footer obscures them. On narrow
screens, the selected inspector remains below a collapsible results list.

Rendered checks covered authentication return and expiry clearing, browser
Back/Forward, retained selection on refresh/filtering, search beyond the first
page, all 52 synthetic symptom matches beyond the related-list cap, 103-event
timeline pagination, queued/no-thread and unknown outcomes, missing/unavailable/
empty states, and the existing capture, conversation and passkey settings views.
Passkey enrollment itself and live operational publication were not exercised.

Oracle review found three data-truth issues, reproduced and corrected: latest
record selection includes independently retried failure reads; related-operation
history shows last observation time, not a potentially different failure's time;
and missing-thread labels apply only to the checked events. Focused checks also
cover capture-tab retention on refresh, out-of-order controller reads, and
clearing remembered private queries on logout. No live-health or shared-cause
conclusion is inferred from these records.
