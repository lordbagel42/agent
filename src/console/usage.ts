import { html } from "hono/html";
import type { UsageGroup, UsageSnapshot } from "../models/usage.js";
import { badge, page } from "./view.js";

const number = (value: number | null) =>
  value === null
    ? "—"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
        value,
      );
const compact = (value: number | null) =>
  value === null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);
const duration = (value: number | null) =>
  value === null ? "—" : `${(value / 1000).toFixed(1)}s`;
const date = (value: number) =>
  new Date(value).toISOString().replace("T", " ").slice(0, 16);
const tokens = (group: UsageGroup) =>
  group.input === null && group.output === null
    ? null
    : (group.input ?? 0) + (group.output ?? 0);
const percent = (a: number, b: number) =>
  b ? `${((100 * a) / b).toFixed(1)}%` : "—";

function breakdown(
  title: string,
  subtitle: string,
  groups: UsageGroup[],
  modelLinks?: string,
) {
  return html`<section class="u-panel"><header><div><h2>${title}</h2><p>${subtitle}</p></div><span class="u-index">${String(groups.length).padStart(2, "0")}</span></header><div class="u-scroll"><table><thead><tr><th scope="col">${modelLinks ? "Model" : "Stage"}</th><th scope="col">Calls</th><th scope="col">Input / output</th><th scope="col">Measured</th><th scope="col">Avg time</th></tr></thead><tbody>${groups.map((group) => html`<tr><th scope="row">${modelLinks ? html`<a href="${modelLinks}&model=${encodeURIComponent(group.label)}">${group.label} ↗</a>` : group.label}<svg class="u-spark" viewBox="0 0 120 4" aria-hidden="true"><rect width="120" height="4" rx="2" fill="#293332"/><rect width="${(120 * group.calls) / Math.max(1, ...groups.map((g) => g.calls))}" height="4" rx="2" fill="#8cdbc2"/></svg></th><td>${number(group.calls)}</td><td><span class="mint">${compact(group.input)}</span><span class="u-slash"> / </span><span class="violet">${compact(group.output)}</span></td><td>${group.measured}/${group.calls}</td><td>${duration(group.duration)}</td></tr>`)}</tbody></table>${groups.length ? "" : html`<div class="u-empty">No recorded calls in this selection.<br><span>No activity is inferred from older conversations.</span></div>`}</div></section>`;
}

function chart(snapshot: UsageSnapshot) {
  const step = snapshot.days === 1 ? 3_600_000 : 86_400_000;
  const first = Math.floor(snapshot.from / step);
  const last = Math.floor(snapshot.now / step);
  const buckets = Array.from({ length: last - first + 1 }, (_, i) => ({
    start: (first + i) * step,
    group: snapshot.timeline.find((g) => Number(g.label) === first + i),
  }));
  const max = Math.max(
    1,
    ...snapshot.timeline.map((group) => tokens(group) ?? 0),
  );
  const width = 660 / buckets.length;
  return html`<svg class="u-chart" viewBox="0 0 760 252" role="img" aria-labelledby="chart-title chart-description"><title id="chart-title">Reported input and output tokens over time</title><desc id="chart-description">${snapshot.days === 1 ? "Hourly" : "Daily"} UTC buckets, clipped to the selected rolling window. Empty slots mean no recorded usage, not zero spend. Input includes cache reads; output includes reasoning. Missing counters are omitted. Exact totals and recent calls are available below and in the JSON export.</desc>${[0, 1, 2, 3].map((i) => html`<line x1="65" x2="740" y1="${30 + i * 58}" y2="${30 + i * 58}" stroke="#2a3634" stroke-dasharray="3 5"/><text x="50" y="${34 + i * 58}" text-anchor="end" fill="#81928f" font-size="11">${tokens(snapshot.total) === null ? "—" : compact((max * (3 - i)) / 3)}</text>`)}${buckets.map(
    ({ start, group }, i) => {
      const inputHeight = (174 * (group?.input ?? 0)) / max;
      const outputHeight = (174 * (group?.output ?? 0)) / max;
      return html`<g><title>${date(start)} UTC · ${group ? `${number(group.input)} input / ${number(group.output)} output · ${group.measured}/${group.calls} fully measured calls` : start + step <= snapshot.since ? "Before instrumentation; unknown" : "No recorded calls"}</title>${group && tokens(group) !== null ? html`<rect x="${70 + i * width}" y="${204 - inputHeight}" width="${Math.max(2, width - 7)}" height="${inputHeight}" fill="#8cdbc2" rx="2"/><rect x="${70 + i * width}" y="${204 - inputHeight - outputHeight}" width="${Math.max(2, width - 7)}" height="${outputHeight}" fill="#b5a0ee" rx="2"/>` : html`<circle cx="${70 + i * width + width / 2 - 3}" cy="204" r="2" fill="#53605d"/>`}${i % Math.max(1, Math.floor(buckets.length / 5)) === 0 ? html`<text x="${70 + i * width}" y="234" fill="#92a39e" font-size="11">${snapshot.days === 1 ? new Date(start).toISOString().slice(11, 16) : new Date(start).toISOString().slice(5, 10)}</text>` : ""}</g>`;
    },
  )}</svg>`;
}

