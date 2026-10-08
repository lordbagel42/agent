# Capability-bound browser worker

## Codex browser companion (separate opt-in)

`browserCompanion` is a separate visual-review capability, not a change to the
receipt-only recipe broker below. June's interaction agent delegates to an
existing durable execution worker. That worker calls
`browserTask: { action: "start", url, goal }`, then `status` or `cancel` with the
returned `taskId`. Available task turns in admitted conversations can use it;
June judges intent, authority and disclosure to the current audience. Tasks and
their status are bound to the original requester, conversation/thread and routed
audience, not an owner-wide task list. Report-only turns cannot start new work.

The companion owns one fresh sandboxed Chromium session and a restricted Codex
0.157.1 thread. Codex gets host-defined navigation, observation, scroll, native
PIN-request, video-discovery and timestamped-frame tools—not a shell, filesystem,
MCP, arbitrary JavaScript, desktop profile or public CDP endpoint. Start/status
results include the ordinary authenticated `/console/browser/<taskId>` HTML URL.
It streams **the same browser** at up to two frames per second, without audio,
recording or remote controls. June's runtime instructions explain this link;
Slack HTML embedding is not implemented here.

For a supported PIN form, June relays the returned question including
`!browser-pin <taskId> <challengeId> <PIN>`. Send that as a plain reply in the same
owner DM/thread. This credential-input control and the owner-authenticated console
remain separate from task eligibility: shared/guest task admission does not grant
PIN submission or console login. The verified host consumes the challenge/message once, removes
the command before ordinary history/memory ingestion, and buffers the PIN only
in memory. June then resumes the existing task using `status`. A wrong PIN needs
a new challenge and fresh message; redelivery cannot submit again. Quoted,
malformed and historical PIN commands are redacted rather than accepted. Slack
itself may retain the original message; do not promise its deletion.

Observations and the live view are blanked during PIN entry. The approved site
necessarily receives the PIN and may reflect it; allow only trusted destinations.
Native same-origin POST forms are supported. Ordinary redirects are denied; a
validated same-origin 303 after submission permits one exact host-issued GET.
307/308 replay, arbitrary clicks, uploads, purchases, SSO and child-frame video
players are not supported. Missing resources or unsupported media must be
reported, not bypassed.

June's tool-free visual review receives actual bounded image inputs, including
video timestamps, through the OpenAI, Anthropic or native Codex image path.
Sampling frames is not watching every moment; there is no audio transcription.
Both Codex and June are instructed to distinguish observed visuals from inference
and treat page content as untrusted data, never permission.

### Provisioning and retention

The optional configuration is disabled by default. Enabling requires
`JUNE_ALLOW_BROWSER_COMPANION=1`, execution workers, private-console hosting,
four disjoint private absolute directories (`directory`, browser `home`,
`tempDirectory`, dedicated `codexHome`), configured HTTPS `navigationOrigins` and
`resourceOrigins`, and the four isolation acknowledgements shown in the example
configuration. `TMPDIR` must equal `tempDirectory`. The process must be
unprivileged and diagnostic/remote-browser overrides disabled. Install the pinned
Playwright Chromium beforehand. Provision Codex authentication deliberately in
its dedicated home; never copy June's existing credentials or another session's
login as a shortcut.

These gates **do not provision isolation**. The external process, egress,
ephemeral-storage and resource controls described below remain mandatory for
both Chromium and its host networking. Playwright buffers HTTP responses; external
memory/response limits are necessary. Private observations are sent to the selected
model providers, whose retention policies are independent of local cleanup.

The current `deployment.blueGreen` durable Slack intake persists raw envelopes
before June receives them. Enabling the companion together with that mode is
therefore rejected: an upstream secret-input path that bypasses durable queuing
is required first. Other proxies must also avoid storing/logging request bodies.
Do not turn off deployed intake or switch routing merely to enable this feature.

