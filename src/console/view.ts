import { html } from "hono/html";

export function page(
  title: string,
  nonce: string,
  body: ReturnType<typeof html>,
) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title} · June</title>
  <style nonce="${nonce}">
    :root{color-scheme:light;background:#f5f2eb;color:#252c29;font-family:Georgia,serif}*{box-sizing:border-box}body{margin:0}main{max-width:1080px;margin:auto;padding:48px 28px 72px}header{border-top:3px solid #293e33;border-bottom:1px solid #b6b9aa;padding:18px 0 30px;margin-bottom:30px}.eyebrow,dt,.status,button,footer{font:12px/1.6 ui-monospace,monospace;letter-spacing:.05em}.eyebrow{text-transform:uppercase;color:#536054}h1{font-weight:400;font-size:56px;letter-spacing:-.04em;margin:18px 0 12px}h2{font-size:25px;font-weight:400;margin:0 0 16px}h3{font-size:18px;margin:0 0 7px}p{line-height:1.6;margin:8px 0;color:#50584f}.intro{max-width:660px;font-size:18px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}.panel{border:1px solid #bfc2b6;padding:24px;background:#fbf9f4}.panel.wide{grid-column:1/-1}.status{display:inline-block;color:#7f442b;background:#f1e5d8;padding:3px 8px;margin:0 0 16px;overflow-wrap:anywhere}article+article{border-top:1px solid #d5d7cd;margin-top:18px;padding-top:18px}a{color:#315d47;text-underline-offset:4px}a:hover{color:#7f442b}button{padding:13px 20px;background:#294735;color:#fff;border:0;cursor:pointer;letter-spacing:0;font-size:14px}button:hover{background:#3d6249}:focus-visible{outline:3px solid #a6552e;outline-offset:4px}label{display:block;padding:18px 0;line-height:1.6}input{margin-right:10px;accent-color:#294735}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eeeee5;padding:18px;font:13px/1.6 ui-monospace,monospace}footer{border-top:1px solid #b6b9aa;padding-top:20px;margin-top:36px;color:#596153}time{font:12px ui-monospace,monospace} @media(max-width:650px){main{padding:24px 18px}.grid{grid-template-columns:1fr}h1{font-size:42px}.panel{padding:20px}}
  </style></head><body><main><header><div class="eyebrow">June / private owner console</div><h1>${title}</h1><p class="intro">One place to inspect, question, and confirm. The same host services as chat; no additional authority.</p></header>${body}<footer>Private by design · No third-party assets · Viewing never approves or executes</footer></main></body></html>`;
}

export function confirmForm(proof: string, label: string) {
  return html`<form method="post" autocomplete="off"><input type="hidden" name="proof" value="${proof}"><label><input type="checkbox" name="confirmed" value="yes" required>I have reviewed this exact action and authorize it.</label><button type="submit">${label}</button></form>`;
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
