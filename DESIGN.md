---
name: June private console
description: Restrained dark control panel for June's owner; decisions first, explicit state, mechanical steps automatic.
colors:
  bg: "#111111"
  surface: "#181818"
  surface-raised: "#202020"
  inset: "#141414"
  line: "#2a2a2a"
  line-strong: "#3a3a3a"
  control: "#6b6b6b"
  text: "#ededed"
  text-secondary: "#b8b8b8"
  text-muted: "#a3a3a3"
  on-accent: "#151515"
  hover: "#ffffff"
  badge-neutral: "#1e1e1e"
  code-text: "#c8c8c8"
  focus: "#9ac3ff"
  ok: "#86ceaa"
  ok-bg: "#15241c"
  ok-line: "#2c4d3b"
  warn: "#e3bd78"
  warn-bg: "#282116"
  warn-line: "#54442a"
  danger: "#eea09a"
  danger-bg: "#2a1c1b"
  danger-line: "#5a3532"
  data-input: "#8cdbc2"
  data-output: "#b5a0ee"
typography:
  headline:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
  title-small:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  body-small:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  button:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.3
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 500
  caption:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  figure:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
    fontFeature: "tnum"
  figure-small:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "18px"
    fontWeight: 500
    lineHeight: 1.5
    fontFeature: "tnum"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "6px"
  md: "8px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  card: "20px"
  xl: "24px"
  section: "32px"
components:
  button-primary:
    backgroundColor: "{colors.text}"
    textColor: "{colors.on-accent}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "7px 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.bg}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "7px 14px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.hover}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "7px 14px"
    height: "36px"
  button-danger-hover:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger}"
  button-disabled:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-muted}"
  input:
    backgroundColor: "{colors.inset}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 11px"
    height: "38px"
  badge:
    backgroundColor: "{colors.badge-neutral}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 9px"
  badge-ok:
    backgroundColor: "{colors.ok-bg}"
    textColor: "{colors.ok}"
  badge-warn:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn}"
  badge-danger:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger}"
  notice:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.body-small}"
    rounded: "{rounded.sm}"
    padding: "12px 14px"
  notice-ok:
    backgroundColor: "{colors.ok-bg}"
    textColor: "{colors.text}"
  notice-warn:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.text}"
  notice-danger:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.text}"
  list-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    padding: "14px 16px"
  list-row-hover:
    backgroundColor: "{colors.surface-raised}"
  facts-cell:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    padding: "12px 16px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "{spacing.card}"
  continuation-status:
    textColor: "{colors.text-secondary}"
    typography: "{typography.body}"
  nav-link:
    textColor: "{colors.text-secondary}"
    padding: "0 10px"
    height: "56px"
  nav-link-current:
    textColor: "{colors.text}"
---

<!-- Names, the North Star and the named rules below are derived from the approved direction contract (.impeccable/surfaces/src-console-view-ts.md) and PRODUCT.md without a new owner interview; treat the names as provisional until the owner confirms them. Tokens come from src/console/view.ts and src/console/usage.ts. -->

# Design System: June private console

## Overview

**Creative North Star: "The Quiet Control Panel"**

June's console is a private instrument panel, not a showroom. It opens on what needs the owner and gets out of the way. Familiar navigation, clear typography and responsive behavior take precedence over decorative effects. Every surface is a dark neutral layer separated by hairline dividers, set in the platform's own sans. One light-filled button marks the next decision, and everything else is outline or text. State is always written in words. Color only reinforces what the words already say, so a glance and a careful read agree.

Density is moderate and familiar: lists of rows, key/value fact grids, disclosures for detail, and cards reserved for a single task or decision. Mechanical steps (sign-in links, provider returns, finishing a save) continue on their own and always leave a visible fallback button. Meaningful consent (approvals, tool permissions, disconnects) stays a checked statement plus one explicit button. Empty states say only what the host reports and teach what would appear.

