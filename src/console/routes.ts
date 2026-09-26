import { html } from "hono/html";
import {
  binding,
  confirmations,
  type PrivateRouteSecurity,
  privateRoutes,
} from "./security.js";
import { confirmForm, page } from "./view.js";

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
        "The owner's desk",
        c.get("nonce"),
        html`<p class="eyebrow">Host snapshot · <time>${snapshot.observedAt}</time></p><div class="grid">${consoleSections.map(
          (name) => {
            const section = snapshot.sections[name];
            return html`<section class="panel"><h2>${name[0]?.toUpperCase()}${name.slice(1)}</h2><span class="status">${section?.status ?? "unavailable"}</span><p>${section?.detail ?? "This integration is not connected. No state can be confirmed."}</p>${section?.records.map((record) => html`<article><h3>${record.title}</h3><span class="status">${record.status}</span><p>${record.detail}</p>${record.actionId && deps.inspectAction && deps.confirmAction ? html`<a href="${base}/actions/${encodeURIComponent(record.actionId)}">Review action →</a>` : ""}</article>`)}</section>`;
          },
        )}</div>`,
      ),
    );
  });
  app.get("/actions/:id", async (c) => {
    const action = await deps.inspectAction?.(
      c.get("principal"),
      c.req.param("id"),
    );
    if (!action || !deps.confirmAction)
      return c.text("Action unavailable.", 404);
    return c.html(
      page(
        "Review before acting",
        c.get("nonce"),
        html`<section class="panel"><span class="status">Awaiting explicit confirmation</span><h2>${action.title}</h2><p>${action.detail}</p><pre>${JSON.stringify(action.facts, null, 2)}</pre><p>Revision: ${action.revision}. Confirmation expires in 10 minutes. Changes require a fresh review.</p>${confirmForm(proof.issue(c.get("principal"), new URL(c.req.url).pathname, binding(action)), "Confirm this action")}</section>`,
      ),
    );
  });
  app.post("/actions/:id", async (c) => {
    const action = await deps.inspectAction?.(
      c.get("principal"),
      c.req.param("id"),
    );
    if (!action || !deps.confirmAction)
      return c.text("Action unavailable.", 404);
    const form = await c.req.parseBody();
    const commandId = proof.verify(
      c.get("principal"),
      new URL(c.req.url).pathname,
      binding(action),
      form.proof,
    );
    if (!commandId || form.confirmed !== "yes")
      return c.text(
        "Confirmation expired, changed or invalid. Review again.",
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
        html`<section class="panel"><span class="status">${result.status}</span><p>${result.detail}</p>${result.status === "unknown" ? html`<p>Do not repeat this action. Reconcile the external state first.</p>` : ""}</section>`,
      ),
    );
  });
  return app;
}
