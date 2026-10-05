---
version: 1
slug: "src-console-view-ts"
primary_target: "src/console/view.ts"
related_targets: ["src/console/routes.ts","src/console/connections.ts","src/console/session.ts","src/console/connection-oauth.ts","src/console/usage.ts"]
---

# Dashboard

Mode: Operate. Scope: June's private overview, connections, usage, sign-in,
OAuth return, permission review and recovery screens.

## Direction contract

THESIS: A private control panel that gets the owner to the next meaningful task,
not a collection of implementation panels or repeated consent receipts.

OWN-WORLD: Restrained dark neutral layers, readable system sans typography,
subtle dividers, consistent native forms, and one restrained action accent.
Color supplements explicit status text. No decorative imagery or outside assets.

STORY: See June's reported state, connect an account, inspect usage or review a
specific permission. Mechanical login steps continue automatically; meaningful
authorization remains deliberate.

FIRST VIEWPORT: Primary navigation contains Overview, Connections and Usage.
Overview prioritizes work and decisions before secondary system details.
Connections groups configured accounts and available providers, with one clear
next action per state rather than repeated setup prose and duplicate panels.
Mobile navigation remains visible without a long horizontal tab strip.

FORM: Owner-pinned restrained operational control panel, approved in the thread.
Impeccable seed b78821c4 was inspected; its alternate visual metaphors do not
override the approved task-focused direction. Code-led implementation: no image
generation was requested. Signature interaction: OAuth returns directly to its
saved connection with no second consent step; native fallback controls remain.
Motion is limited to short state feedback and respects reduced motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its
provenance

## Usage direction · 2026-10-05

Owner-pinned reference: Amp's Usage dashboard. Keep June's shared top navigation,
neutral palette, system type and private server-rendered surface. Lead with a
full-width green hourly bubble chart, compact Tokens/Calls and 24h/7d/30d links,
then one divided summary and recent requests. Do not copy Amp billing controls:
June has no billing source. Unknown counters and partial coverage stay explicit.

The signature interaction is native filtering without application scripts;
exact hourly data and per-request counters use disclosures. Green represents
data, not health. Mobile scrolls only the chart and tables and stacks breakdowns.
The supplied reference fixes the direction; the generated concept is exploratory,
not a pixel-exact contract or verification evidence. Validate rendered desktop,
mobile, filtered, unknown and empty states using synthetic data only. No shipping
raster assets are required. Preserve the console-wide rules above.

## Verification constraints

Only synthetic data may appear in previews. Amp's media viewer returned an upload
quota error on the baseline capture; Claude must report whether its local image
reader inspected captures. Real-browser interaction and layout checks remain
mandatory. Oracle reviews the actual final diff; no live provider or deployment
verification may be inferred from fixture success.