**Key Characteristics:**
- Achromatic dark layers (#111111 → #181818 → #202020) with 1px dividers, no shadows.
- A single light action accent; a focus blue reserved for focus, caret and selection.
- Status as text first, in pill badges, fully outlined notices and plain-language rows.
- The Overview puts decisions before work before system facts; review pages put the exact evidence above the decision.
- System sans throughout; monospace only for code and data that must be read exactly.

## Colors

A restrained achromatic ground with one light action accent, one focus blue, three soft semantic tones and two data hues, none of which appears without words.

### Primary
- **Signal White** (#ededed): the primary button fill and primary text. Its rarity as a fill is the point: one per decision.

### Secondary
- **Focus Blue** (#9ac3ff): focus rings, the text caret and text selection (a 30% tint). Never decoration, a surface or a status color.

### Neutral
- **Console Night** (#111111): the page ground, and text on the hovered primary button.
- **Panel Charcoal** (#181818): lists, fact grids, cards, usage panels, disclosures, notices and the top bar.
- **Raised Charcoal** (#202020): row and disclosure hover, secondary-button hover and disabled buttons.
- **Well Black** (#141414): inputs, code blocks and table headers.
- **Hairline** (#2a2a2a): container borders and row dividers.
- **Strong Hairline** (#3a3a3a): neutral badge and notice outlines; disabled and not-yet-confirmed buttons.
- **Control Gray** (#6b6b6b): input and secondary-button borders; the scrollbar thumb.
- **Soft Text** (#b8b8b8): row details, ledes, tabs and neutral notices.
- **Muted Text** (#a3a3a3): hints, fact labels, meta, chart axes and placeholders.
- **Ink** (#151515): text on Signal White.
- **Pure White** (#ffffff): hover for the primary fill, links and secondary-button text.
- **Badge Charcoal** (#1e1e1e): neutral badge fill.
- **Code Gray** (#c8c8c8): text inside code blocks.

### Status (semantic)
- **Settled Green** (#86ceaa, fill #15241c, line #2c4d3b): saved, succeeded, reads allowed, live.
- **Attention Amber** (#e3bd78, fill #282116, line #54442a): awaiting approval, expired, unknown outcome, failed discovery, private input.
- **Stop Rose** (#eea09a, fill #2a1c1b, line #5a3532): failed, rejected, disconnected and destructive actions.
- Usage bubbles reuse **Settled Green** at 15% fill and 75% stroke opacity as a data series, not a health indicator. Area represents the selected metric; a text legend explains the encoding. Dashed neutral rings distinguish unavailable counters from reported-zero crosses.

### Named Rules
**The Text-First Status Rule.** Every state is written in words: in a badge, a heading, a notice or the row itself. Tone color only supplements it, and configuration states such as configured, observed or recorded stay neutral.

**The One Light Action Rule.** Each decision gets at most one Signal White button. Alternatives are outlined.

**The Foreground-on-Tint Rule.** Text inside a tinted notice uses the foreground (#ededed), never gray.

## Typography

**Display Font:** none (product UI)
**Body Font:** system-ui (with -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif)
**Label/Mono Font:** ui-monospace (with SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace)

**Character:** One platform sans carries headings, labels, buttons and figures in small steps (12, 13, 14 and 15px) under a 22px page title. The mono face appears only where exactness matters.

### Hierarchy
- **Headline** (600, 22px, 1.3, -0.01em): the single page title; 20px at 720px and below.
- **Title** (600, 15px, 1.3): section headings.
- **Title Small** (600, 14px, 1.3): row and card headings.
- **Body** (400, 14px, 1.5): default text. Ledes stop at 70ch; notice, card and section-intro prose stops at 75ch.
- **Body Small** (400, 13px, 1.5): row details, notices, breadcrumbs and consent statements.
- **Button** (600, 13px, 1.3): every button label.
- **Label** (500, 12px): status badges (on a 20px line box) and table headers.
- **Caption** (400, 12px, 1.5): fact labels, hints, section notes, row meta and the footer.
- **Figure** (600, 26px, 1.2, -0.02em, tabular numerals): usage totals only; 22px at 720px and below. Supporting usage facts use 18px system sans.
- **Mono** (400, 12.5px): inline code and table data cells; code blocks set 12px at 1.7.

### Named Rules
**The One Family Rule.** System sans carries every heading, label, button and sentence. Monospace is for code and data that must be read exactly, never a "technical" costume.

## Layout

The main column is at most 1120px wide, with 32px top and 24px side padding (24px and 16px at 720px and below). Single-task pages (sign-in, continuation, errors, sign-out) narrow to 520px. The page header holds an optional breadcrumb, the headline with an optional status badge, a short lede, and right-aligned page actions or meta, 24px above the first section. Sections sit 32px apart, with their heading 10px above the content, so there is more space above a heading than below it. Two-column grids use a 24px gap and stack at 720px and below. Usage leads with a full-width hourly bubble chart, followed by a single summary panel and recent requests. Its four facts become two columns and its provider/model/stage rows become one column at 720px and below.

At 720px and below, the primary navigation becomes a full-width second row of equal 44px segments instead of a scrolling tab strip. Buttons grow to 44px touch height, and rows with actions stack those actions under their text; badge-only rows keep the badge on the right. At 400px and below the Owner label hides, leaving Sign out. Wide tables and the usage chart scroll inside their panel, so the page itself never overflows horizontally.

### Named Rules
**The Decisions-First Rule.** The Overview leads with what needs the owner, then work, then system facts. A review page shows exactly what is being approved above its single decision. Sources the host does not report are grouped into one disclosure, never shown as empty panels.

## Elevation & Depth

The system is flat. Depth comes from tonal layering (#111111 ground, #181818 surfaces, #202020 raised and hover) and 1px hairlines. There are no shadows anywhere.

### Named Rules
**The Flat Layer Rule.** Declare depth with a lighter layer and a hairline, never a shadow or gradient.

## Shapes

Corners are gently rounded and consistent. Controls, notices and code blocks use 6px; containers (lists, fact grids, cards, disclosures and usage panels) use 8px. Status badges are pills (999px). Usage chart marks are circles with 1.3px outlines. Container outlines are a uniform 1px on all sides, and dividers inside them are single 1px hairlines. The current tab uses a 2px bottom indicator.

### Named Rules
**The Two Radii Rule.** Controls take 6px and containers 8px. Only badges and thin data bars round fully.

**The No-Stripe Rule.** Nothing gets a thick or colored side border. Notices, rows and cards keep a full 1px outline.

## Components

### Buttons
- **Shape:** gently rounded (6px), 36px tall (44px at 720px and below), 7px × 14px padding, 13px/600 label.
- **Primary:** Signal White fill and outline with Ink text; hover goes to Pure White with Console Night text.
- **Secondary:** transparent with a Control Gray outline and Signal White text. Hover raises the fill to #202020 and lightens the outline to #a3a3a3 and the text to Pure White.
- **Danger:** transparent with a #5a3532 outline and Stop Rose text; hover fills #2a1c1b and brightens the outline to Stop Rose. Used only for destructive actions such as Disconnect.
- **Disabled:** #202020 fill, #3a3a3a outline, muted text and a not-allowed cursor. A consent submit stays outlined in #3a3a3a with Soft Text until its statement is checked.
- **Focus / Motion:** 2px Focus Blue outline at 2px offset; color and border transitions of 120ms.

### Badges
- **Style:** pill with a 6px dot in the text color, 12px/500 label, 1px outline. Neutral is #1e1e1e fill with Soft Text; tones use their own fill, line and text.
- **State:** tone follows the label (for example "Awaiting approval" is amber and "Authorization saved" is green). Unmapped labels stay neutral.

### Cards / Containers
- **Corner Style:** 8px for every container.
- **Background:** Panel Charcoal (#181818) on the Console Night ground.
- **Shadow Strategy:** none; see Elevation & Depth.
- **Border:** 1px Hairline outline, with 1px Hairline dividers inside.
- **Internal Padding:** cards 20px, list rows 14px × 16px, fact cells and disclosure summaries 12px × 16px. Usage summary sections have 24px side padding (16px on mobile), separated by dividers rather than nested cards.
- **Lists:** linked rows raise to #202020 on hover, underline their title and show a drawn chevron. Their focus ring is inset (a -3px offset), so the list's clipped edges never hide it.
- **Fact grids:** key/value cells with 12px muted labels, flowing into columns of at least 200px.
- **Cards:** hold one task or decision, such as a review decision, the disconnect zone or the live viewer. A card never contains a notice or another card.
- **Disclosures:** a Panel Charcoal summary row with a drawn chevron that turns in 120ms. Nested lists sit flush inside with a single border.

### Notices
- **Style:** 12px × 14px padding, 6px corners and a full 1px outline. A bold title names the state unless the page heading already does. Neutral uses Panel Charcoal with Soft Text; tones use their tinted fill, their line color and foreground text.
- **Placement:** standalone, never nested inside a card, and 16px from an adjacent card or fact grid.

### Inputs / Fields
- **Style:** Well Black fill, 1px Control Gray outline, 6px corners, 38px tall, 8px × 11px padding. The label sits 6px above the field at 13px/500, and hints are 12px Muted Text. Placeholders use Muted Text at 80%.
- **Focus:** Focus Blue ring and caret; hover lightens the outline to #a3a3a3.
- **Error:** invalid fields take a Stop Rose outline.
- **Consent:** a required 16px checkbox statement with a muted detail line precedes one submit button, which stays de-emphasized until checked.

### Navigation
- **Top bar:** Panel Charcoal with a Hairline bottom, 56px tall, holding the brand mark, the primary tabs and a right-aligned Owner label with Sign out. Pages without console navigation, such as OAuth problems and the live view, show only the brand.
- **Tabs:** 14px/500 Soft Text links that brighten to Signal White on hover. The current tab is Signal White with a 2px bottom indicator, and the focus ring sits inside the tab. At 720px and below the tabs become equal full-width segments on their own row.
- **Breadcrumb:** a small muted trail above the headline on detail pages.

### Continuation status (signature)
A pulsing 8px muted dot sits beside a Soft Text status line ("Opening GitHub…", "Finishing your GitHub connection…"), followed by one full-width fallback button. The dot is the only looping motion: 900ms ease-in-out, alternating opacity, stopped under reduced motion. The step continues on its own once the page is visible, and the button remains for no-script and automated browsers.

## Do's and Don'ts

### Do:
- **Do** lead the Overview with what needs the owner, then work, then system facts, and keep a review's exact evidence above its decision.
- **Do** write every state in words; tone color (#86ceaa, #e3bd78, #eea09a) only supplements it.
- **Do** keep one Signal White (#ededed) button per decision and outline the alternatives.
- **Do** use fact grids for key/value data and list rows for records, and keep prose within 75ch.
- **Do** theme browser surfaces from the palette: Focus Blue (#9ac3ff) for focus rings and the caret, selection at 30% Focus Blue, and a #6b6b6b scrollbar thumb.
- **Do** scope empty states to what the host reports, and say what would appear there.

### Don't:
- **Don't** add thick or colored side borders to notices, rows or cards.
- **Don't** nest a notice or a card inside another card.
- **Don't** put eyebrow or kicker labels above headings, number sections, or use glyphs in place of drawn icons.
- **Don't** use shadows or gradients for depth.
- **Don't** color configuration states as health; configured, observed and recorded stay neutral.
- **Don't** state absence as fact when a source is unreported or history is limited to recent requests.
