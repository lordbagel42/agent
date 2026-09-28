import { html } from "hono/html";
import type { UsageGroup, UsageSnapshot } from "../models/usage.js";
import { badge, consoleNavigation, page } from "./view.js";

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

// Data colors only; they never carry meaning without a text label.
const input = "#8cdbc2";
const output = "#b5a0ee";

function breakdown(
  title: string,
  subtitle: string,
  groups: UsageGroup[],
  modelLinks?: string,
) {
  const most = Math.max(1, ...groups.map((group) => group.calls));
  return html`<section class="panel" aria-label="${title}"><header class="panel-head"><h2>${title}</h2><p class="hint">${subtitle}</p></header><div class="table-wrap"><table><thead><tr><th scope="col">${modelLinks ? "Model" : "Stage"}</th><th scope="col" class="num">Calls</th><th scope="col" class="num">Input / output</th><th scope="col" class="num">Measured</th><th scope="col" class="num">Avg time</th></tr></thead><tbody>${groups.map((group) => html`<tr><th scope="row">${modelLinks ? html`<a href="${modelLinks}&model=${encodeURIComponent(group.label)}">${group.label}</a>` : group.label}<svg class="spark" viewBox="0 0 120 4" aria-hidden="true"><rect width="120" height="4" rx="2" fill="#2c3533"/><rect width="${(120 * group.calls) / most}" height="4" rx="2" fill="${input}"/></svg></th><td class="num">${number(group.calls)}</td><td class="num">${compact(group.input)} / ${compact(group.output)}</td><td class="num">${group.measured}/${group.calls}</td><td class="num">${duration(group.duration)}</td></tr>`)}</tbody></table>${groups.length ? "" : html`<p class="empty">No recorded calls in this selection. No activity is inferred from older conversations.</p>`}</div></section>`;
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
  return html`<svg class="chart" viewBox="0 0 760 252" role="img" aria-labelledby="chart-title chart-description"><title id="chart-title">Reported input and output tokens over time</title><desc id="chart-description">${snapshot.days === 1 ? "Hourly" : "Daily"} UTC buckets, clipped to the selected rolling window. Empty slots mean no recorded usage, not zero spend. Input includes cache reads; output includes reasoning. Missing counters are omitted. Exact totals and recent calls are available below and in the JSON export.</desc>${[0, 1, 2, 3].map((i) => html`<line x1="65" x2="740" y1="${30 + i * 58}" y2="${30 + i * 58}" stroke="#2c2c2c" stroke-dasharray="3 5"/><text x="50" y="${34 + i * 58}" text-anchor="end" fill="#a3a3a3" font-size="11">${tokens(snapshot.total) === null ? "—" : compact((max * (3 - i)) / 3)}</text>`)}${buckets.map(
    ({ start, group }, i) => {
      const inputHeight = (174 * (group?.input ?? 0)) / max;
      const outputHeight = (174 * (group?.output ?? 0)) / max;
      return html`<g><title>${date(start)} UTC · ${group ? `${number(group.input)} input / ${number(group.output)} output · ${group.measured}/${group.calls} fully measured calls` : start + step <= snapshot.since ? "Before instrumentation; unknown" : "No recorded calls"}</title>${group && tokens(group) !== null ? html`<rect x="${70 + i * width}" y="${204 - inputHeight}" width="${Math.max(2, width - 7)}" height="${inputHeight}" fill="${input}" rx="2"/><rect x="${70 + i * width}" y="${204 - inputHeight - outputHeight}" width="${Math.max(2, width - 7)}" height="${outputHeight}" fill="${output}" rx="2"/>` : html`<circle cx="${70 + i * width + width / 2 - 3}" cy="204" r="2" fill="#5a5a5a"/>`}${i % Math.max(1, Math.floor(buckets.length / 5)) === 0 ? html`<text x="${70 + i * width}" y="234" fill="#a3a3a3" font-size="11">${snapshot.days === 1 ? new Date(start).toISOString().slice(11, 16) : new Date(start).toISOString().slice(5, 10)}</text>` : ""}</g>`;
    },
  )}</svg>`;
}

