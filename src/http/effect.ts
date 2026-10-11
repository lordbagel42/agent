import { Effect, Layer, Scope } from "effect";
import { HttpMiddleware, HttpRouter, HttpServer } from "effect/http";
import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { type JuneRuntime, TelemetryLayer } from "../effect/runtime.js";

/**
 * Serves migrated Effect routes from a Hono route while Hono owns the socket.
 * Hono's auth, lifecycle fence, body limit and `june.http.request` span still
 * run first. Handler spans join June's private telemetry through the process
 * runtime's memoized tracer; Effect's per-request server span stays disabled.
 */
export function mountEffectRoutes(
  runtime: JuneRuntime,
  routes: Layer.Layer<
    never,
    never,
    HttpRouter.HttpRouter | Layer.Success<typeof HttpServer.layerServices>
  >,
) {
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(
      routes,
      TelemetryLayer,
      Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => true),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { memoMap: runtime.memoMap, disableLogger: true },
  );
  // Released with the process runtime, before its own layers.
  Effect.runSync(Scope.addFinalizer(runtime.scope, Effect.promise(dispose)));
  return async (c: Context) => {
    const response = await handler(c.req.raw);
    // Through Hono's builder, so headers set by earlier middleware (such as
    // the operator cache policy) and the buffered body match `c.json`; the
    // Node adapter derives the length as it does for Hono's own responses.
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    // Null-body statuses (204, 304, HEAD) must stay null for `new Response`.
    const body = response.body === null ? null : await response.arrayBuffer();
    return c.newResponse(body, {
      status: response.status as StatusCode,
      headers,
    });
  };
}
