import { Effect, Layer, Option, Schema } from "effect";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";
import type { WorktreeDiffSummary } from "../coding/worktree.js";
import { Uuid } from "../effect/schema.js";
import { attempt, awaited, json, jsonBody, respond } from "./effect.js";

const JOB_ID = /^[a-f0-9]{64}$/;
const Resume = Schema.Struct({ confirmedStopped: Schema.Literal(true) });
const isUuid = Schema.is(Uuid);

const params = { id: Schema.String };
const endpoint = { params, success: Schema.Any };
export class JobsApi extends HttpApi.make("june-operator").add(
  HttpApiGroup.make("jobs")
    .add(
      HttpApiEndpoint.get("inspect", "/:id", endpoint),
      HttpApiEndpoint.get("diff", "/:id/diff", endpoint),
      HttpApiEndpoint.post("resume", "/:id/resume", endpoint),
      HttpApiEndpoint.post("cancel", "/:id/cancel", endpoint),
    )
    .prefix("/operator/jobs"),
) {}

export interface JobRouteDependencies {
  inspectJob(id: string): Promise<unknown | undefined>;
  inspectJobDiff?(id: string): Promise<WorktreeDiffSummary | null>;
  resumeJob(id: string, commandId: string): Promise<boolean>;
  cancelJob?(id: string): Promise<boolean>;
  /** Records the failed request for automatic repair. */
  report(): void;
}

/** Hono paths for `mountEffectRoutes`; diff and cancel only when supported. */
export const jobPaths = (deps: JobRouteDependencies) => ({
  get: [
    "/operator/jobs/:id",
    ...(deps.inspectJobDiff ? ["/operator/jobs/:id/diff"] : []),
  ],
  post: [
    "/operator/jobs/:id/resume",
    ...(deps.cancelJob ? ["/operator/jobs/:id/cancel"] : []),
  ],
});

/**
 * Operator coding-job inspection and control behind Hono's `/operator/*`
 * bearer auth and admission fence. Validation failures keep their specific
 * 400 bodies; a dependency failure is the app's 500 `request_failed`.
 */
export function jobRoutes(deps: JobRouteDependencies) {
  const failed = respond(() =>
    Effect.sync(deps.report).pipe(
      Effect.as(json({ error: "request_failed" }, 500)),
    ),
  );
  const handlers = HttpApiBuilder.group(JobsApi, "jobs", (h) =>
    Effect.succeed(
      h
        .handle(
          "inspect",
          ({ params }) =>
            failed(
              Effect.gen(function* () {
                if (!JOB_ID.test(params.id))
                  return json({ error: "invalid_job_id" }, 400);
                const job = yield* attempt(() => deps.inspectJob(params.id));
                return job === undefined
                  ? json({ error: "not_found" }, 404)
                  : job;
              }).pipe(Effect.withSpan("june.http.jobs.inspect")),
            ),
          awaited,
        )
        .handle(
          "diff",
          ({ params, request }) =>
            failed(
              Effect.gen(function* () {
                const inspect = deps.inspectJobDiff;
                if (
                  !inspect ||
                  !JOB_ID.test(params.id) ||
                  request.url.includes("?")
                )
                  return json({ error: "job_id_only" }, 400);
                const summary = yield* attempt(() => inspect(params.id));
                return summary ?? json({ error: "diff_unavailable" }, 409);
              }).pipe(Effect.withSpan("june.http.jobs.diff")),
            ),
          awaited,
        )
        .handleRaw(
          "resume",
          ({ params, request }) =>
            failed(
              Effect.gen(function* () {
                const input = yield* jsonBody(Resume).pipe(Effect.option);
                if (!JOB_ID.test(params.id) || Option.isNone(input))
                  return json(
                    { error: "confirm_previous_worker_stopped" },
                    400,
                  );
                const commandId = request.headers["idempotency-key"];
                if (!isUuid(commandId))
                  return json({ error: "uuid_idempotency_key_required" }, 400);
                return (yield* attempt(() =>
                  deps.resumeJob(params.id, commandId),
                ))
                  ? json({ queued: true }, 202)
                  : json({ error: "job_not_resumable" }, 409);
              }).pipe(Effect.withSpan("june.http.jobs.resume")),
            ),
          awaited,
        )
        .handle(
          "cancel",
          ({ params }) =>
            failed(
              Effect.gen(function* () {
                const cancel = deps.cancelJob;
                if (!cancel || !JOB_ID.test(params.id))
                  return json({ error: "invalid_job_id" }, 400);
                return (yield* attempt(() => cancel(params.id)))
                  ? json({ cancellationRequested: true }, 202)
                  : json({ error: "not_found" }, 404);
              }).pipe(Effect.withSpan("june.http.jobs.cancel")),
            ),
          awaited,
        ),
    ),
  );
  return HttpApiBuilder.layer(JobsApi).pipe(Layer.provide(handlers));
}
