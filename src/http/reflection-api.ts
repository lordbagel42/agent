import { Cause, Effect, Layer, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";
import type { ReflectionInput } from "../runtime/reflection.js";

/** The single operator failure body; Hono's `onError` returned the same. */
const RequestFailed = Schema.Struct({
  error: Schema.Literal("request_failed"),
}).pipe(HttpApiSchema.status(500));
const requestFailed = { error: "request_failed" } as const;

const Id = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(250000),
);
const Enqueue = Schema.Struct({
  scope: Schema.optionalKey(Schema.String),
  evidenceIds: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  kind: Schema.Literals(["curiosity", "reflection"]),
  mode: Schema.Literals(["interaction", "idle", "deep"]),
});
const ById = Schema.Struct({ id: Id });
const Reconcile = Schema.Struct({
  id: Id,
  confirmedStopped: Schema.Literal(true),
  live: Schema.optionalKey(Schema.Boolean),
});

const endpoint = <const Name extends string, const Path extends `/${string}`>(
  name: Name,
  path: Path,
  payload: typeof Enqueue | typeof ById | typeof Reconcile,
) =>
  HttpApiEndpoint.post(name, path, {
    payload,
    success: Schema.Any,
    error: RequestFailed,
  });

export class ReflectionApi extends HttpApi.make("june-operator").add(
  HttpApiGroup.make("reflection")
    .add(
      HttpApiEndpoint.get("status", "/", {
        success: Schema.Any,
        error: RequestFailed,
      }),
      endpoint("enqueue", "/enqueue", Enqueue),
      endpoint("cancel", "/cancel", ById),
      endpoint("candidate", "/candidate", ById),
      endpoint("reconcile", "/reconcile", Reconcile),
    )
    .prefix("/operator/reflection"),
) {}

export interface ReflectionRouteDependencies {
  actor: {
    status(): Promise<unknown>;
    enqueue(input: ReflectionInput): Promise<unknown>;
    cancel(id: string): Promise<unknown>;
    candidate(id: string): Promise<unknown>;
    reconcile(id: string, confirmedStopped: true): Promise<unknown>;
    occupancy(id: string, active: boolean): Promise<unknown>;
  };
  /** Resolves the memory audience; throws for an unconfigured one. */
  audience(scope: string | undefined): string;
  /** Records the failed request for automatic repair. */
  report(): void;
}

/**
 * Operator reflection control. Hono still authenticates `/operator/*` and
 * fences admission before these handlers run. Bodies are read like Hono's
 * `c.req.json()` (no content-type requirement) and decoded strictly, as the
 * former Zod `strictObject`s did; every failure is a 500 `request_failed`.
 */
export const reflectionRoutes = (deps: ReflectionRouteDependencies) => {
  const call = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => cause });
  const body = <A>(schema: Schema.ConstraintDecoder<A, never>) =>
    HttpServerRequest.schemaBodyJson(schema, { onExcessProperty: "error" });
  // Serialized here, not by the endpoint encoder, so a value JSON.stringify
  // rejects fails like Hono's `c.json` did instead of becoming a defect.
  const failed = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    typeof requestFailed,
    R
  > =>
    effect.pipe(
      Effect.flatMap((value) => HttpServerResponse.json(value)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? (Effect.failCause(cause) as Effect.Effect<never>)
          : Effect.sync(deps.report).pipe(
              Effect.andThen(Effect.fail(requestFailed)),
            ),
      ),
    );
  // Like the Hono handlers, finish the actor call and keep the admission fence
  // held even if the client disconnects; aborts must not cancel mutations.
  const awaited = { uninterruptible: true };
  const handlers = HttpApiBuilder.group(ReflectionApi, "reflection", (h) =>
    Effect.succeed(
      h
        .handle(
          "status",
          () =>
            failed(
              call(() => deps.actor.status()).pipe(
                Effect.withSpan("june.http.reflection.status"),
              ),
            ),
          awaited,
        )
        .handleRaw(
          "enqueue",
          () =>
            failed(
              Effect.gen(function* () {
                const input = yield* body(Enqueue);
                const scope = yield* Effect.try({
                  try: () => deps.audience(input.scope),
                  catch: (cause) => cause,
                });
                return yield* call(() =>
                  deps.actor.enqueue({ ...input, scope } as ReflectionInput),
                );
              }).pipe(Effect.withSpan("june.http.reflection.enqueue")),
            ),
          awaited,
        )
        .handleRaw(
          "cancel",
          () =>
            failed(
              Effect.gen(function* () {
                const { id } = yield* body(ById);
                return { cancelled: yield* call(() => deps.actor.cancel(id)) };
              }).pipe(Effect.withSpan("june.http.reflection.cancel")),
            ),
          awaited,
        )
        .handleRaw(
          "candidate",
          () =>
            failed(
              Effect.gen(function* () {
                const { id } = yield* body(ById);
                return yield* call(() => deps.actor.candidate(id));
              }).pipe(Effect.withSpan("june.http.reflection.candidate")),
            ),
          awaited,
        )
        .handleRaw(
          "reconcile",
          () =>
            failed(
              Effect.gen(function* () {
                const input = yield* body(Reconcile);
                if (input.live) {
                  yield* call(() => deps.actor.occupancy(input.id, false));
                  return { reconciled: true };
                }
                return {
                  reconciled: yield* call(() =>
                    deps.actor.reconcile(input.id, true),
                  ),
                };
              }).pipe(Effect.withSpan("june.http.reflection.reconcile")),
            ),
          awaited,
        ),
    ),
  );
  return HttpApiBuilder.layer(ReflectionApi).pipe(Layer.provide(handlers));
};
