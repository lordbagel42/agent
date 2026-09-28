import { html, raw } from "hono/html";

export const consoleSections = [
  "configuration",
  "capabilities",
  "jobs",
  "memory",
  "reflection",
  "approvals",
  "revocations",
] as const;

export interface NavItem {
  label: string;
  href: string;
  current?: boolean;
}

/** Task navigation. Subsystem detail lives inside these pages, not in tabs. */
export function consoleNavigation(
  base: string,
  current: "overview" | "usage" | "connections" | undefined,
  connectionsAvailable = false,
): NavItem[] {
  return [
    { label: "Overview", href: base || "/", current: current === "overview" },
    ...(connectionsAvailable
      ? [
          {
            label: "Connections",
            href: `${base}/connections`,
            current: current === "connections",
          },
        ]
      : []),
    { label: "Usage", href: `${base}/usage`, current: current === "usage" },
  ];
}

// Values are defined once here; DESIGN.md documents the same tokens.
const styles = `
:root{color-scheme:dark;--bg:#111111;--surface:#181818;--surface-raised:#202020;--inset:#141414;--line:#2a2a2a;--line-strong:#3a3a3a;--control:#6b6b6b;--text:#ededed;--text-secondary:#b8b8b8;--text-muted:#a3a3a3;--on-accent:#151515;--focus:#9ac3ff;--ok:#86ceaa;--ok-bg:#15241c;--ok-line:#2c4d3b;--warn:#e3bd78;--warn-bg:#282116;--warn-line:#54442a;--danger:#eea09a;--danger-bg:#2a1c1b;--danger-line:#5a3532;--radius:8px;--radius-small:6px;--font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5;font-synthesis:none;-webkit-text-size-adjust:100%}
*,*::before,*::after{box-sizing:border-box}html{scrollbar-color:var(--control) transparent}body{margin:0;min-height:100vh;display:flex;flex-direction:column}::selection{background:color-mix(in srgb,var(--focus) 30%,transparent);color:var(--text)}p{margin:0}a{color:inherit;text-decoration-thickness:1px;text-underline-offset:3px}a:hover{color:#fff}button,input,select{font:inherit}input{caret-color:var(--focus)}:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
a.item:focus-visible{outline-offset:-3px}
h1,h2,h3{margin:0;font-weight:600;line-height:1.3;overflow-wrap:anywhere}h1{font-size:22px;letter-spacing:-.01em}h2{font-size:15px}h3{font-size:14px}code,pre,.mono{font-family:var(--mono);font-size:12.5px}code{overflow-wrap:anywhere}
.skip{position:absolute;left:16px;top:-60px;z-index:2;padding:8px 12px;border-radius:var(--radius-small);background:var(--text);color:var(--on-accent);font-weight:600;text-decoration:none}.skip:focus{top:12px}
.topbar{background:var(--surface);border-bottom:1px solid var(--line)}.topbar-inner{max-width:1120px;margin:0 auto;padding:0 24px;min-height:56px;display:flex;align-items:stretch;gap:28px}.brand{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:650;text-decoration:none}.brand-mark{display:grid;place-items:center;width:24px;height:24px;border-radius:6px;background:var(--text);color:var(--on-accent);font-size:13px;font-weight:700}
.nav{display:flex;gap:4px}.nav a{display:flex;align-items:center;padding:0 10px;margin-bottom:-1px;border-bottom:2px solid transparent;color:var(--text-secondary);font-weight:500;text-decoration:none}.nav a:hover{color:var(--text)}.nav a[aria-current=page]{color:var(--text);border-bottom-color:var(--text)}.nav a:focus-visible{outline-offset:-4px}
.account{margin-left:auto;display:flex;align-items:center;gap:16px;color:var(--text-muted);font-size:13px}.owner{display:inline-flex;align-items:center;gap:6px}.owner svg{width:13px;height:13px}.account a{color:var(--text-secondary)}
main{flex:1;width:100%;max-width:1120px;margin:0 auto;padding:32px 24px 64px}main:focus{outline:none}main.narrow{max-width:520px;padding-top:56px}
.page-header{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px 24px;margin-bottom:24px}.crumbs{margin-bottom:6px;color:var(--text-muted);font-size:13px}.crumbs a{color:var(--text-secondary);text-decoration:none}.crumbs a:hover{color:var(--text);text-decoration:underline}.title-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}.lede{margin-top:6px;max-width:70ch;color:var(--text-secondary)}.page-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.section{margin-top:32px}.section-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 16px;margin-bottom:10px}.section-note{color:var(--text-muted);font-size:12px}.section>.notice+.list,.section>.notice+.facts,.section>.list+.notice,.section>.facts+.list,.section>.list+.disclosure{margin-top:12px}.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;align-items:start}.grid-2>.section{margin-top:0}
.section-intro{margin:-4px 0 10px;max-width:75ch}.list{margin:0;padding:0;list-style:none;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}.list>*+*{border-top:1px solid var(--line)}.item{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:10px 20px;padding:14px 16px}.item-body{min-width:0}.item-body>p{margin-top:3px;color:var(--text-secondary);font-size:13px;overflow-wrap:anywhere}.item-meta{margin-top:4px;color:var(--text-muted);font-size:12px;overflow-wrap:anywhere}.item-side{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px 10px}.item-side form{margin:0}.item>.more,.item>.item-wide{grid-column:1/-1}a.item{color:inherit;text-decoration:none}a.item:hover{background:var(--surface-raised)}a.item:hover h3{text-decoration:underline}a.item .item-side::after{content:"";flex:none;width:7px;height:7px;margin:0 2px 0 4px;border-top:1.5px solid var(--text-muted);border-right:1.5px solid var(--text-muted);transform:rotate(45deg)}.empty{padding:16px;color:var(--text-muted);font-size:13px}
.status{font-family:var(--font);display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:1px 9px;border:1px solid var(--line-strong);border-radius:999px;background:#1e1e1e;color:var(--text-secondary);font-size:12px;font-weight:500;line-height:20px;white-space:nowrap}.status::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}.status[data-tone=ok]{border-color:var(--ok-line);background:var(--ok-bg);color:var(--ok)}.status[data-tone=warn]{border-color:var(--warn-line);background:var(--warn-bg);color:var(--warn)}.status[data-tone=danger]{border-color:var(--danger-line);background:var(--danger-bg);color:var(--danger)}
.notice{padding:12px 14px;border:1px solid var(--line-strong);border-radius:var(--radius-small);background:var(--surface);color:var(--text-secondary);font-size:13px}.notice strong{display:block;margin-bottom:2px;color:var(--text);font-weight:600}.notice p{max-width:75ch}.notice p+p{margin-top:6px}.notice .actions{margin-top:12px}.notice[data-tone=ok]{border-color:var(--ok-line);background:var(--ok-bg);color:var(--text)}.notice[data-tone=warn]{border-color:var(--warn-line);background:var(--warn-bg);color:var(--text)}.notice[data-tone=danger]{border-color:var(--danger-line);background:var(--danger-bg);color:var(--text)}.notice+.facts,.notice+.card,.card+.notice{margin-top:16px}
.button,button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;padding:7px 14px;border:1px solid var(--text);border-radius:var(--radius-small);background:var(--text);color:var(--on-accent);font-size:13px;font-weight:600;line-height:1.3;text-align:center;text-decoration:none;cursor:pointer;transition:background-color .12s,border-color .12s,color .12s}.button:hover,button:hover{border-color:#fff;background:#fff;color:#111}.button.secondary,button.secondary{border-color:var(--control);background:transparent;color:var(--text)}.button.secondary:hover,button.secondary:hover{border-color:var(--text-muted);background:var(--surface-raised);color:#fff}.button.danger,button.danger{border-color:var(--danger-line);background:transparent;color:var(--danger)}.button.danger:hover,button.danger:hover{border-color:var(--danger);background:var(--danger-bg);color:var(--danger)}button:disabled{border-color:var(--line-strong);background:var(--surface-raised);color:var(--text-muted);cursor:not-allowed}.actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:16px}.full{width:100%}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}.facts>div{min-width:0;margin:-1px 0 0 -1px;padding:12px 16px;border-top:1px solid var(--line);border-left:1px solid var(--line)}.facts dt{color:var(--text-muted);font-size:12px}.facts dd{margin:3px 0 0;overflow-wrap:anywhere}
.disclosure{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius)}.disclosure>summary,.more>summary{display:flex;align-items:center;gap:10px;cursor:pointer;list-style:none}.disclosure>summary{padding:12px 16px;font-weight:500}.disclosure>summary:hover{background:var(--surface-raised)}.more>summary{width:fit-content;color:var(--text-secondary);font-size:13px}.more>summary:hover{color:var(--text)}.disclosure>summary::-webkit-details-marker,.more>summary::-webkit-details-marker{display:none}.disclosure>summary::before,.more>summary::before{content:"";flex:none;width:6px;height:6px;margin:0 2px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .12s}.disclosure[open]>summary::before,.more[open]>summary::before{transform:rotate(45deg)}.disclosure-body{padding:14px 16px 16px;border-top:1px solid var(--line)}.disclosure>.list{border-width:1px 0 0;border-radius:0 0 var(--radius) var(--radius)}.more-body{margin-top:12px}.disclosure-body>*+*,.more-body>*+*{margin-top:12px}
pre{max-height:420px;margin:0;padding:12px 14px;overflow:auto;background:var(--inset);border:1px solid var(--line);border-radius:var(--radius-small);color:#c8c8c8;font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
.field{display:grid;gap:6px;margin-top:16px}.field:first-child{margin-top:0}.field>span:first-child,.field-label{font-size:13px;font-weight:500}.hint{color:var(--text-muted);font-size:12px}input:not([type=checkbox]):not([type=hidden]),select{width:100%;min-height:38px;padding:8px 11px;border:1px solid var(--control);border-radius:var(--radius-small);background:var(--inset);color:var(--text)}input:hover,select:hover{border-color:var(--text-muted)}input::placeholder{color:var(--text-muted);opacity:.8}input[aria-invalid=true]{border-color:var(--danger)}
.check{display:flex;align-items:flex-start;gap:10px;margin-top:14px;font-size:13px;cursor:pointer}.check input{flex:none;width:16px;height:16px;margin:2px 0 0;accent-color:var(--text)}.check small{display:block;margin-top:2px;color:var(--text-muted);font-size:12px}.confirm-form{margin:0}.confirm-form button[type=submit]{margin-top:14px}.confirm-form:has(input[name=confirmed]:not(:checked)) button[type=submit]{border-color:var(--line-strong);background:transparent;color:var(--text-secondary)}
.card{padding:20px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius)}.card>p{max-width:75ch}.card>*+*{margin-top:16px}.card+.card,.card+.disclosure{margin-top:16px}.status-code{margin-top:20px;color:var(--text-muted);font-size:12px}.working{display:flex;align-items:center;gap:10px;color:var(--text-secondary)}.working::before{content:"";flex:none;width:8px;height:8px;border-radius:50%;background:var(--text-muted);animation:pulse .9s ease-in-out infinite alternate}@keyframes pulse{from{opacity:.3}to{opacity:1}}
.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:10px 16px;border-top:1px solid var(--line);text-align:left;vertical-align:top}thead th{border-top:0;background:var(--inset);color:var(--text-muted);font-size:12px;font-weight:500;white-space:nowrap}tbody th{font-weight:500}tbody td{color:var(--text-secondary);font-family:var(--mono);font-size:12.5px;white-space:nowrap}.num{font-variant-numeric:tabular-nums;text-align:right}
.footer{border-top:1px solid var(--line)}.footer-inner{max-width:1120px;margin:0 auto;padding:16px 24px;color:var(--text-muted);font-size:12px}
@media (max-width:720px){.topbar-inner{flex-wrap:wrap;gap:0 12px;padding:0 16px}.brand{min-height:52px}.nav{order:3;width:calc(100% + 32px);margin:0 -16px;padding:0 8px;border-top:1px solid var(--line)}.nav a{flex:1;justify-content:center;min-height:44px;padding:0 6px}main{padding:24px 16px 48px}main.narrow{padding-top:32px}h1{font-size:20px}.grid-2{grid-template-columns:1fr;gap:32px}.item:has(.item-side form,.item-side .button){grid-template-columns:1fr}.item:has(.item-side form,.item-side .button) .item-side{justify-content:flex-start}.button,button{min-height:44px}.footer-inner{padding:16px}}
@media (max-width:400px){.owner{display:none}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

// Continues a marked form once the page is actually shown. Contains no values:
// the form carries its own signed proof. Prerendered and background documents
// wait; automated browsers keep the manual control for attended sign-in. The
// button is disabled once a submission starts so it cannot race a second POST.
const continueScript = `(()=>{const f=document.querySelector("form[data-continue]");if(!f)return;let sent=false;const disable=()=>{for(const b of f.querySelectorAll("button"))b.disabled=true};f.addEventListener("submit",e=>{if(sent){e.preventDefault();return}sent=true;setTimeout(disable)});if(f.hasAttribute("data-attended")&&navigator.webdriver)return;const go=()=>{if(sent||document.prerendering||document.visibilityState!=="visible")return;sent=true;disable();f.submit()};document.addEventListener("visibilitychange",go);document.addEventListener("prerenderingchange",go);go()})();`;

const lock = html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5"/><path d="M5.5 7V4a2.5 2.5 0 0 1 5 0v3"/></svg>`;

