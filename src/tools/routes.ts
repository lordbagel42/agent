import { timingSafeEqual } from "node:crypto";
import { Effect, Layer, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { JuneRuntime } from "../effect/runtime.js";
import { Int, Uuid } from "../effect/schema.js";
import {
  attempt,
  awaited,
  json,
  jsonBody,
  mountEffectRoutes,
  query,
  respond,
} from "../http/effect.js";
import type { OpaqueActionLinks } from "../links/opaque.js";
import type { CapabilityBroker } from "./broker.js";

const Link = Schema.Struct({
  grantId: Uuid,
  action: Schema.Unknown,
  expiresAt: Int({ minimum: 1 }),
});

const params = { id: Schema.String };
const endpoint = { success: Schema.Any };
const grant = <const Name extends string>(name: Name) =>
  HttpApiEndpoint.post(name, `/grants/:id/${name}`, { params, ...endpoint });
export class CapabilitiesApi extends HttpApi.make("june-operator").add(
  HttpApiGroup.make("capabilities")
    .add(
      HttpApiEndpoint.get("status", "/status", endpoint),
      HttpApiEndpoint.post("link", "/links", endpoint),
      HttpApiEndpoint.post("revokeLink", "/links/:token/revoke", {
        params: { token: Schema.String },
        ...endpoint,
      }),
      HttpApiEndpoint.post("propose", "/proposals", endpoint),
      HttpApiEndpoint.post("grant", "/grants", endpoint),
      grant("revoke"),
      grant("cancel"),
      grant("reconcile"),
      grant("execute"),
      HttpApiEndpoint.get("receipt", "/grants/:id/receipt", {
        params,
        ...endpoint,
      }),
      HttpApiEndpoint.get("audit", "/audit", endpoint),
    )
    .prefix("/operator/capabilities"),
) {}

/** Any JSON body, read like Hono's `c.req.json()`. */
const body = HttpServerRequest.HttpServerRequest.pipe(
  Effect.flatMap((request) => request.json),
);

/** Mount at /operator/capabilities. This factory authenticates independently:
 * neither request JSON nor model output can select the acting principal.
 * No cookies/CORS; browser callers must use the configured exact console origin.
 * The guard and body limit run in Hono before the Effect handlers; every
 * handler failure is a 400 `capability_denied`.
 */
export function createCapabilityRoutes(options: {
  runtime: JuneRuntime;
  broker: CapabilityBroker;
  owner: string;
  operatorToken: string;
  consoleOrigin?: string;
  actionLinks?: OpaqueActionLinks;
}) {
  const { broker, owner, operatorToken, consoleOrigin } = options;
  if (operatorToken.length < 32 || !owner)
    throw new Error("invalid_capability_configuration");
  if (
    consoleOrigin !== undefined &&
    new URL(consoleOrigin).origin !== consoleOrigin
  )
    throw new Error("invalid_capability_configuration");
  const actionLinks = consoleOrigin ? options.actionLinks : undefined;
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

  const denied = respond(() =>
    Effect.succeed(json({ error: "capability_denied" }, 400)),
  );
  const handlers = HttpApiBuilder.group(CapabilitiesApi, "capabilities", (h) =>
    Effect.succeed(
      h
        .handle(
          "status",
          () =>
            denied(
              Effect.succeed({
                mounted: true,
                registeredTools: broker.registeredToolCount,
              }).pipe(Effect.withSpan("june.http.capabilities.status")),
            ),
          awaited,
        )
        .handleRaw(
          "link",
          () =>
            denied(
              Effect.gen(function* () {
                // Mounted in Hono only when action links are configured.
                if (!actionLinks)
                  return json({ error: "capability_denied" }, 400);
                const { grantId, action, expiresAt } = yield* jsonBody(Link);
                const token = yield* attempt(() =>
                  actionLinks.issueReviewed(owner, grantId, action, expiresAt),
                );
                return token
                  ? json(
                      {
                        url: `${consoleOrigin}/console/action-links/${token}`,
                        expiresAt,
                      },
                      201,
                    )
                  : json({ error: "action_link_capacity" }, 429);
              }).pipe(Effect.withSpan("june.http.capabilities.link")),
            ),
          awaited,
        )
        .handle(
          "revokeLink",
          ({ params }) =>
            denied(
              attempt(() => actionLinks?.revoke(owner, params.token)).pipe(
                Effect.as({ revoked: true }),
                Effect.withSpan("june.http.capabilities.link_revoke"),
              ),
            ),
          awaited,
        )
        .handleRaw(
          "propose",
          () =>
            denied(
              body.pipe(
                Effect.flatMap((input) => attempt(() => broker.propose(input))),
                Effect.withSpan("june.http.capabilities.propose"),
              ),
            ),
          awaited,
        )
        .handleRaw(
          "grant",
          () =>
            denied(
              Effect.gen(function* () {
                const input: unknown = yield* body;
                if (
                  !input ||
                  typeof input !== "object" ||
                  !("audience" in input) ||
                  input.audience !== owner
                )
                  return json({ error: "capability_denied" }, 400);
                const grantId = yield* attempt(() =>
                  broker.grant(owner, input),
                );
                return json({ grantId }, 201);
              }).pipe(Effect.withSpan("june.http.capabilities.grant")),
            ),
          awaited,
        )
        .handle(
          "revoke",
          ({ params }) =>
            denied(
              attempt(() => broker.revoke(owner, params.id)).pipe(
                Effect.as({ revoked: true }),
                Effect.withSpan("june.http.capabilities.revoke"),
              ),
            ),
          awaited,
        )
        .handle(
          "cancel",
          ({ params }) =>
            denied(
              attempt(() => broker.cancel(owner, params.id)).pipe(
                Effect.map((receipt) => ({
                  revoked: true,
                  receipt: receipt ?? null,
                })),
                Effect.withSpan("june.http.capabilities.cancel"),
              ),
            ),
          awaited,
        )
        .handleRaw(
          "reconcile",
          ({ params }) =>
            denied(
              body.pipe(
                Effect.flatMap((input) =>
                  attempt(() => broker.reconcile(owner, params.id, input)),
                ),
                Effect.withSpan("june.http.capabilities.reconcile"),
              ),
            ),
          awaited,
        )
        // An owner API can execute only grants bound to the owner. Worker-bound
        // grants go through trusted worker wrappers, never an audience
        // supplied in this body.
        .handleRaw(
          "execute",
          ({ params }) =>
            denied(
              body.pipe(
                Effect.flatMap((input) =>
                  attempt(() => broker.execute(owner, params.id, input)),
                ),
                Effect.withSpan("june.http.capabilities.execute"),
              ),
            ),
          awaited,
        )
        .handle(
          "receipt",
          ({ params }) =>
            denied(
              attempt(() => broker.audit(owner, params.id)).pipe(
                Effect.map((receipt) => ({ receipt: receipt ?? null })),
                Effect.withSpan("june.http.capabilities.receipt"),
              ),
            ),
          awaited,
        )
        .handle(
          "audit",
          ({ request }) =>
            denied(
              attempt(() =>
                broker.auditEvents(
                  owner,
                  Number(query(request.url, "after") ?? "0"),
                ),
              ).pipe(
                Effect.map((events) => ({ events })),
                Effect.withSpan("june.http.capabilities.audit"),
              ),
            ),
          awaited,
        ),
    ),
  );
  const routes = mountEffectRoutes(
    options.runtime,
    HttpApiBuilder.layer(CapabilitiesApi).pipe(Layer.provide(handlers)),
  );
  app.get("/status", routes);
  if (actionLinks) {
    app.post("/links", routes);
    app.post("/links/:token/revoke", routes);
  }
  app.post("/proposals", routes);
  app.post("/grants", routes);
  for (const path of ["revoke", "cancel", "reconcile", "execute"])
    app.post(`/grants/:id/${path}`, routes);
  app.get("/grants/:id/receipt", routes);
  app.get("/audit", routes);
  return app;
}
