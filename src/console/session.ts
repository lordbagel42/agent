import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import type { ModelProvider } from "../core/contracts.js";
import { wrapModelProvider } from "../models/invocation.js";
import {
  allowNonceScript,
  confirmations,
  type PrivateEnv,
  type PrivateRouteSecurity,
  privateRoutes,
  sessionReturnPath,
} from "./security.js";
import { continueForm, messagePage, page } from "./view.js";

/** Process-local bearer links. Restart revokes all outstanding links. */
export function createConsoleLoginLinks(origin: string) {
  const links = new Map<string, number>();
  const credentialUrl = new RegExp(
    `${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?:console/session/link/)?[A-Za-z0-9_-]{24}(?![A-Za-z0-9_-])`,
    "g",
  );
  const prune = () => {
    for (const [id, expires] of links)
      if (expires <= Date.now()) links.delete(id);
  };
  // Match URL shape, not live entries: also redact consumed/restarted links.
  const redact = (text: string) =>
    text.replace(credentialUrl, "[dashboard sign-in credential omitted]");
  return {
    // Use before encoding host-generated evidence receipts for later history.
    redact,
    // Install inside any tool wrapper so later MCP synthesis is protected too.
    wrapModel(model: ModelProvider): ModelProvider {
      return wrapModelProvider(
        model,
        (model) => (request, signal, isCurrent, canStartAction) =>
          model.reply(
            {
              ...request,
              system: redact(request.system),
              messages: request.messages.map(({ role, content }) => ({
                role,
                content: redact(content),
              })),
            },
            signal,
            isCurrent,
            canStartAction,
          ),
      );
    },
    issue() {
      prune();
      if (links.size >= 32) return;
      const id = randomBytes(18).toString("base64url");
      const expires = Date.now() + 600_000;
      links.set(id, expires);
      return {
        url: `${origin}/${id}`,
        expiresAt: new Date(expires).toISOString(),
      };
    },
    has(id: string) {
      prune();
      return links.has(id);
    },
    consume(id: string) {
      prune();
      // Delete synchronously: concurrent redemptions can have only one winner.
      return links.delete(id);
    },
  };
}

/** Optional browser bridge for the host's existing Bearer authentication.
 * Mount routes on private ingress only. Tokens stay in server memory for at most
 * 15 minutes and are revalidated on every request. Restart logs everyone out. */
