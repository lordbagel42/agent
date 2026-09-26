import { html } from "hono/html";
import {
  binding,
  confirmations,
  type PrivateRouteSecurity,
  privateRoutes,
} from "./security.js";
import { badge, confirmForm, messagePage, metadata, page } from "./view.js";

export const consoleSections = [
  "configuration",
  "capabilities",
  "jobs",
  "memory",
  "reflection",
  "approvals",
  "revocations",
] as const;
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
  inspect(principal: string): Promise<ConsoleSnapshot>;
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

export function createConsoleRoutes(deps: ConsoleDependencies) {
  const app = privateRoutes(deps.security);
  const proof = confirmations(deps.security.csrfSecret);
  app.get("/", async (c) => {
    const snapshot = await deps.inspect(c.get("principal"));
    // Absolute path preserves nesting whether mounted with or without a trailing slash.
    const base = new URL(c.req.url).pathname.replace(/\/$/, "");
    return c.html(
      page(
        "Overview",
        c.get("nonce"),
        html`<div class="summary-bar"><div><span class="eyebrow">Host snapshot</span><p><time>${snapshot.observedAt}</time></p></div><div><span class="eyebrow">Access</span><p>Owner-authenticated</p></div><div><span class="eyebrow">Actions</span><p>${deps.inspectAction && deps.confirmAction ? "Explicit confirmation required" : "Read-only · actions not connected"}</p></div></div><div class="section-heading"><h2>Workspace services</h2><span class="small muted">Reported by the host</span></div><div class="grid">${consoleSections.map(
          (name) => {
            const section = snapshot.sections[name];
            return html`<section class="panel" id="${name}"><div class="panel-heading"><h2>${name[0]?.toUpperCase()}${name.slice(1)}</h2>${badge(section?.status ?? "unavailable")}</div><div class="panel-description"><p>${section?.detail ?? "This integration is not connected. No state can be confirmed."}</p></div>${section?.records.length ? section.records.map((record) => html`<article class="record"><div><h3>${record.title}</h3><p>${record.detail}</p>${record.actionId && deps.inspectAction && deps.confirmAction ? html`<a class="record-action" href="${base}/actions/${encodeURIComponent(record.actionId)}">Review action <span aria-hidden="true">↗</span></a>` : ""}</div>${badge(record.status)}</article>`) : html`<div class="empty"><span class="empty-mark" aria-hidden="true">—</span><span>${section?.status === "available" ? "No records returned by the host." : "Unavailable · no state to inspect"}</span></div>`}</section>`;
          },
        )}</div>`,
        {
          description:
            "Inspect configuration, work, and permissions. Changes always start with a review.",
          navigation: [
            { label: "Overview", href: base || "/", current: true },
            ...consoleSections.map((name) => ({
              label: `${name[0]?.toUpperCase()}${name.slice(1)}`,
              href: `#${name}`,
            })),
          ],
        },
      ),
    );
  });
  app.get("/actions/:id", async (c) => {
    const action = await deps.inspectAction?.(
      c.get("principal"),
      c.req.param("id"),
    );
    if (!action || !deps.confirmAction)
      return c.html(
        messagePage(
          c.get("nonce"),
          "Action unavailable",
          "The host has not made this action available for confirmation.",
          404,
        ),
        404,
      );
    const overview = new URL(c.req.url).pathname.split("/actions/")[0] || "/";
    return c.html(
      page(
        "Review action",
        c.get("nonce"),
        html`<div class="review-grid"><div class="stack"><section class="panel" id="scope"><div class="panel-heading"><h2>${action.title}</h2>${badge("Awaiting review")}</div><div class="panel-description"><p>${action.detail}</p></div>${metadata(action.facts)}<div class="panel-description"><span class="eyebrow">Revision</span><code>${action.revision}</code></div></section><details class="panel" id="payload" open><summary>Exact review data <span class="format">JSON</span></summary><pre>${JSON.stringify(action, null, 2)}</pre></details></div><aside class="panel" id="confirmation"><div class="panel-heading"><h2>Confirm action</h2></div><div class="panel-body"><div class="callout"><strong>Review before you authorize</strong><p>The review proof is valid for 10 minutes. It does not extend the action's expiry. Any change requires a fresh review.</p></div>${confirmForm(proof.issue(c.get("principal"), new URL(c.req.url).pathname, binding(action)), "Confirm this action")}</div></aside></div>`,
        {
          description:
            "Verify the scope and consequences before giving permission.",
          navigation: [
            { label: "← Overview", href: overview },
            { label: "Action review", href: "#scope", current: true },
          ],
        },
      ),
    );
  });
  app.post("/actions/:id", async (c) => {
    const action = await deps.inspectAction?.(
      c.get("principal"),
      c.req.param("id"),
    );
    if (!action || !deps.confirmAction)
      return c.html(
        messagePage(
          c.get("nonce"),
          "Action unavailable",
          "The host has not made this action available for confirmation.",
          404,
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
        html`<section class="panel receipt"><div class="panel-body">${badge(result.status)}<h2>${result.status === "unknown" ? "The outcome needs reconciliation" : result.status === "succeeded" ? "Success recorded by the host" : "Action rejected"}</h2><p>${result.detail}</p>${result.status === "unknown" ? html`<div class="receipt-meta"><div class="callout warning"><strong>Do not repeat this action.</strong><p>Reconcile the external state first. This page cannot confirm whether the effect occurred.</p></div></div>` : ""}</div></section>`,
        {
          description:
            "The host's recorded result, not an invitation to retry.",
          navigation: [
            {
              label: "← Overview",
              href: new URL(c.req.url).pathname.split("/actions/")[0] || "/",
            },
          ],
        },
      ),
    );
  });
  return app;
}
