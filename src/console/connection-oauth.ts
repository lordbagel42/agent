import { randomBytes, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import {
  allowNonceScript,
  binding,
  confirmations,
  type PrivateEnv,
  type PrivateRouteSecurity,
  privateRoutes,
} from "./security.js";
import { consoleNavigation, continueForm, page } from "./view.js";

/** Browser return for explicitly configured providers. The owner consents once,
 * on the provider. Each attempt is bound to the initiating principal, the
 * provider's state and the browser that started it: an HttpOnly Lax cookie,
 * which a provider's top-level redirect still carries. The callback only
 * records the return and moves to a same-origin document, where the Strict
 * console session is present for an authenticated, signed finish POST.
 * Pending state is consumed before the exchange, which is never retried. */
export function createConnectionOAuthRoutes(
  security: PrivateRouteSecurity,
  provider: {
    id: "slack" | "amp" | "github";
    name: string;
    flow?: {
      begin(principal: string): string | Promise<string>;
      complete(principal: string, callback: string): Promise<void>;
    };
  },
) {
  const { id, name, flow } = provider;
  const root = new Hono();
  const app = privateRoutes(security);
  const proof = confirmations(security.csrfSecret);
  const base = "/console/connections";
  const path = `${base}/${id}`;
  const chrome = {
    narrow: true,
    navigation: consoleNavigation("/console", "connections", true),
    signOut: security.signOutPath,
  };
  const secure = security.origin.startsWith("https:");
  const cookie = secure ? `__Host-june-${id}-oauth` : `june-${id}-oauth-dev`;
  const attempts = new Map<
    string,
    { principal: string; state: string; expires: number; callback?: string }
  >();
  const prune = () => {
    for (const [key, attempt] of attempts)
      if (attempt.expires <= Date.now()) attempts.delete(key);
  };
  const same = (a: string, b: string) => {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  };
  const connectForm = (principal: string, label: string) =>
    html`<form method="post" action="${path}/connect"><input type="hidden" name="proof" value="${proof.issue(principal, `${path}/connect`, id)}"><button type="submit">${label}</button></form>`;
  const back = html`<a class="button secondary" href="${base}">Back to Connections</a>`;
  const problem = (
    c: Context<PrivateEnv>,
    title: string,
    detail: string,
    status: 400 | 403 | 409 | 503,
    options: {
      signedIn?: boolean;
      tone?: "neutral" | "warn";
      actions?: ReturnType<typeof html>;
    } = {},
  ) =>
    c.html(
      page(
        title,
        c.get("nonce"),
        html`<div class="notice" data-tone="${options.tone ?? (status === 503 ? "warn" : "danger")}"><p>${detail}</p></div><div class="actions">${options.actions ?? back}</div>`,
        options.signedIn ? chrome : { narrow: true },
      ),
      status,
    );
  // Anonymous: the provider's cross-site redirect omits the Strict session.
  const callback = privateRoutes({
    ...security,
    authenticate: async () => "oauth-return",
  });
  callback.get("/", (c) => {
    prune();
    if (!flow || c.req.url.length > 12_000)
      return problem(
        c,
        `${name} connection unavailable`,
        "Return to Connections and start a fresh sign-in. Nothing was saved.",
        400,
      );
    const key = getCookie(c, cookie) ?? "";
    const attempt = attempts.get(key);
    const query = new URL(c.req.url).searchParams;
    const state = query.get("state") ?? "";
    const matches = !!attempt && !!state && same(state, attempt.state);
    if (query.has("error")) {
      if (matches) {
        attempts.delete(key);
        deleteCookie(c, cookie, { path: "/", secure });
      }
      return matches && query.get("error") === "access_denied"
        ? problem(
            c,
            `${name} sign-in cancelled`,
            `You cancelled on ${name}. Nothing was saved and June's tools are unchanged. Connect again from Connections whenever you're ready.`,
            400,
            { tone: "neutral" },
          )
        : problem(
            c,
            `${name} didn't authorize June`,
            `${name} returned without an authorization. Nothing was saved. Start again from Connections.`,
            400,
            { tone: "warn" },
          );
    }
    if (!attempt)
      return problem(
        c,
        `${name} return not recognized`,
        `This return doesn't belong to a ${name} sign-in started in this browser, or it expired or was already used. Nothing was saved. Start again from Connections in the browser you want to use.`,
        400,
      );
    if (!matches)
      return problem(
        c,
        `${name} return doesn't match`,
        `This return doesn't match the ${name} sign-in started in this browser. Nothing was saved. Start again from Connections.`,
        400,
      );
    if (!query.get("code"))
      return problem(
        c,
        `${name} authorization incomplete`,
        `${name} did not return a complete authorization. Nothing was saved. Start again from Connections.`,
        400,
      );
    const url = `${security.origin}${path}/callback${new URL(c.req.url).search}`;
    // A reload repeats the same return; a different code never replaces it.
    if (attempt.callback && attempt.callback !== url)
      return problem(
        c,
        `${name} return already received`,
        `June already has a ${name} return for this sign-in. This one was ignored and nothing new was saved.`,
        409,
      );
    attempt.callback = url;
    return c.html(
      page(
        "Returning to June",
        c.get("nonce"),
        html`<div class="card"><p class="working" role="status">Finishing your ${name} connection…</p><div class="actions"><a class="button full" href="${path}/finish">Continue</a></div></div>`,
        { narrow: true, refresh: `${path}/finish` },
      ),
    );
  });
  root.route("/callback", callback);
  app.post("/connect", async (c) => {
    const form = await c.req.parseBody();
    const principal = c.get("principal");
    if (!flow || !proof.verify(principal, `${path}/connect`, id, form.proof))
      return problem(
        c,
        `${name} connection unavailable`,
        "This Connect button expired or isn't available on this host. Open Connections and try again. Nothing was started.",
        403,
        { signedIn: true },
      );
    prune();
    if (
      [...attempts.values()].filter(
        (attempt) => attempt.principal !== principal,
      ).length >= 8
    )
      return problem(
        c,
        `${name} sign-in busy`,
        "Too many sign-ins are waiting. Try again in 10 minutes. Nothing was started.",
        503,
        { signedIn: true },
      );
    let target: URL;
    try {
      target = new URL(await flow.begin(principal));
    } catch {
      return problem(
        c,
        `${name} sign-in couldn't start`,
        `June couldn't start a ${name} sign-in. A save may still be finishing; check Connections before trying again.`,
        503,
        { signedIn: true },
      );
    }
    const state = target.searchParams.get("state");
    if (!state)
      return problem(
        c,
        `${name} sign-in couldn't start`,
        `June couldn't bind this ${name} sign-in to your browser. Nothing was saved.`,
        503,
        { signedIn: true },
      );
    // A fresh start replaces this owner's earlier attempt, as the provider does.
    for (const [key, attempt] of attempts)
      if (attempt.principal === principal) attempts.delete(key);
    const key = randomBytes(32).toString("base64url");
    attempts.set(key, { principal, state, expires: Date.now() + 600_000 });
    setCookie(c, cookie, key, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: 600,
    });
    // form-action 'self' blocks a redirect to the provider after this POST,
    // so a same-origin document continues instead (no script needed).
    return c.html(
      page(
        `Continue on ${name}`,
        c.get("nonce"),
        html`<div class="card"><p class="working" role="status">Opening ${name}…</p><p>Review what ${name} asks for there. After you approve, you come back here and June saves the connection. Tools stay disabled until you enable them.</p><div class="actions"><a class="button full" href="${target.href}">Continue to ${name}</a></div></div>`,
        { ...chrome, refresh: target.href },
      ),
    );
  });
  app.get("/finish", (c) => {
    prune();
    const key = getCookie(c, cookie) ?? "";
    const attempt = attempts.get(key);
    const principal = c.get("principal");
    if (!flow || !attempt || attempt.principal !== principal)
      return problem(
        c,
        `No ${name} connection to finish`,
        `No ${name} return is waiting in this browser. It may have finished already, expired after 10 minutes, or been cleared by a June restart. Check Connections for the saved state.`,
        400,
        {
          signedIn: true,
          actions: html`<a class="button" href="${base}">Open Connections</a>`,
        },
      );
    if (!attempt.callback)
      return c.html(
        page(
          `Waiting for ${name}`,
          c.get("nonce"),
          html`<div class="card"><p>${name} hasn't sent this browser back to June yet. Finish approving in the ${name} tab, or start again.</p><div class="actions">${connectForm(principal, "Start again")}${back}</div></div>`,
          chrome,
        ),
      );
    allowNonceScript(c);
    return c.html(
      page(
        `Saving your ${name} connection`,
        c.get("nonce"),
        html`<div class="card"><p class="working" role="status">Verifying your ${name} account and saving the connection…</p>${continueForm(proof.issue(principal, `${path}/finish`, binding(key)), `Finish connecting ${name}`, { action: `${path}/finish` })}<p class="hint">This uses the approval you gave on ${name}. Saving the connection doesn't enable any tools.</p></div>`,
        { ...chrome, script: true },
      ),
    );
  });
  app.post("/finish", async (c) => {
    const form = await c.req.parseBody();
    const key = getCookie(c, cookie) ?? "";
    const attempt = attempts.get(key);
    const principal = c.get("principal");
    if (
      !flow ||
      !attempt?.callback ||
      attempt.principal !== principal ||
      attempt.expires <= Date.now() ||
      !proof.verify(principal, `${path}/finish`, binding(key), form.proof)
    )
      return problem(
        c,
        `${name} connection not finished`,
        "This return is invalid, expired, already used, or belongs to another browser. No token exchange was started. Check Connections for the saved state before starting again.",
        403,
        { signedIn: true },
      );
    // Consume first: a lost response or repeated POST cannot replay the code.
    attempts.delete(key);
    deleteCookie(c, cookie, { path: "/", secure });
    try {
      await flow.complete(principal, attempt.callback);
    } catch {
      return problem(
        c,
        `${name} connection not confirmed`,
        `June could not confirm that this ${name} authorization was verified and saved. ${name} may have rejected it or it may have expired. Check Connections before starting a fresh sign-in; this return can't be reused.`,
        400,
        { signedIn: true },
      );
    }
    return c.redirect(path, 303);
  });
  root.route("/", app);
  return {
    routes: root,
    /** This browser's attempt, for Connections: waiting on the provider, or
     * returned and ready to finish with one signed POST. */
    pending(c: Context, principal: string) {
      prune();
      const key = getCookie(c, cookie) ?? "";
      const attempt = attempts.get(key);
      if (!flow || !attempt || attempt.principal !== principal) return;
      return attempt.callback
        ? {
            state: "returned" as const,
            proof: proof.issue(principal, `${path}/finish`, binding(key)),
          }
        : { state: "waiting" as const };
    },
  };
}
