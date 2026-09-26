# Capability-bound browser worker

`BrowserAdapter` implements `ToolAdapter.execute(action, credential)`. Register it
under the tool name `browser`. The only accepted arguments are
`{ "operation": "operator-configured-name" }`. Each named operation binds an
exact account, vault item, canonical HTTPS origin, starting URL, request list,
steps, and confirmation. Configuration is trusted operator input, not model or
page input. Freeze configuration for the lifetime of outstanding grants; revoke
old grants before changing a recipe under the same name.

## Integration

The integration owner must add exact dependency `playwright: "1.63.0"` and update
the lockfile, then install its Chromium build with `pnpm exec playwright install
chromium` on the worker host/image. Install the system libraries required by
Playwright for that OS. Chromium's sandbox is explicitly **enabled**; do not work
around a launch failure by adding `--no-sandbox`. No desktop browser, imported
profile/cookies, CDP port, or remote browser endpoint is used.
An optional host-only `executablePath` selects an installed executable. Prefer
the matching Playwright-managed build/cache; arbitrary system browser versions
are not verified. `PLAYWRIGHT_BROWSERS_PATH` can select the host's managed cache.

```typescript
const browser = new BrowserAdapter({
  operations: [{
    name: "check-account",
    account: "configured-account",
    item: "configured-vault-item",
    origin: "https://account.example.com",
    url: "https://account.example.com/status",
    requests: [{
      url: "https://account.example.com/status",
      method: "GET",
      credential: true,
    }],
    success: { selector: "#account-status", text: "Active" },
  }],
});
// Supply through the credential resolver, NEVER through action.arguments:
// { bearerToken: "..." }
// broker tools: { browser }, and await browser.close() on host shutdown.
```

The shared credential shapes are `{ bearerToken: string }` and
`{ kind: "login", username: string, password: string }`. Anonymous
operations accept only null/undefined. A recipe with any `credential: true`
request requires a bearer credential; the header is injected by the worker on
only those exact requests, never through DOM scripts or a model prompt. Cookies
created during the operation remain in its fresh context and are not reused.
A login recipe instead contains one step
`{ kind: "login", usernameSelector: "#username", passwordSelector: "#password" }`,
followed by a configured click to submit. The secret write checks the document's
origin synchronously with filling the input. The form's request still requires
an exact allowlisted URL and method. Login and bearer cannot be mixed in one
recipe. Login values never appear in action arguments or recipe config.
OAuth/SSO redirects, TOTP, downloads, and arbitrary browser scripts are not
supported. Do not pass a Bitwarden item object directly; the resolver must
explicitly select the supported credential.

`execute` optionally takes a third `AbortSignal` from trusted host code. `close()`
permanently stops accepting work and closes active browsers. A deadline (15s by
default, configurable from 100ms to 60s) also closes the context/browser. Browser
launch has the same timeout. Cancellation cannot undo a request already sent;
keep the broker receipt unknown and reconcile rather than re-execute. The broker
owns durable one-use receipts and crash recovery, not this in-memory adapter.
Broker revocation prevents admission; it does not interrupt an already admitted
adapter. The worker deadline/host signal or shutdown handles those operations.

The result is `{ operation, status: "confirmed" }`. Anonymous recipes can opt
into `outputSelector`, yielding at most 4096 UTF-16 code units as `untrustedText`.
Credentialed recipes cannot return page text: even redaction cannot safely remove
all encodings/transformations of reflected secrets. Errors are fixed strings,
never Playwright errors or DOM/HTTP payloads. There are no screenshots, traces,
HARs, videos, storage-state exports, or worker logs. The broker intentionally
discards adapter results and exposes receipts only. An authorized output path
requires a separately reviewed privacy policy; do not bypass the broker to expose
these results. Returned text is source data and must never authorize another tool.

## Request and completion policy

- A fresh Chromium process and nonpersistent context are created per action.
- Only exact configured URL + method pairs at the granted origin are fetched.
  Include required styles/scripts/API calls explicitly; no wildcard hosts/paths,
  third-party CDN exceptions, or discovery from page links.
- Every request has a use budget (default one, GET at most sixteen). Non-GET
  requests can be sent only once per operation. A route is counted **before**
  network dispatch. This prevents duplicate submission to the same configured
  endpoint, not logically duplicate effects spread across different endpoints.
- No automatic network retries. All 3xx responses are rejected, including
  same-origin redirects. `route.fetch` uses `maxRedirects: 0, maxRetries: 0`;
  `route.continue` would silently follow redirects and is not used.
- New tabs, child frames, WebSockets, downloads, and off-origin navigations fail
  the operation. Service workers are blocked; no browser permissions are granted.
  Main-frame navigations are capped at eight; recipes have at most sixteen steps.
- Steps are configured `click`, nonsecret literal `fill`, or typed `login` actions. Choose
  exact selectors and do not put passwords in recipe values. Requests triggered
  by page JavaScript still require the same allowlist and use budget.
- The final selector must be visible with exactly the configured text. This is
  a site-specific confirmation contract, not independent proof of a business
  outcome. Use an acknowledgement shown only after the intended effect commits,
  never a preexisting generic banner. Unknown outcomes must not be retried.

## Required deployment boundary

This adapter is **not an OS or network sandbox**. Before enabling real secrets:

1. Run in a dedicated unprivileged worker/container/VM with no owner home,
   desktop sessions, SSH/cloud credentials, vault database, Docker socket, host
   mounts, or unrelated environment secrets. Keep Chromium sandboxing enabled.
2. Enforce external egress for both Node/Playwright and Chromium. Permit only the
   explicitly approved destinations, deny LAN/loopback/link-local/metadata and
   arbitrary DNS, and account for DNS rebinding. URL checks are not IP/network
   isolation. Browser internals, DNS/preconnect, WebRTC and a compromised browser
   are outside Playwright's HTTP routing guarantee. Only the isolated local test
   harness may set `allowLoopbackHttp: true`; do not expose this through HTTP/model
   input or production config.
3. Use private **tmpfs** for `TMPDIR` and browser temporary data, disable swap or
   use encrypted swap, disable core dumps/crash collection, and apply memory/CPU/
   process limits plus a supervisor hard deadline. Nonpersistent contexts still
   involve browser temporary profiles; context closure alone is not a guarantee
   against filesystem remnants after a crash. `route.fetch` buffers responses;
   bounded returned text does not bound response/download bytes or process memory.
4. Disable Playwright debug/protocol logging (`DEBUG`, `PWDEBUG`), tracing,
   instrumentation, request-body/header logging, and secret-bearing telemetry at
   every surrounding layer. Do not persist credential objects or authenticated
   page content in workflow journals, error reports, model prompts, or artifacts.

The approved origin is trusted to receive its credential; a compromised approved
server may misuse it. No worker can recall a credential or external effect after
dispatch. This is why short-lived credentials, broker revocation, narrow endpoint
configuration, and external isolation are complementary requirements.

## Verification

`pnpm exec vitest run src/tools/browser.test.ts` runs disposable loopback HTTP
fixtures with a real Chromium process. It covers account/item/origin/argument
widening, credential reflection exclusion, fresh cookie state, cross-origin
redirect/subresource/tab blocking, frame/WebSocket blocking, duplicate mutation
suppression, and cancellation. No real website or live credential is used.

Authoritative APIs consulted:

- https://playwright.dev/docs/api/class-browsercontext#browser-context-route
- https://playwright.dev/docs/api/class-route#route-fetch
- https://playwright.dev/docs/api/class-browsercontext#browser-context-route-web-socket
- https://playwright.dev/docs/api/class-browsertype#browser-type-launch
