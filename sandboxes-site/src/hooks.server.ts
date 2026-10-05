import { type Handle, redirect } from "@sveltejs/kit";
import { dev } from "$app/environment";
import { sessionCookie } from "$lib/server/auth.js";
import { config } from "$lib/server/config.js";

export const handle: Handle = async ({ event, resolve }) => {
  if (
    !["GET", "HEAD"].includes(event.request.method) &&
    event.request.headers.get("origin") !== event.url.origin
  ) {
    return new Response("Origin not allowed", { status: 403 });
  }
  const publicRoute =
    event.url.pathname === "/login" || event.url.pathname === "/health";
  if (
    !publicRoute &&
    !config().sessions.valid(event.cookies.get(sessionCookie))
  ) {
    if (event.url.pathname.startsWith("/api/"))
      return new Response("Sign in required", {
        status: 401,
        headers: { "cache-control": "no-store" },
      });
    redirect(303, "/login");
  }
  const response = await resolve(event);
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-content-type-options", "nosniff");
  // no-referrer makes native form POSTs send Origin:null, failing CSRF checks.
  response.headers.set("referrer-policy", "same-origin");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=()",
  );
  if (!dev)
    response.headers.set("strict-transport-security", "max-age=31536000");
  return response;
};
