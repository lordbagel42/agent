import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { messagePage } from "./view.js";

export interface PrivateRouteSecurity {
  /** Canonical externally visible origin. Never derive this from Host headers. */
  origin: string;
  csrfSecret: string;
  /** Set only when this host mounts the browser session bridge. */
  signInPath?: string;
  /** Trusted owner/session identity, never a request field. Undefined denies access. */
  authenticate(request: Request): Promise<string | undefined>;
}
export type PrivateEnv = { Variables: { principal: string; nonce: string } };

/** Mount only on private ingress. Disable/redact URL and body access logs upstream. */
export function privateRoutes(security: PrivateRouteSecurity) {
  const origin = new URL(security.origin);
  if (
    origin.origin !== security.origin ||
    security.csrfSecret.length < 32 ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      ))
  )
    throw new Error("Invalid private route security configuration");
  const app = new Hono<PrivateEnv>();
  app.onError((_error, c) =>
    c.html(
      messagePage(
        c.get("nonce"),
        "Service unavailable",
        "No success has been confirmed. Inspect the host's state before considering another attempt. Do not repeat an uncertain action.",
        503,
      ),
      503,
    ),
  );
  app.use("*", async (c, next) => {
    const nonce = randomBytes(18).toString("base64url");
    c.set("nonce", nonce);
    c.header("Cache-Control", "no-store, private");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
    c.header(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    );
    const principal = await security.authenticate(c.req.raw);
    if (!principal)
      return c.html(
        messagePage(
          nonce,
          "Authentication required",
          "Sign in through this host's private session entry point, then open the console or original action link again.",
          401,
          security.signInPath
            ? {
                label: "Sign in →",
                href: `${security.signInPath}${c.req.method === "GET" ? `?returnTo=${encodeURIComponent(new URL(c.req.url).pathname)}` : ""}`,
              }
            : undefined,
        ),
        401,
      );
    c.set("principal", principal);
    // no-referrer makes native form submissions send Origin: null in browsers.
    // Accept that only with browser-enforced same-origin fetch metadata; the
    // action handler still requires a signed principal/path/content-bound proof.
    const sameOrigin =
      c.req.header("origin") === security.origin ||
      (c.req.header("origin") === "null" &&
        c.req.header("sec-fetch-site") === "same-origin");
    if (
      c.req.method === "POST" &&
      (!sameOrigin ||
        c.req.header("sec-fetch-site") === "cross-site" ||
        c.req.header("content-type")?.split(";")[0] !==
          "application/x-www-form-urlencoded")
    )
      return c.html(
        messagePage(
          nonce,
          "Confirmation rejected",
          "Use the confirmation form on this private origin. No permission was granted by this request.",
          403,
        ),
        403,
      );
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 8192,
      onError: (c) =>
        c.html(
          messagePage(
            c.get("nonce"),
            "Request too large",
            "This private form accepts only a bounded confirmation request.",
            413,
          ),
          413,
        ),
    }),
  );
  return app;
}

/** Keep recovery local and query-free: never carry OAuth codes or replay a POST. */
export function sessionReturnPath(value: unknown, fallback: string): string {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\%\s?#]/u.test(value)
  )
    return fallback;
  return new URL(value, "https://local.invalid").pathname === value
    ? value
    : fallback;
}

export function binding(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Stateless CSRF proof bound to identity, exact route and reviewed content.
 * The host must durably deduplicate commandId; this proof is not an execution lock. */
export function confirmations(secret: string) {
  const sign = (principal: string, path: string, payload: string) =>
    createHmac("sha256", secret)
      .update(JSON.stringify([principal, path, payload]))
      .digest("base64url");
  return {
    issue(principal: string, path: string, reviewed: string) {
      const payload = Buffer.from(
        JSON.stringify({
          reviewed,
          commandId: randomUUID(),
          expires: Date.now() + 600_000,
        }),
      ).toString("base64url");
      return `${payload}.${sign(principal, path, payload)}`;
    },
    verify(
      principal: string,
      path: string,
      reviewed: string,
      proof: unknown,
    ): string | undefined {
      if (typeof proof !== "string" || proof.length > 2048) return;
      const [payload, signature, extra] = proof.split(".");
      if (!payload || !signature || extra !== undefined) return;
      const expected = Buffer.from(sign(principal, path, payload));
      const actual = Buffer.from(signature);
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      )
        return;
      try {
        const value = JSON.parse(Buffer.from(payload, "base64url").toString());
        if (
          value.reviewed === reviewed &&
          value.expires > Date.now() &&
          typeof value.commandId === "string"
        )
          return value.commandId;
      } catch {
        /* Invalid proofs never reach the host. */
      }
    },
  };
}
