import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { OpaqueActionLinks } from "../links/opaque.js";
import type { CapabilityBroker } from "./broker.js";

/** Mount at /operator/capabilities. This factory authenticates independently:
 * neither request JSON nor model output can select the acting principal.
 * No cookies/CORS; browser callers must use the configured exact console origin.
 */
export function createCapabilityRoutes(options: {
  broker: CapabilityBroker;
  owner: string;
  operatorToken: string;
  consoleOrigin?: string;
  actionLinks?: OpaqueActionLinks;
}) {
  const { broker, owner, operatorToken, consoleOrigin, actionLinks } = options;
  if (operatorToken.length < 32 || !owner)
    throw new Error("invalid_capability_configuration");
  if (
    consoleOrigin !== undefined &&
    new URL(consoleOrigin).origin !== consoleOrigin
  )
    throw new Error("invalid_capability_configuration");
  const expected = Buffer.from(`Bearer ${operatorToken}`);
  const app = new Hono();
  app.onError((_error, c) => c.json({ error: "capability_denied" }, 400));
  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    const supplied = Buffer.from(c.req.header("authorization") ?? "");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return c.json({ error: "unauthorized" }, 401);
    const origin = c.req.header("origin");
    if (
      (origin !== undefined && origin !== consoleOrigin) ||
      c.req.header("sec-fetch-site") === "cross-site"
    )
      return c.json({ error: "forbidden" }, 403);
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 65_536,
      onError: (c) => c.json({ error: "body_too_large" }, 413),
    }),
  );
  app.get("/status", (c) =>
    c.json({ mounted: true, registeredTools: broker.registeredToolCount }),
  );
  if (actionLinks && consoleOrigin) {
    app.post("/links", async (c) => {
      const { grantId, action, expiresAt } = z
        .strictObject({
          grantId: z.uuid(),
          action: z.unknown(),
          expiresAt: z.number().int().positive(),
        })
        .parse(await c.req.json());
      const token = actionLinks.issueReviewed(
        owner,
        grantId,
        action,
        expiresAt,
      );
      return token
        ? c.json(
            {
              url: `${consoleOrigin}/console/action-links/${token}`,
              expiresAt,
            },
            201,
          )
        : c.json({ error: "action_link_capacity" }, 429);
    });
    app.post("/links/:token/revoke", (c) => {
      actionLinks.revoke(owner, c.req.param("token"));
      return c.json({ revoked: true });
    });
  }
  app.post("/proposals", async (c) =>
    c.json(broker.propose(await c.req.json())),
  );
  app.post("/grants", async (c) => {
    const input: unknown = await c.req.json();
    if (
      !input ||
      typeof input !== "object" ||
      !("audience" in input) ||
      input.audience !== owner
    )
      return c.json({ error: "capability_denied" }, 400);
    return c.json({ grantId: broker.grant(owner, input) }, 201);
  });
  app.post("/grants/:id/revoke", (c) => {
    broker.revoke(owner, c.req.param("id"));
    return c.json({ revoked: true });
  });
  app.post("/grants/:id/cancel", (c) =>
    c.json({
      revoked: true,
      receipt: broker.cancel(owner, c.req.param("id")) ?? null,
    }),
  );
  app.post("/grants/:id/reconcile", async (c) =>
    c.json(broker.reconcile(owner, c.req.param("id"), await c.req.json())),
  );
  // An owner API can execute only grants bound to the owner. Worker-bound grants
  // go through trusted worker wrappers, never an audience supplied in this body.
  app.post("/grants/:id/execute", async (c) =>
    c.json(await broker.execute(owner, c.req.param("id"), await c.req.json())),
  );
  app.get("/grants/:id/receipt", (c) =>
    c.json({ receipt: broker.audit(owner, c.req.param("id")) ?? null }),
  );
  app.get("/audit", (c) =>
    c.json({
      events: broker.auditEvents(owner, Number(c.req.query("after") ?? "0")),
    }),
  );
  return app;
}
