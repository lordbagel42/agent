import type { ExecuteOptions, StreamMessage } from "@ampcode/sdk";
import { execute as sdkExecute } from "@ampcode/sdk";
import { Effect, Schema, Stream } from "effect";
import type { CodingResult, CodingRuntime } from "../core/contracts.js";
import type { JuneRuntime } from "../effect/runtime.js";

type AmpExecute = (options: ExecuteOptions) => AsyncIterable<StreamMessage>;
type RunInput = Parameters<CodingRuntime["run"]>[0];

const MAX_REPORT_LENGTH = 32_000;
const TRUNCATION_NOTICE = "\n\n[Report truncated]";

const ERROR_MESSAGES = {
  cancelled: "Amp execution was cancelled.",
  execution_failed: "Amp execution failed.",
  thread_not_reported: "Amp execution did not report a thread.",
  thread_save_failed: "Amp thread could not be saved.",
  stream_failed: "Amp execution status is unknown.",
  result_not_reported: "Amp execution did not report a final result.",
} as const;
export type AmpRuntimeErrorCode = keyof typeof ERROR_MESSAGES;

export class AmpRuntimeError extends Schema.TaggedError<AmpRuntimeError>()(
  "AmpRuntimeError",
  {
    code: Schema.Literals(Object.keys(ERROR_MESSAGES) as AmpRuntimeErrorCode[]),
  },
) {
  override readonly message = ERROR_MESSAGES[this.code];
}

function boundedReport(report: string): string {
  if (report.length <= MAX_REPORT_LENGTH) {
    return report;
  }
  return `${report.slice(0, MAX_REPORT_LENGTH - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`;
}

function isThreadId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const failure = (code: AmpRuntimeErrorCode) => new AmpRuntimeError({ code });

export function makeAmpRuntime(execute: AmpExecute = sdkExecute) {
  return Effect.fn("june.coding.amp.run")(function* (input: RunInput) {
    const cancelled = () => input.signal.aborted;
    if (cancelled()) return yield* failure("cancelled");
    if (input.threadId !== undefined && !isThreadId(input.threadId))
      return yield* failure("thread_not_reported");

    let threadId = input.threadId;
    let report: string | undefined;
    // The pinned SDK patch forces --features fast on every execution.
    // Its public options schema does not yet expose thread features.
    const options: ExecuteOptions["options"] = { cwd: input.cwd };
    if (threadId !== undefined) options.continue = threadId;

    yield* Effect.suspend(() => {
      input.assertCurrent?.();
      return Stream.fromAsyncIterable(
        execute({
          prompt: input.prompt,
          options,
          signal: input.signal,
          // The pinned SDK repeats this after its async config preparation,
          // immediately before spawning/submitting; it never serializes it.
          ...(input.assertCurrent && { assertCurrent: input.assertCurrent }),
        }),
        // Mapped below with the caller's cancellation state.
        (cause) => cause,
      ).pipe(
        Stream.runForEach((message) =>
          Effect.gen(function* () {
            if (cancelled()) return yield* failure("cancelled");
            if (!isThreadId(message.session_id))
              return yield* failure("thread_not_reported");
            if (threadId !== undefined && message.session_id !== threadId)
              return yield* failure("stream_failed");
            if (threadId === undefined) {
              threadId = message.session_id;
              const saved = threadId;
              yield* Effect.tryPromise({
                try: () => input.onThread(saved),
                catch: () =>
                  failure(cancelled() ? "cancelled" : "thread_save_failed"),
              });
              if (cancelled()) return yield* failure("cancelled");
            }
            if (message.type === "result") {
              if (message.is_error) return yield* failure("execution_failed");
              // The SDK checks child exit only on natural exhaustion, not return().
              report = boundedReport(message.result);
            }
          }),
        ),
      );
    }).pipe(
      // Every non-runtime failure, including a throwing assertCurrent, is an
      // unknown outcome unless the caller already cancelled.
      Effect.catchCause((cause) => {
        const error = cause.reasons.find((reason) => reason._tag === "Fail");
        if (error?._tag === "Fail" && error.error instanceof AmpRuntimeError)
          return Effect.fail(error.error);
        return Effect.fail(
          failure(cancelled() ? "cancelled" : "stream_failed"),
        );
      }),
    );

    if (cancelled()) return yield* failure("cancelled");
    if (threadId === undefined) return yield* failure("thread_not_reported");
    if (report === undefined) return yield* failure("result_not_reported");
    return { threadId, report } satisfies CodingResult;
  });
}

export function createAmpRuntime({
  execute,
  effectRuntime,
}: {
  execute?: AmpExecute;
  effectRuntime: JuneRuntime;
}): CodingRuntime {
  const run = makeAmpRuntime(execute);
  return { run: (input) => effectRuntime.runPromise(run(input)) };
}
