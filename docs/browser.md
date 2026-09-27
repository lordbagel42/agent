# Capability-bound browser worker

`BrowserAdapter` implements `ToolAdapter.execute(action, credential)`. Register it
under the tool name `browser`. June's host requires arguments
`{ "operation": "operator-configured-name", "recipeDigest": "sha256" }`.
Use `adapter.action(name)` or `browserOperationDigest(recipe)` to construct them;
the digest binds the complete parsed recipe, including default values. A grant
for an older recipe cannot authorize a changed recipe under the same name.
Standalone legacy adapter callers may omit the digest only when the host has
not set `requireRecipeDigest: true`. Each named operation binds an
exact account, vault item, canonical HTTPS origin, starting URL, request list,
steps, and confirmation. Configuration is trusted operator input, not model or
page input. Freeze configuration for the lifetime of outstanding grants; revoke
old grants before changing a recipe under the same name.

## Opt-in June host reads

Browsing is disabled by default. Configuring MCP, generic capabilities, Chromium,
or read recipes does not enable it. The host mounts anonymous reads in the same
generic `CapabilityBroker` only with all of:

- `capabilities.directory`, the existing private broker ledger directory;
- top-level `browser.enabled: true` and at least one named recipe in
  `browser.readOperations` or the separate `browser.mutationOperations` opt-in below;
- `browser.execution.kind: "isolated-host"`, dedicated absolute `home` and
  `tempDirectory`, and explicit `true` for `processIsolationAcknowledged`,
  `networkIsolationAcknowledged`, `ephemeralStorageAcknowledged`, and
  `resourceLimitsAcknowledged`;
- the separate host gate `JUNE_ALLOW_ISOLATED_BROWSER=1`;
- an unprivileged host, private canonical execution directories outside Git,
  `TMPDIR` equal to the configured temporary directory, and no `DEBUG`, `PWDEBUG`
  or `NODE_DEBUG` diagnostics, npm `pwdebug` aliases, or `SELENIUM_REMOTE_URL`,
  `SELENIUM_REMOTE_HEADERS`, `SELENIUM_REMOTE_CAPABILITIES` overrides. Playwright
  reads those controls in the parent process before applying the child environment.

The acknowledgements and gate attest operator-provided isolation; they do not
create or prove an OS/network sandbox. Meet the deployment boundary below before
setting them. Chromium receives only the explicitly configured `HOME` and
`TMPDIR`, never June's environment credentials. No desktop profile, cookies,
remote browser endpoint, `--no-sandbox`, or production loopback exception is
configurable. The pinned Playwright browser must already be installed.

Read recipes use the `BrowserOperation` shape below but must have only anonymous
`GET` requests and no click, fill, or login steps. Account and item are explicit
nonsecret aliases even for anonymous reads; scope widening is rejected. GET is
an operator's classification, not proof an endpoint cannot change remote state.
`browser.timeoutMs` defaults to 15000 (100–60000 allowed). Do not put credentials
in URLs, selectors, or success text.

June can answer owner-private capability questions using
`inspection: "capabilities"`, including requested activation, host gate,
registration and bounded operation-name metadata. This lookup launches no
browser and grants nothing. Without the host gate a configured browser remains
blocked. Configuration is not live verification. The authenticated operator uses
the existing `/operator/capabilities` proposal/grant/execute routes with the exact
action from `adapter.action(name)`; every read still needs its own owner grant.
This slice deliberately returns **receipts only**, not webpage text to June.
Anonymous adapter output is capped at 4096 UTF-16 units but the broker discards
it. Authenticated vault operations and mutations are separate capabilities, not
implicitly authorized by read configuration.

## Integration

The repository pins `playwright: "1.63.0"`. Install its Chromium build with
`pnpm exec playwright install chromium` on the worker host/image.
Install the system libraries required by
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
launch has the same timeout. The worker rechecks cancellation after asynchronous
request-header lookup, before dispatch. Cancellation cannot undo a request already sent;
keep the broker receipt unknown and reconcile rather than re-execute. The broker
owns durable one-use receipts and crash recovery, not this in-memory adapter.
Broker revocation prevents admission. Authenticated broker cancellation also
signals the admitted operation; it does not certify that it stopped. The receipt
stays `unknown`, and local reconciliation remains blocked until execution settles.
The worker deadline/host signal or shutdown requests the same owned-resource cleanup.

