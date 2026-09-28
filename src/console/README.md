# Private owner surface

`createConsoleRoutes` (`./routes.ts`) and `createActionLinkRoutes`
(`../links/routes.ts`) return unmounted Hono apps. Nothing changes public ingress.
Mount them on the **private authenticated listener**, for example at
`/console` and `/actions`. Do not mount them behind public webhook routing.

Both require `PrivateRouteSecurity`: a fixed externally visible origin, a
host-managed random CSRF secret of at least 32 characters, and an authentication
callback returning the trusted principal or `undefined`. Console authentication
must authorize the owner, not merely any signed-in user. Action links additionally
check the broker's intended audience. Authentication must work for ordinary browser
navigation and form POSTs; use the host's private authenticated session, never
tokens in query strings, HTML, local storage, or injected client scripts.

For a Bearer-only host, `createConsoleSessionBridge(security)` in `session.ts`
returns `{ routes, authenticate }`. Mount its `/login` and `/logout` routes on a
private session prefix; pass the returned `authenticate` to the console and action
factories. Its optional second argument is the local console path (default
`/console`), the default destination after sign-in. Set `signOutPath` in
`PrivateRouteSecurity` so pages link to its logout route. Do not place the
session mount behind middleware requiring a Bearer header on every browser
navigation. A password form exchanges the token for an
opaque HttpOnly, Secure, SameSite=Strict cookie (Secure is omitted only for local
HTTP development) and redirects to the validated `returnTo`. The token stays in
server memory, is rechecked with the original host authentication callback on
every request, and expires after 15 minutes. `GET /login` with a valid session
continues to `returnTo` instead of asking again. Logout is a one-button POST with
a principal-bound CSRF proof, not a consent checkbox; a stale form is replaced
with a fresh one. Restarting the process revokes all sessions. Use a single
private host process or sticky routing; this is not distributed session storage.
Limit/rate-limit login at private ingress. Disable request-body logging.

Strict cookies are withheld on cross-site navigations. With `signInPath` set, an
unauthenticated GET returns 401 with a script-free `<meta http-equiv="refresh">`
to `signInPath?returnTo=<path>`; that same-origin document transition sends the
cookie, so an existing session continues and otherwise the sign-in page renders
(it never redirects back unauthenticated, so there is no loop). The sign-in page
remembers a validated, query-free `returnTo` for ten minutes in an HttpOnly Strict
cookie; token or link sign-in then continues there. POSTs are never replayed.

The optional third bridge argument `{ links, token }` enables `/link/:id`.
`links` is the shared `createConsoleLoginLinks(origin)` process-local store used by
the owner-private June directive and Bearer-only `POST /operator/console/login-links`.
`token` stays host-side and is reauthenticated before redemption. The HTTP host
redirects root `/<24-character-id>` URLs to this session route. Links are
single-use, expire after 10 minutes, and never extend the existing 15-minute
session or authorize operator endpoints. At most 32 unused links exist per process.
GET/HEAD only render and never consume. The page carries a signed, path-bound form
that a nonce-authorized script submits once the document is visible and not
prerendering; `navigator.webdriver` and no-JavaScript browsers get a manual
**Continue to June** button. The script contains no values. Same-origin checks and
atomic consumption are mandatory. Expired/used/restart-invalidated links fail
closed. A preview service that drives an unautomated browser could still redeem a
link; June sends links only to the owner's private conversation. These links do
not bypass private ingress authentication such as Cloudflare Access.
Disable/redact URL capture for both the root short link and session routes.