export function usagePage(
  snapshot: UsageSnapshot,
  nonce: string,
  base: string,
  options: { connectionsAvailable?: boolean; signOut?: string } = {},
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
  const metric = (label: string, value: string, note?: string) =>
    html`<div class="metric"><dt>${label}</dt><dd>${value}</dd>${note ? html`<dd class="hint">${note}</dd>` : ""}</div>`;
  return page(
    "Usage",
    nonce,
    html`<style nonce="${nonce}">
  .filters{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px}.filters label{display:grid;gap:4px;color:var(--text-muted);font-size:12px}.filters select{width:auto;min-width:150px;max-width:240px}
  .kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0}.kpi{min-width:0;margin:0;padding:16px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius)}.kpi dt{color:var(--text-secondary);font-size:12px}.kpi dd{margin:0}.kpi .value{margin:8px 0 4px;font-size:28px;font-weight:600;line-height:1.2;letter-spacing:-.02em;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.kpi .hint{overflow-wrap:anywhere}
  .panel{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}.panel-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 16px;padding:14px 16px}.panel-body{padding:0 16px 16px}.panel-foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 16px;padding:10px 16px;border-top:1px solid var(--line);color:var(--text-muted);font-size:12px}
  .usage-main{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:16px}.usage-three{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.chart-wrap{overflow-x:auto}.chart{display:block;width:100%;height:auto;padding:0 8px}.legend{display:flex;gap:14px;color:var(--text-secondary);font-size:12px}.legend i{display:inline-block;width:8px;height:8px;margin-right:6px;border-radius:2px;background:${input}}.legend i.output{background:${output}}
  .metrics{margin:0}.metric{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:2px 12px;padding:10px 0;border-top:1px solid var(--line)}.metric:first-child{border-top:0;padding-top:0}.metric dt{color:var(--text-secondary);font-size:13px}.metric dd{margin:0;font-family:var(--mono);font-size:15px;font-variant-numeric:tabular-nums}.metric dd.hint{flex-basis:100%;font-family:var(--font);font-size:12px}.meter{display:block;width:100%;height:6px;margin:4px 0 8px}
  .plan{padding-top:12px;margin-top:12px;border-top:1px solid var(--line)}.plan h3{font-size:13px}.plan p{margin-top:4px;color:var(--text-secondary);font-size:12px}.price{margin:0 0 6px;color:var(--warn);font-size:22px;font-weight:600}
  .spark{display:block;width:96px;height:4px;margin-top:8px}.ledger .table-wrap{max-height:480px}.ledger thead{position:sticky;top:0;z-index:1}.ledger tbody th{white-space:normal;min-width:180px}.ledger tbody th p{color:var(--text-muted);font-size:12px;font-weight:400}.method{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}.method p{margin-top:4px;color:var(--text-secondary);font-size:12px}
  @media (max-width:960px){.usage-main,.usage-three{grid-template-columns:1fr}.method{grid-template-columns:1fr}}@media (max-width:720px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi .value{font-size:22px}.filters{width:100%}.filters label{flex:1;min-width:130px}.filters select{width:100%;max-width:none}.chart{min-width:620px;padding:0}}
</style><dl class="kpis"><div class="kpi"><dt>Reported tokens</dt><dd class="value">${compact(observed)}</dd><dd class="hint">${observed === null ? "Not yet reported" : `${number(observed)} observed · not a bill`}</dd></div><div class="kpi"><dt>Input tokens</dt><dd class="value">${compact(total.input)}</dd><dd class="hint">${total.inputReports}/${total.calls} calls report input · includes cache</dd></div><div class="kpi"><dt>Output tokens</dt><dd class="value">${compact(total.output)}</dd><dd class="hint">${total.outputReports}/${total.calls} calls report output · includes reasoning</dd></div><div class="kpi"><dt>Provider calls</dt><dd class="value">${number(total.calls)}</dd><dd class="hint">${number(total.failed ?? 0)} failed · ${number(total.pending ?? 0)} unresolved</dd></div></dl>
  <div class="section notice" data-tone="warn"><strong>Measured, not assumed</strong><p>Instrumentation began ${date(snapshot.since)} UTC. Earlier usage and billing are unavailable, not zero. ${total.calls - (total.measured ?? 0)} selected calls lack a complete input/output report. ${snapshot.writeFailures ? `${snapshot.writeFailures} telemetry settlements failed in this process; affected calls remain unresolved.` : "Totals include only reported counters; gaps are not filled with estimates."}</p></div>
  <div class="section usage-main"><section class="panel" aria-labelledby="timeline"><header class="panel-head"><div><h2 id="timeline">Consumption over time</h2><p class="hint">${snapshot.days === 1 ? "Hourly" : "Daily"} UTC buckets · rolling window · first and last buckets may be partial</p></div><div class="legend"><span><i></i>Input</span><span><i class="output"></i>Output</span></div></header><div class="chart-wrap">${chart(snapshot)}</div>${observed === null ? html`<p class="empty">Waiting for measured usage. No synthetic history and no assumed zeroes.</p>` : ""}<div class="panel-foot"><span>${date(snapshot.from)} → ${date(snapshot.now)} UTC</span><span>${number(total.measured ?? 0)} fully measured calls</span></div></section>
  <section class="panel" aria-labelledby="spend"><header class="panel-head"><h2 id="spend">Spend and entitlement</h2>${badge("Not a bill")}</header><div class="panel-body"><p class="price">Unavailable</p><p class="hint">No invoice or billing API is connected. Token activity does not establish a dollar charge.</p><div class="plan"><h3>ChatGPT subscription · ${subscription?.calls ?? 0} calls</h3><p>Codex uses the dedicated login. Subscription price, remaining quota, resets and overages are not reported here. Usage is not necessarily free or unlimited.</p></div><div class="plan"><h3>API usage · ${apiCalls} calls</h3><p>Provider-reported tokens only. Account discounts, service tiers, credits and taxes are unknown.</p></div><div class="plan"><h3>Cost estimates · unavailable</h3><p>No verified rate card is configured. June will not substitute guessed API prices for subscription billing.</p></div></div></section></div>
  <div class="section usage-three"><section class="panel" aria-labelledby="cache"><header class="panel-head"><div><h2 id="cache">Cache</h2><p class="hint">A subset of input, never counted twice</p></div></header><div class="panel-body"><dl class="metrics">${metric("Cache-read tokens", compact(total.cached))}${metric("Cache-write tokens", compact(total.cacheWrite))}${metric("Cache-read share", cacheComparable && total.input ? percent(total.cached ?? 0, total.input) : "—", `${total.cacheReports}/${total.calls} calls report cache reads. Share appears only when every selected call reports both input and cache. Missing details are not zero.`)}</dl></div></section>
  <section class="panel" aria-labelledby="latency"><header class="panel-head"><div><h2 id="latency">Reasoning and latency</h2><p class="hint">Host wall time, not generation speed</p></div></header><div class="panel-body"><dl class="metrics">${metric("Reasoning tokens (part of output)", compact(total.reasoning))}${metric("Median / p95 time", `${duration(snapshot.p50)} / ${duration(snapshot.p95)}`)}${metric("Mean call time", duration(total.duration), `${total.reasoningReports}/${total.calls} calls report reasoning separately. Timings include setup, transport and cleanup; failed settled calls are included.`)}</dl></div></section>
  <section class="panel" aria-labelledby="coverage"><header class="panel-head"><div><h2 id="coverage">Measurement coverage</h2><p class="hint">How much of the selection is visible</p></div></header><div class="panel-body"><dl class="metrics">${metric("Input and output available", percent(total.measured ?? 0, total.calls))}</dl><svg class="meter" viewBox="0 0 300 6" preserveAspectRatio="none" role="img" aria-label="${total.measured ?? 0} of ${total.calls} calls have input and output counts"><rect width="300" height="6" rx="3" fill="#303630"/><rect width="${(300 * (total.measured ?? 0)) / Math.max(1, total.calls)}" height="6" rx="3" fill="#b9d79f"/></svg><dl class="metrics">${metric("Missing full usage", number(total.calls - (total.measured ?? 0)))}${metric("Unresolved attempts", number(total.pending ?? 0), "Unresolved means still running or interrupted before settlement. A failed call may consume tokens. Never retry based on this page.")}</dl></div></section></div>
  <div class="section grid-2">${breakdown("Models", "Configured model IDs · select one to filter", snapshot.byModel, `${base}/usage?days=${snapshot.days}`)}${breakdown("Stages", "Fast, deep and synthesis, with extraction and reflection separated", snapshot.byStage)}</div>
  <section class="section panel ledger" aria-labelledby="ledger"><header class="panel-head"><div><h2 id="ledger">Request ledger</h2><p class="hint">Latest 100 attempts in this selection · provider-reported counters · — means unavailable</p></div></header><div class="table-wrap"><table><thead><tr><th scope="col">Started (UTC)</th><th scope="col">Model / access</th><th scope="col">Stage</th><th scope="col" class="num">Input</th><th scope="col" class="num">Cached</th><th scope="col" class="num">Output</th><th scope="col" class="num">Reasoning</th><th scope="col" class="num">Time</th><th scope="col">Outcome</th></tr></thead><tbody>${snapshot.recent.map((row) => html`<tr><td><time datetime="${new Date(row.started).toISOString()}">${date(row.started)}</time></td><th scope="row">${row.model}<p>${row.provider === "codex" ? "ChatGPT subscription" : `${row.provider} API`}</p></th><td>${row.stage}</td><td class="num">${number(row.input)}</td><td class="num">${number(row.cached)}</td><td class="num">${number(row.output)}</td><td class="num">${number(row.reasoning)}</td><td class="num">${duration(row.duration)}</td><td>${badge(row.status === "pending" ? "unknown" : row.status)}</td></tr>`)}</tbody></table>${snapshot.recent.length ? "" : html`<p class="empty">No measured calls yet. Usage appears here after June calls a configured model; this page never starts a call.</p>`}</div><div class="panel-foot">Outcomes describe the instrumented provider operation, not message delivery. No prompts, messages, credentials, user IDs or conversation identifiers are recorded.</div></section>
  <details class="section disclosure"><summary>How to read these numbers</summary><div class="disclosure-body method"><div><h3>Provider reports, not tokenizer guesses</h3><p>Codex turn.completed, OpenAI Responses usage, and Anthropic Messages usage feed an independent durable ledger. Anthropic input requires both cache fields to produce a normalized total. Reasoning and cache remain subsets, not extra tokens. Codex all-zero fallback reports are unavailable; individual zero detail counters can still be provider defaults.</p></div><div><h3>Honest gaps and forward-only history</h3><p>Only new instrumented invocations are recorded. Replayed conversations do not create usage. There is no backfill, invoice reconciliation or proof of continuous host availability. Unknown counters and interrupted attempts stay unknown.</p></div><div><h3>Private by construction</h3><p>The ledger stores random attempt IDs, configured model/provider names, stages, times, outcomes and token counts. Native coding workers, external observer services and non-model tools are outside this ledger. Exports use the same owner authentication.</p></div></div></details>
  <p class="section hint">Observed ${date(snapshot.now)} UTC. Refresh to update.</p>`,
    {
      description:
        "Provider-reported tokens for June's model calls. Missing counters stay unknown, never zero.",
      actions: html`<form class="filters" method="get"><label>Window<select name="days">${[1, 7, 30].map((days) => html`<option value="${days}"${days === snapshot.days ? html` selected` : ""}>${days === 1 ? "Last 24 hours" : `Last ${days} days`}</option>`)}</select></label><label>Model<select name="model"><option value="">All models</option>${snapshot.models.map((model) => html`<option value="${model}"${model === snapshot.model ? html` selected` : ""}>${model}</option>`)}</select></label><button type="submit" class="secondary">Apply</button><a class="button secondary" href="${base}/usage/export${query}">Export JSON</a></form>`,
      navigation: consoleNavigation(
        base,
        "usage",
        options.connectionsAvailable,
      ),
      signOut: options.signOut,
    },
  );
}
