import { spawn } from "node:child_process";
import { Effect, Schema } from "effect";
import { z } from "zod";
import type { JuneRuntime } from "../effect/runtime.js";

const path = z.string().regex(/^\/[A-Za-z0-9_./-]+$/);
export const ampJobsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/),
  user: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
  identityFile: path,
  knownHostsFile: path,
  policyRevision: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  workspaces: z.record(z.string().regex(/^amp-[a-zA-Z0-9_-]+$/), path),
  timeoutMs: z.number().int().min(1000).max(3_600_000).default(3_600_000),
});
export type AmpJobsConfig = z.infer<typeof ampJobsSchema>;

/** Remote transport, deliberately NOT CodingRuntime: no local cwd or verifier. */
export interface RemoteAmpJobs {
  workspaces: Record<string, string>;
  timeoutMs: number;
  run(input: {
    id: string;
    workspace: string;
    goal: string;
    signal: AbortSignal;
    /** Synchronous owner-local fence; never an asynchronous current RPC. */
    assertCurrent?: () => void;
    onThread: (threadId: string) => Promise<void>;
  }): Promise<{ threadId: string; report: string }>;
}

/** Host-detected transport failure. Abort reasons, receipt-save and parse
 * failures keep their original error, as before the Effect migration. */
export class RemoteAmpJobError extends Schema.TaggedError<RemoteAmpJobError>()(
  "RemoteAmpJobError",
  { message: Schema.String },
) {}
const failure = (message: string) => new RemoteAmpJobError({ message });

type RunInput = Parameters<RemoteAmpJobs["run"]>[0];

export function createRemoteAmpJobs(
  config: AmpJobsConfig,
  effectRuntime: JuneRuntime,
): RemoteAmpJobs {
  const run = Effect.fn("june.coding.remote_amp.run")(
    function* (input: RunInput) {
      input.signal.throwIfAborted();
      if (!Object.hasOwn(config.workspaces, input.workspace))
        return yield* failure("Unknown remote workspace");
      const payload = Buffer.from(
        JSON.stringify({
          id: input.id,
          workspace: input.workspace,
          directory: config.workspaces[input.workspace],
          policyRevision: config.policyRevision,
          goal: input.goal,
        }),
      ).toString("base64url");
      input.assertCurrent?.();
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          spawn(
            "/usr/bin/ssh",
            [
              "-F",
              "/dev/null",
              "-T",
              "-o",
              "BatchMode=yes",
              "-o",
              "IdentitiesOnly=yes",
              "-o",
              "StrictHostKeyChecking=yes",
              "-o",
              `UserKnownHostsFile=${config.knownHostsFile}`,
              "-o",
              "GlobalKnownHostsFile=/dev/null",
              "-o",
              "IdentityAgent=none",
              "-o",
              "ConnectTimeout=15",
              "-o",
              "ServerAliveInterval=15",
              "-o",
              "ServerAliveCountMax=3",
              "-i",
              config.identityFile,
              "-l",
              config.user,
              config.host,
              `june-job ${payload}`,
            ],
            {
              stdio: ["ignore", "pipe", "ignore"],
              env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
            },
          ),
        ),
        (child) => Effect.sync(() => child.kill("SIGKILL")),
      );
      // Observe immediately, including spawn errors. Never log raw transport output.
      const exited = new Promise<number | null>((resolve) => {
        child.once("error", () => resolve(null));
        child.once("close", resolve);
      });
      const abort = () => {
        child.kill("SIGKILL"); // Stops only local SSH; remote state stays unknown.
        child.stdout.destroy(new Error("Remote job observation interrupted"));
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          input.signal.addEventListener("abort", abort, { once: true });
          if (input.signal.aborted) abort();
        }),
        () =>
          Effect.sync(() => input.signal.removeEventListener("abort", abort)),
      );
      return yield* Effect.promise(async () => {
        let pending = "";
        let threadId: string | undefined;
        let report: string | undefined;
        child.stdout.setEncoding("utf8");
        for await (const chunk of child.stdout) {
          pending += chunk;
          // Bound individual stream records, not only saved reports.
          if (Buffer.byteLength(pending) > 1_048_576)
            throw failure("Remote record too large");
          let newline = pending.indexOf("\n");
          while (newline >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            const message = JSON.parse(line);
            if (message.type === "system" && message.subtype === "init") {
              if (threadId || !/^T-[a-f0-9-]{36}$/i.test(message.session_id))
                throw failure("Invalid remote receipt");
              threadId = message.session_id;
              await input.onThread(threadId as string);
            }
            if (message.type === "result") {
              if (
                !threadId ||
                message.session_id !== threadId ||
                message.is_error ||
                typeof message.result !== "string"
              )
                throw failure("Remote result unavailable");
              report = message.result.slice(0, 32_000);
            }
            newline = pending.indexOf("\n");
          }
        }
        const code = await exited;
        input.signal.throwIfAborted();
        if (code !== 0 || !threadId || report === undefined || pending.trim())
          throw failure("Remote completion unknown");
        return { threadId, report };
      });
    },
    Effect.scoped,
    Effect.catchDefect((defect) =>
      defect instanceof RemoteAmpJobError
        ? Effect.fail(defect)
        : Effect.die(defect),
    ),
  );
  return {
    workspaces: config.workspaces,
    timeoutMs: config.timeoutMs,
    run: (input) => effectRuntime.runPromise(run(input)),
  };
}
