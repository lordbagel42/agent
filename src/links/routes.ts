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
  consoleNavigation,
  messagePage,
  metadata,
  outcomeDescription,
  page,
  utc,
} from "../console/view.js";
import type { ToolAction } from "../tools/broker.js";
import type { OpaqueActionLinks } from "./opaque.js";

export interface ActionLinkDependencies {
  security: PrivateRouteSecurity;
  /** Console mount for shared navigation; omitted for standalone mounts. */
  console?: { path: string; connectionsAvailable?: boolean };
  links: OpaqueActionLinks;
  /** Trusted host resolution only. Return no credentials/secrets in arguments.
   * Verify matchesGrant with the configured owner before returning a payload for review.
   * The broker rechecks this exact payload against its granted fingerprint on POST. */
  resolveAction(
    principal: string,
    grantId: string,
    token: string,
  ): Promise<ToolAction | undefined>;
}

export function createActionLinkRoutes(deps: ActionLinkDependencies) {
  const app = privateRoutes(deps.security);
  const proof = confirmations(deps.security.csrfSecret);
  const chrome = deps.console
    ? {
        navigation: consoleNavigation(
          deps.console.path,
          undefined,
          deps.console.connectionsAvailable,
        ),
        signOut: deps.security.signOutPath,
      }
    : {};
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
    const action = await deps.resolveAction(
      principal,
      link.grantId,
      c.req.param("token"),
    );
    const ready = link.status === "ready" && action;
    return c.html(
      page(
        "Review linked action",
        c.get("nonce"),
        html`<div class="grid-2"><div class="section">${metadata({ ...(action ? { Tool: action.tool, Account: action.account, "Credential item": action.item, "Destination origin": action.origin } : {}), "Intended audience": principal, "Link expires": utc(link.expiresAt) })}${action ? html`<details class="disclosure section" open><summary>Exact action payload</summary><div class="disclosure-body"><pre>${JSON.stringify(action, null, 2)}</pre></div></details>` : html`<div class="section notice"><strong>Action details unavailable</strong><p>Execution is disabled.</p></div>`}</div><section class="section card" aria-labelledby="decision"><h2 id="decision">${ready ? "Authorize execution" : "Execution unavailable"}</h2>${ready ? html`<p><strong>One grant. One execution.</strong> Review the exact payload and intended audience. Permission is checked again before execution.</p>${confirmForm(proof.issue(principal, new URL(c.req.url).pathname, binding(action)), "Confirm and execute once")}<p class="hint">The review proof is valid for 10 minutes. The link and grant may expire sooner; the proof does not extend either expiry.</p>` : html`<p>${link.status === "ready" ? "The host could not resolve the approved payload. Nothing can execute without those details." : outcomeDescription(link.status)}</p><button type="button" class="full" disabled>Execution disabled</button>`}</section></div>`,
        {
          ...chrome,
          description:
            "A private, scoped action. Opening this link never executes it.",
          status: badge(link.status),
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
    const action = await deps.resolveAction(
      principal,
      link.grantId,
      c.req.param("token"),
    );
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
        html`<div class="card">${badge(receipt.status)}<h2>${receipt.status === "unknown" ? "The outcome needs reconciliation" : "The host recorded an outcome"}</h2><p>${outcomeDescription(receipt.status)}</p><p class="hint">Receipt ID <code>${receipt.id}</code></p></div>`,
        {
          ...chrome,
          narrow: true,
          description:
            "This grant has been consumed. It will not execute again.",
        },
      ),
    );
  });
  return app;
}
