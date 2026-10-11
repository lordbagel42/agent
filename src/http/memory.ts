import { Effect, Layer, Schema, SchemaTransformation } from "effect";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";
import { isPattern, Uuid } from "../effect/schema.js";
import type { CuratedPersonalityStore } from "../memory/curated.js";
import type { EvidenceStore } from "../memory/store.js";
import {
  attempt,
  awaited,
  json,
  jsonBody,
  queries,
  query,
  respond,
} from "./effect.js";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
const BackupId = Schema.String.check(isPattern(/^[a-f0-9]{64}$/));
const Integer = Schema.String.check(isPattern(/^(0|[1-9]\d{0,15})$/)).pipe(
  Schema.decodeTo(
    Schema.Number,
    SchemaTransformation.transform({ decode: Number, encode: String }),
  ),
);
const Tombstones = Schema.Struct({
  audience: Schema.optionalKey(Id),
  after: Schema.optionalKey(Integer),
  watermark: Schema.optionalKey(Integer),
  limit: Schema.optionalKey(Integer),
});
const Backup = Schema.Struct({ id: BackupId, confirmed: Schema.Literal(true) });
const Restore = Schema.Struct({ id: BackupId });
const Review = Schema.Struct({
  audience: Schema.optionalKey(Id),
  decision: Schema.Literals(["accepted", "rejected"]),
});
const Forget = Schema.Struct({
  audience: Schema.optionalKey(Id),
  sourceId: Id,
  confirmed: Schema.Literal(true),
});
const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2000),
);
const Revise = Schema.Struct({
  audience: Schema.optionalKey(Id),
  id: Uuid,
  trait: Schema.Literals(["verbosity", "tone", "humor", "interests"]),
  value: Text,
  basis: Schema.Literals(["owner-correction", "inferred"]),
  evidenceIds: Schema.Array(Id).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
  explanation: Text,
  confidence: Schema.Number.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(1),
  ),
  confirmed: Schema.Literal(true),
});
const Rollback = Schema.Struct({
  id: Uuid,
  target: Id,
  explanation: Text,
  confirmed: Schema.Literal(true),
});

const Rejected = Schema.Struct({
  error: Schema.Literal("memory_request_rejected"),
}).pipe(HttpApiSchema.status(400));
const NotFound = Schema.Struct({ error: Schema.Literal("not_found") }).pipe(
  HttpApiSchema.status(404),
);
const get = <const Name extends string, const Path extends `/${string}`>(
  name: Name,
  path: Path,
) => HttpApiEndpoint.get(name, path, { success: Schema.Any, error: Rejected });
const post = <
  const Name extends string,
  const Path extends `/${string}`,
  P extends Schema.Top & { readonly DecodingServices: never },
>(
  name: Name,
  path: Path,
  payload: P,
) =>
  HttpApiEndpoint.post(name, path, {
    payload,
    success: Schema.Any,
    error: Rejected,
  });

export class MemoryApi extends HttpApi.make("june-operator").add(
  HttpApiGroup.make("memory")
    .add(
      get("retrieve", "/"),
      get("tombstones", "/tombstones"),
      get("backupStatus", "/backup"),
      post("backup", "/backup", Backup),
      post("validateRestore", "/restore/validate", Restore),
      // The ID is validated in the handler so a bad one is `memory_request_rejected`.
      HttpApiEndpoint.post("review", "/proposals/:id/review", {
        params: { id: Schema.String },
        payload: Review,
        success: Schema.Any,
        error: Rejected,
      }),
      HttpApiEndpoint.post("forget", "/forget", {
        payload: Forget,
        success: Schema.Any,
        error: [Rejected, NotFound],
      }),
      post("revisePersonality", "/personality/revise", Revise),
      post("rollbackPersonality", "/personality/rollback", Rollback),
    )
    .prefix("/operator/memory"),
) {}

/** Hono paths for `mountEffectRoutes`; the personality routes exist only with
 * a personality store. */
export const memoryPaths = (personality: boolean) => ({
  get: [
    "/operator/memory",
    "/operator/memory/tombstones",
    "/operator/memory/backup",
  ],
  post: [
    "/operator/memory/backup",
    "/operator/memory/restore/validate",
    "/operator/memory/proposals/:id/review",
    "/operator/memory/forget",
    ...(personality
      ? [
          "/operator/memory/personality/revise",
          "/operator/memory/personality/rollback",
        ]
      : []),
  ],
});

/** Mount ONLY behind the host's owner bearer authentication. No model access.
 * Every failure is a 400 `memory_request_rejected`, as the Hono group's
 * `onError` returned; bodies and queries are decoded strictly. */
