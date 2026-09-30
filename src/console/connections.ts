import { type Context, Hono } from "hono";
import { html } from "hono/html";
import {
  ConnectionInputError,
  type ConnectionView,
  type McpConnections,
  type ToolPermission,
} from "../tools/connections.js";
import type { createGitHubOAuth } from "../tools/github-oauth.js";
import type { createPuckConsoleOAuth } from "../tools/puck-oauth.js";
import type { createSlackMcpOAuth } from "../tools/slack-mcp-oauth.js";
import { createConnectionOAuthRoutes } from "./connection-oauth.js";
import {
  binding,
  confirmations,
  type PrivateEnv,
  type PrivateRouteSecurity,
  privateRoutes,
} from "./security.js";
import {
  badge,
  confirmForm,
  consoleNavigation,
  metadata,
  page,
  relative,
  utc,
} from "./view.js";

export interface ConnectionDependencies {
  store: McpConnections;
  slack?: ReturnType<typeof createSlackMcpOAuth>;
  amp?: ReturnType<typeof createPuckConsoleOAuth>;
  github?: ReturnType<typeof createGitHubOAuth>;
  githubAppSlug?: string;
}

// Account providers use their own sign-in; every other entry is a tool server.
const providers = [
  {
    id: "github",
    name: "GitHub",
    purpose:
      "Commits, repositories and issues through GitHub's official MCP server.",
    setup:
      "The host must register a GitHub App and configure its client credentials, owner account ID and webhook secret.",
    notes:
      "Account authorization, repository installation and tool permissions are separate steps. Tokens refresh privately when possible; a failed or uncertain refresh requires reconnecting. Events wake June only when the host's shared event ingress is enabled, and receiving an event grants no permissions.",
  },
  {
    id: "slack",
    name: "Slack",
    purpose:
      "Search Slack as you through Slack's official MCP server. Separate from June's bot login.",
    setup:
      "The host must configure the Slack app client credentials and register this dashboard's callback.",
    notes:
      "Uses the host-configured Slack app. Expired Slack authorization requires reconnecting.",
  },
  {
    id: "amp",
    name: "Amp",
    purpose:
      "Use Amp through your own Amp account. No copied CLI login or API key.",
    setup: "Amp sign-in requires a public HTTPS dashboard origin.",
    notes:
      "Expired Amp access requires reconnecting; there is no background refresh.",
  },
] as const;
const accountIds: readonly string[] = providers.map(({ id }) => id);

const expired = (connection: ConnectionView) =>
  !!connection.expiresAt &&
  connection.expiresAt <= Date.now() &&
  !connection.refreshable;
const serverStatus = (connection: ConnectionView) =>
  expired(connection)
    ? "Authorization expired"
    : connection.status === "connected"
      ? "Tools discovered"
      : connection.status === "unavailable"
        ? "Discovery failed"
        : "Not tested";
const toolSummary = (connection: ConnectionView) => {
  const enabled = connection.tools.filter(
    (tool) => tool.permission !== "disabled",
  ).length;
  return connection.status === "not_tested"
    ? "Tools not discovered yet"
    : connection.status === "unavailable"
      ? "Last discovery failed"
      : `${enabled} of ${connection.tools.length} tools enabled`;
};
const requestStatus: Record<string, string> = {
  awaiting_approval: "Awaiting approval",
  unknown: "Outcome unknown",
  not_started: "Not started",
};

