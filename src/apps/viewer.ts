import { Hono } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { appIdSchema, digestSchema } from "./artifact.js";
import type { AppReceipt } from "./client.js";

const domain = z
  .string()
  .max(200)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/);
export const SIGNED_IN_SUFFIX = "--signed-in";
export const viewerConfigSchema = z.strictObject({
  port: z.number().int().min(1024).max(65535),
  /** Zone apex: control at <domain>, apps at <app>.<domain> and
   * <app>--signed-in.<domain>, one label deep so universal TLS covers them. */
  domain,
  issuer: z.string().regex(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/),
  audience: digestSchema,
});
export type ViewerConfig = z.infer<typeof viewerConfigSchema>;

export function appViewerUrl(
  config: ViewerConfig,
  appId: string,
  access: "public" | "signed-in",
) {
  return `https://${appId}${access === "signed-in" ? SIGNED_IN_SUFFIX : ""}.${config.domain}/apps/${appId}/`;
}

/** Public listener: apps on subdomains; only the signed control API and a
 * readiness summary on the apex. Never mount engine or bearer routes here. */
export function createAppsViewer(options: {
  config: ViewerConfig;
  /** Served only for the apex host: June's signed control API and /health. */
  apex: Hono;
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
      event:
        new URL(c.req.url).hostname === config.domain
          ? "apex_request"
          : "viewer_request",
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  });
  app.all("*", async (c) => {
    const url = new URL(c.req.url);
    if (url.hostname === config.domain) return options.apex.fetch(c.req.raw);
    const label = url.hostname.endsWith(`.${config.domain}`)
      ? url.hostname.slice(0, -config.domain.length - 1)
      : "";
    // The Host header selects app and audience; forwarded headers never do.
    const access = label.endsWith(SIGNED_IN_SUFFIX) ? "signed-in" : "public";
    const id = appIdSchema.safeParse(
      access === "signed-in" ? label.slice(0, -SIGNED_IN_SUFFIX.length) : label,
    );
    if (!id.success) return c.notFound();
    const prefix = `/apps/${id.data}/`;
    if (url.pathname === "/" || url.pathname === prefix.slice(0, -1))
      return c.redirect(prefix, 302);
    if (!url.pathname.startsWith(prefix)) return c.notFound();
    const receipt = options.publication(id.data);
    // A signed-in app is never served on its public hostname or vice versa.
    if (
      !receipt?.access ||
      receipt.access !== access ||
      receipt.status !== "deployed"
    )
      return c.notFound();
    const expected = new URL(appViewerUrl(config, id.data, receipt.access));
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