export function memoryRoutes(deps: {
  store: EvidenceStore;
  personality?: CuratedPersonalityStore;
  audience(value: unknown): string;
  invalidateDeliveries?(): void;
  forget(audience: string, sourceId: string): Promise<void>;
}) {
  const rejected = respond(() =>
    Effect.succeed(json({ error: "memory_request_rejected" }, 400)),
  );
  // Hono registers the personality paths only when the store exists.
  const personality = Effect.suspend(() =>
    deps.personality
      ? Effect.succeed(deps.personality)
      : Effect.die("personality_unavailable"),
  );
  const handlers = HttpApiBuilder.group(MemoryApi, "memory", (h) =>
    Effect.succeed(
      h
        .handle(
          "retrieve",
          ({ request }) =>
            rejected(
              attempt(() => {
                const audience = deps.audience(query(request.url, "audience"));
                return {
                  ...deps.store.retrieve(
                    audience,
                    query(request.url, "query") ?? "",
                  ),
                  proposals: deps.store.proposals(audience),
                  personality:
                    deps.personality?.effectiveTraits(audience) ?? {},
                  revisions: deps.personality?.ownerHistory() ?? null,
                };
              }).pipe(Effect.withSpan("june.http.memory.retrieve")),
            ),
          awaited,
        )
        .handle(
          "tombstones",
          ({ request }) =>
            rejected(
              Effect.gen(function* () {
                const all = queries(request.url);
                if (Object.values(all).some((values) => values.length !== 1))
                  return yield* Effect.fail("invalid_tombstone_query");
                const { audience, ...options } =
                  yield* Schema.decodeUnknownEffect(Tombstones, {
                    onExcessProperty: "error",
                  })(
                    Object.fromEntries(
                      Object.entries(all).map(([k, [v]]) => [k, v]),
                    ),
                  );
                yield* attempt(() => deps.audience(audience));
                // Ledger-wide owner export. Tombstones intentionally retain no audiences.
                return yield* attempt(() =>
                  deps.store.exportTombstones(options),
                );
              }).pipe(Effect.withSpan("june.http.memory.tombstones")),
            ),
          awaited,
        )
        .handle(
          "backupStatus",
          () =>
            rejected(
              attempt(() => deps.store.backupStatus()).pipe(
                Effect.withSpan("june.http.memory.backup_status"),
              ),
            ),
          awaited,
        )
        .handleRaw(
          "backup",
          () =>
            rejected(
              Effect.gen(function* () {
                const input = yield* jsonBody(Backup);
                return {
                  manifest: yield* attempt(() => deps.store.backup(input.id)),
                };
              }).pipe(Effect.withSpan("june.http.memory.backup")),
            ),
          awaited,
        )
        .handleRaw(
          "validateRestore",
          () =>
            rejected(
              Effect.gen(function* () {
                const input = yield* jsonBody(Restore);
                // Fixed local backup ID; never accept a path, key, or caller's watermark.
                return yield* attempt(() =>
                  deps.store.validateBackup(input.id),
                );
              }).pipe(Effect.withSpan("june.http.memory.validate_restore")),
            ),
          awaited,
        )
        .handleRaw(
          "review",
          ({ params }) =>
            rejected(
              Effect.gen(function* () {
                const input = yield* jsonBody(Review);
                const audience = yield* attempt(() =>
                  deps.audience(input.audience),
                );
                const id = yield* Schema.decodeUnknownEffect(Id)(params.id);
                yield* attempt(() =>
                  deps.store.reviewProposal(audience, id, input.decision),
                );
                return { reviewed: true };
              }).pipe(Effect.withSpan("june.http.memory.review")),
            ),
          awaited,
        )
        .handleRaw(
          "forget",
          () =>
            rejected(
              Effect.gen(function* () {
                const input = yield* jsonBody(Forget);
                const audience = yield* attempt(() =>
                  deps.audience(input.audience),
                );
                const known = yield* attempt(
                  () =>
                    !!deps.store.source(audience, input.sourceId) ||
                    deps.store.isDeleted(input.sourceId),
                );
                if (!known) return json({ error: "not_found" }, 404);
                yield* attempt(async () => {
                  // Cancel queued external copies before tombstoning, with no async gap.
                  // A crash here may over-cancel, never dispatch forgotten context on restart.
                  deps.invalidateDeliveries?.();
                  // Ledger before working-context cleanup. A crash still fails closed
                  // at runtime source revalidation; retry repeats the remaining cleanup.
                  deps.store.deleteSource(input.sourceId);
                  deps.personality?.forgetGlobalProposals();
                  await deps.forget(audience, input.sourceId);
                });
                return { forgotten: true, physicalPurge: false };
              }).pipe(Effect.withSpan("june.http.memory.forget")),
            ),
          awaited,
        )
        .handleRaw(
          "revisePersonality",
          () =>
            rejected(
              Effect.gen(function* () {
                const store = yield* personality;
                const input = yield* jsonBody(Revise);
                return yield* attempt(() => {
                  const scope = deps.audience(input.audience);
                  const maxAge = 604800000;
                  const {
                    audience: _audience,
                    confirmed: _confirmed,
                    ...proposal
                  } = input;
                  const evidenceIds = [...input.evidenceIds];
                  const commit = store.ownerRevise(
                    { ...proposal, evidenceIds, scope },
                    deps.store.reflectionEvidence(scope, evidenceIds, maxAge),
                    Date.now(),
                    maxAge,
                  );
                  return { commit };
                });
              }).pipe(Effect.withSpan("june.http.memory.revise_personality")),
            ),
          awaited,
        )
        .handleRaw(
          "rollbackPersonality",
          () =>
            rejected(
              Effect.gen(function* () {
                const store = yield* personality;
                const input = yield* jsonBody(Rollback);
                return {
                  commit: yield* attempt(() =>
                    store.ownerRollback(
                      input.id,
                      input.target,
                      input.explanation,
                      Date.now(),
                    ),
                  ),
                };
              }).pipe(Effect.withSpan("june.http.memory.rollback_personality")),
            ),
          awaited,
        ),
    ),
  );
  return HttpApiBuilder.layer(MemoryApi).pipe(Layer.provide(handlers));
}