export function createConsoleSessionBridge(
  security: PrivateRouteSecurity,
  consolePath = "/console",
  login?: { links: ReturnType<typeof createConsoleLoginLinks>; token: string },
) {
  if (
    !consolePath.startsWith("/") ||
    consolePath.startsWith("//") ||
    consolePath.includes("\\")
  )
    throw new Error("Console path must be a local absolute path");
  const sessions = new Map<string, { token: string; expires: number }>();
  const logins = new Map<string, { until: number; count: number }>();
  const secure = security.origin.startsWith("https:");
  const cookie = secure ? "__Host-june-console" : "june-console-dev";
  // A validated local path to continue after the next sign-in, including one
  // through a June link. Never a query: OAuth codes stay server-side.
  const returnCookie = secure
    ? "__Host-june-console-return"
    : "june-console-return-dev";
  const proof = confirmations(security.csrfSecret);
  const authenticateToken = (token: string) =>
    security.authenticate(
      new Request(security.origin, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  const prune = () => {
    for (const [id, session] of sessions)
      if (session.expires <= Date.now()) sessions.delete(id);
    for (const [principal, window] of logins)
      if (window.until <= Date.now()) logins.delete(principal);
  };
  const setSession = (c: Context, token: string) => {
    const previous = getCookie(c, cookie);
    if (previous) sessions.delete(previous);
    const id = randomBytes(32).toString("base64url");
    sessions.set(id, { token, expires: Date.now() + 900_000 });
    setTimeout(() => sessions.delete(id), 900_000).unref();
    setCookie(c, cookie, id, {
      httpOnly: true,
      secure,
      sameSite: "Strict",
      path: "/",
      maxAge: 900,
    });
  };
  const authenticate: PrivateRouteSecurity["authenticate"] = async (
    request,
  ) => {
    prune();
    // Header authentication remains available for operator clients.
    if (request.headers.has("authorization"))
      return security.authenticate(request);
    const id = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookie}=`))
      ?.slice(cookie.length + 1);
    const session = id ? sessions.get(id) : undefined;
    if (!session) return;
    const principal = await authenticateToken(session.token);
    if (!principal && id) sessions.delete(id);
    return principal;
  };
  const path = (c: Context) => new URL(c.req.url).pathname;
  const mount = (c: Context) =>
    path(c).replace(/\/(?:login|logout|link\/[^/]*)$/, "");
  // Never continue into another session route, such as a used sign-in link.
  const target = (c: Context, value: unknown) => {
    const returnTo = sessionReturnPath(value, consolePath);
    const prefix = mount(c);
    return prefix && (returnTo === prefix || returnTo.startsWith(`${prefix}/`))
      ? consolePath
      : returnTo;
  };
  const forgetReturn = (c: Context) => {
    if (getCookie(c, returnCookie) !== undefined)
      deleteCookie(c, returnCookie, { path: "/", secure });
  };
  const resume = (c: Context) => {
    const returnTo = target(c, getCookie(c, returnCookie));
    forgetReturn(c);
    return returnTo;
  };
  const signedOut = (c: Context<PrivateEnv>) =>
    c.html(
      messagePage(
        c.get("nonce"),
        "You're signed out",
        "There is no active dashboard session in this browser.",
        401,
        { label: "Sign in", href: `${mount(c)}/login` },
      ),
      401,
    );
  const signOutPage = (
    c: Context<PrivateEnv>,
    principal: string,
    notice?: string,
  ) =>
    page(
      "Sign out of June?",
      c.get("nonce"),
      html`${notice ? html`<div class="notice" data-tone="warn"><p>${notice}</p></div>` : ""}<div class="card"><p>This ends the dashboard session in this browser. Tool permissions and work June has already started are unchanged.</p><form method="post" action="${mount(c)}/logout" autocomplete="off"><input type="hidden" name="proof" value="${proof.issue(principal, `${mount(c)}/logout`, "logout")}"><div class="actions"><button type="submit">Sign out</button><a class="button secondary" href="${consolePath}">Stay signed in</a></div></form></div>`,
      { narrow: true },
    );
  // Anonymous access is confined to login rendering, not console/action routes.
  const routes = privateRoutes({
    ...security,
    authenticate: async () => "login",
  });
  if (login) {
    const unavailable = (c: Context<PrivateEnv>) =>
      c.html(
        page(
          "This sign-in link can't be used",
          c.get("nonce"),
          html`<div class="card"><p>It may have expired, been used already, or been cleared when June restarted. No session was created.</p><p class="hint">Ask June in your private conversation for a new link. If this browser is already signed in, the dashboard still opens.</p><div class="actions"><a class="button" href="${consolePath}">Open dashboard</a><a class="button secondary" href="${mount(c)}/login">Use an operator token</a></div></div>`,
          { narrow: true },
        ),
        410,
      );
    // GET and HEAD only render: previews and unfurlers never redeem a link.
    // A visible, attended browser submits the signed form by itself.
    routes.get("/link/:id", (c) => {
      if (!login.links.has(c.req.param("id"))) return unavailable(c);
      allowNonceScript(c);
      return c.html(
        page(
          "Signing you in",
          c.get("nonce"),
          html`<div class="card"><p class="working" role="status">Opening your private dashboard…</p>${continueForm(proof.issue("login", path(c), "link"), "Continue to June", { attended: true })}<p class="hint">This one-time link came from June. If the dashboard doesn't open by itself, choose Continue. Tool permissions are unchanged.</p></div>`,
          { narrow: true, script: true },
        ),
      );
    });
    routes.post("/link/:id", async (c) => {
      const form = await c.req.parseBody();
      if (!proof.verify("login", path(c), "link", form.proof))
        return c.html(
          messagePage(
            c.get("nonce"),
            "Sign-in not completed",
            "This sign-in form expired or didn't come from your link. Your link has not been used; open it again.",
            403,
          ),
          403,
        );
      if (!(await authenticateToken(login.token))) return unavailable(c);
      prune();
      if (sessions.size >= 64)
        return c.html(
          messagePage(
            c.get("nonce"),
            "Session capacity reached",
            "Try again after an existing session expires. Your link has not been used.",
            503,
          ),
          503,
        );
      if (!login.links.consume(c.req.param("id"))) return unavailable(c);
      setSession(c, login.token);
      return c.redirect(resume(c), 303);
    });
  }
  routes.get("/login", async (c) => {
    const returnTo = target(c, c.req.query("returnTo"));
    // Cross-site links reach this route through the console's same-origin
    // bridge, where the Strict cookie is sent: existing sessions continue.
    if (await authenticate(c.req.raw)) return c.redirect(returnTo, 303);
    if (returnTo === consolePath) forgetReturn(c);
    else
      setCookie(c, returnCookie, returnTo, {
        httpOnly: true,
        secure,
        sameSite: "Strict",
        path: "/",
        maxAge: 600,
      });
    return c.html(
      page(
        "Sign in to June",
        c.get("nonce"),
        html`<div class="card"><p>Ask June for a sign-in link in your private conversation. Opening it signs this browser in directly${returnTo === consolePath ? "" : " and continues where you left off"}.</p><p class="hint">Links work once and expire after 10 minutes. A session lasts 15 minutes and never changes tool permissions.</p></div><details class="disclosure"><summary>Use an operator token</summary><div class="disclosure-body"><form method="post" action="${path(c)}" autocomplete="off"><input type="hidden" name="returnTo" value="${returnTo}"><input type="hidden" name="proof" value="${proof.issue("login", path(c), returnTo)}"><label class="field" for="operator-token"><span>Operator token</span><input id="operator-token" name="token" type="password" autocomplete="off" required maxlength="4096"></label><p class="hint">Held in server memory only; never placed in a URL or browser storage.</p><div class="actions"><button type="submit" class="full">Sign in</button></div></form></div></details>`,
        { narrow: true },
      ),
    );
  });
  routes.post("/login", async (c) => {
    const form = await c.req.parseBody();
    const returnTo = target(c, form.returnTo);
    const recovery = {
      label: "Back to sign in",
      href: `${path(c)}?returnTo=${encodeURIComponent(returnTo)}`,
    };
    if (!proof.verify("login", path(c), returnTo, form.proof))
      return c.html(
        messagePage(
          c.get("nonce"),
          "Sign-in form expired",
          "Open the sign-in page again for a fresh form. No session was created.",
          403,
          recovery,
        ),
        403,
      );
    if (
      typeof form.token !== "string" ||
      !form.token ||
      form.token.length > 4096 ||
      /[\r\n]/u.test(form.token)
    )
      return c.html(
        messagePage(
          c.get("nonce"),
          "Sign-in rejected",
          "The token could not be authenticated. Return to the private login page to try again.",
          401,
          recovery,
        ),
        401,
      );
    const principal = await authenticateToken(form.token);
    if (!principal)
      return c.html(
        messagePage(
          c.get("nonce"),
          "Sign-in rejected",
          "The token could not be authenticated. Return to the private login page to try again.",
          401,
          recovery,
        ),
        401,
      );
    prune();
    // Anonymous failures never consume another principal's sign-in budget.
    const window = logins.get(principal) ?? {
      until: Date.now() + 60_000,
      count: 0,
    };
    logins.set(principal, window);
    if (window.count >= 120) {
      c.header("Retry-After", "60");
      return c.html(
        messagePage(
          c.get("nonce"),
          "Too many sign-in attempts",
          "Wait one minute before signing in again. No new session was created.",
          429,
          recovery,
        ),
        429,
      );
    }
    window.count++;
    if (sessions.size >= 64)
      return c.html(
        messagePage(
          c.get("nonce"),
          "Session capacity reached",
          "Try again after an existing session expires. No new session was created.",
          503,
        ),
        503,
      );
    setSession(c, form.token);
    forgetReturn(c);
    return c.redirect(returnTo, 303);
  });
  routes.get("/logout", async (c) => {
    const principal = await authenticate(c.req.raw);
    if (!principal) return signedOut(c);
    return c.html(signOutPage(c, principal));
  });
  // Signing out is CSRF-checked, not a consent decision: a stale form is
  // replaced with a fresh one instead of a dead end.
  routes.post("/logout", async (c) => {
    const principal = await authenticate(c.req.raw);
    const form = await c.req.parseBody();
    if (!principal) return signedOut(c);
    if (!proof.verify(principal, path(c), "logout", form.proof))
      return c.html(
        signOutPage(
          c,
          principal,
          "That sign-out form expired. Choose Sign out again.",
        ),
        403,
      );
    const id = getCookie(c, cookie);
    if (id) sessions.delete(id);
    deleteCookie(c, cookie, { path: "/", secure });
    forgetReturn(c);
    return c.html(
      page(
        "Signed out",
        c.get("nonce"),
        html`<div class="card"><p>This browser's dashboard session has ended. Tool permissions and work already started are unchanged.</p><div class="actions"><a class="button secondary" href="${mount(c)}/login">Sign in again</a></div></div>`,
        { narrow: true },
      ),
    );
  });
  return { routes, authenticate };
}
