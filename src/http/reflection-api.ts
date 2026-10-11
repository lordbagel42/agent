import { Effect, Layer, Schema } from "effect";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";
import type { ReflectionInput } from "../runtime/reflection.js";
import { attempt, awaited, json, jsonBody, respond } from "./effect.js";

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
  const failed = respond(() =>
    Effect.sync(deps.report).pipe(Effect.as(json(requestFailed, 500))),
  );
  const handlers = HttpApiBuilder.group(ReflectionApi, "reflection", (h) =>
    Effect.succeed(
      h
        .handle(
          "status",
          () =>
            failed(
              attempt(() => deps.actor.status()).pipe(
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
                const input = yield* jsonBody(Enqueue);
                const scope = yield* attempt(() => deps.audience(input.scope));
                return yield* attempt(() =>
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
                const { id } = yield* jsonBody(ById);
                return {
                  cancelled: yield* attempt(() => deps.actor.cancel(id)),
                };
              }).pipe(Effect.withSpan("june.http.reflection.cancel")),
            ),
          awaited,
        )
        .handleRaw(
          "candidate",
          () =>
            failed(
              Effect.gen(function* () {
                const { id } = yield* jsonBody(ById);
                return yield* attempt(() => deps.actor.candidate(id));
              }).pipe(Effect.withSpan("june.http.reflection.candidate")),
            ),
          awaited,
        )
        .handleRaw(
          "reconcile",
          () =>
            failed(
              Effect.gen(function* () {
                const input = yield* jsonBody(Reconcile);
                if (input.live) {
                  yield* attempt(() => deps.actor.occupancy(input.id, false));
                  return { reconciled: true };
                }
                return {
                  reconciled: yield* attempt(() =>
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
