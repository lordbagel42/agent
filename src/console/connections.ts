import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { html } from "hono/html";
import {
  ConnectionInputError,
  type McpConnections,
  type ToolPermission,
} from "../tools/connections.js";
import type { createPuckConsoleOAuth } from "../tools/puck-oauth.js";
import type { createSlackMcpOAuth } from "../tools/slack-mcp-oauth.js";
import { SLACK_APP_ID } from "../tools/slack-mcp-oauth.js";
import { createConnectionOAuthRoutes } from "./connection-oauth.js";
import {
  binding,
  confirmations,
  type PrivateRouteSecurity,
  privateRoutes,
} from "./security.js";
import { badge, confirmForm, consoleNavigation, page } from "./view.js";

export interface ConnectionDependencies {
  store: McpConnections;
  slack?: ReturnType<typeof createSlackMcpOAuth>;
  amp?: ReturnType<typeof createPuckConsoleOAuth>;
}

export function createConnectionRoutes(
  security: PrivateRouteSecurity,
  deps: ConnectionDependencies,
) {
  const root = new Hono();
  const proof = confirmations(security.csrfSecret);
  const base = "/console/connections";
  const navigation = consoleNavigation("/console", "connections", true);
  const addForm = (
    principal: string,
    values = { name: "", url: "" },
    error?: ConnectionInputError,
  ) => {
    const invalid = (field: string) =>
      error?.field === field
        ? html` aria-invalid="true" aria-describedby="add-error"`
        : "";
    return html`<section class="panel"><div class="panel-heading"><h2>Add an MCP server</h2>${badge("Streamable HTTP")}</div><div class="panel-body"><form method="post" action="${base}/add" autocomplete="off"><input type="hidden" name="proof" value="${proof.issue(principal, `${base}/add`, "add")}">${error ? html`<div id="add-error" class="callout warning" role="alert"><strong>Connection not added</strong><p>${error.message}</p><p>Safe name and URL entries are retained. For your security, sensitive URL entries are cleared and any bearer token must be entered again.</p></div>` : ""}<label class="field" for="name">Name</label><input id="name" name="name" required maxlength="80" placeholder="My research tools" value="${values.name}"${invalid("name")}><label class="field" for="url">HTTPS server URL</label><input id="url" name="url" type="url" required maxlength="2048" placeholder="https://example.com/mcp" value="${values.url}"${invalid("url")}><label class="field" for="token">Bearer token <span class="muted">optional for public servers</span></label><input id="token" name="token" type="password" maxlength="4000" autocomplete="off"${invalid("token")}><p class="small muted">Use HTTPS without a username, password, query or fragment. Use a server you trust. Its operator receives your token and tool arguments. Credentials are encrypted on the host, never shown again. Generic OAuth and local commands are not supported.</p><button type="submit">Add connection</button></form></div></section>`;
  };
  const slackOAuth = createConnectionOAuthRoutes(security, {
    id: "slack",
    name: "Slack",
    flow: deps.slack,
  });
  root.route("/slack", slackOAuth.routes);
  // The OAuth server fetches this static public document without a June session.
  // Ingress must expose only this exact metadata path, not the private console.
  root.get("/amp/client.json", (c) => {
    if (!deps.amp) return c.notFound();
    c.header("Cache-Control", "public, max-age=300");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    return c.json(deps.amp.clientMetadataDocument);
  });
  const ampOAuth = createConnectionOAuthRoutes(security, {
    id: "amp",
    name: "Amp",
    flow: deps.amp,
  });
  root.route("/amp", ampOAuth.routes);
  const app = privateRoutes(security);
  const field = (value: unknown) => (typeof value === "string" ? value : "");
  app.get("/", (c) => {
    const connections = deps.store.list();
    const slack = connections.find((connection) => connection.id === "slack");
    const expired = !!slack?.expiresAt && slack.expiresAt <= Date.now();
    const resumable = slackOAuth.hasPending(getCookie(c, slackOAuth.cookie));
    const amp = connections.find((connection) => connection.id === "amp");
    const ampExpired = !!amp?.expiresAt && amp.expiresAt <= Date.now();
    const ampPending = ampOAuth.hasPending(getCookie(c, ampOAuth.cookie));
    return c.html(
      page(
        "Connections",
        c.get("nonce"),
        html`
    <div class="summary-bar"><div><span class="eyebrow">MCP servers</span><p>${deps.store.list().length} connected configurations</p></div><div><span class="eyebrow">Audience</span><p>Owner-private conversations only</p></div><div><span class="eyebrow">Default permission</span><p>All tools disabled</p></div></div>
    <section class="panel"><div class="panel-heading"><h2>Amp</h2>${badge(ampPending ? "Save confirmation needed" : ampExpired ? "Authorization expired" : amp?.authenticated ? "Authorization saved" : deps.amp ? "Not connected" : "Setup required")}</div><div class="panel-body">${ampPending ? html`<p>Your Amp sign-in is waiting for confirmation. Resume to verify the account and save its authorization.</p><a class="button" href="${base}/amp/finish">Resume Amp setup →</a>` : html`<p>${ampExpired ? "Your Amp authorization has expired. Reconnect to use Amp tools again." : amp?.authenticated ? "Your Amp authorization is saved. Discover tools, then choose what June may read or propose from your private conversations." : "Let June use Amp through your account. Sign in directly with Amp; no copied CLI login or API key is needed."}</p><div class="actions">${amp ? html`<a class="button" href="${base}/amp">Manage Amp tools →</a>` : ""}${deps.amp ? html`<form method="post" action="${base}/amp/connect"><input type="hidden" name="proof" value="${proof.issue(c.get("principal"), `${base}/amp/connect`, "amp")}"><button type="submit">${amp ? "Reconnect Amp →" : "Connect Amp →"}</button></form>` : html`<p>A public HTTPS console origin is required for Amp sign-in.</p>`}</div>`}<p class="small muted">Saving authorization does not enable tools. Reads need your permission; actions need approval. Expired grants require reconnecting.</p></div></section>
    <div class="grid"><section class="panel"><div class="panel-heading"><h2>Slack</h2>${badge(resumable ? "Save confirmation needed" : expired ? "Authorization expired" : slack?.authenticated ? "Authorization saved" : deps.slack ? "Not connected" : "Setup required")}</div><div class="panel-body">${resumable ? html`<p>Your Slack return is waiting for confirmation. Resume to save this authorization; do not start another Slack sign-in.</p><div class="actions"><a class="button" href="${base}/slack/finish">Resume Slack setup →</a></div>` : html`<p>${slack?.authenticated ? (expired ? "Your saved Slack authorization has expired. Reconnect to use Slack tools again." : "June has saved your Slack authorization. Manage the connection to discover tools and review their permissions.") : "Connect Slack's official MCP with your own Slack account. This is separate from June's bot login."}</p>${slack ? html`<div class="actions"><a class="button" href="${base}/slack">Manage Slack tools →</a></div>` : ""}${deps.slack ? html`<form method="post" action="${base}/slack/connect"><input type="hidden" name="proof" value="${proof.issue(c.get("principal"), `${base}/slack/connect`, "slack")}"><button type="submit">${slack ? "Reconnect Slack →" : "Connect Slack →"}</button></form>` : html`<div class="callout">The host must configure the Slack app client credentials and register this dashboard's callback before OAuth is available.</div>`}`}<p class="small muted">App ${SLACK_APP_ID} · Saving authorization does not enable tools. Reconnecting resets tool permissions.</p></div></section>
    ${addForm(c.get("principal"))}</div>
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
    // The store durably consumes this command, even after disconnection.
    const input = {
      name: field(form.name),
      url: field(form.url),
      token: field(form.token),
    };
    try {
      deps.store.add(input, command);
    } catch (error) {
      // Only pre-write validation failures are safe to correct and resubmit.
      // Unexpected storage failures retain the private route's uncertain 503.
      if (!(error instanceof ConnectionInputError)) throw error;
      const safe = (value: string, max: number) =>
        value.length <= max &&
        ![input.token, field(form.proof)].some(
          (secret) => secret && value.includes(secret),
        )
          ? value
          : "";
      let url = "";
      try {
        const parsed = new URL(input.url);
        if (
          ["http:", "https:"].includes(parsed.protocol) &&
          !parsed.username &&
          !parsed.password &&
          !parsed.search &&
          !parsed.hash
        )
          url = safe(input.url, 2048);
      } catch {
        /* Malformed URLs may contain credentials: do not reflect them. */
      }
      return c.html(
        page(
          "Check connection details",
          c.get("nonce"),
          html`${addForm(c.get("principal"), { name: safe(input.name, 80), url }, error)}<p><a href="${base}">← Back to connections</a></p>`,
          { navigation },
        ),
        400,
      );
    }
    return c.redirect(`${base}/${command}`, 303);
  });
  app.get("/approvals/:id", (c) => {
    const proposal = deps.store
      .proposals()
      .find((value) => value.id === c.req.param("id"));
    if (!proposal) return c.notFound();
    // Never label an old request with a replacement connection's destination.
    const connection = deps.store
      .list()
      .find(
        (value) =>
          value.id === proposal.connection &&
          value.revision === proposal.revision,
      );
    return c.html(
      page(
        "Review tool request",
        c.get("nonce"),
        html`<section class="panel"><div class="panel-heading"><h2>${proposal.tool}</h2>${badge(proposal.status)}</div><div class="panel-body">${connection ? html`<h3>${connection.name}</h3><p>Destination: <code>${connection.url}</code></p><p class="small muted">${connection.authenticated ? "Uses the credential saved for this connection. The credential is not shown." : "No saved credential is sent."}</p>` : html`<div class="callout warning">The connection has changed or been removed. The reviewed destination is no longer available. Ask June for a new request; this request cannot be approved.</div>`}<p class="small muted">Connection ID: ${proposal.connection} · Revision: ${proposal.revision}</p><p>This action may change external data. Verify the exact destination and arguments below. Approval authorizes this tool call once, not future calls. Approval expires ${new Date(proposal.expiresAt).toISOString()}.</p><pre>${JSON.stringify(proposal.arguments, null, 2)}</pre>${connection && proposal.status === "awaiting_approval" ? confirmForm(proof.issue(c.get("principal"), `${base}/approvals/${proposal.id}`, binding(proposal)), "Approve and execute once") : html`<p>No execution is available. Unknown outcomes must be checked externally; they are never retried here.</p>`}</div></section>`,
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
        html`<section class="panel"><div class="panel-heading"><h2>Connection</h2>${badge(expired ? "Authorization expired" : connection.status)}</div><div class="panel-body">${["slack", "amp"].includes(connection.id) && connection.authenticated ? html`<div class="callout"><strong>${expired ? "Authorization expired" : "Authorization saved"}</strong><p>${expired ? `Reconnect from Connections to renew your ${connection.name} authorization.` : connection.status === "not_tested" ? `Your ${connection.name} account was verified and its authorization saved. Next, discover tools below, then review and enable the ones June may use. No tools are enabled yet.` : `Your ${connection.name} authorization is stored. Tool discovery and permissions are separate; review their status below.`}</p>${connection.account ? html`<p class="small muted">Verified account: <code>${connection.account}</code></p>` : ""}<a href="${base}">← Connections</a></div>` : ""}<p><code>${connection.url}</code></p><p>Discovering tools sends your credential to this exact server. It never runs a tool. Changing a contract disables that tool until reviewed again.</p><form method="post" action="${path}/discover"><input type="hidden" name="proof" value="${proof.issue(c.get("principal"), `${path}/discover`, connection.revision)}"><button type="submit">Test & discover tools</button></form></div></section><div class="section-heading"><h2>Tool permissions</h2><span class="small muted">Changes apply immediately</span></div><div class="callout warning"><strong>Read-only is your authorization, not a server guarantee.</strong><p>Review the complete contract before allowing automatic reads. Use “Approval required” for anything that sends, edits, creates or deletes. Private results go to June's configured model; her answer enters your conversation history.</p></div><div class="stack">${connection.tools.map(
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
