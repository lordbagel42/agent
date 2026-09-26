import { html } from "hono/html";

export function page(
  title: string,
  nonce: string,
  body: ReturnType<typeof html>,
  options: {
    description?: string;
    narrow?: boolean;
    navigation?: { label: string; href: string; current?: boolean }[];
  } = {},
) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title} · June</title>
  <style nonce="${nonce}">
    :root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fafafa;color:#171717;font-size:14px;line-height:1.5;font-synthesis:none}
    *{box-sizing:border-box}body{margin:0}a{color:inherit;text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:3px}button,input{font:inherit}button,a,input,summary{-webkit-tap-highlight-color:transparent}:focus-visible{outline:2px solid #0070f3;outline-offset:4px}
    .topbar{background:#fff;border-bottom:1px solid #eaeaea}.topbar-inner{max-width:1248px;margin:auto;padding:0 32px;min-height:64px;display:flex;align-items:center;gap:16px}.brand{display:flex;align-items:center;gap:10px;font-weight:650;font-size:18px;letter-spacing:-.5px}.mark{display:grid;place-items:center;background:#171717;color:white;width:28px;height:28px;border-radius:6px;font-size:16px}.slash{font-size:23px;color:#d4d4d4;font-weight:300}.workspace-name{font-weight:500}.private-label{margin-left:auto;display:flex;align-items:center;gap:6px;color:#666;font-size:12px}.private-label svg{width:13px;height:13px}
    .tabs{background:#fff;border-bottom:1px solid #eaeaea}.tabs-inner{display:flex;gap:24px;overflow-x:auto;max-width:1248px;margin:auto;padding:0 32px;scrollbar-width:thin}.tabs a{display:block;white-space:nowrap;padding:15px 0 13px;border-bottom:2px solid transparent;color:#666;font-size:13px}.tabs a[aria-current]{color:#171717;border-color:#171717;font-weight:500}.tabs a:hover{color:#171717;text-decoration:none}
    main{max-width:1248px;margin:auto;padding:34px 32px 64px;min-height:calc(100vh - 172px)}main.narrow{max-width:520px;padding-top:64px}.page-heading{margin-bottom:26px}h1{font-size:26px;line-height:1.3;letter-spacing:-.8px;font-weight:600;margin:0 0 7px}h2{font-size:14px;font-weight:600;line-height:1.5;margin:0}h3{font-size:14px;font-weight:500;margin:0}p{margin:6px 0 0;color:#666;line-height:1.65;overflow-wrap:anywhere}.description{max-width:760px}.muted{color:#737373}.small{font-size:12px}.mono,code,pre,time{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}.mono,code{font-size:12px;overflow-wrap:anywhere}
    .summary-bar{display:grid;grid-template-columns:2fr 1fr 1fr;border:1px solid #e5e5e5;border-radius:8px;background:#fff;margin-bottom:28px}.summary-bar>div{padding:16px 20px;min-width:0}.summary-bar>div+div{border-left:1px solid #eaeaea}.eyebrow{display:block;color:#737373;font-size:12px;margin-bottom:5px}.summary-bar p{margin:0;color:#262626;font-size:13px}.summary-bar time{font-size:12px}
    .section-heading{display:flex;align-items:center;justify-content:space-between;margin:0 0 12px}.section-heading h2{font-size:16px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;align-items:start}.panel{background:#fff;border:1px solid #e5e5e5;border-radius:8px;min-width:0;overflow:hidden;scroll-margin-top:24px}.panel-heading{padding:18px 20px;border-bottom:1px solid #eee;display:flex;gap:14px;align-items:center;justify-content:space-between}.panel-heading h2{font-size:14px}.panel-body{padding:20px}.panel-description{padding:14px 20px;border-bottom:1px solid #eee;background:#fdfdfd}.panel-description p{margin:0;font-size:12px}.empty{padding:20px;color:#737373;font-size:13px;display:flex;align-items:flex-start;gap:10px}.empty-mark{font-family:ui-monospace,monospace;color:#a3a3a3}.record{padding:16px 20px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:start}.record+.record{border-top:1px solid #eee}.record p{font-size:12px;margin-top:5px}.record-action{font-size:12px;font-weight:500;display:inline-flex;gap:5px;margin-top:10px}.record h3{overflow-wrap:anywhere}.record>.status{margin-top:1px}
    .status{display:inline-flex;align-items:center;gap:6px;border:1px solid #e5e5e5;border-radius:999px;padding:2px 8px;color:#666;background:#fafafa;font-size:11px;font-weight:500;line-height:18px;max-width:100%;overflow-wrap:anywhere}.status::before{content:"";height:5px;width:5px;border-radius:50%;background:currentColor;flex-shrink:0}.status[data-status=available],.status[data-status=succeeded],.status[data-status=active]{color:#147a47;border-color:#ccebd9;background:#f0faf4}.status[data-status=unknown],.status[data-status=awaiting-review],.status[data-status=ready]{color:#966315;border-color:#f2dfb5;background:#fffaf0}.status[data-status=failed],.status[data-status=rejected]{color:#b42318;border-color:#f3d2cf;background:#fff5f4}
    .review-grid{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(290px,1fr);gap:24px;align-items:start}.stack{display:grid;gap:20px}.metadata{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin:0}.metadata>div{min-width:0;padding:16px 20px;border-bottom:1px solid #eee}.metadata>div:nth-child(odd){border-right:1px solid #eee}.metadata dt{color:#737373;font-size:12px;margin-bottom:6px;text-transform:capitalize}.metadata dd{margin:0;font-size:13px;overflow-wrap:anywhere}.metadata>div:last-child{border-bottom:0}.metadata>div:nth-last-child(2):nth-child(odd){border-bottom:0}
    details summary{padding:17px 20px;cursor:pointer;font-size:13px;font-weight:500;list-style-position:inside}.format{float:right;color:#737373;font:11px ui-monospace,monospace;font-weight:400}pre{margin:0;background:#fafafa;border-top:1px solid #eee;padding:20px;font-size:12px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;color:#404040}.callout{border:1px solid #e5e5e5;border-radius:6px;background:#fafafa;padding:14px 16px;font-size:13px}.callout p{font-size:12px;margin-top:4px}.callout.warning{border-color:#f2dfb5;background:#fffcf5}.callout.warning strong{color:#8c601b}.callout.danger{border-color:#f3d2cf;background:#fff8f7}.callout.danger strong{color:#b42318}.panel-body>.callout+*{margin-top:20px}
    .confirm-form{padding:0;margin:0}.consent{display:flex;align-items:flex-start;gap:10px;margin:20px 0;cursor:pointer;font-size:13px;line-height:1.6}.consent input{width:16px;height:16px;margin:3px 0 0;accent-color:#171717;flex-shrink:0}.consent small{display:block;color:#737373;margin-top:4px;font-size:12px}.button,button{display:inline-flex;justify-content:center;align-items:center;gap:8px;padding:9px 14px;min-height:38px;border:1px solid #171717;border-radius:6px;background:#171717;color:#fff;font-weight:500;font-size:13px;cursor:pointer;line-height:1.4}.button:hover,button:hover{background:#383838;text-decoration:none}.button.secondary{background:#fff;border-color:#ddd;color:#171717}.button.secondary:hover{background:#fafafa}.full{width:100%}button:disabled{background:#f2f2f2;border-color:#e5e5e5;color:#a3a3a3;cursor:not-allowed}.confirm-form .confirm-enabled{display:none}.confirm-form:has(input[name=confirmed]:checked) .confirm-disabled{display:none}.confirm-form:has(input[name=confirmed]:checked) .confirm-enabled{display:inline-flex}.hint{font-size:12px;color:#737373;margin-top:12px}.field{display:block;font-size:13px;font-weight:500;margin:22px 0 8px}input[type=password]{display:block;width:100%;border:1px solid #d4d4d4;border-radius:6px;padding:10px 12px;background:#fff;min-height:40px;margin-bottom:18px}.login-note{border-top:1px solid #eee;padding:16px 20px;background:#fafafa;font-size:12px;color:#737373}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}.receipt{max-width:720px}.receipt .panel-body{padding:24px}.receipt h2{font-size:18px;margin:16px 0 8px;letter-spacing:-.3px}.receipt-meta{margin-top:22px;padding-top:18px;border-top:1px solid #eee}.error-code{font:12px ui-monospace,monospace;color:#737373;margin-bottom:20px}
    .footer{border-top:1px solid #eaeaea;background:#fff}.footer-inner{max-width:1248px;margin:auto;padding:20px 32px;display:flex;justify-content:space-between;gap:20px;color:#737373;font-size:12px}.footer strong{font-weight:500;color:#666}
    @media(max-width:760px){.topbar-inner{padding:0 20px;min-height:58px;gap:12px}.private-label{font-size:11px}.tabs-inner{padding:0 20px;gap:22px}main{padding:26px 20px 44px}main.narrow{padding-top:36px}.grid,.review-grid{grid-template-columns:1fr}.summary-bar{grid-template-columns:1fr 1fr}.summary-bar>div:first-child{grid-column:1/-1;border-bottom:1px solid #eee}.summary-bar>div:nth-child(2){border-left:0}.summary-bar>div{padding:14px 16px}.panel-heading,.panel-body{padding:17px}.panel-description,.record{padding:14px 17px}.metadata>div{padding:15px 17px}pre{padding:17px;font-size:12px}.footer-inner{padding:20px;flex-direction:column;gap:5px}h1{font-size:24px}.workspace-name{font-size:13px}.record{gap:10px}.review-grid{gap:20px}}
    @media(max-width:400px){.private-label span{display:none}.metadata{grid-template-columns:1fr}.metadata>div:nth-child(odd){border-right:0}.metadata>div:nth-last-child(2):nth-child(odd){border-bottom:1px solid #eee}}
  </style></head><body><header class="topbar"><div class="topbar-inner"><div class="brand"><span class="mark" aria-hidden="true">J</span>June</div><span class="slash" aria-hidden="true">/</span><span class="workspace-name">Private workspace</span><span class="private-label"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5"/><path d="M5.5 7V4a2.5 2.5 0 0 1 5 0v3"/></svg><span>Owner access</span></span></div></header>${options.navigation?.length ? html`<nav class="tabs" aria-label="Workspace"><div class="tabs-inner">${options.navigation.map((item) => html`<a href="${item.href}"${item.current ? html` aria-current="page"` : ""}>${item.label}</a>`)}</div></nav>` : ""}<main class="${options.narrow ? "narrow" : ""}"><div class="page-heading"><h1>${title}</h1>${options.description ? html`<p class="description">${options.description}</p>` : ""}</div>${body}</main><footer class="footer"><div class="footer-inner"><strong>June · Private workspace</strong><span>Viewing never approves or executes. No third-party assets.</span></div></footer></body></html>`;
}

export function badge(status: string) {
  return html`<span class="status" data-status="${status.toLowerCase().replaceAll(" ", "-")}">${status}</span>`;
}

export function metadata(facts: Record<string, string>) {
  return html`<dl class="metadata">${Object.entries(facts).map(([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`)}</dl>`;
}

export function confirmForm(proof: string, label: string) {
  return html`<form method="post" autocomplete="off" class="confirm-form"><input type="hidden" name="proof" value="${proof}"><label class="consent"><input type="checkbox" name="confirmed" value="yes" required><span>I have reviewed this exact action and authorize it.<small>Consent applies only to the details shown on this page.</small></span></label><button type="button" class="full confirm-disabled" disabled>${label}</button><button type="submit" class="full confirm-enabled">${label}</button><p class="hint">Your explicit consent is required to submit.</p></form>`;
}

export function messagePage(
  nonce: string,
  title: string,
  detail: string,
  code: number,
) {
  return page(
    title,
    nonce,
    html`<section class="panel"><div class="panel-body"><div class="error-code">HTTP ${code} / PRIVATE CONSOLE</div><div class="callout ${code >= 500 ? "warning" : "danger"}"><strong>${title}</strong><p>${detail}</p></div><p class="hint">No action has been confirmed by this response.</p></div></section>`,
    { narrow: true },
  );
}

export function outcomeDescription(status: string): string {
  switch (status) {
    case "succeeded":
      return "The host recorded confirmed success. This grant will not execute again.";
    case "failed":
      return "The owner reconciled this outcome as failed. This grant remains consumed and cannot be retried.";
    case "unknown":
      return "Outcome unknown. Do not retry. Reconcile external state before considering any new grant.";
    default:
      return "No outcome can be confirmed here.";
  }
}
