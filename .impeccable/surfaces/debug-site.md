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

THESIS: An independently available capture workbench, organized around the
reported message and recorded evidence rather than a generic metrics dashboard.

OWN-WORLD: Extend June's dark neutral palette, system sans and exact-value mono.
Use shadcn-svelte controls, hairlines, small status labels and dense selectable
rows. No imagery, gradients, decorative charts or invented health signals.

STORY: Open a DEBUG link, understand what was captured, follow the recorded turn,
inspect its exact evidence, and see which sources were deliberately not captured.

FIRST VIEWPORT: Independent June Debug header, recent captures on the left,
capture reason and export at the top, compact facts, evidence tabs, and a wide
timeline beside its selected record. On mobile, stack the inspector and expose
capture navigation without horizontal document overflow.

FORM: Owner-pinned Vercel/Cloudflare operational language. Painter's two-layout
comparison favored trace-first; dashboard navigation and invented telemetry in
that concept are excluded. Signature interaction: selecting an evidence row
reveals its exact retained payload without losing the surrounding chronology.

FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its
provenance

## Operations extension

The approved read-only Operations route inherits this world. Compact Captures /
Operations navigation preserves the capture and passkey workflows. A deployment
observation strip leads with its timestamp and stale age, never invented health.
Below it, server-backed filters and dense operation rows sit beside the selected
immutable timeline and matching symptom history; narrow screens stack these
regions and let the operation list collapse without hiding the selection.

Refresh preserves the selected incident. Event time and archive observation time
remain separate, including explicitly unknown historical times. Related-history
counts include the selected operation and link to all retained matches, not only
the bounded related list. Recorded terminal outcomes and Amp/capture links are
evidence, not claims of a shared root cause or verified recovery. No action
controls or private content are added. Verification uses labeled synthetic data.

## Finish verdict

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

No raster assets ship. Painter supplied layout exploration only. All screenshots
and preview captures contain synthetic evidence, never production conversations.

The Operations extension was inspected at 1440px and 390px using the labeled
synthetic preview, with no horizontal document overflow. The inline finish review
resolved controller-phase fallback and keyboard focus for matching-history
navigation; independent integration review remains with the parent. The detector
reported only advisory type/radius differences, consistent with the established
dense surface and mobile input sizing; DESIGN.md was not changed.

Rendered checks covered authentication return and expiry clearing, browser
Back/Forward, retained selection on refresh/filtering, search beyond the first
page, all 52 synthetic symptom matches beyond the related-list cap, 103-event
timeline pagination, queued/no-thread and unknown outcomes, missing/unavailable/
empty states, and the existing capture, conversation and passkey settings views.
Passkey enrollment itself and live operational publication were not exercised.
