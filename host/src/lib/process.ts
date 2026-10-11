/**
 * Child processes that need what `effect/process` does not expose: dropping
 * root to another account (`uid`/`gid`, which also clears supplementary
 * groups), extra inherited descriptors, and reading a bounded stream.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";

export class ProcessFailure extends Schema.TaggedError<ProcessFailure>()(
  "ProcessFailure",
  { reason: Schema.String },
) {}

export interface SpawnOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly uid?: number;
  readonly gid?: number;
  readonly stdin?: "ignore" | "pipe" | Uint8Array;
  readonly stdout?: "ignore" | "pipe";
  readonly stderr?: "ignore" | "pipe";
}

/** `subprocess.run(..., timeout=, check=True)` returning stdout; SIGKILL on timeout. */
export const run = (
  argv: readonly string[],
  options: SpawnOptions & {
    readonly timeoutMs: number;
    readonly limit?: number;
  },
) =>
  Effect.callback<Buffer, ProcessFailure>((resume) => {
    const [file = "", ...args] = argv;
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? {},
      uid: options.uid,
      gid: options.gid,
      stdio: [
        options.stdin instanceof Uint8Array
          ? "pipe"
          : (options.stdin ?? "ignore"),
        options.stdout ?? "pipe",
        options.stderr ?? "ignore",
      ],
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let failed: string | undefined;
    child.stdout?.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (options.limit !== undefined && total > options.limit) {
        failed ??= "output_too_large";
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    if (options.stdin instanceof Uint8Array) child.stdin?.end(options.stdin);
    const timer = setTimeout(() => {
      failed ??= "timeout";
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resume(Effect.fail(new ProcessFailure({ reason: "spawn_failed" })));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resume(
        failed || code !== 0
          ? Effect.fail(new ProcessFailure({ reason: failed ?? "exit_status" }))
          : Effect.succeed(Buffer.concat(chunks, total)),
      );
    });
    return Effect.sync(() => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    });
  });

/** A started child whose lifetime the caller owns. */
export const start = (argv: readonly string[], options: SpawnOptions) =>
  Effect.try({
    try: (): ChildProcess => {
      const [file = "", ...args] = argv;
      return spawn(file, args, {
        cwd: options.cwd,
        env: options.env ?? {},
        uid: options.uid,
        gid: options.gid,
        stdio: [
          options.stdin === "pipe" ? "pipe" : "ignore",
          options.stdout ?? "ignore",
          options.stderr ?? "ignore",
        ],
      });
    },
    catch: () => new ProcessFailure({ reason: "spawn_failed" }),
  });

/** Resolves with the exit code, or `null` when killed by a signal. */
export const wait = (child: ChildProcess) =>
  Effect.callback<number | null>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null)
      resume(Effect.succeed(child.exitCode));
    else child.once("exit", (code) => resume(Effect.succeed(code)));
  });

export interface Account {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
}

/** `pwd.getpwnam` from the local passwd database. */
export function account(name: string): Account {
  for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
    const [user, , uid, gid, , home] = line.split(":");
    if (
      user === name &&
      uid !== undefined &&
      gid !== undefined &&
      home !== undefined
    )
      return { name, uid: Number(uid), gid: Number(gid), home };
  }
  throw new Error("account_not_found");
}