/** Items the owner should act on, for the overview. Links only; no actions. */
export function connectionAttention(store: McpConnections) {
  const base = "/console/connections";
  const connections = store.list();
  const name = (id: string) =>
    connections.find((connection) => connection.id === id)?.name ??
    "a removed connection";
  return [
    ...store
      .proposals()
      .filter(({ status }) => ["awaiting_approval", "unknown"].includes(status))
      .map((proposal) =>
        proposal.status === "awaiting_approval"
          ? {
              title: `Review ${proposal.tool}`,
              detail: `Tool request on ${name(proposal.connection)} · expires ${relative(proposal.expiresAt)}`,
              href: `${base}/approvals/${proposal.id}`,
              status: "Awaiting approval",
            }
          : {
              title: `Reconcile ${proposal.tool}`,
              detail: `Outcome unknown on ${name(proposal.connection)}. Check the external result; it is never retried automatically.`,
              href: `${base}/approvals/${proposal.id}`,
              status: "Outcome unknown",
            },
      ),
    ...connections
      .filter(
        (connection) =>
          expired(connection) || connection.status === "unavailable",
      )
      .map((connection) =>
        expired(connection)
          ? {
              title: `Reconnect ${connection.name}`,
              detail: "Its saved authorization has expired.",
              href: accountIds.includes(connection.id)
                ? `${base}#${connection.id}`
                : `${base}/${connection.id}`,
              status: "Authorization expired",
            }
          : {
              title: `Check ${connection.name}`,
              detail:
                "Tool discovery failed. No tools were called; the cause is unknown.",
              href: `${base}/${connection.id}`,
              status: "Discovery failed",
            },
      ),
  ];
}

/** Counts for the overview. proposals() reports recent history only. */
export function connectionSummary(store: McpConnections) {
  const connections = store.list();
  return {
    saved: connections.length,
    enabled: connections.reduce(
      (sum, connection) =>
        sum +
        connection.tools.filter((tool) => tool.permission !== "disabled")
          .length,
      0,
    ),
    awaiting: store
      .proposals()
      .filter(({ status }) => status === "awaiting_approval").length,
  };
}

