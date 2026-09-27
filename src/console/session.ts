import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import type { ModelProvider } from "../core/contracts.js";
import {
  confirmations,
  type PrivateEnv,
  type PrivateRouteSecurity,
  privateRoutes,
  sessionReturnPath,
} from "./security.js";
import { badge, confirmForm, messagePage, page } from "./view.js";

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
      return {
        reply: (request, signal, isCurrent, canStartAction) =>
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
      };
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
  const secure = security.origin.startsWith("https:");
  const cookie = secure ? "__Host-june-console" : "june-console-dev";
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
  // Anonymous access is confined to login rendering, not console/action routes.
  const routes = privateRoutes({
    ...security,
    authenticate: async () => "login",
  });
  if (login) {
    const unavailable = (c: Context<PrivateEnv>) =>
      c.html(
        page(
          "This sign-in link is no longer available",
          c.get("nonce"),
          html`<section class="panel"><div class="panel-body"><p>It may have expired, already been used, or been cleared by a restart.</p><p>Ask June in your private conversation, or ask Amp, for a new link.</p><div class="actions"><a class="button secondary" href="${consolePath}/session/login">Use an operator token</a></div></div></section>`,
          { narrow: true, description: "No new session was created." },
        ),
        410,
      );
    routes.get("/link/:id", (c) => {
      if (!login.links.has(c.req.param("id"))) return unavailable(c);
      return c.html(
        page(
          "Sign in to June",
          c.get("nonce"),
          html`<section class="panel"><div class="panel-body"><h2>One-time dashboard access</h2><p>Continue to your private dashboard. Only use this link if you requested it from June or Amp.</p><form method="post" autocomplete="off"><input type="hidden" name="proof" value="${proof.issue("login", new URL(c.req.url).pathname, "link")}"><input type="hidden" name="confirmed" value="yes"><button class="full" type="submit">Sign in</button></form></div><div class="login-note">Single-use link · Expires 10 minutes after creation<br>Your browser session lasts 15 minutes. Tool permissions are unchanged.</div></section>`,
          { narrow: true, description: "No operator token to copy or paste." },
        ),
      );
    });
    routes.post("/link/:id", async (c) => {
      const form = await c.req.parseBody();
      if (
        form.confirmed !== "yes" ||
        !proof.verify("login", new URL(c.req.url).pathname, "link", form.proof)
      )
        return c.html(
          messagePage(
            c.get("nonce"),
            "Sign-in confirmation rejected",
            "Open your sign-in link again and use its Sign in button.",
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
      return c.redirect(consolePath, 303);
    });
  }
  routes.get("/login", (c) => {
    const returnTo = sessionReturnPath(c.req.query("returnTo"), consolePath);
    return c.html(
      page(
        "Sign in to June",
        c.get("nonce"),
        html`<section class="panel"><div class="panel-body"><h2>Operator authentication</h2><p class="small">Use the token for this trusted private host. It never appears in a URL or browser storage.</p><form method="post" autocomplete="off"><input type="hidden" name="returnTo" value="${returnTo}"><input type="hidden" name="proof" value="${proof.issue("login", new URL(c.req.url).pathname, returnTo)}"><label class="field" for="operator-token">Operator token</label><input id="operator-token" name="token" type="password" autocomplete="off" required maxlength="4096"><button class="full" type="submit">Sign in</button></form></div><div class="login-note">15-minute session · Token held in server memory<br>Signing in does not grant additional tool permissions.</div></section>`,
        {
          narrow: true,
          description: "Your private workspace. Owner access only.",
        },
      ),
    );
  });
  routes.post("/login", async (c) => {
    const form = await c.req.parseBody();
    const returnTo = sessionReturnPath(form.returnTo, consolePath);
    const recovery = {
      label: "Return to sign in",
      href: `${new URL(c.req.url).pathname}?returnTo=${encodeURIComponent(returnTo)}`,
    };
    if (
      !proof.verify("login", new URL(c.req.url).pathname, returnTo, form.proof)
    )
      return c.html(
        messagePage(
          c.get("nonce"),
          "Sign-in confirmation rejected",
          "Open the private login page again for a fresh form.",
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
    return c.html(
      page(
        "Signed in",
        c.get("nonce"),
        html`<section class="panel"><div class="panel-body">${badge("Active")}<p>Your private session is active for 15 minutes. The host rechecks your token on every request.</p><div class="actions"><a class="button" href="${returnTo}">${returnTo === consolePath ? "Open console →" : "Continue →"}</a><a class="button secondary" href="${new URL(c.req.url).pathname.replace(/\/login$/, "/logout")}">End this session</a></div></div></section>`,
        {
          narrow: true,
          description:
            "Authentication confirmed. Tool permissions are unchanged.",
        },
      ),
    );
  });
  routes.get("/logout", async (c) => {
    const principal = await authenticate(c.req.raw);
    if (!principal)
      return c.html(
        messagePage(
          c.get("nonce"),
          "Authentication required",
          "There is no authenticated session to end. Open the private login page to sign in.",
          401,
          {
            label: "Sign in →",
            href: new URL(c.req.url).pathname.replace(/\/logout$/, "/login"),
          },
        ),
        401,
      );
    return c.html(
      page(
        "End this session",
        c.get("nonce"),
        html`<section class="panel"><div class="panel-body"><div class="callout"><strong>Only this browser session will end</strong><p>This does not revoke tool grants or stop already-started actions.</p></div>${confirmForm(proof.issue(principal, new URL(c.req.url).pathname, "logout"), "Sign out")}</div></section>`,
        {
          narrow: true,
          description: "Confirm before revoking this browser's console access.",
          navigation: [{ label: "← Console", href: consolePath }],
        },
      ),
    );
  });
  routes.post("/logout", async (c) => {
    const principal = await authenticate(c.req.raw);
    const form = await c.req.parseBody();
    if (
      !principal ||
      form.confirmed !== "yes" ||
      !proof.verify(
        principal,
        new URL(c.req.url).pathname,
        "logout",
        form.proof,
      )
    )
      return c.html(
        messagePage(
          c.get("nonce"),
          "Sign-out confirmation rejected",
          "Open the session logout page again and review the confirmation.",
          403,
        ),
        403,
      );
    const id = getCookie(c, cookie);
    if (id) sessions.delete(id);
    deleteCookie(c, cookie, { path: "/", secure });
    return c.html(
      page(
        "Signed out",
        c.get("nonce"),
        html`<section class="panel"><div class="panel-body">${badge("Session ended")}<p>This browser session has been revoked. Tool grants and already-started actions are unchanged.</p><div class="actions"><a class="button secondary" href="${new URL(c.req.url).pathname.replace(/\/logout$/, "/login")}">Return to sign in</a></div></div></section>`,
        {
          narrow: true,
          description: "Private console access is closed for this browser.",
        },
      ),
    );
  });
  return { routes, authenticate };
}
