import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import type { McpConnections, ToolPermission } from "../tools/connections.js";
import type { createSlackMcpOAuth } from "../tools/slack-mcp-oauth.js";
import { SLACK_APP_ID } from "../tools/slack-mcp-oauth.js";
import {
  binding,
  confirmations,
  type PrivateRouteSecurity,
  privateRoutes,
} from "./security.js";
import { badge, confirmForm, messagePage, page } from "./view.js";

export interface ConnectionDependencies {
  store: McpConnections;
  slack?: ReturnType<typeof createSlackMcpOAuth>;
}

export function createConnectionRoutes(
  security: PrivateRouteSecurity,
  deps: ConnectionDependencies,
) {
  const root = new Hono();
  const proof = confirmations(security.csrfSecret);
  const base = "/console/connections";
  const navigation = [
    { label: "← Overview", href: "/console" },
    { label: "Connections", href: base, current: true },
  ];
  const callbacks = new Map<string, { url: string; expires: number }>();
  const secure = security.origin.startsWith("https:");
  const cookie = secure ? "__Host-june-slack-return" : "june-slack-return-dev";
  const slackProblem = (nonce: string, title: string, detail: string) =>
    page(
      title,
      nonce,
      html`<section class="panel"><div class="panel-body"><div class="callout warning"><p>${detail}</p></div><a class="button" href="${base}">Return to Connections →</a></div></section>`,
      { navigation },
    );
  // Strict session cookies are absent on a cross-site OAuth redirect. Keep the
  // callback volatile and resume via a same-origin click, then require the owner
  // session and a POST proof before exchanging a code. Never weaken login cookies.
  const callback = privateRoutes({
    ...security,
    authenticate: async () => "oauth-return",
  });
  callback.get("/", (c) => {
    for (const [id, value] of callbacks)
      if (value.expires <= Date.now()) callbacks.delete(id);
    if (!deps.slack || callbacks.size >= 32 || c.req.url.length > 12_000)
      return c.html(
        messagePage(
          c.get("nonce"),
          "Slack connection unavailable",
          "Return to Connections and start a fresh sign-in.",
          400,
        ),
        400,
      );
    const query = new URL(c.req.url).searchParams;
    if (query.has("error") || !query.get("code") || !query.get("state"))
      return c.html(
        slackProblem(
          c.get("nonce"),
          "Slack authorization incomplete",
          "Slack did not return a complete authorization. No new connection was saved. Return to Connections to start again.",
        ),
        400,
      );
    const id = randomBytes(32).toString("base64url");
    callbacks.set(id, {
      url: `${security.origin}${base}/slack/callback${new URL(c.req.url).search}`,
      expires: Date.now() + 600_000,
    });
    setCookie(c, cookie, id, {
      secure,
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 600,
    });
    return c.html(
      page(
        "Slack setup is not finished",
        c.get("nonce"),
        html`<section class="panel"><div class="panel-body"><h2>One save confirmation remains</h2><p>You have returned from Slack, but June has not saved this authorization yet. Continue here to review and save it with your owner session.</p><div class="actions"><a class="button" href="${base}/slack/finish">Continue to save Slack connection →</a></div><p class="small muted">This step expires after 10 minutes or if June restarts. Saving authorization does not enable tools.</p></div></section>`,
        { navigation },
      ),
    );
  });
  root.route("/slack/callback", callback);
  const app = privateRoutes(security);
  const field = (value: unknown) => (typeof value === "string" ? value : "");
  app.get("/", (c) => {
    const connections = deps.store.list();
    const slack = connections.find((connection) => connection.id === "slack");
    const expired = !!slack?.expiresAt && slack.expiresAt <= Date.now();
    const pending = callbacks.get(getCookie(c, cookie) ?? "");
    const resumable = !!deps.slack && !!pending && pending.expires > Date.now();
    return c.html(
      page(
        "Connections",
        c.get("nonce"),
        html`
    <div class="summary-bar"><div><span class="eyebrow">MCP servers</span><p>${deps.store.list().length} connected configurations</p></div><div><span class="eyebrow">Audience</span><p>Owner-private conversations only</p></div><div><span class="eyebrow">Default permission</span><p>All tools disabled</p></div></div>
    <div class="grid"><section class="panel"><div class="panel-heading"><h2>Slack</h2>${badge(resumable ? "Save confirmation needed" : expired ? "Authorization expired" : slack?.authenticated ? "Authorization saved" : deps.slack ? "Not connected" : "Setup required")}</div><div class="panel-body">${resumable ? html`<p>Your Slack return is waiting for confirmation. Resume to save this authorization; do not start another Slack sign-in.</p><div class="actions"><a class="button" href="${base}/slack/finish">Resume Slack setup →</a></div>` : html`<p>${slack?.authenticated ? (expired ? "Your saved Slack authorization has expired. Reconnect to use Slack tools again." : "June has saved your Slack authorization. Manage the connection to discover tools and review their permissions.") : "Connect Slack's official MCP with your own Slack account. This is separate from June's bot login."}</p>${slack ? html`<div class="actions"><a class="button" href="${base}/slack">Manage Slack tools →</a></div>` : ""}${deps.slack ? html`<form method="post" action="${base}/slack/connect"><input type="hidden" name="proof" value="${proof.issue(c.get("principal"), `${base}/slack/connect`, "slack")}"><button type="submit">${slack ? "Reconnect Slack →" : "Connect Slack →"}</button></form>` : html`<div class="callout">The host must configure the Slack app client credentials and register this dashboard's callback before OAuth is available.</div>`}`}<p class="small muted">App ${SLACK_APP_ID} · Saving authorization does not enable tools. Reconnecting resets tool permissions.</p></div></section>
    <section class="panel"><div class="panel-heading"><h2>Add an MCP server</h2>${badge("Streamable HTTP")}</div><div class="panel-body"><form method="post" action="${base}/add" autocomplete="off"><input type="hidden" name="proof" value="${proof.issue(c.get("principal"), `${base}/add`, "add")}"><label class="field" for="name">Name</label><input id="name" name="name" required maxlength="80" placeholder="My research tools"><label class="field" for="url">HTTPS server URL</label><input id="url" name="url" type="url" required maxlength="2048" placeholder="https://example.com/mcp"><label class="field" for="token">Bearer token <span class="muted">optional for public servers</span></label><input id="token" name="token" type="password" maxlength="4000" autocomplete="off"><p class="small muted">Use a server you trust. Its operator receives your token and tool arguments. Credentials are encrypted on the host, never shown again. Generic OAuth and local commands are not supported.</p><button type="submit">Add connection</button></form></div></section></div>
    <div class="section-heading"><h2>Your connections</h2><span class="small muted">Test, inspect, then enable tools</span></div><div class="stack">${deps.store.list().map((connection) => html`<section class="panel"><div class="panel-heading"><h2>${connection.name}</h2>${badge(connection.expiresAt && connection.expiresAt <= Date.now() ? "Authorization expired" : connection.status)}</div><div class="panel-body"><p><code>${connection.url}</code></p><p class="small muted">${connection.authenticated ? "Credential saved" : "No credential"} · ${connection.tools.filter((tool) => tool.permission !== "disabled").length} enabled / ${connection.tools.length} discovered</p>${connection.status === "unavailable" ? html`<div class="callout warning">Discovery failed. Check the URL, credential, account permissions and server availability. No tools were called.</div>` : ""}<div class="actions"><a class="button" href="${base}/${connection.id}">Manage connection →</a></div></div></section>`)}${deps.store.list().length ? "" : html`<section class="panel"><div class="empty">No connections yet. Add a server or connect Slack to get started.</div></section>`}</div>
    <div class="section-heading"><h2>Tool approvals</h2><span class="small muted">Recent requests and recorded outcomes</span></div><section class="panel">${deps.store.proposals().map((proposal) => html`<article class="record"><div><h3>${proposal.tool}</h3><p>Expires ${new Date(proposal.expiresAt).toISOString()}</p><a href="${base}/approvals/${proposal.id}">Review exact request →</a></div>${badge(proposal.status)}</article>`)}${deps.store.proposals().length ? "" : html`<div class="empty">No pending requests. June will link you here when a tool needs approval.</div>`}</section>`,
        {
          navigation,
          description: "Give June useful tools without giving away control.",
        },
      ),
    );
  });
  app.post("/add", async (c) => {
    const form = await c.req.parseBody();
    const command = proof.verify(
      c.get("principal"),
      `${base}/add`,
      "add",
      form.proof,
    );
    if (!command) return c.text("Invalid or expired form", 403);
    // The proof's command ID makes resubmitting this form replace, not duplicate.
    deps.store.add(
      {
        name: field(form.name),
        url: field(form.url),
        token: field(form.token),
      },
      command,
    );
    return c.redirect(`${base}/${command}`, 303);
  });
  app.post("/slack/connect", async (c) => {
    const form = await c.req.parseBody();
    if (
      !deps.slack ||
      !proof.verify(
        c.get("principal"),
        `${base}/slack/connect`,
        "slack",
        form.proof,
      )
    )
      return c.text("Slack connection unavailable", 403);
    // A same-origin POST starts OAuth; external redirection is navigation, not a form action.
    const target = deps.slack.begin(c.get("principal"));
    return c.html(
      page(
        "Authorize Slack",
        c.get("nonce"),
        html`<section class="panel"><div class="panel-body"><h2>Continue on Slack</h2><p>Review Slack's requested permissions before accepting. Returning here does not enable tools automatically.</p><a class="button" href="${target}">Authorize June in Slack →</a></div></section>`,
        { navigation },
      ),
    );
  });
  app.get("/slack/finish", (c) => {
    const id = getCookie(c, cookie) ?? "";
    const pending = callbacks.get(id);
    if (!pending || pending.expires <= Date.now())
      return c.html(
        slackProblem(
          c.get("nonce"),
          "Slack setup expired",
          "This save confirmation is no longer available. It may have expired, already been used, or been cleared by a June restart. Check your saved connection in Connections before starting again.",
        ),
        400,
      );
    return c.html(
      page(
        "Save Slack connection",
        c.get("nonce"),
        html`<section class="panel"><div class="panel-body"><p>This is the final step, not another Slack sign-in. Confirm below to verify your Slack account and save its authorization to June's encrypted store. All tools start disabled; reconnecting resets existing permissions.</p>${confirmForm(proof.issue(c.get("principal"), `${base}/slack/finish`, binding(id)), "Save Slack connection")}</div></section>`,
        { navigation },
      ),
    );
  });
  app.post("/slack/finish", async (c) => {
    const form = await c.req.parseBody();
    const id = getCookie(c, cookie) ?? "";
    const pending = callbacks.get(id);
    if (
      !deps.slack ||
      !pending ||
      pending.expires <= Date.now() ||
      form.confirmed !== "yes" ||
      !proof.verify(
        c.get("principal"),
        `${base}/slack/finish`,
        binding(id),
        form.proof,
      )
    )
      return c.html(
        slackProblem(
          c.get("nonce"),
          "Slack confirmation rejected",
          "This confirmation is invalid, expired, or already used. No token exchange was started by this submission. Return to Connections to check the saved status or resume setup.",
        ),
        403,
      );
    callbacks.delete(id);
    deleteCookie(c, cookie, { path: "/", secure });
    try {
      await deps.slack.complete(c.get("principal"), pending.url);
    } catch {
      return c.html(
        slackProblem(
          c.get("nonce"),
          "Slack connection not confirmed",
          "June could not confirm that this Slack authorization was verified and saved. The attempt may have expired or been rejected by Slack. Check the saved status in Connections before starting a fresh sign-in; this confirmation cannot be reused.",
        ),
        400,
      );
    }
    return c.redirect(`${base}/slack`, 303);
  });
  app.get("/approvals/:id", (c) => {
    const proposal = deps.store
      .proposals()
      .find((value) => value.id === c.req.param("id"));
    if (!proposal) return c.notFound();
    return c.html(
      page(
        "Review tool request",
        c.get("nonce"),
        html`<section class="panel"><div class="panel-heading"><h2>${proposal.tool}</h2>${badge(proposal.status)}</div><div class="panel-body"><p>Connection: ${proposal.connection}. This action may change external data. Verify the exact destination and arguments. Approval expires ${new Date(proposal.expiresAt).toISOString()}.</p><pre>${JSON.stringify(proposal.arguments, null, 2)}</pre>${proposal.status === "awaiting_approval" ? confirmForm(proof.issue(c.get("principal"), `${base}/approvals/${proposal.id}`, binding(proposal)), "Approve and execute once") : html`<p>No execution is available. Unknown outcomes must be checked externally; they are never retried here.</p>`}</div></section>`,
        { navigation },
      ),
    );
  });
  app.post("/approvals/:id", async (c) => {
    const proposal = deps.store
      .proposals()
      .find((value) => value.id === c.req.param("id"));
    const form = await c.req.parseBody();
    if (
      !proposal ||
      form.confirmed !== "yes" ||
      !proof.verify(
        c.get("principal"),
        `${base}/approvals/${proposal.id}`,
        binding(proposal),
        form.proof,
      )
    )
      return c.text("Request changed or confirmation expired", 403);
    await deps.store.confirm(proposal.id);
    return c.redirect(`${base}/approvals/${proposal.id}`, 303);
  });
  app.get("/:id", (c) => {
    const connection = deps.store
      .list()
      .find((value) => value.id === c.req.param("id"));
    if (!connection) return c.notFound();
    const path = `${base}/${connection.id}`;
    const expired =
      !!connection.expiresAt && connection.expiresAt <= Date.now();
    return c.html(
      page(
        connection.name,
        c.get("nonce"),
        html`<section class="panel"><div class="panel-heading"><h2>Connection</h2>${badge(expired ? "Authorization expired" : connection.status)}</div><div class="panel-body">${connection.id === "slack" && connection.authenticated ? html`<div class="callout"><strong>${expired ? "Authorization expired" : "Authorization saved"}</strong><p>${expired ? "Reconnect from Connections to renew your Slack authorization." : connection.status === "not_tested" ? "Your Slack account was verified and its authorization saved. Next, discover tools below, then review and enable the ones June may use. No tools are enabled yet." : "Your Slack authorization is stored. Tool discovery and permissions are separate; review their status below."}</p><a href="${base}">← Connections</a></div>` : ""}<p><code>${connection.url}</code></p><p>Discovering tools sends your credential to this exact server. It never runs a tool. Changing a contract disables that tool until reviewed again.</p><form method="post" action="${path}/discover"><input type="hidden" name="proof" value="${proof.issue(c.get("principal"), `${path}/discover`, connection.revision)}"><button type="submit">Test & discover tools</button></form></div></section><div class="section-heading"><h2>Tool permissions</h2><span class="small muted">Changes apply immediately</span></div><div class="callout warning"><strong>Read-only is your authorization, not a server guarantee.</strong><p>Review the complete contract before allowing automatic reads. Use “Approval required” for anything that sends, edits, creates or deletes. Private results go to June's configured model; her answer enters your conversation history.</p></div><div class="stack">${connection.tools.map(
          ({ contract, permission }) =>
            html`<section class="panel"><div class="panel-heading"><h2>${contract.name}</h2>${badge(permission)}</div><div class="panel-body"><p>${contract.description ?? "No description supplied."}</p><details><summary>Inspect full tool contract</summary><pre>${JSON.stringify(contract, null, 2)}</pre></details><form method="post" action="${path}/permission"><input type="hidden" name="tool" value="${contract.name}"><input type="hidden" name="proof" value="${proof.issue(c.get("principal"), `${path}/permission`, binding([connection.revision, contract.name]))}"><label class="field">Permission <select name="permission">${(
              [
                ["disabled", "Disabled"],
                ["read", "Allow read-only use in my DMs"],
                ["approval", "Approval required for every call"],
              ] as const
            ).map(
              ([value, label]) =>
                html`<option value="${value}"${permission === value ? html` selected` : ""}>${label}</option>`,
            )}</select></label><label class="field"><input type="checkbox" name="confirmed" value="yes" required> I reviewed this contract and authorize this permission.</label><button type="submit">Save permission</button></form></div></section>`,
        )}${connection.tools.length ? "" : html`<section class="panel"><div class="empty">No tools discovered. Test this connection first.</div></section>`}</div><section class="panel"><div class="panel-body"><h2>Disconnect</h2><p>Forget this credential and block future calls. Already-started external actions cannot be recalled.</p><form method="post" action="${path}/disconnect"><input type="hidden" name="proof" value="${proof.issue(c.get("principal"), `${path}/disconnect`, connection.revision)}"><label class="field"><input type="checkbox" name="confirmed" value="yes" required> Disconnect this server</label><button class="secondary" type="submit">Disconnect</button></form></div></section>`,
        { navigation },
      ),
    );
  });
  for (const action of ["discover", "disconnect", "permission"] as const)
    app.post(`/:id/${action}`, async (c) => {
      const connection = deps.store
        .list()
        .find((value) => value.id === c.req.param("id"));
      const form = await c.req.parseBody();
      const tool = field(form.tool);
      if (
        !connection ||
        !proof.verify(
          c.get("principal"),
          `${base}/${connection.id}/${action}`,
          action === "permission"
            ? binding([connection.revision, tool])
            : connection.revision,
          form.proof,
        ) ||
        (action !== "discover" && form.confirmed !== "yes")
      )
        return c.text("Connection changed or confirmation expired", 403);
      if (action === "discover")
        await deps.store.discover(connection.id, connection.revision);
      if (action === "disconnect")
        deps.store.disconnect(connection.id, connection.revision);
      if (action === "permission")
        deps.store.permit(
          connection.id,
          connection.revision,
          tool,
          field(form.permission) as ToolPermission,
        );
      return c.redirect(
        action === "disconnect" ? base : `${base}/${connection.id}`,
        303,
      );
    });
  root.route("/", app);
  return root;
}
