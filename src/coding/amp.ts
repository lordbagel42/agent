import type { ExecuteOptions, StreamMessage } from "@ampcode/sdk";
import { execute as sdkExecute } from "@ampcode/sdk";
import type { CodingRuntime } from "../core/contracts.js";

type AmpExecute = (options: ExecuteOptions) => AsyncIterable<StreamMessage>;

const MAX_REPORT_LENGTH = 32_000;
const TRUNCATION_NOTICE = "\n\n[Report truncated]";

export type AmpRuntimeErrorCode =
  | "cancelled"
  | "execution_failed"
  | "thread_not_reported"
  | "thread_save_failed"
  | "stream_failed"
  | "result_not_reported";

const ERROR_MESSAGES: Record<AmpRuntimeErrorCode, string> = {
  cancelled: "Amp execution was cancelled.",
  execution_failed: "Amp execution failed.",
  thread_not_reported: "Amp execution did not report a thread.",
  thread_save_failed: "Amp thread could not be saved.",
  stream_failed: "Amp execution status is unknown.",
  result_not_reported: "Amp execution did not report a final result.",
};

export class AmpRuntimeError extends Error {
  constructor(readonly code: AmpRuntimeErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AmpRuntimeError";
  }
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

export function createAmpRuntime({
  execute = sdkExecute,
}: {
  execute?: AmpExecute;
} = {}): CodingRuntime {
  return {
    async run(input) {
      if (input.signal.aborted) {
        throw new AmpRuntimeError("cancelled");
      }
      if (input.threadId !== undefined && !isThreadId(input.threadId)) {
        throw new AmpRuntimeError("thread_not_reported");
      }

      let threadId = input.threadId;
      let report: string | undefined;
      // The pinned SDK patch forces --features fast on every execution.
      // Its public options schema does not yet expose thread features.
      const options: ExecuteOptions["options"] = { cwd: input.cwd };
      if (threadId !== undefined) {
        options.continue = threadId;
      }

      try {
        for await (const message of execute({
          prompt: input.prompt,
          options,
          signal: input.signal,
        })) {
          if (input.signal.aborted) {
            throw new AmpRuntimeError("cancelled");
          }
          if (!isThreadId(message.session_id)) {
            throw new AmpRuntimeError("thread_not_reported");
          }
          if (threadId !== undefined && message.session_id !== threadId) {
            throw new AmpRuntimeError("stream_failed");
          }
          if (threadId === undefined) {
            threadId = message.session_id;
            try {
              await input.onThread(threadId);
            } catch {
              if (input.signal.aborted) {
                throw new AmpRuntimeError("cancelled");
              }
              throw new AmpRuntimeError("thread_save_failed");
            }
            if (input.signal.aborted) {
              throw new AmpRuntimeError("cancelled");
            }
          }
          if (message.type === "result") {
            if (message.is_error) {
              throw new AmpRuntimeError("execution_failed");
            }
            // The SDK checks child exit only on natural exhaustion, not return().
            report = boundedReport(message.result);
          }
        }
      } catch (error) {
        if (error instanceof AmpRuntimeError) {
          throw error;
        }
        if (input.signal.aborted) {
          throw new AmpRuntimeError("cancelled");
        }
        throw new AmpRuntimeError("stream_failed");
      }

      if (input.signal.aborted) {
        throw new AmpRuntimeError("cancelled");
      }
      if (threadId === undefined) {
        throw new AmpRuntimeError("thread_not_reported");
      }
      if (report === undefined) {
        throw new AmpRuntimeError("result_not_reported");
      }
      return { threadId, report };
    },
  };
}