export interface PageOptions {
  description?: string;
  /** Single-task layout for sign-in, continuation and message pages. */
  narrow?: boolean;
  navigation?: NavItem[];
  /** Sign-out page for authenticated pages when the session bridge is mounted. */
  signOut?: string;
  crumbs?: { label: string; href: string }[];
  status?: ReturnType<typeof html>;
  actions?: ReturnType<typeof html>;
  /** Same-document navigation without script (Strict cookies need a document). */
  refresh?: string;
  /** Include the continuation script; the route must call allowNonceScript. */
  script?: boolean;
}

export function page(
  title: string,
  nonce: string,
  body: ReturnType<typeof html>,
  options: PageOptions = {},
) {
  const home = options.navigation?.[0]?.href;
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><meta name="referrer" content="no-referrer">${options.refresh ? html`<meta http-equiv="refresh" content="0; url='${options.refresh}'">` : ""}<title>${title} · June</title><style nonce="${nonce}">${raw(styles)}</style></head><body><a class="skip" href="#main">Skip to content</a><header class="topbar"><div class="topbar-inner">${home ? html`<a class="brand" href="${home}"><span class="brand-mark" aria-hidden="true">J</span>June</a>` : html`<span class="brand"><span class="brand-mark" aria-hidden="true">J</span>June</span>`}${options.navigation?.length ? html`<nav class="nav" aria-label="Primary">${options.navigation.map((item) => html`<a href="${item.href}"${item.current ? html` aria-current="page"` : ""}>${item.label}</a>`)}</nav>` : ""}${options.signOut ? html`<div class="account"><span class="owner">${lock}<span>Owner</span></span><a href="${options.signOut}">Sign out</a></div>` : ""}</div></header><main id="main" tabindex="-1"${options.narrow ? html` class="narrow"` : ""}><header class="page-header"><div>${options.crumbs?.length ? html`<nav class="crumbs" aria-label="Breadcrumb">${options.crumbs.map((crumb) => html`<a href="${crumb.href}">${crumb.label}</a> / `)}</nav>` : ""}<div class="title-row"><h1>${title}</h1>${options.status ?? ""}</div>${options.description ? html`<p class="lede">${options.description}</p>` : ""}</div>${options.actions ? html`<div class="page-actions">${options.actions}</div>` : ""}</header>${body}</main><footer class="footer"><div class="footer-inner">June · Private owner console. Viewing a page never approves or runs anything.</div></footer>${options.script ? html`<script nonce="${nonce}">${raw(continueScript)}</script>` : ""}</body></html>`;
}

type Tone = "ok" | "warn" | "danger" | "neutral";
const tones: Record<string, Tone> = {
  active: "ok",
  available: "ok",
  "authorization saved": "ok",
  connected: "ok",
  "reads allowed": "ok",
  succeeded: "ok",
  "tools discovered": "ok",
  "approval received": "warn",
  "authorization expired": "warn",
  "awaiting approval": "warn",
  "awaiting review": "warn",
  "discovery failed": "warn",
  "needs approval": "warn",
  "not tested": "warn",
  "outcome unknown": "warn",
  ready: "warn",
  unknown: "warn",
  failed: "danger",
  rejected: "danger",
};

/** Status text is authoritative; color only supplements it. */
export function badge(status: string, tone?: Tone) {
  const label = status.replaceAll("_", " ");
  return html`<span class="status" data-tone="${tone ?? tones[label.toLowerCase()] ?? "neutral"}">${label}</span>`;
}

export function metadata(facts: Record<string, string>) {
  return html`<dl class="facts">${Object.entries(facts).map(([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`)}</dl>`;
}

/** Deliberate consent: a required statement checkbox plus one submit button. */
export function confirmForm(
  proof: string,
  label: string,
  options: {
    action?: string;
    statement?: string;
    detail?: string;
    danger?: boolean;
    fields?: ReturnType<typeof html>;
  } = {},
) {
  return html`<form method="post"${options.action ? html` action="${options.action}"` : ""} autocomplete="off" class="confirm-form"><input type="hidden" name="proof" value="${proof}">${options.fields ?? ""}<label class="check"><input type="checkbox" name="confirmed" value="yes" required><span>${options.statement ?? "I have reviewed this exact action and authorize it."}<small>${options.detail ?? "Consent applies only to the details shown on this page."}</small></span></label><button type="submit"${options.danger ? html` class="danger"` : ""}>${label}</button></form>`;
}

/** Mechanical continuation: submits itself when shown; the button is the
 * no-script and automated-browser fallback. Pair with allowNonceScript.
 * attended: stay manual in automated browsers (credential-bearing links). */
export function continueForm(
  proof: string,
  label: string,
  options: { action?: string; attended?: boolean } = {},
) {
  return html`<form method="post"${options.action ? html` action="${options.action}"` : ""} autocomplete="off" data-continue${options.attended ? html` data-attended` : ""}><input type="hidden" name="proof" value="${proof}"><button type="submit" class="full">${label}</button></form>`;
}

export function messagePage(
  nonce: string,
  title: string,
  detail: string,
  code: number,
  recovery?: { label: string; href: string; automatic?: boolean },
) {
  return page(
    title,
    nonce,
    html`<div class="notice" data-tone="${code >= 500 ? "warn" : code === 401 || code === 404 || code === 410 ? "neutral" : "danger"}"><p>${detail}</p></div>${recovery ? html`<div class="actions"><a class="button" href="${recovery.href}">${recovery.label}</a></div>` : ""}<p class="status-code">Status ${code}</p>`,
    {
      narrow: true,
      refresh: recovery?.automatic ? recovery.href : undefined,
    },
  );
}

/** Server time in UTC; readable and unambiguous without client scripts. */
export function utc(time: number) {
  const iso = new Date(time).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function when(value: number | string) {
  const time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) return html`${String(value)}`;
  return html`<time datetime="${new Date(time).toISOString()}">${utc(time)}</time>`;
}

export function relative(time: number, now = Date.now()) {
  const minutes = Math.round((time - now) / 60_000);
  const size = Math.abs(minutes);
  if (!size) return "now";
  const unit =
    size < 90
      ? `${size} min`
      : size < 2160
        ? `${Math.round(size / 60)} h`
        : `${Math.round(size / 1440)} d`;
  return minutes > 0 ? `in ${unit}` : `${unit} ago`;
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
