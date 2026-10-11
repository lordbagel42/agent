import { Effect, Layer, Schema } from "effect";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";
import { Int, isPattern } from "../effect/schema.js";
import type { ImportedMemoryExtraction } from "../imports/extraction.js";
import type { HistoryImports } from "../imports/index.js";
import { ImportBudgetExceeded, type ImportCoverage } from "../memory/store.js";
import { attempt, awaited, json, jsonBody, respond } from "./effect.js";

const Digest = Schema.String.check(isPattern(/^[a-f0-9]{64}$/));
const Start = Schema.Struct({
  confirmed: Schema.Literal(true),
  digest: Digest,
  expectedPages: Int({ minimum: 0 }),
});
const ExtractionStart = Schema.Struct({
  confirmed: Schema.Literal(true),
  digest: Digest,
});
const ExtractionCancel = Schema.Struct({ digest: Digest });

const params = { id: Schema.String };
const endpoint = { success: Schema.Any };
export class ImportsApi extends HttpApi.make("june-operator").add(
  HttpApiGroup.make("imports")
    .add(
      HttpApiEndpoint.get("review", "/", endpoint),
      HttpApiEndpoint.post("start", "/:id/start", {
        params,
        payload: Start,
        ...endpoint,
      }),
      HttpApiEndpoint.post("cancel", "/:id/cancel", { params, ...endpoint }),
      HttpApiEndpoint.get("extraction", "/:id/extraction", {
        params,
        ...endpoint,
      }),
      HttpApiEndpoint.post("extractionStart", "/:id/extraction/start", {
        params,
        payload: ExtractionStart,
        ...endpoint,
      }),
      HttpApiEndpoint.post("extractionCancel", "/:id/extraction/cancel", {
        params,
        payload: ExtractionCancel,
        ...endpoint,
      }),
    )
    .prefix("/operator/imports"),
) {}

/** Hono paths for `mountEffectRoutes`. */
export const importPaths = {
  get: ["/operator/imports", "/operator/imports/:id/extraction"],
  post: [
    "/operator/imports/:id/start",
    "/operator/imports/:id/cancel",
    "/operator/imports/:id/extraction/start",
    "/operator/imports/:id/extraction/cancel",
  ],
};

/** Mount behind owner bearer auth. A selection is not consent to fetch it.
 * Every page requires exact coverage confirmation and the expected page count;
 * a lost response cannot advance another page with the same confirmation.
 */
export function importRoutes(
  imports: HistoryImports,
  selections: Record<string, ImportCoverage>,
  extraction?: ImportedMemoryExtraction,
) {
  const configuredIds = new Set(Object.keys(selections));
  const rejected = respond((error) =>
    Effect.succeed(
      error instanceof ImportBudgetExceeded
        ? json(
            {
              error: "import_budget_exceeded",
              dimension: error.dimension,
              reason: error.message,
            },
            409,
          )
        : json({ error: "import_request_rejected" }, 400),
    ),
  );
  const unavailable = json({ error: "extraction_unavailable" }, 503);
  const handlers = HttpApiBuilder.group(ImportsApi, "imports", (h) =>
    Effect.succeed(
      h
        .handle(
          "review",
          () =>
            rejected(
              attempt(() =>
                Object.fromEntries(
                  [...configuredIds].map((id) => [id, imports.review(id)]),
                ),
              ).pipe(Effect.withSpan("june.http.imports.review")),
            ),
          awaited,
        )
        .handleRaw(
          "start",
          ({ params }) =>
            rejected(
              Effect.gen(function* () {
                if (!configuredIds.has(params.id))
                  return json({ error: "not_found" }, 404);
                const input = yield* jsonBody(Start);
                const selection = yield* attempt(() =>
                  imports.review(params.id),
                );
                if (
                  input.digest !== selection.digest ||
                  input.expectedPages !== (selection.progress?.pages ?? 0)
                )
                  return json({ error: "import_review_changed" }, 409);
                // beginImport durably binds the approved coverage before credential lookup.
                return yield* attempt(() => imports.start(params.id));
              }).pipe(Effect.withSpan("june.http.imports.start")),
            ),
          awaited,
        )
        .handle(
          "cancel",
          ({ params }) =>
            rejected(
              attempt(() => imports.cancel(params.id)).pipe(
                Effect.withSpan("june.http.imports.cancel"),
              ),
            ),
          awaited,
        )
        .handle(
          "extraction",
          ({ params }) =>
            rejected(
              Effect.gen(function* () {
                if (!extraction) return unavailable;
                return yield* attempt(() => extraction.review(params.id));
              }).pipe(Effect.withSpan("june.http.imports.extraction")),
            ),
          awaited,
        )
        .handleRaw(
          "extractionStart",
          ({ params }) =>
            rejected(
              Effect.gen(function* () {
                if (!extraction) return unavailable;
                const input = yield* jsonBody(ExtractionStart);
                const review = yield* attempt(() =>
                  extraction.review(params.id),
                );
                if (review.digest !== input.digest)
                  return json({ error: "extraction_review_changed" }, 409);
                return yield* attempt(() =>
                  extraction.start(params.id, input.digest),
                );
              }).pipe(Effect.withSpan("june.http.imports.extraction_start")),
            ),
          awaited,
        )
        .handleRaw(
          "extractionCancel",
          ({ params }) =>
            rejected(
              Effect.gen(function* () {
                if (!extraction) return unavailable;
                const input = yield* jsonBody(ExtractionCancel);
                return yield* attempt(() =>
                  extraction.cancel(params.id, input.digest),
                );
              }).pipe(Effect.withSpan("june.http.imports.extraction_cancel")),
            ),
          awaited,
        ),
    ),
  );
  return HttpApiBuilder.layer(ImportsApi).pipe(Layer.provide(handlers));
}
