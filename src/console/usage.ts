import { html } from "hono/html";
import type { UsageGroup, UsageSnapshot } from "../models/usage.js";
import { badge, consoleNavigation, page } from "./view.js";

const number = (value: number | null) =>
  value === null ? "—" : new Intl.NumberFormat("en-US").format(value);
const compact = (value: number | null) =>
  value === null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(value);
const duration = (value: number | null) =>
  value === null ? "—" : `${(value / 1000).toFixed(1)}s`;
const date = (value: number) =>
  new Date(value).toISOString().replace("T", " ").slice(0, 16);
const tokens = (group: { input: number | null; output: number | null }) =>
  group.input === null && group.output === null
    ? null
    : (group.input ?? 0) + (group.output ?? 0);
const percent = (a: number, b: number) =>
  b ? `${((100 * a) / b).toFixed(1)}%` : "—";
const provider = (name: string) =>
  name === "codex" ? "ChatGPT subscription" : `${name} API`;
type Metric = "tokens" | "calls";
const value = (group: UsageGroup, metric: Metric) =>
  metric === "calls" ? group.calls : tokens(group);

function activityChart(snapshot: UsageSnapshot, metric: Metric) {
  const day = 86_400_000;
  const firstDay = Math.floor(snapshot.from / day);
  const dayCount = Math.floor(snapshot.now / day) - firstDay + 1;
  const maximum = Math.max(
    1,
    ...snapshot.activity.map((g) => value(g, metric) ?? 0),
  );
  const radius = snapshot.days === 30 ? 12 : 22;
  const points = snapshot.activity.map((group) => {
    const started = Number(group.label) * 3_600_000;
    const hour = new Date(started).getUTCHours();
    const x = 62 + ((started / day - firstDay + 1 / 48) / dayCount) * 906;
    const y = 60 + ((hour + 0.5) / 24) * 272;
    const amount = value(group, metric);
    const label = `${date(started)} UTC · ${number(group.calls)} calls · ${number(group.input)} input / ${number(group.output)} output · ${group.measured}/${group.calls} fully measured`;
    return { x, y, amount, label };
  });
  return html`<svg class="usage-chart" data-metric="${metric}" viewBox="0 0 1000 366" role="img" aria-labelledby="activity-title activity-description">
    <title id="activity-title">Hourly ${metric === "calls" ? "provider calls" : "reported token usage"}</title>
    <desc id="activity-description">Dates run left to right, UTC hours top to bottom. Each circle represents one recorded hour; its area is proportional to ${metric} within this selection. Dashed rings mean unavailable tokens; crosses mean reported zero. Empty space does not prove zero usage. The hourly data table and JSON export contain exact counters.</desc>
    ${[0, 6, 12, 18, 24].map((hour) => html`<line class="usage-grid" x1="62" x2="968" y1="${60 + (hour / 24) * 272}" y2="${60 + (hour / 24) * 272}"/><text class="usage-axis" x="42" y="${64 + (hour / 24) * 272}" text-anchor="end">${String(hour).padStart(2, "0")}</text>`)}
    ${Array.from({ length: dayCount }, (_, i) => {
      const x = 62 + (i / dayCount) * 906;
      const label = new Date((firstDay + i) * day).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
      return html`<line class="usage-grid" x1="${x}" x2="${x}" y1="48" y2="344"/>${i % Math.max(1, Math.ceil(dayCount / 10)) === 0 ? html`<text class="usage-axis" x="${x + 453 / dayCount}" y="28" text-anchor="middle">${label}</text>` : ""}`;
    })}
    ${points.map(({ x, y, amount, label }) => html`<g class="usage-point"><title>${label}</title>${amount === null ? html`<circle class="usage-unknown" cx="${x}" cy="${y}" r="4"/>` : amount === 0 ? html`<path class="usage-zero" d="M${x - 3} ${y - 3}l6 6m-6 0l6 -6"/>` : html`<circle class="usage-bubble" cx="${x}" cy="${y}" r="${radius * Math.sqrt(amount / maximum)}"/>`}</g>`)}
  </svg>`;
}

