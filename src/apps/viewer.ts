import { Hono } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { appIdSchema, digestSchema } from "./artifact.js";
import type { AppReceipt } from "./client.js";

const domain = z
  .string()
  .max(200)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/);
export const viewerConfigSchema = z
  .strictObject({
    port: z.number().int().min(1024).max(65535),
    publicDomain: domain,
    signedInDomain: domain,
    issuer: z.string().regex(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/),
    audience: digestSchema,
  })
  .refine(
    ({ publicDomain, signedInDomain }) =>
      publicDomain !== signedInDomain &&
      !publicDomain.endsWith(`.${signedInDomain}`) &&
      !signedInDomain.endsWith(`.${publicDomain}`),
  );
export type ViewerConfig = z.infer<typeof viewerConfigSchema>;

export function appViewerUrl(
  config: ViewerConfig,
  appId: string,
  access: "public" | "signed-in",
) {
  return `https://${appId}.${access === "public" ? config.publicDomain : config.signedInDomain}/apps/${appId}/`;
}

/** Separate listener: never mount control, health, or engine routes here. */
export function createAppsViewer(options: {
  config: ViewerConfig;
  publication(appId: string): AppReceipt | null;
  serve(request: Request, appId: string): Promise<Response>;
  log(event: Record<string, string | number>): void;
}) {
  const { config } = options;
  const keys = createRemoteJWKSet(
    new URL(`${config.issuer}/cdn-cgi/access/certs`),
    { timeoutDuration: 3000 },
  );
  const app = new Hono();
  app.onError(() =>
    Response.json({ error: "viewer_unavailable" }, { status: 503 }),
  );
  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    // Never let an app/cache preserve authenticated content after a policy change.
    c.header("Cache-Control", "no-store, private");
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    c.header("Origin-Agent-Cluster", "?1");
    c.header(
      "Content-Security-Policy",
      "frame-ancestors 'none'; worker-src 'none'",
      { append: true },
    );
    options.log({
      event: "viewer_request",
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  });
  app.all("/apps/:appId/*", async (c) => {
    const id = appIdSchema.safeParse(c.req.param("appId"));
    if (!id.success) return c.notFound();
    const receipt = options.publication(id.data);
    if (!receipt?.access || receipt.status !== "deployed") return c.notFound();
    const expected = new URL(appViewerUrl(config, id.data, receipt.access));
    const url = new URL(c.req.url);
    // Forwarded host/proto/identity headers are not a source of authority.
    if (
      url.host !== expected.host ||
      !url.pathname.startsWith(expected.pathname)
    )
      return c.notFound();
    if (receipt.access === "signed-in") {
      const token = c.req.header("cf-access-jwt-assertion");
      if (!token || token.length > 16_384)
        return c.json({ error: "sign_in_required" }, 401);
      try {
        const { payload } = await jwtVerify(token, keys, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: ["RS256"],
          requiredClaims: ["exp", "iat", "sub", "email"],
        });
        // A signed human identity, not an email header or a service token.
        if (
          payload.type !== "app" ||
          typeof payload.sub !== "string" ||
          !payload.sub ||
          typeof payload.email !== "string" ||
          !payload.email.includes("@")
        )
          throw new Error("human_identity_required");
      } catch {
        return c.json({ error: "sign_in_required" }, 401);
      }
      const origin = c.req.header("origin");
      const site = c.req.header("sec-fetch-site");
      const navigation =
        ["GET", "HEAD"].includes(c.req.method) &&
        c.req.header("sec-fetch-mode") === "navigate";
      if (
        (origin && origin !== expected.origin) ||
        (site && site !== "same-origin" && site !== "none" && !navigation)
      )
        return c.json({ error: "cross_origin_request" }, 403);
    }
    // Authentication may have awaited key retrieval while deployment changed.
    if (options.publication(id.data)?.id !== receipt.id) return c.notFound();
    const headers = new Headers();
    for (const name of [
      "accept",
      "accept-language",
      "content-type",
      "range",
      "if-none-match",
    ])
      if (c.req.header(name)) headers.set(name, c.req.header(name) ?? "");
    const response = await options.serve(
      new Request(c.req.raw, { headers }),
      id.data,
    );
    if (options.publication(id.data)?.id !== receipt.id) {
      await response.body?.cancel();
      return c.notFound();
    }
    const outgoing = new Headers();
    response.headers.forEach((value, name) => {
      if (
        name !== "set-cookie" &&
        !name.startsWith("access-control-") &&
        name !== "service-worker-allowed" &&
        name !== "cdn-cache-control" &&
        name !== "cloudflare-cdn-cache-control" &&
        name !== "surrogate-control"
      )
        outgoing.append(name, value);
    });
    return new Response(response.body, {
      status: response.status,
      headers: outgoing,
    });
  });
  return app;
}
