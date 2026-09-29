import { html, raw } from "hono/html";

const styles = `
:root{color-scheme:dark;font:15px/1.5 system-ui,sans-serif;background:#111;color:#ededed}
body{margin:0;min-height:100dvh;display:flex;flex-direction:column;scrollbar-color:#6b6b6b transparent}
body>header a{color:#9ac3ff;text-underline-offset:3px}
.gate,.workflow,body>header{box-sizing:border-box}
.gate button,.gate input{font:inherit;box-sizing:border-box}
.gate button{background:#ededed;color:#151515;border:0;border-radius:6px;padding:11px 18px;cursor:pointer;margin-top:18px;width:100%}
.gate button:hover{background:#fff}
.gate input{display:block;width:100%;padding:12px;background:#181818;color:#ededed;border:1px solid #6b6b6b;border-radius:6px;caret-color:#9ac3ff;font-variant-numeric:tabular-nums}
.gate label{display:block;margin:24px 0 8px}
.gate :focus-visible,body>header :focus-visible,.workflow :focus-visible{outline:2px solid #9ac3ff;outline-offset:3px}
.gate h1,.workflow h1{font-size:24px;line-height:1.3;letter-spacing:-.02em}
.gate p,.workflow p{color:#b8b8b8;max-width:65ch}
.gate{width:100%;max-width:430px;padding:28px;margin:14vh auto}
body>header{padding:16px 24px;border-bottom:1px solid #2a2a2a;display:flex;align-items:center;gap:20px;flex-wrap:wrap}
body>header h1{font-size:17px;margin:0;flex:1;min-width:160px}
#status{color:#b8b8b8;font-size:13px}
#content{flex:1;display:flex;flex-direction:column}
#canvas{height:calc(100dvh - 59px);min-height:400px;background:white;color-scheme:light}
.document{width:100%;flex:1;min-height:calc(100dvh - 59px);border:0;background:white}
.workflow{width:100%;max-width:900px;margin:40px auto;padding:0 24px}
.workflow ol{padding:0;list-style:none}.workflow li{border-top:1px solid #2a2a2a;padding:16px 0}
.workflow summary{cursor:pointer;display:flex;justify-content:space-between;gap:24px}.workflow small{color:#b8b8b8}
.gate .error{color:#eea09a}
@media(max-width:540px){body>header{padding:12px 16px;gap:8px}body>header h1{flex-basis:100%}.gate{margin:8vh auto}#canvas{height:calc(100dvh - 83px)}}`;
export function artifactPage(
  id: string,
  nonce: string,
  locked = false,
  error = false,
) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>June · shared artifact</title><style nonce="${nonce}">${raw(styles)}</style>${!locked ? html`<link rel="stylesheet" href="/artifacts/assets/client.css"><script type="module" src="/artifacts/assets/client.js"></script>` : ""}</head><body data-artifact="${id}">${locked ? html`<main class="gate"><h1>This space is private.</h1><p>Ask its creator for the eight-digit access PIN, then enter it here.</p>${error ? html`<p class="error" role="alert">Could not unlock. Check your PIN; after repeated attempts, wait 15 minutes.</p>` : ""}<form method="post" action="/artifacts/${id}/unlock"><label for="pin">Access PIN</label><input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{8}" minlength="8" maxlength="8" required autocomplete="off"><button type="submit">Open shared space</button></form><p><small>A PIN opens this artifact only. It does not grant control of June.</small></p></main>` : html`<header><h1 id="title">June · shared space</h1><span id="status" role="status">Connecting…</span><a href="/artifacts/${id}/" target="_blank" rel="noopener">Open in browser</a></header><main id="content"></main>`}</body></html>`;
}
export const HTML_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; sandbox";
