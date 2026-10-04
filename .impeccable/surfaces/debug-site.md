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