Tasks expire after at most one hour, or thirty minutes waiting for input.
Cancellation joins Codex/review work before deleting the local Codex transcript
using `thread/delete`. Images and PIN buffers are volatile; goals/URLs are scrubbed
on termination, and retained reports expire at the task deadline. A memory-deletion
revision immediately fences evidence access and triggers cleanup on the next
one-second maintenance tick. Nonsecret task/operation/challenge receipts remain
to prevent replay. Crash-orphaned transcripts require operator reconciliation;
do not claim they were deleted merely because the UI is unavailable.

Restart or uncertain cleanup produces `needs_review` and blocks replacement.
After independently confirming the old Chromium/Codex processes have stopped,
the authenticated operator may POST `{ "confirmedStopped": true }` to
`/operator/browser/<taskId>/reconcile`. This deletes remaining local transcript
data and clears the launch fence without replaying a task. June can inspect the
status and ask for this intervention; she cannot assert operator confirmation.
If the browser's original close promise failed, restart the host under the normal
deployment recovery procedure before reconciliation. Never delete the Codex auth
home or restore old conversation data to recover a task.

Local verification: `pnpm exec vitest run src/browser
src/runtime/browser-capability.test.ts`. The browser tests use real sandboxed
Chromium and disposable PIN/video fixtures; protocol tests use controlled Codex
messages. These are not proof of authenticated inference or the owner's real URL.

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
  `browser.readOperations`, `browser.mutationOperations` or the separate
  `browser.credentialOperations` opt-in below;
- `browser.execution.kind: "isolated-host"`, dedicated absolute `home` and
  `tempDirectory`, and explicit `true` for `processIsolationAcknowledged`,
  `networkIsolationAcknowledged`, `ephemeralStorageAcknowledged`, and
  `resourceLimitsAcknowledged`;
- the separate host gate `JUNE_ALLOW_ISOLATED_BROWSER=1`;
- an unprivileged host, private canonical execution directories outside Git,
  `TMPDIR` equal to the configured temporary directory, and no `DEBUG`, `PWDEBUG`
  or `NODE_DEBUG`/`NODE_DEBUG_NATIVE` diagnostics, npm `pwdebug` aliases, or `SELENIUM_REMOTE_URL`,
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

June can answer capability questions when inspection is exposed, using
`inspection: "capabilities"`, including requested activation, host gate,
registration and bounded operation-name metadata. This lookup launches no
browser and grants nothing. Without the host gate a configured browser remains
blocked. Configuration is not live verification. The authenticated operator uses
the existing `/operator/capabilities` proposal/grant/execute routes with the exact
action from `adapter.action(name)` for manual broker operations, including these
anonymous reads. `readOperations` are not in the `browserProposal` task catalog;
the mutation/credential task path below creates its own exact one-use grant.
This slice deliberately returns **receipts only**, not webpage text to June.
Anonymous adapter output is capped at 4096 UTF-16 units but the broker discards
it. Authenticated vault operations and mutations are separate capabilities, not
implicitly authorized by read configuration.

## Opt-in credential operations

`browser.credentialOperations` is a separate, empty-by-default list of named
recipes using bearer injection or exactly one login step. It requires the same
browser isolation gates plus the protected `credentials` host configuration
described in [Credential host wiring](../src/credentials/README.md). Each recipe's
account/item/origin and credential kind must match a configured binding; the host
checks this at startup and again before resolution. Validation, status inspection
and proposals never read the session file or invoke the vault CLI.

Credential recipes use short lowercase names (letters, digits, hyphen, underscore;
maximum 64 characters), no literal `fill` steps or `outputSelector`, and at most
1400 JSON characters. URLs, selectors, success text, names and aliases must be
nonsecret configuration. Use a typed `login` step for both username and password;
submission is a separately configured click, never appended automatically.
The entire recipe is digest-bound, including exact requests and use budgets.

