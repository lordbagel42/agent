import { html } from "hono/html";
import {
  binding,
  confirmations,
  type PrivateRouteSecurity,
  privateRoutes,
} from "../console/security.js";
import { confirmForm, outcomeDescription, page } from "../console/view.js";
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
      return c.text(
        "Link unavailable, expired, revoked, or not intended for you.",
        404,
      );
    }
    const action = await deps.resolveAction(principal, link.grantId);
    return c.html(
      page(
        "An action, not a shortcut",
        c.get("nonce"),
        html`<section class="panel"><span class="status">${link.status}</span><h2>Review the exact scope</h2><p>Intended audience: ${principal}</p><p>Link expiry: ${new Date(link.expiresAt).toISOString()}</p>${action ? html`<pre>${JSON.stringify(action, null, 2)}</pre>` : html`<p>Action details unavailable. Execution is disabled.</p>`}${link.status === "ready" && action ? confirmForm(proof.issue(principal, new URL(c.req.url).pathname, binding(action)), "Confirm and execute once") : html`<p>${outcomeDescription(link.status)}</p>`}</section>`,
      ),
    );
  });
  app.post("/:token", async (c) => {
    const principal = c.get("principal");
    let link: ReturnType<OpaqueActionLinks["inspect"]>;
    try {
      link = deps.links.inspect(principal, c.req.param("token"));
    } catch {
      return c.text(
        "Link unavailable, expired, revoked, or not intended for you.",
        404,
      );
    }
    const action = await deps.resolveAction(principal, link.grantId);
    if (!action) return c.text("Action details unavailable.", 503);
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
      return c.text(
        "Confirmation expired, changed or invalid. Review again.",
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
        html`<section class="panel"><span class="status">${receipt.status}</span><p>${outcomeDescription(receipt.status)}</p><p>Receipt: ${receipt.id}</p></section>`,
      ),
    );
  });
  return app;
}
