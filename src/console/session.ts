import { randomBytes } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import {
  confirmations,
  type PrivateRouteSecurity,
  privateRoutes,
} from "./security.js";
import { confirmForm, page } from "./view.js";

/** Optional browser bridge for the host's existing Bearer authentication.
 * Mount routes on private ingress only. Tokens stay in server memory for at most
 * 15 minutes and are revalidated on every request. Restart logs everyone out. */
export function createConsoleSessionBridge(
  security: PrivateRouteSecurity,
  consolePath = "/console",
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
  routes.get("/login", (c) =>
    c.html(
      page(
        "Welcome back",
        c.get("nonce"),
        html`<section class="panel"><h2>Unlock your private console</h2><p>Enter the operator token. It stays on this server for a 15-minute session, never in a URL or browser storage. Use only on your trusted private origin.</p><form method="post" autocomplete="off"><input type="hidden" name="proof" value="${proof.issue("login", new URL(c.req.url).pathname, "login")}"><label>Operator token <input name="token" type="password" autocomplete="off" required maxlength="4096"></label><button type="submit">Sign in</button></form></section>`,
      ),
    ),
  );
  routes.post("/login", async (c) => {
    const form = await c.req.parseBody();
    if (
      !proof.verify("login", new URL(c.req.url).pathname, "login", form.proof)
    )
      return c.text("Sign-in confirmation rejected.", 403);
    if (
      typeof form.token !== "string" ||
      !form.token ||
      form.token.length > 4096 ||
      /[\r\n]/u.test(form.token)
    )
      return c.text("Sign-in rejected.", 401);
    const principal = await authenticateToken(form.token);
    if (!principal) return c.text("Sign-in rejected.", 401);
    prune();
    if (sessions.size >= 64)
      return c.text(
        "Session capacity reached. Try again after an existing session expires.",
        503,
      );
    const previous = getCookie(c, cookie);
    if (previous) sessions.delete(previous);
    const id = randomBytes(32).toString("base64url");
    sessions.set(id, { token: form.token, expires: Date.now() + 900_000 });
    setTimeout(() => sessions.delete(id), 900_000).unref();
    setCookie(c, cookie, id, {
      httpOnly: true,
      secure,
      sameSite: "Strict",
      path: "/",
      maxAge: 900,
    });
    return c.html(
      page(
        "Signed in",
        c.get("nonce"),
        html`<section class="panel"><p>Your private session is active for 15 minutes.</p><p><a href="${consolePath}">Open console →</a></p><p><a href="${new URL(c.req.url).pathname.replace(/\/login$/, "/logout")}">End this session</a></p></section>`,
      ),
    );
  });
  routes.get("/logout", async (c) => {
    const principal = await authenticate(c.req.raw);
    if (!principal) return c.text("Authentication required.", 401);
    return c.html(
      page(
        "End this session",
        c.get("nonce"),
        html`<section class="panel"><p>This revokes this browser's private console session, not tool grants or already-started actions.</p>${confirmForm(proof.issue(principal, new URL(c.req.url).pathname, "logout"), "Sign out")}</section>`,
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
      return c.text("Sign-out confirmation rejected.", 403);
    const id = getCookie(c, cookie);
    if (id) sessions.delete(id);
    deleteCookie(c, cookie, { path: "/", secure });
    return c.html(
      page(
        "Signed out",
        c.get("nonce"),
        html`<p>This browser session has been revoked.</p>`,
      ),
    );
  });
  return { routes, authenticate };
}