June's `browserProposal` catalog includes these named recipes. Selecting an exact
name executes immediately through a host-created durable one-use grant, without
compulsory human approval. Only configured credential references enter the action;
the host resolves their values after authorization checks. June cannot read or
enroll credentials through this interface. A credentialed recipe
never returns page text, screenshots, vault item bodies or errors, only a receipt.
An anonymous recipe sharing its account/item/origin still never reads the vault.
No credential recipe or default binding is installed automatically. The authenticated
operator routes remain optional manual interfaces, not prerequisites for June's task.

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

The broker uses `executeWithCredentialResolver` for browser actions: the browser
validates the exact configured recipe before invoking the one-use credential
callback. The callback checks grant/link validity both before lookup and after
lookup, so revocation or expiry while the vault is pending cannot release the
credential. A callback retained past execution cannot read the vault. Browser
cancellation also covers the lookup interval. Direct `execute(action, credential)`
is a trusted low-level fixture API, not a June-callable secret-reading tool.
Credentialed operations refuse `DEBUG`, `PWDEBUG`, `NODE_DEBUG`, and
`NODE_DEBUG_NATIVE`; protocol diagnostics are not a safe redaction surface.
Keep diagnostics disabled from process startup for its entire lifetime; clearing
an environment variable cannot disable logging already initialized elsewhere.

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

## One exact configured task

`browser.mutationOperations` is a separate, empty-by-default opt-in under the same
browser execution/isolation gates. It never changes `readOperations` permissions.
Each mutation recipe has exactly one nonsecret literal `fill` or one `click`.
A fill cannot allow non-GET requests or append a submit; a click may allow at most
one exact non-GET URL/method, with a one-use request budget. Login, credentials,
page-text output and multi-step sequences are not supported on this surface.
Recipes are limited to 1400 serialized JSON characters; the discovery catalog and
escaped execution receipts are bounded to 3500 characters, never silently clipped.
Up to 16 named mutations are supported;
names use a lowercase letter followed by up to 63 lowercase letters, digits,
underscores or hyphens. Values must be nonsecret configuration. Task replies expose
names and receipt metadata, not recipe payloads, page contents or credentials.

June discovers names with `browserProposal: { "operation": null }` and executes
one with `browserProposal: { "operation": "exact-name" }`, leaving text empty
and other actions unset. Null is discovery only: it grants nothing, resolves no
credentials and opens no browser. A named operation persists its invocation and
exact-action binding, creates a one-use broker grant and runs the configured
recipe. June decides whether that action fits the actual request and audience;
there is no blanket owner/private-DM or per-action human approval requirement.
June cannot invent selectors, URLs, form values or recipe steps at runtime. The
broker binds the full recipe digest, account, item and origin, not broad browsing
authority. Changed recipes invalidate old actions even under the same name.

For optional manual execution, an operator authenticates to `POST /operator/capabilities/grants`
with `{ "audience": "<owner id>", "action": <reviewed action>, "expiresAt":
<Unix milliseconds within five minutes> }`, then POST the identical action to
`/operator/capabilities/grants/<grantId>/execute`. Never give June the operator
token. A read grant cannot authorize a mutation. Receipts are durable and one-use:
replaying an invocation only inspects its saved grant/receipt, including after
restart. Missing or unknown receipts never authorize redispatch with the same or
a new operation ID. Historical proposals are not swept or executed automatically.
Unknown outcomes require independent stoppage/outcome verification and authenticated
reconciliation, not a replacement grant or another provider.

Every action uses a fresh browser context: filling in one action does not retain
the field for a later click. A click acts on the configured page as loaded, not
on a previous fill. The approved origin remains trusted; URL/method checks do
not prove server-side semantics or make an arbitrary website safe. Configure
only known endpoints and an exact post-action confirmation. Do not label an
endpoint with side effects as a read.

`src/tools/browser-proposals.test.ts` uses only a disposable local HTTPS form,
self-signed fixture certificate and local broker database to exercise discovery,
exact execution and replay protection. `src/runtime/registry.test.ts` covers the
June-facing directive boundary. Local fixtures are not evidence of live browser
activation, credential access or a real site's business outcome.
