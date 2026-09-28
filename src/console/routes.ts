import { html } from "hono/html";
import type { UsageSnapshot } from "../models/usage.js";
import type { McpConnections } from "../tools/connections.js";
import { connectionAttention, connectionSummary } from "./connections.js";
import {
  binding,
  confirmations,
  type PrivateRouteSecurity,
  privateRoutes,
} from "./security.js";
import { usagePage } from "./usage.js";
import {
  badge,
  confirmForm,
  consoleNavigation,
  consoleSections,
  messagePage,
  metadata,
  page,
  when,
} from "./view.js";

export { consoleSections } from "./view.js";
export interface ConsoleRecord {
  title: string;
  status: string;
  detail: string;
  actionId?: string;
}
export interface ConsoleSection {
  status: "available" | "unavailable";
  detail: string;
  records: ConsoleRecord[];
}
/** Only owner-safe text: never credentials, authorization headers or opaque link tokens. */
export interface ConsoleSnapshot {
  observedAt: string;
  sections: Partial<Record<(typeof consoleSections)[number], ConsoleSection>>;
}
export interface ConsoleAction {
  id: string;
  revision: string;
  title: string;
  detail: string;
  /** Exact safe action description, including scope, audience and expiry where relevant. */
  facts: Record<string, string>;
}
export interface ConsoleDependencies {
  security: PrivateRouteSecurity;
  connectionsAvailable?: boolean;
  /** Read-only: surfaces pending requests and connection problems on the overview. */
  connections?: McpConnections;
  inspect(principal: string): Promise<ConsoleSnapshot>;
  usage?(
    principal: string,
    days: number,
    model: string,
  ): Promise<UsageSnapshot>;
  inspectAction?(
    principal: string,
    id: string,
  ): Promise<ConsoleAction | undefined>;
  /** Recheck owner permission and revision atomically; durably deduplicate commandId.
   * Return unknown for ambiguous side effects. Never automatically retry them. */
  confirmAction?(
    principal: string,
    command: { id: string; revision: string; commandId: string },
  ): Promise<{ status: "succeeded" | "unknown" | "rejected"; detail: string }>;
}

type SectionName = (typeof consoleSections)[number];
const labels: Record<SectionName, string> = {
  configuration: "Configuration",
  capabilities: "Capabilities",
  jobs: "Work",
  memory: "Memory",
  reflection: "Reflection",
  approvals: "Approvals",
  revocations: "Revocations",
};