export function createConnectionRoutes(
  security: PrivateRouteSecurity,
  deps: ConnectionDependencies,
) {
  const root = new Hono();
  const proof = confirmations(security.csrfSecret);
  const base = "/console/connections";
  const chrome = {
    navigation: consoleNavigation("/console", "connections", true),
    signOut: security.signOutPath,
  };
  const crumbs = [{ label: "Connections", href: base }];
  const addForm = (
    principal: string,
    values = { name: "", url: "" },
    error?: ConnectionInputError,
  ) => {
    const invalid = (field: string) =>
      error?.field === field
        ? html` aria-invalid="true" aria-describedby="add-error"`
        : "";
    return html`<form method="post" action="${base}/add" autocomplete="off"><input type="hidden" name="proof" value="${proof.issue(principal, `${base}/add`, "add")}">${error ? html`<div id="add-error" class="notice" data-tone="warn" role="alert"><strong>Server not added</strong><p>${error.message}</p><p>Safe name and URL entries are kept. Sensitive URL entries are cleared, and any bearer token must be entered again.</p></div>` : ""}<label class="field" for="name"><span>Name</span><input id="name" name="name" required maxlength="80" placeholder="My research tools" value="${values.name}"${invalid("name")}></label><label class="field" for="url"><span>HTTPS server URL</span><input id="url" name="url" type="url" required maxlength="2048" placeholder="https://example.com/mcp" value="${values.url}"${invalid("url")}></label><label class="field" for="token"><span>Bearer token <span class="hint">optional for public servers</span></span><input id="token" name="token" type="password" maxlength="4000" autocomplete="off"${invalid("token")}></label><p class="hint">Streamable HTTP over HTTPS, without a username, password, query or fragment. Use a server you trust: its operator receives your token and tool arguments. Credentials are encrypted on the host and never shown again. Generic OAuth and local commands are not supported.</p><div class="actions"><button type="submit">Add server</button></div></form>`;
  };
  const oauth = {
    github: createConnectionOAuthRoutes(security, {
      id: "github",
      name: "GitHub",
      flow: deps.github,
    }),
    slack: createConnectionOAuthRoutes(security, {
      id: "slack",
      name: "Slack",
      flow: deps.slack,
    }),
    amp: createConnectionOAuthRoutes(security, {
      id: "amp",
      name: "Amp",
      flow: deps.amp,
    }),
  };
  const configured = {
    github: !!deps.github,
    slack: !!deps.slack,
    amp: !!deps.amp,
  };
  root.route("/slack", oauth.slack.routes);
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
  root.route("/amp", oauth.amp.routes);
  root.route("/github", oauth.github.routes);
  const app = privateRoutes(security);
  const field = (value: unknown) => (typeof value === "string" ? value : "");
  const connectForm = (principal: string, id: string, label: string) =>
    html`<form method="post" action="${base}/${id}/connect"><input type="hidden" name="proof" value="${proof.issue(principal, `${base}/${id}/connect`, id)}"><button type="submit">${label}</button></form>`;
  const rejected = (c: Context<PrivateEnv>, title: string, detail: string) =>
    c.html(
      page(
        title,
        c.get("nonce"),
        html`<div class="notice" data-tone="danger"><p>${detail}</p></div><div class="actions"><a class="button secondary" href="${base}">Back to Connections</a></div>`,
        { ...chrome, narrow: true },
      ),
      403,
    );
  const account = (
    c: Context<PrivateEnv>,
    provider: (typeof providers)[number],
    connection: ConnectionView | undefined,
  ) => {
    const principal = c.get("principal");
    const { id, name } = provider;
    const pending = oauth[id].pending(c, principal);
    const manage = connection
      ? html`<a class="button secondary" href="${base}/${id}">Manage</a>`
      : "";
    let status: ReturnType<typeof badge>;
    let detail: string;
    let action: ReturnType<typeof html> | string = "";
    if (pending?.state === "returned") {
      status = badge("Approval received");
      detail = `${name} approved June. Finish to verify your account and save the connection.`;
      action = html`<form method="post" action="${base}/${id}/finish"><input type="hidden" name="proof" value="${pending.proof}"><button type="submit">Finish connecting</button></form>`;
    } else if (pending) {
      status = badge(`Waiting for ${name}`, "warn");
      detail = `A ${name} sign-in started in this browser hasn't returned yet. Starting again replaces it.`;
      action = html`${connectForm(principal, id, "Start again")}${manage}`;
    } else if (connection && expired(connection)) {
      status = badge("Authorization expired");
      detail = `Reconnect to use ${name} tools again. Reconnecting resets tool permissions.`;
      action = html`${configured[id] ? connectForm(principal, id, `Reconnect ${name}`) : ""}${manage}`;
    } else if (connection?.authenticated) {
      status = badge("Authorization saved");
      detail = `${toolSummary(connection)}${connection.account ? ` · account ${connection.account}` : ""}`;
      action = html`${manage}${id === "github" && deps.githubAppSlug ? html`<a class="button secondary" href="${`https://github.com/apps/${encodeURIComponent(deps.githubAppSlug)}/installations/new`}">Choose repositories</a>` : ""}`;
    } else {
      status = badge("Not connected");
      detail = provider.purpose;
      action = html`${configured[id] ? connectForm(principal, id, `Connect ${name}`) : ""}${manage}`;
    }
    return html`<li class="item" id="${id}"><div class="item-body"><h3>${name}</h3><p>${detail}</p></div><div class="item-side">${status}${action}</div><details class="more"><summary>About ${name} access</summary><div class="more-body"><p class="hint">${connection && detail !== provider.purpose ? `${provider.purpose} ` : ""}${provider.notes} Saving authorization does not enable tools; each tool starts disabled.</p></div></details></li>`;
  };
  app.get("/", (c) => {
    const principal = c.get("principal");
    const connections = deps.store.list();
    const proposals = deps.store.proposals();
    const find = (id: string) =>
      connections.find((connection) => connection.id === id);
    const available = providers.filter(({ id }) => configured[id] || find(id));
    const unavailable = providers.filter(
      ({ id }) => !configured[id] && !find(id),
    );
    const servers = connections.filter(({ id }) => !accountIds.includes(id));
    const open = proposals.filter(({ status }) =>
      ["awaiting_approval", "unknown"].includes(status),
    );
    const earlier = proposals.filter((proposal) => !open.includes(proposal));
    const request = (proposal: (typeof proposals)[number]) =>
      html`<li class="item"><div class="item-body"><h3>${proposal.tool}</h3><p class="item-meta">${find(proposal.connection)?.name ?? "Removed connection"}${proposal.status === "awaiting_approval" ? ` · expires ${relative(proposal.expiresAt)}` : ""}</p></div><div class="item-side">${badge(requestStatus[proposal.status] ?? proposal.status)}<a class="button${proposal.status === "awaiting_approval" ? "" : " secondary"}" href="${base}/approvals/${proposal.id}">Review</a></div></li>`;
    return c.html(
      page(
        "Connections",
        c.get("nonce"),
        html`${
          open.some(({ status }) => status === "awaiting_approval")
            ? html`<div class="notice" data-tone="warn"><strong>${open.filter(({ status }) => status === "awaiting_approval").length} recent tool request${open.filter(({ status }) => status === "awaiting_approval").length === 1 ? "" : "s"} awaiting your approval</strong><p>Nothing runs until you approve the exact request. <a href="#requests">Review requests</a></p></div>`
            : ""
        }<section class="section" aria-labelledby="accounts"><div class="section-head"><h2 id="accounts">Accounts</h2><span class="section-note">Sign in once on the provider; June saves the connection when you return</span></div>${available.length ? html`<ul class="list">${available.map((provider) => account(c, provider, find(provider.id)))}</ul>` : html`<div class="list"><p class="empty">No account providers are configured on this host.</p></div>`}${
          unavailable.length
            ? html`<details class="disclosure"><summary>Not set up on this host: ${unavailable.map(({ name }) => name).join(", ")}</summary><div class="disclosure-body">${unavailable.map((provider) => html`<p><strong>${provider.name}.</strong> <span class="hint">${provider.setup}</span></p>`)}</div></details>`
            : ""
        }</section><section class="section" aria-labelledby="servers"><div class="section-head"><h2 id="servers">Tool servers</h2><span class="section-note">Test, review contracts, then choose what June may use</span></div>${
          servers.length
            ? html`<ul class="list">${servers.map((connection) => html`<li class="item"><div class="item-body"><h3>${connection.name}</h3><p><code>${connection.url}</code></p><p class="item-meta">${connection.authenticated ? "Credential saved" : "No credential"} · ${toolSummary(connection)}</p></div><div class="item-side">${badge(serverStatus(connection))}<a class="button secondary" href="${base}/${connection.id}">Manage</a></div></li>`)}</ul>`
            : html`<div class="list"><p class="empty">No tool servers yet. Add a trusted MCP server below.</p></div>`
        }<details class="disclosure"${servers.length ? "" : html` open`}><summary>Add an MCP server</summary><div class="disclosure-body">${addForm(principal)}</div></details></section><section class="section" aria-labelledby="requests"><div class="section-head"><h2 id="requests">Tool requests</h2><span class="section-note">Recent history only. June links you here when a tool needs approval</span></div>${open.length ? html`<ul class="list">${open.map(request)}</ul>` : html`<div class="list"><p class="empty">No recent requests are waiting for you.</p></div>`}${earlier.length ? html`<details class="disclosure"><summary>Earlier requests (${earlier.length})</summary><ul class="list">${earlier.map(request)}</ul></details>` : ""}</section>`,
        {
          ...chrome,
          description:
            "Accounts and tool servers June can use. Every tool starts disabled until you choose otherwise.",
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
    if (!command)
      return rejected(
        c,
        "Form expired",
        "This form expired or came from elsewhere. Open Connections for a fresh form. Nothing was added.",
      );
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
          "Check the server details",
          c.get("nonce"),
          addForm(
            c.get("principal"),
            { name: safe(input.name, 80), url },
            error,
          ),
          { ...chrome, crumbs, narrow: true },
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
    const reviewable = connection && proposal.status === "awaiting_approval";
    return c.html(
      page(
        "Review tool request",
        c.get("nonce"),
        html`${connection ? "" : html`<div class="notice" data-tone="danger"><strong>Connection changed since this request</strong><p>The connection has changed or been removed, so the reviewed destination is no longer shown and this request can't be approved. Ask June for a new request if you still need it.</p></div>`}${metadata(
          {
            // The tool stays identifiable after any connection change.
            Tool: proposal.tool,
            // Destination facts only from the exact reviewed revision.
            ...(connection
              ? {
                  Server: connection.name,
                  Destination: connection.url,
                  Credential: connection.authenticated
                    ? "The saved credential for this connection is sent. It is not shown."
                    : "No saved credential is sent.",
                }
              : {}),
            Expires: `${utc(proposal.expiresAt)} (${relative(proposal.expiresAt)})`,
          },
        )}<section class="section" aria-labelledby="arguments"><div class="section-head"><h2 id="arguments">Exact arguments</h2><span class="section-note">Request ${proposal.id} · connection ${proposal.connection} · revision ${proposal.revision}</span></div><pre>${JSON.stringify(proposal.arguments, null, 2)}</pre></section><section class="section" aria-labelledby="decision"><div class="section-head"><h2 id="decision">Decision</h2></div><div class="card">${reviewable ? html`<p>This call may change external data. Approval runs this exact call once, not future calls.</p>${confirmForm(proof.issue(c.get("principal"), `${base}/approvals/${proposal.id}`, binding(proposal)), "Approve and run once", { statement: "I reviewed this exact request and approve running it once.", detail: `Approval must happen before ${utc(proposal.expiresAt)}.` })}` : proposal.status === "unknown" ? html`<p>The outcome is unknown and is never retried here. After checking independently that the call stopped and what it did, record the result by sending <code>!mcp-reconcile ${proposal.id} confirmed-stopped verified-succeeded</code> (or <code>verified-failed</code>) in your private conversation with June.</p>` : html`<p>No execution is available here. Unknown outcomes must be checked externally; they are never retried here.</p>`}</div></section>`,
        {
          ...chrome,
          crumbs,
          status: badge(requestStatus[proposal.status] ?? proposal.status),
          description:
            "Verify the destination and arguments. Approval authorizes exactly this call, once.",
        },
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
      return rejected(
        c,
        "Request changed or approval expired",
        "Nothing ran. Open the request again for a fresh review; changed, cancelled and expired requests cannot be approved.",
      );
    await deps.store.confirm(proposal.id);
    return c.redirect(`${base}/approvals/${proposal.id}`, 303);
  });
  app.get("/:id", (c) => {
    const connection = deps.store
      .list()
      .find((value) => value.id === c.req.param("id"));
    if (!connection) return c.notFound();
    const principal = c.get("principal");
    const path = `${base}/${connection.id}`;
    const provider = providers.find(({ id }) => id === connection.id);
    const lapsed = expired(connection);
    const enabled = connection.tools.filter(
      (tool) => tool.permission !== "disabled",
    ).length;
    // Enabled tools first; discovery order otherwise.
    const tools = [...connection.tools].sort(
      (a, b) =>
        Number(a.permission === "disabled") -
        Number(b.permission === "disabled"),
    );
    const next = lapsed
      ? html`<div class="notice" data-tone="warn"><strong>Authorization expired</strong><p>${provider ? `Reconnect ${connection.name} to renew it. Reconnecting resets tool permissions.` : "Update this server's credential by adding it again; June can't renew it."}</p></div>`
      : connection.status === "not_tested"
        ? html`<div class="notice"><strong>${provider ? `Your ${connection.name} authorization is saved` : "Next: discover tools"}</strong><p>${provider ? "Next, discover tools, then review and enable the ones June may use. No tools are enabled yet." : "Discovery sends the saved credential to this exact server and lists its tools. It never runs a tool."}</p></div>`
        : connection.status === "unavailable"
          ? html`<div class="notice" data-tone="warn"><strong>Discovery failed</strong><p>Check the URL, credential, account permissions and server availability, then test again. No tools were called.</p></div>`
          : enabled
            ? ""
            : html`<div class="notice"><strong>No tools enabled</strong><p>Review a tool's contract below and choose what June may use.</p></div>`;
    return c.html(
      page(
        connection.name,
        c.get("nonce"),
        html`${next}<section class="section" aria-labelledby="details"><div class="section-head"><h2 id="details">Connection</h2></div>${metadata(
          {
            Endpoint: connection.url,
            ...(connection.account
              ? { "Verified account": connection.account }
              : {}),
            Credential: connection.authenticated
              ? "Saved and encrypted on the host"
              : "None",
            ...(connection.expiresAt
              ? {
                  Authorization: lapsed
                    ? `Expired ${utc(connection.expiresAt)}`
                    : connection.refreshable
                      ? `Renews automatically · current token ${connection.expiresAt <= Date.now() ? "renews when next used" : `until ${utc(connection.expiresAt)}`}`
                      : `Expires ${utc(connection.expiresAt)}`,
                }
              : {}),
            Tools: toolSummary(connection),
          },
        )}<div class="actions"><form method="post" action="${path}/discover"><input type="hidden" name="proof" value="${proof.issue(principal, `${path}/discover`, connection.revision)}"><button type="submit"${connection.status === "not_tested" ? "" : html` class="secondary"`}>Test & discover tools</button></form>${provider && configured[provider.id] ? html`<form method="post" action="${path}/connect"><input type="hidden" name="proof" value="${proof.issue(principal, `${path}/connect`, provider.id)}"><button type="submit" class="secondary">Reconnect ${connection.name}</button></form>` : ""}</div><p class="hint">Discovery sends your credential to this exact server and never runs a tool. A changed contract disables that tool until you review it again.${provider ? " Reconnecting replaces the saved authorization and resets tool permissions." : ""}</p></section><section class="section" aria-labelledby="tools"><div class="section-head"><h2 id="tools">Tools</h2><span class="section-note">${connection.tools.length} discovered · ${enabled} enabled · changes apply immediately</span></div>${
          tools.length
            ? html`<div class="notice" data-tone="warn"><strong>Read-only is your authorization, not a server guarantee.</strong><p>Review the complete contract before allowing automatic reads. Use approval for anything that sends, edits, creates or deletes. Private results go to June's configured model, and her answer enters your conversation history.</p></div><ul class="list">${tools.map(
                ({ contract, permission }) =>
                  html`<li class="item"><div class="item-body"><h3><code>${contract.name}</code></h3><p>${contract.description ?? "No description supplied."}</p></div><div class="item-side">${badge(permission === "read" ? "Reads allowed" : permission === "approval" ? "Needs approval" : "Disabled")}</div><details class="more"><summary>Review contract and permission</summary><div class="more-body"><pre>${JSON.stringify(contract, null, 2)}</pre>${confirmForm(
                    proof.issue(
                      principal,
                      `${path}/permission`,
                      binding([connection.revision, contract.name]),
                    ),
                    "Save permission",
                    {
                      action: `${path}/permission`,
                      statement:
                        "I reviewed this contract and authorize this permission.",
                      detail:
                        "The choice applies to this contract only. A changed contract disables the tool again.",
                      fields: html`<input type="hidden" name="tool" value="${contract.name}"><label class="field"><span>Permission</span><select name="permission">${(
                        [
                          ["disabled", "Disabled"],
                          ["read", "Allow read-only use in my DMs"],
                          ["approval", "Approval required for every call"],
                        ] as const
                      ).map(
                        ([value, label]) =>
                          html`<option value="${value}"${permission === value ? html` selected` : ""}>${label}</option>`,
                      )}</select></label>`,
                    },
                  )}</div></details></li>`,
              )}</ul>`
            : html`<div class="list"><p class="empty">No tools discovered. Test this connection first.</p></div>`
        }</section><section class="section" aria-labelledby="disconnect"><div class="section-head"><h2 id="disconnect">Disconnect</h2></div><div class="card"><p>Forget this credential and block future calls. Already-started external actions can't be recalled.${provider ? ` Revoke June's access at ${connection.name} separately if needed.` : ""}</p>${confirmForm(
          proof.issue(principal, `${path}/disconnect`, connection.revision),
          "Disconnect",
          {
            action: `${path}/disconnect`,
            statement: `Disconnect ${connection.name} from June`,
            detail:
              "June loses this connection and every tool permission on it.",
            danger: true,
          },
        )}</div></section>`,
        {
          ...chrome,
          crumbs,
          status: badge(
            provider && connection.authenticated && !lapsed
              ? "Authorization saved"
              : serverStatus(connection),
          ),
        },
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
        return rejected(
          c,
          "Connection changed or form expired",
          "Nothing changed. Open the connection again and review its current state before retrying.",
        );
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