export function usagePage(
  snapshot: UsageSnapshot,
  nonce: string,
  base: string,
) {
  const { total } = snapshot;
  const observed = tokens(total);
  const cacheComparable =
    total.calls > 0 &&
    total.inputReports === total.calls &&
    total.cacheReports === total.calls;
  const subscription = snapshot.byProvider.find(
    (group) => group.label === "codex",
  );
  const apiCalls = snapshot.byProvider
    .filter((g) => g.label !== "codex")
    .reduce((sum, g) => sum + g.calls, 0);
  const query = `?days=${snapshot.days}&model=${encodeURIComponent(snapshot.model)}`;
  return page(
    "Token intelligence",
    nonce,
    html`
  <style nonce="${nonce}">
    :root{background:#0d1211;color:#edf0e9}.topbar,.tabs,.footer{background:#111816;border-color:#29332f}.topbar-inner,.tabs-inner,main,.footer-inner{max-width:1400px}.mark{background:#b9dec9}.page-heading{margin:10px 0 28px}.page-heading h1{font:normal 48px/1.1 Georgia,serif;letter-spacing:-1.8px;color:#f0efe5}.description{color:#9aada3;max-width:none}.tabs a[aria-current]{border-color:#b9dec9;color:#d0e5d8}.u-toolbar{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:24px;flex-wrap:wrap}.u-live{font:11px ui-monospace,monospace;letter-spacing:1px;text-transform:uppercase;color:#a5c9b7;display:flex;gap:9px;align-items:center}.u-live:before{content:"";width:6px;height:6px;background:#a5c9b7;border-radius:50%;box-shadow:0 0 0 4px #a5c9b712}.u-filters{display:flex;gap:9px;align-items:end;flex-wrap:wrap}.u-filters label{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#a4b4ac;display:grid;gap:5px}.u-filters select{background:#19221e;color:#e1e9df;padding:8px 27px 8px 10px;border:1px solid #3c4b41;border-radius:5px;font:12px inherit;max-width:240px;height:36px}.u-filters button,.u-export{min-height:36px;padding:8px 13px;background:#d5e8c8;border-color:#d5e8c8;font-size:12px}.u-export{background:none;border:1px solid #3c4b41;border-radius:5px;color:#c8d7cd;display:inline-block}.u-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:20px}.u-kpi,.u-panel{border:1px solid #2e3b34;border-radius:10px;background:#141c18;min-width:0;overflow:hidden}.u-kpi{padding:22px 24px;background:linear-gradient(135deg,#1c2820,#141c18 75%)}.u-kpi .label{color:#acbdb2;font-size:12px;display:flex;justify-content:space-between;gap:10px}.u-kpi .value{font:42px/1.15 Georgia,serif;color:#eff2e8;letter-spacing:-1px;margin:16px 0 9px;font-variant-numeric:tabular-nums}.u-kpi .foot{color:#95a69a;font-size:11px}.mint{color:#8cdbc2}.violet{color:#c0adf4}.amber{color:#ebc887}.u-icon{color:#7e9f88}.u-main{display:grid;grid-template-columns:minmax(0,2.1fr) minmax(280px,1fr);gap:20px;margin-bottom:20px}.u-panel header{padding:22px 24px 16px;display:flex;justify-content:space-between;align-items:start;gap:12px}.u-panel h2{font-size:15px;color:#e2eadf}.u-panel header p{font-size:11px;color:#96a99a;margin-top:5px}.u-index{font:11px ui-monospace,monospace;color:#7f9886;border:1px solid #344738;padding:2px 7px;border-radius:4px}.u-legend{display:flex;gap:16px;font-size:11px;color:#adbbb2;flex-wrap:wrap}.u-dot{display:inline-block;width:7px;height:7px;border-radius:2px;background:#8cdbc2;margin-right:6px}.u-dot.output{background:#b5a0ee}.u-chart{display:block;width:100%;height:auto;padding:0 12px}.u-chart-note{border-top:1px solid #2a3830;padding:13px 24px;font-size:11px;color:#96aa9b;display:flex;justify-content:space-between;gap:16px}.u-billing{padding:0 24px 22px}.u-billing .price{font:36px Georgia,serif;color:#ebc887;margin:3px 0 10px}.u-billing p{font-size:12px;color:#a2b0a7}.u-billing .u-plan{border-top:1px solid #303d34;margin-top:18px;padding-top:17px}.u-plan strong{display:block;font-size:12px;color:#c5d8c9;margin-bottom:5px}.u-plan p{font-size:11px;margin:0}.u-detail-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin-bottom:20px}.u-metrics{padding:0 24px 15px}.u-metric{display:flex;align-items:baseline;justify-content:space-between;padding:12px 0;gap:15px;font-size:12px;color:#aebbb1;border-top:1px solid #29382e}.u-metric strong{font:19px ui-monospace,monospace;color:#e0eade}.u-metric small{color:#859b8c;font-size:10px}.u-meter{height:6px;width:100%;display:block;margin:3px 0 13px}.u-mini-note{color:#93a697;font-size:11px;line-height:1.6;margin:0}.u-split{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px}.u-scroll{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left;font-size:12px;white-space:nowrap}thead{background:#19241d;color:#99ad9f;font-size:10px;text-transform:uppercase;letter-spacing:.7px}th,td{padding:13px 20px;border-top:1px solid #2a3830}th{font-weight:500}tbody td{font-family:ui-monospace,monospace;color:#b5c2b7;font-size:11px}tbody th{color:#d6e2d4;font-size:12px;max-width:300px;overflow-wrap:anywhere;white-space:normal}tbody tr:hover{background:#1b2820}.u-spark{display:block;width:95px;height:4px;margin-top:10px}.u-slash{color:#627568}.u-empty{padding:36px 24px;font-size:14px;color:#cad6c8;line-height:1.8}.u-empty span{font-size:12px;color:#91a293}.u-notice{border:1px solid #4c4630;background:#252419;border-radius:8px;padding:13px 18px;margin-bottom:20px;color:#c3b58e;font-size:11px;line-height:1.7}.u-notice strong{color:#e1d1a5;font-weight:500}.u-method{margin-top:20px}.u-method summary{font-size:12px;color:#b0c2b3}.u-method .u-method-grid{padding:4px 24px 24px;display:grid;grid-template-columns:repeat(3,1fr);gap:24px}.u-method h3{font-size:12px;color:#d4e0d1}.u-method p{font-size:11px;color:#99aa9d}.u-footer-note{color:#7f9886;font:10px ui-monospace,monospace;margin-top:20px;letter-spacing:.3px}.u-pending{color:#ebc887}.u-record-time{font-size:10px;color:#a2b4a6}.u-table-caption{padding:0 24px 18px;font-size:11px;color:#8ea192}.u-chart-empty{padding:0 24px 12px;color:#b2c5b6;font-size:12px}
    .u-records .u-scroll{max-height:460px}.u-records thead{position:sticky;top:0;z-index:1}.u-records .u-table-caption{padding-top:16px;border-top:1px solid #2a3830}
    @media(min-width:1400px){main{padding-top:38px}}@media(max-width:1050px){.u-kpi{padding:18px}.u-kpi .value{font-size:34px}.u-main{grid-template-columns:minmax(0,1.7fr) minmax(260px,1fr)}.u-split{grid-template-columns:1fr}.u-panel header{padding:19px}.u-metrics{padding:0 19px 15px}.u-detail-grid{gap:14px}.u-metric strong{font-size:16px}}
    @media(max-width:760px){.page-heading h1{font-size:39px;letter-spacing:-1.2px}.u-kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.u-kpi .value{font-size:34px}.u-main,.u-detail-grid{grid-template-columns:1fr}.u-main{gap:14px}.u-toolbar{gap:20px}.u-filters{width:100%}.u-filters label:nth-child(2){flex:1;min-width:130px}.u-filters select{max-width:100%;width:100%}.u-chart{padding:0}.u-chart-note{padding:12px 19px}.u-method .u-method-grid{grid-template-columns:1fr;gap:18px}.u-chart-note{flex-wrap:wrap}.u-kpi .label{font-size:11px}.u-kpi .foot{font-size:10px}.u-records header{flex-wrap:wrap}}
  </style>
  <div class="u-toolbar"><div class="u-live">Private observatory · provider-reported usage</div><form class="u-filters" method="get"><label>Window<select name="days">${[1, 7, 30].map((days) => html`<option value="${days}"${days === snapshot.days ? html` selected` : ""}>${days === 1 ? "Last 24 hours" : `Last ${days} days`}</option>`)}</select></label><label>Model<select name="model"><option value="">All models</option>${snapshot.models.map((model) => html`<option value="${model}"${model === snapshot.model ? html` selected` : ""}>${model}</option>`)}</select></label><button type="submit">Apply ↗</button><a class="u-export" href="${base}/usage/export${query}">Export JSON ↓</a></form></div>
  <div class="u-kpis">
    <section class="u-kpi"><div class="label">Reported tokens <span class="u-icon">◈</span></div><div class="value">${compact(observed)}</div><div class="foot">${observed === null ? "Not yet reported" : `${number(observed)} observed · not a bill`}</div></section>
    <section class="u-kpi"><div class="label">Input tokens <span class="mint">↗</span></div><div class="value">${compact(total.input)}</div><div class="foot">${total.inputReports}/${total.calls} calls report input · includes cache</div></section>
    <section class="u-kpi"><div class="label">Output tokens <span class="violet">↙</span></div><div class="value">${compact(total.output)}</div><div class="foot">${total.outputReports}/${total.calls} calls report output · includes reasoning</div></section>
    <section class="u-kpi"><div class="label">Provider calls <span class="u-icon">⌁</span></div><div class="value">${number(total.calls)}</div><div class="foot">${number(total.failed ?? 0)} failed · ${number(total.pending ?? 0)} unresolved</div></section>
  </div>
  <div class="u-notice"><strong>Measured, not assumed.</strong> Instrumentation began ${date(snapshot.since)} UTC. Earlier usage and billing are unavailable, not zero. ${total.calls - (total.measured ?? 0)} selected calls lack a complete input/output report. ${snapshot.writeFailures ? `${snapshot.writeFailures} telemetry settlements failed in this process; affected calls remain unresolved.` : "Totals include only reported counters; gaps are not filled with estimates."}</div>
  <div class="u-main"><section class="u-panel"><header><div><h2>Consumption over time</h2><p>${snapshot.days === 1 ? "Hourly" : "Daily"} UTC buckets · rolling window · first and last buckets may be partial</p></div><div class="u-legend"><span><i class="u-dot"></i>Input</span><span><i class="u-dot output"></i>Output</span></div></header>${chart(snapshot)}${observed === null ? html`<div class="u-chart-empty">Waiting for measured usage. No synthetic history, no assumed zeroes.</div>` : ""}<div class="u-chart-note"><span>${date(snapshot.from)} → ${date(snapshot.now)} UTC</span><span>${number(total.measured ?? 0)} fully measured calls</span></div></section>
  <aside class="u-panel"><header><h2>Spend & entitlement</h2><span class="u-index">NOT A BILL</span></header><div class="u-billing"><div class="price">Unavailable</div><p>No invoice or billing API is connected. Token activity does not establish a dollar charge.</p><div class="u-plan"><strong>◉ ChatGPT subscription <span class="mint">· ${subscription?.calls ?? 0} calls</span></strong><p>Codex uses the dedicated login. Subscription price, remaining quota, resets and overages are not reported here. Usage is not necessarily free or unlimited.</p></div><div class="u-plan"><strong>◈ API usage <span class="violet">· ${apiCalls} calls</span></strong><p>Provider-reported tokens only. Account discounts, service tiers, credits and taxes are unknown.</p></div><div class="u-plan"><strong>≈ Cost estimates · unavailable</strong><p>No verified rate card is configured. June will not substitute guessed API prices for subscription billing.</p></div></div></aside></div>
  <div class="u-detail-grid">
    <section class="u-panel"><header><div><h2>Cache intelligence</h2><p>A subset of input, never counted twice</p></div><span class="u-index">01</span></header><div class="u-metrics"><div class="u-metric"><span>Cache-read tokens</span><strong class="mint">${compact(total.cached)}</strong></div><div class="u-metric"><span>Cache-write tokens</span><strong>${compact(total.cacheWrite)}</strong></div><div class="u-metric"><span>Cache-read share</span><strong>${cacheComparable && total.input ? percent(total.cached ?? 0, total.input) : "—"}</strong></div><p class="u-mini-note">${total.cacheReports}/${total.calls} calls report cache reads. Share is shown only when every selected call reports both input and cache. Missing details are not zero.</p></div></section>
    <section class="u-panel"><header><div><h2>Reasoning & latency</h2><p>Host wall time, not generation speed</p></div><span class="u-index">02</span></header><div class="u-metrics"><div class="u-metric"><span>Reasoning tokens <small>⊂ output</small></span><strong>${compact(total.reasoning)}</strong></div><div class="u-metric"><span>Median / p95 time</span><strong>${duration(snapshot.p50)} / ${duration(snapshot.p95)}</strong></div><div class="u-metric"><span>Mean call time</span><strong>${duration(total.duration)}</strong></div><p class="u-mini-note">${total.reasoningReports}/${total.calls} calls report reasoning separately. Timings include setup, transport and cleanup; failed settled calls are included.</p></div></section>
    <section class="u-panel"><header><div><h2>Measurement coverage</h2><p>Visibility is a metric, too</p></div><span class="u-index">03</span></header><div class="u-metrics"><div class="u-metric"><span>Input + output available</span><strong>${percent(total.measured ?? 0, total.calls)}</strong></div><svg class="u-meter" viewBox="0 0 300 6" preserveAspectRatio="none" role="img" aria-label="${total.measured ?? 0} of ${total.calls} calls have input and output counts"><rect width="300" height="6" rx="3" fill="#303c31"/><rect width="${(300 * (total.measured ?? 0)) / Math.max(1, total.calls)}" height="6" rx="3" fill="#b9d79f"/></svg><div class="u-metric"><span>Missing full usage</span><strong>${number(total.calls - (total.measured ?? 0))}</strong></div><div class="u-metric"><span>Unresolved attempts</span><strong>${number(total.pending ?? 0)}</strong></div><p class="u-mini-note">Unresolved means still running or interrupted before settlement. A failed call may consume tokens. Never retry based on this page.</p></div></section>
  </div>
  <div class="u-split">${breakdown("Model attribution", "Configured model IDs · click to isolate a model", snapshot.byModel, `${base}/usage?days=${snapshot.days}`)}${breakdown("Where the work happens", "Fast → deep → synthesis, with extraction and reflection separated", snapshot.byStage)}</div>
  <section class="u-panel u-records"><header><div><h2>Request ledger</h2><p>Latest 100 attempts in this selection · counters are provider-reported · — means unavailable</p></div>${badge("private")}</header><div class="u-scroll"><table><thead><tr><th scope="col">Started · UTC</th><th scope="col">Model / access</th><th scope="col">Stage</th><th scope="col">Input</th><th scope="col">Cached</th><th scope="col">Output</th><th scope="col">Reasoning</th><th scope="col">Time</th><th scope="col">Outcome</th></tr></thead><tbody>${snapshot.recent.map((row) => html`<tr><td><time class="u-record-time" datetime="${new Date(row.started).toISOString()}">${date(row.started)}</time></td><th scope="row">${row.model}<p class="small">${row.provider === "codex" ? "ChatGPT subscription" : `${row.provider} API`}</p></th><td>${row.stage}</td><td class="mint">${number(row.input)}</td><td>${number(row.cached)}</td><td class="violet">${number(row.output)}</td><td>${number(row.reasoning)}</td><td>${duration(row.duration)}</td><td>${badge(row.status === "pending" ? "unknown" : row.status)}</td></tr>`)}</tbody></table>${snapshot.recent.length ? "" : html`<div class="u-empty">Your first measured call starts the story.<br><span>Usage appears here after June calls a configured model. This page never starts a call.</span></div>`}</div><div class="u-table-caption">Outcomes describe the instrumented provider operation, not message delivery. No prompts, messages, credentials, user IDs or conversation identifiers are recorded.</div></section>
  <details class="u-panel u-method"><summary>How to read these numbers · methodology & boundaries</summary><div class="u-method-grid"><div><h3>Provider reports, not tokenizer guesses</h3><p>Codex turn.completed, OpenAI Responses usage, and Anthropic Messages usage feed an independent durable ledger. Anthropic input requires both cache fields to produce a normalized total. Reasoning and cache remain subsets, not extra tokens. Codex all-zero fallback reports are unavailable; individual zero detail counters can still be provider defaults.</p></div><div><h3>Honest gaps & forward-only history</h3><p>Only new instrumented invocations are recorded. Replayed conversations do not create usage. There is no backfill, invoice reconciliation or proof of continuous host availability. Unknown counters and interrupted attempts stay unknown.</p></div><div><h3>Private by construction</h3><p>The ledger stores random attempt IDs, configured model/provider names, stages, times, outcomes and token counts. Native coding workers, external observer services and non-model tools are outside this ledger. Exports use the same owner authentication.</p></div></div></details>
  <div class="u-footer-note">OBSERVED ${date(snapshot.now)} UTC · SERVER-RENDERED · NO THIRD-PARTY TRACKING · REFRESH TO UPDATE</div>`,
    {
      description:
        "Every token has a story. Understand the work, the reuse, and what is still unknown.",
      navigation: [
        { label: "Overview", href: base || "/" },
        { label: "Token intelligence", href: `${base}/usage`, current: true },
      ],
    },
  );
}