export function createConsoleRoutes(deps: ConsoleDependencies) {
  const app = privateRoutes(deps.security);
  const proof = confirmations(deps.security.csrfSecret);
  const actions = !!(deps.inspectAction && deps.confirmAction);
  app.get("/usage/:export?", async (c) => {
    const base = new URL(c.req.url).pathname.replace(/\/usage(\/.*)?$/, "");
    if (
      !deps.usage ||
      (c.req.param("export") && c.req.param("export") !== "export")
    )
      return c.html(
        messagePage(
          c.get("nonce"),
          "Usage unavailable",
          "The host has not connected a usage ledger. No usage or spending can be confirmed.",
          404,
          { label: "Back to Overview", href: base || "/" },
        ),
        404,
      );
    const days = Number(c.req.query("days") ?? 7);
    const snapshot = await deps.usage(
      c.get("principal"),
      [1, 7, 30].includes(days) ? days : 7,
      (c.req.query("model") ?? "").slice(0, 256),
    );
    if (c.req.param("export")) {
      c.header("Content-Disposition", 'attachment; filename="june-usage.json"');
      return c.json({
        ...snapshot,
        billing: "unavailable",
        estimates: "unavailable",
        history:
          "Only instrumented calls; absent counters are unknown, not zero.",
        recentLimit: 100,
      });
    }
    return c.html(
      usagePage(snapshot, c.get("nonce"), base, {
        connectionsAvailable: deps.connectionsAvailable,
        signOut: deps.security.signOutPath,
      }),
    );
  });
  app.get("/", async (c) => {
    const snapshot = await deps.inspect(c.get("principal"));
    // Absolute path preserves nesting whether mounted with or without a trailing slash.
    const base = new URL(c.req.url).pathname.replace(/\/$/, "");
    const review = (id: string) => `${base}/actions/${encodeURIComponent(id)}`;
    const reported = (name: SectionName) => {
      const section = snapshot.sections[name];
      return section &&
        (section.status === "available" || section.records.length)
        ? section
        : undefined;
    };
    const records = (name: SectionName) => {
      const section = reported(name);
      if (!section) return "";
      return html`<section class="section" id="${name}" aria-labelledby="${name}-title"><div class="section-head"><h2 id="${name}-title">${labels[name]}</h2>${section.status === "available" ? "" : badge("Unavailable")}</div><p class="hint section-intro">${section.detail}</p>${
        section.records.length
          ? html`<ul class="list">${section.records.map((record) => html`<li class="item"><div class="item-body"><h3>${record.title}</h3><p>${record.detail}</p>${record.actionId && actions ? html`<p class="item-meta"><a href="${review(record.actionId)}">Review action</a></p>` : ""}</div><div class="item-side">${badge(record.status)}</div></li>`)}</ul>`
          : html`<div class="list"><p class="empty">No records returned by the host.</p></div>`
      }</section>`;
    };
    const attention = [
      ...(deps.connections ? connectionAttention(deps.connections) : []),
      ...(actions
        ? consoleSections.flatMap((name) =>
            (snapshot.sections[name]?.records ?? []).flatMap((record) =>
              record.actionId
                ? [
                    {
                      title: record.title,
                      detail: record.detail,
                      href: review(record.actionId),
                      status: record.status,
                    },
                  ]
                : [],
            ),
          )
        : []),
    ];
    const unreported = consoleSections.filter((name) => !reported(name));
    const summary = deps.connections && connectionSummary(deps.connections);
    return c.html(
      page(
        "Overview",
        c.get("nonce"),
        html`<section class="section" aria-labelledby="attention"><div class="section-head"><h2 id="attention">Needs your attention</h2></div>${
          attention.length
            ? html`<ul class="list">${attention.map((item) => html`<li><a class="item" href="${item.href}"><div class="item-body"><h3>${item.title}</h3><p>${item.detail}</p></div><div class="item-side">${badge(item.status)}</div></a></li>`)}</ul>`
            : html`<div class="list"><p class="empty">No actionable items are reported here. Recent tool requests, unknown outcomes and connection problems appear here when the host reports them.</p></div>`
        }</section>${records("jobs")}${
          deps.connectionsAvailable
            ? html`<section class="section" aria-labelledby="connections-title"><div class="section-head"><h2 id="connections-title">Connections</h2><a class="section-note" href="${base}/connections">Open Connections</a></div>${summary ? metadata({ "Saved connections": String(summary.saved), "Enabled tools": String(summary.enabled), "Recent requests awaiting approval": String(summary.awaiting) }) : html`<div class="list"><a class="item" href="${base}/connections"><div class="item-body"><h3>Accounts and tool servers</h3><p>Connect accounts, review tool contracts and approve requests.</p></div></a></div>`}</section>`
            : ""
        }${records("memory")}${records("reflection")}${records("approvals")}${records("revocations")}${
          reported("configuration") || reported("capabilities")
            ? html`<div class="grid-2 section">${records("configuration")}${records("capabilities")}</div>`
            : ""
        }${
          unreported.length
            ? html`<section class="section"><details class="disclosure"><summary>Not reported by this host: ${unreported.map((name) => labels[name]).join(", ")}</summary><div class="disclosure-body"><p class="hint">No connected source reports these here, so no state is confirmed.</p>${unreported.map((name) => html`<p><strong>${labels[name]}.</strong> <span class="hint">${snapshot.sections[name]?.detail ?? "Not connected."}</span></p>`)}</div></details></section>`
            : ""
        }`,
        {
          description:
            "What June reports right now, with decisions first. Viewing never approves or runs anything.",
          actions: html`<p class="section-note">Observed ${when(snapshot.observedAt)} · ${actions ? "Actions need explicit confirmation" : "Read-only"}</p>`,
          navigation: consoleNavigation(
            base,
            "overview",
            deps.connectionsAvailable,
          ),
          signOut: deps.security.signOutPath,
        },
      ),
    );
  });
  app.get("/actions/:id", async (c) => {
    const action = await deps.inspectAction?.(
      c.get("principal"),
      c.req.param("id"),
    );
    const overview = new URL(c.req.url).pathname.split("/actions/")[0] || "/";
    if (!action || !deps.confirmAction)
      return c.html(
        messagePage(
          c.get("nonce"),
          "Action unavailable",
          "The host has not made this action available for confirmation.",
          404,
          { label: "Back to Overview", href: overview },
        ),
        404,
      );
    return c.html(
      page(
        action.title,
        c.get("nonce"),
        html`<div class="grid-2"><div class="section">${metadata(action.facts)}<p class="hint">Revision <code>${action.revision}</code></p><details class="disclosure" open><summary>Exact review data</summary><div class="disclosure-body"><pre>${JSON.stringify(action, null, 2)}</pre></div></details></div><section class="section card" aria-labelledby="decision"><h2 id="decision">Decision</h2><p class="hint">The review proof is valid for 10 minutes. It does not extend the action's expiry. Any change requires a fresh review.</p>${confirmForm(proof.issue(c.get("principal"), new URL(c.req.url).pathname, binding(action)), "Confirm this action")}</section></div>`,
        {
          description: action.detail,
          status: badge("Awaiting review"),
          crumbs: [{ label: "Overview", href: overview }],
          navigation: consoleNavigation(
            overview,
            undefined,
            deps.connectionsAvailable,
          ),
          signOut: deps.security.signOutPath,
        },
      ),
    );
  });
  app.post("/actions/:id", async (c) => {
    const action = await deps.inspectAction?.(
      c.get("principal"),
      c.req.param("id"),
    );
    const overview = new URL(c.req.url).pathname.split("/actions/")[0] || "/";
    if (!action || !deps.confirmAction)
      return c.html(
        messagePage(
          c.get("nonce"),
          "Action unavailable",
          "The host has not made this action available for confirmation.",
          404,
          { label: "Back to Overview", href: overview },
        ),
        404,
      );
    const form = await c.req.parseBody();
    const commandId = proof.verify(
      c.get("principal"),
      new URL(c.req.url).pathname,
      binding(action),
      form.proof,
    );
    if (!commandId || form.confirmed !== "yes")
      return c.html(
        messagePage(
          c.get("nonce"),
          "Confirmation rejected",
          "Confirmation expired, changed or invalid. Open a fresh review before trying again.",
          403,
          { label: "Open a fresh review", href: new URL(c.req.url).pathname },
        ),
        403,
      );
    const result = await deps.confirmAction(c.get("principal"), {
      id: action.id,
      revision: action.revision,
      commandId,
    });
    return c.html(
      page(
        "Action receipt",
        c.get("nonce"),
        html`<div class="card">${badge(result.status)}<h2>${result.status === "unknown" ? "The outcome needs reconciliation" : result.status === "succeeded" ? "Success recorded by the host" : "Action rejected"}</h2><p>${result.detail}</p></div>${result.status === "unknown" ? html`<div class="notice" data-tone="warn"><strong>Do not repeat this action.</strong><p>Reconcile the external state first. This page cannot confirm whether the effect occurred.</p></div>` : ""}`,
        {
          description:
            "The host's recorded result, not an invitation to retry.",
          crumbs: [{ label: "Overview", href: overview }],
          navigation: consoleNavigation(
            overview,
            undefined,
            deps.connectionsAvailable,
          ),
          signOut: deps.security.signOutPath,
        },
      ),
    );
  });
  return app;
}
