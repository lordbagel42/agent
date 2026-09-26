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
`/console`) for the signed-in page's navigation link. Do not place the session mount behind middleware requiring a Bearer
header on every browser navigation. A password form exchanges the token for an
opaque HttpOnly, Secure, SameSite=Strict cookie (Secure is omitted only for local
HTTP development). The token stays in server memory, is rechecked with the original
host authentication callback on every request, and expires after 15 minutes.
POST logout revokes that session; restarting the process revokes all sessions.
Use a single private host process or sticky routing; this is not distributed session
storage. Limit/rate-limit login at private ingress. Disable request-body logging.

The console reads `ConsoleSnapshot` from the same host APIs used by chat. Omitted
sections explicitly report unavailable. Supply owner-safe configuration, capability,
job, memory/proposal, reflection, approval and revocation records. No independent
state store, job runner, approval policy, or invented readiness exists here.

Without action callbacks, the overview explicitly reports read-only access and
does not render review links. Navigation uses real section anchors and the current
mount; session navigation uses the configured console path. No scripts or external
fonts are loaded. Modern CSS `:has()` reveals the submit control only when the
required consent checkbox is checked; native form validation and the server's
signed-proof checks remain authoritative. Browsers without `:has()` keep the
confirmation button disabled. The 10-minute proof lifetime never extends a host
action or link expiry; include the actual action expiry in the reviewed facts.

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
All responses, including errors, prohibit caching/referrers/framing; there are no
scripts, third-party assets or outbound links. HTML interpolation is escaped.
Opaque tokens remain in the incoming URL; **redact/disable access logs, tracing,
analytics and proxy URL capture** for this mount. Headers cannot erase browser
history or a reverse proxy log. Never share production screenshots with private
records or token-bearing address bars.