Cancellation and shutdown wait for the page operation, context/browser close
promises, and outstanding route callbacks to settle. They never race settlement
against the abort signal. Only the operation's fresh context and Chromium process
are closed; unrelated browser sessions remain untouched. Close calls are coalesced,
including resources returned by a late launch after cancellation. A failed close
produces only `browser_cleanup_failed`, leaves the broker outcome `unknown`, and
fences the adapter against new work. Shutdown continues reporting that failure;
it is not proof the browser stopped. June must not describe an unknown receipt as
cancelled, successful, or safely retryable. The owner must independently confirm
stoppage and reconcile the consumed grant; there is no automatic retry.

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
suppression, and cancellation (including after admission but before dispatch).
No real website or live credential is used.

Authoritative APIs consulted:

- https://playwright.dev/docs/api/class-browsercontext#browser-context-route
- https://playwright.dev/docs/api/class-route#route-fetch
- https://playwright.dev/docs/api/class-browsercontext#browser-context-route-web-socket
- https://playwright.dev/docs/api/class-browsertype#browser-type-launch

## One exact mutation proposal

`browser.mutationOperations` is a separate, empty-by-default opt-in under the same
browser execution/isolation gates. It never changes `readOperations` permissions.
Each mutation recipe has exactly one nonsecret literal `fill` or one `click`.
A fill cannot allow non-GET requests or append a submit; a click may allow at most
one exact non-GET URL/method, with a one-use request budget. Login, credentials,
page-text output and multi-step sequences are not supported on this surface.
Recipes are limited to 1400 serialized JSON characters; startup also rejects a
complete escaped review that exceeds 3500 characters instead of truncating it.
Up to 16 named mutations are supported;
names use a lowercase letter followed by up to 63 lowercase letters, digits,
underscores or hyphens. Values are nonsecret configuration and appear in the
owner-private proposal/history, not a channel or guest reply.

June discovers names with `browserProposal: { "operation": null }` and proposes
one with `browserProposal: { "operation": "exact-name" }`, leaving text empty
and other actions unset. This path only calls the broker's `propose`; it does not
grant, resolve credentials, open a browser or execute. The host returns the
entire configured recipe and exact `ToolAction` directly for human review. JSON
Unicode escapes keep URLs and markup inert; JSON decoding restores exact values.
The preview must match the adapter's full recipe digest and account/origin scope.
June cannot invent selectors, URLs, form values or recipe steps at runtime.

The human must separately authenticate to `POST /operator/capabilities/grants`
with `{ "audience": "<owner id>", "action": <reviewed action>, "expiresAt":
<Unix milliseconds within five minutes> }`, then POST the identical action to
`/operator/capabilities/grants/<grantId>/execute`. Never give June the operator
token. The broker binds tool/account/item/origin and arguments including the full
recipe digest, not a broad browsing scope. An approved read cannot authorize a
mutation; a changed recipe invalidates the old action even under the same name.
Receipts are durable and one-use: retrying the same grant does not repeat the
effect, including after restart. An unknown receipt requires inspection and
reconciliation, not a new automatic grant or retry.

Every action uses a fresh browser context: filling in one action does not retain
the field for a later click. A click acts on the configured page as loaded, not
on a previous fill. The approved origin remains trusted; URL/method checks do
not prove server-side semantics or make an arbitrary website safe. Configure
only known endpoints and an exact post-action confirmation. Do not label an
endpoint with side effects as a read.

`src/tools/browser-proposals.test.ts` uses only a disposable local HTTPS form,
self-signed fixture certificate and local broker database. It checks that a
proposal does nothing, unauthenticated approval is denied, read/wrong-scope
grants cannot mutate, a fill cannot submit POSTs even from an input handler, and
an approved click sends exactly once across broker restart. `src/runtime/registry.test.ts` checks June's private
proposal path and denial in guest, public, mixed-directive and synthesis turns.
