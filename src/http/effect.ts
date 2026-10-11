import { Cause, Effect, Layer, type Schema, Scope } from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { type JuneRuntime, TelemetryLayer } from "../effect/runtime.js";

/**
 * Serves migrated Effect routes from a Hono route while Hono owns the socket.
 * Hono's auth, lifecycle fence, body limit and `june.http.request` span still
 * run first. Handler spans join June's private telemetry under that span;
 * Effect's per-request server span stays disabled. The mount is disposed with
 * the process runtime.
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
    {
      // Own memo map: memoized `HttpRouter.layer` would otherwise be one
      // router shared by every mount. The tracer layer is a stateless wrapper.
      disableLogger: true,
      // Hono matches parameters of any length; find-my-way defaults to 100.
      routerConfig: { maxParamLength: Number.MAX_SAFE_INTEGER },
    },
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

/** Route option for handlers that must finish once started, as Hono's did:
 * a client abort neither cancels the work nor releases the admission fence. */
export const awaited = { uninterruptible: true } as const;

/** Reads the body like Hono's `c.req.json()` (any content type) and decodes it
 * strictly, like Zod's `strictObject(...).parse`. */
export const jsonBody = <A>(schema: Schema.ConstraintDecoder<A, never>) =>
  HttpServerRequest.schemaBodyJson(schema, { onExcessProperty: "error" });

/** A promise whose rejection is a handler failure, like an awaited throw. */
export const attempt = <A>(run: () => A | Promise<A>) =>
  Effect.tryPromise({ try: async () => run(), catch: (cause) => cause });

/** `c.json(body, status)`. */
export const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status });

/**
 * Responds like a Hono handler in a group with an `onError`: a value is sent
 * as `c.json(value)`, a response as is, and any failure or defect goes to
 * `onError` with the thrown value. Serializing here keeps a value
 * `JSON.stringify` rejects a handler failure, as it was in `c.json`.
 * Interruption (client abort) passes through.
 */
export const respond =
  <R2>(
    onError: (
      error: unknown,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R2>,
  ) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R | R2> =>
    effect.pipe(
      Effect.flatMap((value) =>
        HttpServerResponse.isHttpServerResponse(value)
          ? Effect.succeed(value)
          : HttpServerResponse.json(value),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? (Effect.failCause(cause) as Effect.Effect<never>)
          : onError(Cause.squash(cause)),
      ),
    );

// Hono's query decoding: `+` is a space and a malformed escape stays literal
// (URLSearchParams would substitute U+FFFD).
const decodeQuery = (value: string) => {
  const spaced = value.replaceAll("+", " ");
  if (!spaced.includes("%")) return spaced;
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
      try {
        return decodeURIComponent(match);
      } catch {
        return match;
      }
    });
  }
};

/** Hono's `c.req.queries()` for a request URL: every value per name, in order. */
export function queries(url: string): Record<string, string[]> {
  const result: Record<string, string[]> = Object.create(null);
  const start = url.indexOf("?");
  if (start === -1) return result;
  const hash = url.indexOf("#", start);
  for (const part of url
    .slice(start + 1, hash === -1 ? undefined : hash)
    .split("&")) {
    const equals = part.indexOf("=");
    const name = decodeQuery(equals === -1 ? part : part.slice(0, equals));
    if (name === "") continue;
    const value = equals === -1 ? "" : decodeQuery(part.slice(equals + 1));
    if (result[name]) result[name].push(value);
    else result[name] = [value];
  }
  return result;
}

/** Hono's `c.req.query(name)`: the first value. */
export const query = (url: string, name: string): string | undefined =>
  queries(url)[name]?.[0];
