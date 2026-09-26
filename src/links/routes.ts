import { html } from "hono/html";
import {
  binding,
  confirmations,
  type PrivateRouteSecurity,
  privateRoutes,
} from "../console/security.js";
import {
  badge,
  confirmForm,
  messagePage,
  metadata,
  outcomeDescription,
  page,
} from "../console/view.js";
import type { ToolAction } from "../tools/broker.js";
import type { OpaqueActionLinks } from "./opaque.js";

export interface ActionLinkDependencies {
  security: PrivateRouteSecurity;
  links: OpaqueActionLinks;
  /** Same trusted proposal store as chat. Return no credentials/secrets in arguments.
   * Verify matchesGrant with the configured owner before returning a payload for review.
   * The broker rechecks this exact payload against its granted fingerprint on POST. */
  resolveAction(
    principal: string,
    grantId: string,
  ): Promise<ToolAction | undefined>;
}

export function createActionLinkRoutes(deps: ActionLinkDependencies) {
  const app = privateRoutes(deps.security);
  const proof = confirmations(deps.security.csrfSecret);
  app.get("/:token", async (c) => {
    const principal = c.get("principal");
    let link: ReturnType<OpaqueActionLinks["inspect"]>;
    try {
      link = deps.links.inspect(principal, c.req.param("token"));
    } catch {
      return c.html(
        messagePage(
          c.get("nonce"),
          "Link unavailable",
          "This link may be expired, revoked, or not intended for you. No action can be confirmed here.",
          404,
        ),
        404,
      );
    }
    const action = await deps.resolveAction(principal, link.grantId);
    return c.html(
      page(
        "Review linked action",
        c.get("nonce"),
        html`<div class="review-grid"><div class="stack"><section class="panel" id="scope"><div class="panel-heading"><h2>Action scope</h2>${badge(link.status)}</div>${metadata({ ...(action ? { Tool: action.tool, Account: action.account, "Credential item": action.item, "Destination origin": action.origin } : {}), "Intended audience": principal, "Link expires": new Date(link.expiresAt).toISOString() })}</section><section class="panel" id="payload">${action ? html`<details open><summary>Exact action payload <span class="format">JSON</span></summary><pre>${JSON.stringify(action, null, 2)}</pre></details>` : html`<div class="panel-heading"><h2>Action payload</h2></div><div class="empty"><span class="empty-mark" aria-hidden="true">—</span><span>Action details unavailable. Execution is disabled.</span></div>`}</section></div><aside class="panel" id="confirmation"><div class="panel-heading"><h2>${link.status === "ready" && action ? "Authorize execution" : "Execution unavailable"}</h2></div><div class="panel-body">${link.status === "ready" && action ? html`<div class="callout"><strong>One grant. One execution.</strong><p>Review the exact payload and intended audience. Permission is checked again before execution.</p></div>${confirmForm(proof.issue(principal, new URL(c.req.url).pathname, binding(action)), "Confirm and execute once")}<p class="hint">The review proof is valid for 10 minutes. The link and grant may expire sooner; the proof does not extend either expiry.</p>` : html`<div class="callout ${link.status === "unknown" ? "warning" : ""}"><strong>${link.status === "unknown" ? "Outcome unknown" : "Execution disabled"}</strong><p>${link.status === "ready" ? "The host could not resolve the approved payload. Nothing can execute without those details." : outcomeDescription(link.status)}</p></div><button type="button" class="full" disabled>Execution disabled</button>`}</div></aside></div>`,
        {
          description:
            "A private, scoped action. Opening this link never executes it.",
          navigation: [
            { label: "Scope", href: "#scope", current: true },
            { label: "Exact payload", href: "#payload" },
            { label: "Confirmation", href: "#confirmation" },
          ],
        },
      ),
    );
  });
  app.post("/:token", async (c) => {
    const principal = c.get("principal");
    let link: ReturnType<OpaqueActionLinks["inspect"]>;
    try {
      link = deps.links.inspect(principal, c.req.param("token"));
    } catch {
      return c.html(
        messagePage(
          c.get("nonce"),
          "Link unavailable",
          "This link may be expired, revoked, or not intended for you. No action can be confirmed here.",
          404,
        ),
        404,
      );
    }
    const action = await deps.resolveAction(principal, link.grantId);
    if (!action)
      return c.html(
        messagePage(
          c.get("nonce"),
          "Action details unavailable",
          "The host could not resolve the approved payload. Execution is disabled.",
          503,
        ),
        503,
      );
    const form = await c.req.parseBody();
    if (
      form.confirmed !== "yes" ||
      !proof.verify(
        principal,
        new URL(c.req.url).pathname,
        binding(action),
        form.proof,
      )
    )
      return c.html(
        messagePage(
          c.get("nonce"),
          "Confirmation rejected",
          "Confirmation expired, changed or invalid. Open the original private link for a fresh review.",
          403,
        ),
        403,
      );
    const receipt = await deps.links.redeem(
      principal,
      c.req.param("token"),
      action,
    );
    return c.html(
      page(
        "Action receipt",
        c.get("nonce"),
        html`<section class="panel receipt"><div class="panel-body">${badge(receipt.status)}<h2>${receipt.status === "unknown" ? "The outcome needs reconciliation" : "The host recorded an outcome"}</h2><div class="callout ${receipt.status === "unknown" ? "warning" : ""}"><p>${outcomeDescription(receipt.status)}</p></div><div class="receipt-meta"><span class="eyebrow">Receipt ID</span><code>${receipt.id}</code></div></div></section>`,
        {
          description:
            "This grant has been consumed. It will not execute again.",
        },
      ),
    );
  });
  return app;
}
