import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import {
  binding,
  confirmations,
  type PrivateRouteSecurity,
  privateRoutes,
} from "./security.js";
import { confirmForm, consoleNavigation, messagePage, page } from "./view.js";

/** Shared browser return/owner-confirmation boundary for explicitly configured
 * providers. Callback URLs stay volatile; only an authenticated same-origin POST
 * exchanges a code. This does not relax the console's Strict session cookie. */
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
  const navigation = consoleNavigation("/console", "connections", true);
  const secure = security.origin.startsWith("https:");
  const cookie = secure ? `__Host-june-${id}-return` : `june-${id}-return-dev`;
  const callbacks = new Map<string, { url: string; expires: number }>();
  const problem = (nonce: string, title: string, detail: string) =>
    page(
      title,
      nonce,
      html`<section class="panel"><div class="panel-body"><div class="callout warning"><p>${detail}</p></div><a class="button" href="${base}">Return to Connections →</a></div></section>`,
      { navigation },
    );
  const callback = privateRoutes({
    ...security,
    authenticate: async () => "oauth-return",
  });
  callback.get("/", (c) => {
    for (const [key, value] of callbacks)
      if (value.expires <= Date.now()) callbacks.delete(key);
    if (!flow || callbacks.size >= 32 || c.req.url.length > 12_000)
      return c.html(
        messagePage(
          c.get("nonce"),
          `${name} connection unavailable`,
          "Return to Connections and start a fresh sign-in.",
          400,
        ),
        400,
      );
    const query = new URL(c.req.url).searchParams;
    if (query.has("error") || !query.get("code") || !query.get("state"))
      return c.html(
        problem(
          c.get("nonce"),
          `${name} authorization incomplete`,
          `${name} did not return a complete authorization. No new connection was saved. Return to Connections to start again.`,
        ),
        400,
      );
    const key = randomBytes(32).toString("base64url");
    callbacks.set(key, {
      url: `${security.origin}${path}/callback${new URL(c.req.url).search}`,
      expires: Date.now() + 600_000,
    });
    setCookie(c, cookie, key, {
      secure,
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 600,
    });
    return c.html(
      page(
        `${name} setup is not finished`,
        c.get("nonce"),
        html`<section class="panel"><div class="panel-body"><h2>One save confirmation remains</h2><p>You have returned from ${name}, but June has not saved this authorization yet. Continue here to review and save it with your owner session.</p><div class="actions"><a class="button" href="${path}/finish">Continue to save ${name} connection →</a></div><p class="small muted">This step expires after 10 minutes or if June restarts. Saving authorization does not enable tools.</p></div></section>`,
        { navigation },
      ),
    );
  });
  root.route("/callback", callback);
  app.post("/connect", async (c) => {
    const form = await c.req.parseBody();
    if (
      !flow ||
      !proof.verify(c.get("principal"), `${path}/connect`, id, form.proof)
    )
      return c.text(`${name} connection unavailable`, 403);
    const target = await flow.begin(c.get("principal"));
    return c.html(
      page(
        `Authorize ${name}`,
        c.get("nonce"),
        html`<section class="panel"><div class="panel-body"><h2>Continue on ${name}</h2><p>Review ${name}'s requested permissions before accepting. Returning here does not enable tools automatically.</p><a class="button" href="${target}">Authorize June in ${name} →</a></div></section>`,
        { navigation },
      ),
    );
  });
  app.get("/finish", (c) => {
    const key = getCookie(c, cookie) ?? "";
    const pending = callbacks.get(key);
    if (!pending || pending.expires <= Date.now())
      return c.html(
        problem(
          c.get("nonce"),
          `${name} setup expired`,
          "This save confirmation is no longer available. It may have expired, already been used, or been cleared by a June restart. Check your saved connection in Connections before starting again.",
        ),
        400,
      );
    return c.html(
      page(
        `Save ${name} connection`,
        c.get("nonce"),
        html`<section class="panel"><div class="panel-body"><p>This is the final step, not another ${name} sign-in. Confirm below to verify your ${name} account and save its authorization to June's encrypted store. All tools start disabled; reconnecting resets existing permissions.</p>${confirmForm(proof.issue(c.get("principal"), `${path}/finish`, binding(key)), `Save ${name} connection`)}</div></section>`,
        { navigation },
      ),
    );
  });
  app.post("/finish", async (c) => {
    const form = await c.req.parseBody();
    const key = getCookie(c, cookie) ?? "";
    const pending = callbacks.get(key);
    if (
      !flow ||
      !pending ||
      pending.expires <= Date.now() ||
      form.confirmed !== "yes" ||
      !proof.verify(
        c.get("principal"),
        `${path}/finish`,
        binding(key),
        form.proof,
      )
    )
      return c.html(
        problem(
          c.get("nonce"),
          `${name} confirmation rejected`,
          "This confirmation is invalid, expired, or already used. No token exchange was started by this submission. Return to Connections to check the saved status or resume setup.",
        ),
        403,
      );
    callbacks.delete(key);
    deleteCookie(c, cookie, { path: "/", secure });
    try {
      await flow.complete(c.get("principal"), pending.url);
    } catch {
      return c.html(
        problem(
          c.get("nonce"),
          `${name} connection not confirmed`,
          `June could not confirm that this ${name} authorization was verified and saved. The attempt may have expired or been rejected by ${name}. Check the saved status in Connections before starting a fresh sign-in; this confirmation cannot be reused.`,
        ),
        400,
      );
    }
    return c.redirect(path, 303);
  });
  root.route("/", app);
  return {
    routes: root,
    cookie,
    hasPending(key: string | undefined) {
      const pending = callbacks.get(key ?? "");
      return !!flow && !!pending && pending.expires > Date.now();
    },
  };
}