`createConnectionOAuthRoutes` (`./connection-oauth.ts`) returns account providers
to a saved connection with one signed Connect POST and the provider's own consent.
Connect binds the attempt to the principal, the provider `state` and the browser
(an HttpOnly Lax cookie, which the provider's top-level redirect still carries)
and continues to the provider without script (`form-action 'self'` blocks a
redirect after the POST). The anonymous callback verifies that binding and state,
records the callback URL server-side and moves to a same-origin document. There,
the Strict session is present for `GET /finish`, whose signed form submits itself
(no-JavaScript fallback: one button). `POST /finish` rechecks principal, binding,
proof and expiry, deletes the attempt before `complete()`, and never retries.
Wrong-browser, wrong-state, replayed and expired returns save nothing. A cancelled
provider consent clears the attempt. A lapsed session resumes through sign-in
because the code never leaves the server. Provider modules keep their own state,
PKCE, identity and generation checks.

The console reads `ConsoleSnapshot` from the same host APIs used by chat. Omitted
sections explicitly report unavailable. Supply owner-safe configuration, capability,
job, memory/proposal, reflection, approval and revocation records. No independent
state store, job runner, approval policy, or invented readiness exists here.

Without action callbacks, the overview explicitly reports read-only access and
does not render review links. Navigation is task-based (Overview, Connections when
mounted, Usage) on the current mount; unreported sections are grouped, not shown
as empty panels. The optional read-only `connections` store lets the overview list
pending tool requests, unknown outcomes and connection problems as links. No
external fonts or assets are loaded, and scripts appear only on the sign-in link
and OAuth finish pages. Meaningful decisions (action and tool approvals, tool
permissions, disconnects) keep a required statement checkbox and one submit
button; native validation and the server's signed-proof and `confirmed` checks
remain authoritative. The 10-minute proof lifetime never extends a host action or
link expiry; include the actual action expiry in the reviewed facts.

Records optionally link to a host action ID. `inspectAction` returns an immutable
revision and exact human-readable facts: target, scope, expiry, audience and
consequences. `confirmAction` **must atomically recheck permission and revision and
durably deduplicate commandId**, including ambiguity after a crash. It must not
execute a changed action under the same revision. The route passes a stable command
ID on repeated submission of a form. A fresh form has a fresh command ID; domain
services still enforce one-time proposal approval. Leave both callbacks absent
until the actual services provide those guarantees. Unknown outcomes are visibly
held for reconciliation, not silently retried.

Action links use existing `OpaqueActionLinks` and broker grants. `resolveAction`
reads the original safe payload from the trusted host proposal store. Before
returning it for review, the host must verify
`broker.matchesGrant(configuredOwner, grantId, action)` and return `undefined` for
missing, invalid or mismatched payloads. `matchesGrant` is owner-only read inspection,
not authorization: it also matches revoked, expired or consumed grants. The route
first checks link audience/expiry, displays the authenticated intended audience,
and the broker rechecks exact binding, expiry, audience, revocation and durable
once-only intent on POST. Missing payloads disable execution. Do not put credential
values in tool arguments.
Issuance/revocation remain host actions, usable through the console's review API;
these routes do not grant authority or create another approval store.

GET/HEAD do not mutate host state. POST requires a same-origin form, an expiring
HMAC proof bound to identity/path/reviewed content, and explicit confirmation.
Browsers using no-referrer submit forms with `Origin: null`; that case additionally
requires browser-enforced `Sec-Fetch-Site: same-origin`. Missing origins and
cross-site metadata are rejected. The signed confirmation remains mandatory.
This follows the [Fetch Origin-header algorithm](https://fetch.spec.whatwg.org/#append-a-request-origin-header)
and [Fetch Metadata origin checks](https://www.w3.org/TR/fetch-metadata/#sec-fetch-site-header).
Browsers that omit Fetch Metadata on a null-origin POST fail closed. The header
is not authentication and can be forged by non-browser clients, which still need
valid authentication and the signed proof. Keep untrusted content off this origin;
do not add permissive CORS or relax the no-referrer policy on token-bearing pages.
All responses, including errors, prohibit caching/referrers/framing. CSP stays
`default-src 'none'` with nonce-only styles; only pages that call
`allowNonceScript` add a nonce `script-src`, never `unsafe-inline`. There are no
third-party assets. Outbound links go only to a configured provider's consent page
and GitHub's app installation page. HTML interpolation is escaped.
Opaque tokens remain in the incoming URL; **redact/disable access logs, tracing,
analytics and proxy URL capture** for this mount. Headers cannot erase browser
history or a reverse proxy log. Never share production screenshots with private
records or token-bearing address bars.