export function usagePage(
  snapshot: UsageSnapshot,
  nonce: string,
  base: string,
  options: {
    connectionsAvailable?: boolean;
    signOut?: string;
    metric?: Metric;
  } = {},
) {
  const { total } = snapshot;
  const metric = options.metric ?? "tokens";
  const observed = tokens(total);
  const period = snapshot.days === 1 ? "24 hours" : `${snapshot.days} days`;
  const query = `?days=${snapshot.days}&model=${encodeURIComponent(snapshot.model)}`;
  const url = (
    days = snapshot.days,
    model = snapshot.model,
    selected = metric,
  ) =>
    `${base}/usage?days=${days}&model=${encodeURIComponent(model)}&metric=${selected}`;
  const fact = (label: string, amount: string, note: string) =>
    html`<div><dt>${label}</dt><dd>${amount}</dd><dd class="hint">${note}</dd></div>`;
  const breakdown = (
    title: string,
    groups: UsageGroup[],
    kind: "provider" | "model" | "stage",
  ) =>
    html`<section class="usage-breakdown" aria-label="${title}"><h3>${title}</h3><dl>${[...groups].sort((a, b) => (value(b, metric) ?? -1) - (value(a, metric) ?? -1)).map((group) => html`<div><dt>${kind === "model" ? html`<a href="${url(snapshot.days, group.label)}">${group.label}</a>` : kind === "provider" ? provider(group.label) : group.label}</dt><dd>${compact(value(group, metric))} <span>${metric}</span></dd></div>`)}</dl>${groups.length ? "" : html`<p class="hint">No recorded calls in this selection.</p>`}</section>`;
  const cacheComparable =
    total.calls > 0 &&
    total.inputReports === total.calls &&
    total.cacheReports === total.calls;
  return page(
    "Usage",
    nonce,
    html`<style nonce="${nonce}">
      .usage-segments{display:flex;border:1px solid var(--line-strong);border-radius:var(--radius-small);overflow:hidden}
      .usage-segments a{display:grid;place-items:center;min-width:42px;min-height:34px;padding:6px 12px;color:var(--text-secondary);font-size:13px;font-weight:500;text-decoration:none}
      .usage-segments a+a{border-left:1px solid var(--line-strong)}.usage-segments a:hover{background:var(--surface-raised);color:var(--text)}
      .usage-segments a[aria-current=true]{background:var(--text);color:var(--on-accent)}.usage-segments a:focus-visible{outline-offset:-3px}
      .usage-toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px}
      .usage-filters{display:flex;align-items:center;gap:8px;min-width:0}.usage-filters label{color:var(--text-muted);font-size:13px}
      .usage-filters select{width:auto;max-width:240px;min-height:36px;padding:6px 10px;font-size:13px;border-color:var(--line-strong)}
      .usage-export{color:var(--text-secondary);font-size:13px}.usage-filter-note{display:flex;align-items:center;gap:12px;min-width:0}
      .usage-panel{min-width:0;overflow:hidden;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
      .usage-scroll{overflow-x:auto}.usage-scroll:focus-visible{outline-offset:-3px}.usage-chart{display:block;width:100%;min-width:680px;height:auto}
      .usage-grid{stroke:var(--line);stroke-width:1}.usage-axis{fill:var(--text-muted);font-size:12px}
      .usage-bubble{fill:var(--ok);fill-opacity:.15;stroke:var(--ok);stroke-opacity:.75;stroke-width:1.3;vector-effect:non-scaling-stroke;transition:fill-opacity .12s}
      .usage-point:hover .usage-bubble{fill-opacity:.45;stroke-opacity:1}.usage-unknown{fill:none;stroke:var(--text-muted);stroke-dasharray:2 2}.usage-zero{fill:none;stroke:var(--text-muted)}
      .usage-chart-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;padding:12px 20px;border-top:1px solid var(--line);color:var(--text-muted);font-size:12px}
      .usage-key{display:inline-flex;align-items:center;gap:8px}.usage-key svg{width:16px;height:16px}.usage-summary{margin-top:24px}
      .usage-summary-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px 12px;padding:22px 24px}.usage-summary-head h2{font-size:26px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
      .usage-summary-head p{color:var(--text-muted)}.usage-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0;padding:0 24px 20px;gap:16px}
      .usage-facts dt{color:var(--text-secondary);font-size:12px}.usage-facts dd{margin:4px 0 0;font-variant-numeric:tabular-nums}.usage-facts dd:not(.hint){font-size:18px;font-weight:500}
      .usage-breakdown{padding:18px 24px;border-top:1px solid var(--line)}.usage-breakdown h3{margin-bottom:12px;color:var(--text-muted);font-size:13px;font-weight:500}
      .usage-breakdown dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 40px;margin:0}.usage-breakdown dl>div{display:flex;justify-content:space-between;align-items:baseline;gap:12px;min-width:0}
      .usage-breakdown dt{min-width:0;overflow-wrap:anywhere}.usage-breakdown dt a{text-decoration:none}.usage-breakdown dt a:hover{text-decoration:underline}.usage-breakdown dd{margin:0;flex-shrink:0;font-variant-numeric:tabular-nums}.usage-breakdown dd span{color:var(--text-muted);font-size:12px}
      .usage-coverage{padding:14px 24px;border-top:1px solid var(--line);color:var(--text-muted);font-size:12px}.usage-coverage p+p{margin-top:4px}
      .usage-section-head{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:18px 20px}.usage-ledger .usage-scroll{max-height:460px}.usage-ledger thead{position:sticky;top:0;z-index:1}
      .usage-ledger tbody th{min-width:170px;overflow-wrap:anywhere}.usage-ledger tbody th small{display:block;color:var(--text-muted);font-weight:400;font-size:12px}.usage-ledger tbody tr:hover{background:var(--surface-raised)}
      .usage-counters>summary{cursor:pointer;font-variant-numeric:tabular-nums}.usage-counters dl{min-width:180px;margin:10px 0 0;font-family:var(--font);font-size:12px}.usage-counters dl>div{display:flex;justify-content:space-between;gap:12px;margin:4px 0}.usage-counters dd{margin:0}
      .usage-details{margin-top:16px}.usage-details .usage-scroll{max-height:360px}.usage-details-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}.usage-details-grid>div{margin:0}.usage-details-grid p{margin-top:6px;color:var(--text-secondary);font-size:13px}
      .usage-details-grid dl{margin:10px 0 0}.usage-details-grid dl>div{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 12px;padding:6px 0}.usage-details-grid dt{color:var(--text-muted);font-size:13px}.usage-details-grid dd{margin:0 0 0 auto;font-variant-numeric:tabular-nums}.usage-details-grid dd.hint{flex-basis:100%;margin:0}
      .usage-alert{margin-top:16px}.usage-empty{padding:20px;text-align:center;color:var(--text-secondary)}.usage-empty p{margin:6px auto 0;max-width:60ch;color:var(--text-muted);font-size:13px}
      @media(max-width:720px){.usage-segments a{min-height:44px}.usage-toolbar{align-items:flex-start}.usage-filters{flex-wrap:wrap}.usage-filters select{min-height:44px;max-width:210px}.usage-filter-note{width:100%;justify-content:space-between}.usage-summary-head{padding:20px 16px}.usage-summary-head h2{font-size:22px}.usage-facts{grid-template-columns:repeat(2,minmax(0,1fr));padding:0 16px 20px}.usage-breakdown{padding:16px}.usage-breakdown dl{grid-template-columns:1fr}.usage-coverage{padding:14px 16px}.usage-chart-foot{padding:12px 16px}.usage-details-grid{grid-template-columns:1fr}.usage-section-head{padding:16px}}
    </style>
    <div class="usage-toolbar"><form class="usage-filters" method="get" action="${base}/usage"><input type="hidden" name="days" value="${snapshot.days}"><input type="hidden" name="metric" value="${metric}"><label for="usage-model">Model</label><select id="usage-model" name="model"><option value="">All models</option>${[...new Set([...snapshot.models, ...(snapshot.model ? [snapshot.model] : [])])].map((model) => html`<option value="${model}"${model === snapshot.model ? html` selected` : ""}>${model}</option>`)}</select><button class="secondary" type="submit">Apply</button>${snapshot.model ? html`<a class="usage-export" href="${url(snapshot.days, "")}">Clear</a>` : ""}</form><div class="usage-filter-note"><span class="hint">All times UTC</span><a class="usage-export" href="${base}/usage/export${query}">Export JSON</a></div></div>
    <section class="usage-panel" aria-label="Usage activity"><div class="usage-scroll" tabindex="0" role="region" aria-label="Hourly activity chart; scroll horizontally on small screens">${activityChart(snapshot, metric)}</div>
      ${total.calls === 0 ? html`<div class="usage-empty"><h2>No recorded calls in this selection</h2><p>Usage appears after June calls a configured model. Missing history is unknown, not zero; viewing this page never starts a call.</p></div>` : metric === "tokens" && observed === null ? html`<div class="usage-empty"><h2>Token counts unavailable</h2><p>${number(total.calls)} calls were recorded without token counters. Switch to Calls to see their activity.</p></div>` : ""}
      <div class="usage-chart-foot"><span class="usage-key"><svg viewBox="0 0 16 16" aria-hidden="true"><circle class="usage-bubble" cx="8" cy="8" r="6"/></svg>One circle per hour · area = ${metric === "tokens" ? "reported tokens" : "calls"}</span><span>Dashed ring: unknown · ×: reported zero</span><a href="#hourly-data">View hourly data</a></div>
    </section>
    ${snapshot.writeFailures ? html`<div class="usage-alert notice" data-tone="warn"><strong>Some usage could not be saved</strong><p>${snapshot.writeFailures} telemetry settlements failed in this process. Affected calls remain unresolved; this does not authorize a retry.</p></div>` : ""}
    <section class="usage-panel usage-summary" aria-labelledby="usage-total"><header class="usage-summary-head"><h2 id="usage-total">${metric === "tokens" ? compact(observed) : number(total.calls)} ${metric === "tokens" ? "reported tokens" : "provider calls"}</h2><p>in the last ${period}</p></header>
      <dl class="usage-facts">${fact("Input tokens", compact(total.input), "Includes cached input")}${fact("Output tokens", compact(total.output), "Includes reasoning")}${fact("Cached input", compact(total.cached), "Subset of input, not added again")}${fact("Provider calls", number(total.calls), `${number(total.failed)} failed · ${number(total.pending)} unresolved`)}</dl>
      ${breakdown("From", snapshot.byProvider, "provider")}${breakdown("Models", snapshot.byModel, "model")}${breakdown("Stages", snapshot.byStage, "stage")}
      <div class="usage-coverage"><p>${number(total.measured)} of ${number(total.calls)} calls report complete input/output counts. Totals include reported counters only; missing counters remain unknown.</p><p>Tracking since ${date(snapshot.since)} UTC. Billing, subscription quota and cost estimates are unavailable.</p></div>
    </section>
    <section class="section usage-panel usage-ledger" aria-labelledby="ledger"><header class="usage-section-head"><h2 id="ledger">Recent requests</h2><p class="hint">Latest ${snapshot.recent.length} of ${number(total.calls)} calls · expand tokens for details</p></header><div class="usage-scroll" tabindex="0" role="region" aria-label="Recent requests"><table><thead><tr><th scope="col">Started (UTC)</th><th scope="col">Model / access</th><th scope="col">Stage</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Time</th><th scope="col">Outcome</th></tr></thead><tbody>${snapshot.recent.map(
      (row) =>
        html`<tr><td><time datetime="${new Date(row.started).toISOString()}">${date(row.started)}</time></td><th scope="row">${row.model}<small>${provider(row.provider)}</small></th><td>${row.stage}</td><td class="num"><details class="usage-counters"><summary aria-label="Token details: ${number(tokens(row))} reported tokens">${compact(tokens(row))}</summary><dl>${(
          [
            ["Input", row.input],
            ["Cache reads", row.cached],
            ["Cache writes", row.cacheWrite],
            ["Output", row.output],
            ["Reasoning", row.reasoning],
          ] satisfies [string, number | null][]
        ).map(
          ([label, count]) =>
            html`<div><dt>${label}</dt><dd>${number(count)}</dd></div>`,
        )}</dl></details></td><td class="num">${duration(row.duration)}</td><td>${badge(row.status === "pending" ? "unknown" : row.status)}</td></tr>`,
    )}</tbody></table>${snapshot.recent.length ? "" : html`<p class="empty">No requests to show for this window and model.</p>`}</div><div class="usage-chart-foot">Provider outcomes, not message-delivery receipts. A failed call can consume tokens. Unresolved attempts may still be running or may have been interrupted.</div></section>
    <details class="usage-details disclosure"><summary>Hourly data · exact counters</summary><div class="usage-scroll" id="hourly-data" tabindex="0" role="region" aria-label="Hourly usage data"><table><thead><tr><th scope="col">Hour (UTC)</th><th scope="col" class="num">Calls</th><th scope="col" class="num">Input</th><th scope="col" class="num">Output</th><th scope="col" class="num">Fully measured</th></tr></thead><tbody>${snapshot.activity.map((group) => html`<tr><th scope="row">${date(Number(group.label) * 3_600_000)}</th><td class="num">${number(group.calls)}</td><td class="num">${number(group.input)}</td><td class="num">${number(group.output)}</td><td class="num">${group.measured}/${group.calls}</td></tr>`)}</tbody></table>${snapshot.activity.length ? "" : html`<p class="empty">No recorded hours in this selection.</p>`}</div><p class="usage-chart-foot">Full selected window: ${date(snapshot.from)} → ${date(snapshot.now)} UTC. Boundary hours may be partial. This table is not limited to the latest 100 requests.</p></details>
    <details class="usage-details disclosure"><summary>Measurement details and billing</summary><div class="disclosure-body usage-details-grid"><div><h3>Cache and reasoning</h3><dl>${fact("Cache-read tokens", number(total.cached), `${total.cacheReports}/${total.calls} calls report cache`)}${fact("Cache-write tokens", number(total.cacheWrite), "Included in input")}${fact("Cache-read share", cacheComparable && total.input ? percent(total.cached ?? 0, total.input) : "—", "Requires input and cache on every call")}${fact("Reasoning tokens", number(total.reasoning), `${total.reasoningReports}/${total.calls} calls report reasoning`)}</dl></div><div><h3>Coverage and latency</h3><p>${percent(total.measured, total.calls)} complete input/output reports. Input: ${total.inputReports}/${total.calls}; output: ${total.outputReports}/${total.calls}.</p><dl><div><dt>Median / p95</dt><dd>${duration(snapshot.p50)} / ${duration(snapshot.p95)}</dd></div><div><dt>Mean call time</dt><dd>${duration(total.duration)}</dd></div></dl><p>Host wall time includes setup, transport and cleanup, including failed settled calls. It is not generation speed or end-to-end reply latency.</p></div><div><h3>Token telemetry, not a bill</h3><p>No invoice API or verified rate card is connected. Subscription price, quota, resets, overages, discounts and taxes are unknown. Subscription usage is not necessarily free or unlimited.</p></div><div><h3>Forward-only, private history</h3><p>Only instrumented model calls are included, not whole-account usage, native coding workers, external observers or non-model tools. No prompts, messages, credentials or conversation identifiers are recorded. Replayed conversations do not create usage.</p><p>Anthropic input includes cache only when both cache counters are reported. Codex all-zero fallback reports are unavailable; individual zero detail counters may be provider defaults. Cache and reasoning are subsets, never extra tokens.</p><p>You can also ask June about her usage in your private conversation.</p></div></div></details>
    <p class="section hint">Observed ${date(snapshot.now)} UTC. <a href="${url()}">Refresh usage</a>.</p>`,
    {
      actions: html`<nav class="usage-segments" aria-label="Chart metric">${(["tokens", "calls"] as const).map((item) => html`<a href="${url(snapshot.days, snapshot.model, item)}"${item === metric ? html` aria-current="true"` : ""}>${item === "tokens" ? "Tokens" : "Calls"}</a>`)}</nav><nav class="usage-segments" aria-label="Time window">${[1, 7, 30].map((days) => html`<a href="${url(days)}"${days === snapshot.days ? html` aria-current="true"` : ""}>${days === 1 ? "24h" : `${days}d`}</a>`)}</nav>`,
      navigation: consoleNavigation(
        base,
        "usage",
        options.connectionsAvailable,
      ),
      signOut: options.signOut,
    },
  );
}
