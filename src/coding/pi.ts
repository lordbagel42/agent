import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CodingResult, CodingRuntime } from "../core/contracts.js";

export interface PiRuntimeOptions {
  executable: string;
  provider: string;
  model: string;
  /** Dedicated Pi configuration/auth directory, provisioned by the operator. */
  agentDir: string;
  sessionDir: string;
  /** Explicit child environment, including HOME/PATH and supported provider keys. */
  env: Record<string, string>;
  hostSandboxAcknowledged: true;
  timeoutMs?: number;
  /** Offline process/stream fixtures; never invokes a shell. */
  spawnProcess?: typeof spawn;
}

export class PiRuntimeError extends Error {
  constructor(
    readonly code:
      | "configuration_invalid"
      | "session_invalid"
      | "session_busy"
      | "thread_save_failed"
      | "cancelled"
      | "execution_failed"
      | "outcome_unknown",
  ) {
    super(
      `Pi runtime: ${code}. No automatic retry is safe after a prompt was sent.`,
    );
    this.name = "PiRuntimeError";
  }
}

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_RECORD = 4 * 1024 * 1024;
const MAX_REPORT = 32_000;
const NOTICE = "\n\n[Report truncated]";
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object"
    ? (value as RecordValue)
    : {};
}

async function checkSession(
  path: string,
  cwd: string,
  threadId: string,
  finalMessage?: RecordValue,
  start = 0,
) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < start) throw new Error();
      // Admission needs only the native header, not the full transcript.
      const buffer = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const newline = buffer.subarray(0, bytesRead).indexOf(10);
      if (newline === -1) throw new Error();
      const header = object(JSON.parse(buffer.toString("utf8", 0, newline)));
      if (
        header.type !== "session" ||
        header.version !== 3 ||
        header.id !== threadId ||
        header.cwd !== cwd
      )
        throw new Error();
      if (finalMessage) {
        // message_end precedes Pi's disk append. Settlement alone cannot prove
        // that append succeeded. Inspect this turn's appended records, not an
        // identical earlier answer, with bounded memory after the child exits.
        let pending = "";
        let persisted: RecordValue | undefined;
        for await (const chunk of file.createReadStream({
          start: Math.max(start, newline + 1),
          encoding: "utf8",
          autoClose: false,
        })) {
          pending += chunk;
          let end = pending.indexOf("\n");
          while (end !== -1) {
            const line = pending.slice(0, end);
            if (Buffer.byteLength(line, "utf8") > MAX_RECORD) throw new Error();
            const entry = object(JSON.parse(line));
            if (
              entry.type === "message" &&
              object(entry.message).role === "assistant"
            ) {
              persisted = object(entry.message);
            }
            pending = pending.slice(end + 1);
            end = pending.indexOf("\n");
          }
          if (Buffer.byteLength(pending, "utf8") > MAX_RECORD)
            throw new Error();
        }
        if (pending || !isDeepStrictEqual(persisted, finalMessage))
          throw new Error();
      }
      // Pi writes synchronously but does not fsync before reporting its state.
      await file.sync();
      return stat.size;
    } finally {
      await file.close();
    }
  } catch {
    throw new PiRuntimeError("session_invalid");
  }
}

/** Pi RPC 0.87.1. Tool access must be contained by an operator's host sandbox. */
export function createPiRuntime(options: PiRuntimeOptions): CodingRuntime {
  if (
    options.hostSandboxAcknowledged !== true ||
    ![options.executable, options.agentDir, options.sessionDir].every(
      isAbsolute,
    ) ||
    !options.provider ||
    !options.model ||
    !options.env.HOME ||
    !isAbsolute(options.env.HOME) ||
    !options.env.PATH ||
    (options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs <= 0 ||
        options.timeoutMs > 2_147_483_647))
  ) {
    throw new PiRuntimeError("configuration_invalid");
  }

  return {
    async run(input) {
      if (input.signal.aborted) throw new PiRuntimeError("cancelled");
      if (input.threadId !== undefined && !ID.test(input.threadId)) {
        throw new PiRuntimeError("session_invalid");
      }
      await mkdir(options.sessionDir, { recursive: true, mode: 0o700 });
      const root = await realpath(options.sessionDir);
      const cwd = await realpath(input.cwd);
      let directory: string;
      if (input.threadId) {
        try {
          const bindingPath = join(root, `${input.threadId}.json`);
          if ((await realpath(bindingPath)) !== bindingPath) throw new Error();
          const binding = object(
            JSON.parse(await readFile(bindingPath, "utf8")),
          );
          if (
            binding.cwd !== cwd ||
            typeof binding.directory !== "string" ||
            !/^run-[a-zA-Z0-9]+$/.test(binding.directory)
          )
            throw new Error();
          directory = join(root, binding.directory);
          if (
            (await realpath(directory)) !== directory ||
            (await realpath(join(directory, "session.jsonl"))) !==
              join(directory, "session.jsonl")
          ) {
            throw new Error();
          }
        } catch {
          throw new PiRuntimeError("session_invalid");
        }
      } else {
        directory = await mkdtemp(join(root, "run-"));
        // Pi initializes an empty explicit session file with its own UUID/header.
        await writeFile(join(directory, "session.jsonl"), "", {
          flag: "wx",
          mode: 0o600,
        });
      }
      const lock = join(directory, "lock");
      try {
        await mkdir(lock);
      } catch {
        throw new PiRuntimeError("session_busy");
      }

      let child: ChildProcessWithoutNullStreams | undefined;
      let exited = false;
      let shuttingDown = false;
      let cleanExit: Promise<void> = Promise.resolve();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let result: CodingResult | undefined;
      let finalMessage: RecordValue | undefined;
      let sessionBytes = 0;
      const sessionFile = join(directory, "session.jsonl");
      const interrupted = Promise.withResolvers<never>();
      // Attach immediately: cancellation can arrive while awaiting persistence.
      void interrupted.promise.catch(() => {});
      let failure: PiRuntimeError | undefined;
      const fail = (code: PiRuntimeError["code"] = "outcome_unknown") => {
        failure ??= new PiRuntimeError(code);
        interrupted.reject(failure);
      };
      const abort = () => fail("cancelled");
      input.signal.addEventListener("abort", abort, { once: true });
      const guard = <T>(promise: Promise<T>) =>
        Promise.race([promise, interrupted.promise]);
      try {
        if (input.signal.aborted) throw new PiRuntimeError("cancelled");
        if (input.threadId)
          await checkSession(sessionFile, cwd, input.threadId);
        if (input.signal.aborted) throw new PiRuntimeError("cancelled");
        child = (options.spawnProcess ?? spawn)(
          options.executable,
          [
            "--mode",
            "rpc",
            "--provider",
            options.provider,
            "--model",
            options.model,
            "--session",
            sessionFile,
            "--session-dir",
            directory,
            "--no-approve",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--tools",
            "read,bash,edit,write,grep,find,ls",
          ],
          {
            cwd,
            env: { ...options.env, PI_CODING_AGENT_DIR: options.agentDir },
            stdio: "pipe",
            detached: true,
          },
        ) as ChildProcessWithoutNullStreams;
        const process = child;
        cleanExit = new Promise((resolve) => {
          process.once("close", (code, signal) => {
            exited = true;
            resolve();
            if (!shuttingDown || code !== 0 || signal) fail();
          });
        });
        process.on("error", () => fail());
        process.stdin.on("error", () => fail());
        process.stdout.on("error", () => fail());
        process.stderr.on("error", () => fail());
        process.stderr.resume(); // Drain, but never expose credential-bearing diagnostics.
        deadline = setTimeout(() => fail(), options.timeoutMs ?? 30 * 60_000);
        const pending = new Map<
          string,
          { command: string; resolve: (data: RecordValue) => void }
        >();
        const settled = Promise.withResolvers<void>();
        let prompted = false;
        let buffer = "";
        process.stdout.setEncoding("utf8");
        process.stdout.on("end", () => {
          if (!shuttingDown || buffer.length) fail();
        });
        process.stdout.on("data", (chunk: string) => {
          if (failure) return;
          buffer += chunk;
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            if (
              Buffer.byteLength(buffer.slice(0, newline), "utf8") > MAX_RECORD
            ) {
              fail();
              return;
            }
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
              const event = object(JSON.parse(line));
              if (typeof event.type !== "string") throw new Error();
              if (event.type === "response" && event.success !== true) fail();
              if (event.type === "response" && typeof event.id === "string") {
                const request = pending.get(event.id);
                if (request) {
                  pending.delete(event.id);
                  if (
                    event.success !== true ||
                    event.command !== request.command
                  )
                    fail();
                  else request.resolve(object(event.data));
                }
              } else if (
                prompted &&
                event.type === "message_end" &&
                object(event.message).role === "assistant"
              ) {
                finalMessage = object(event.message);
              } else if (prompted && event.type === "agent_settled")
                settled.resolve();
            } catch {
              fail();
            }
            if (failure) return;
            newline = buffer.indexOf("\n");
          }
          if (Buffer.byteLength(buffer, "utf8") > MAX_RECORD) fail();
        });
        let sequence = 0;
        const command = (type: string, fields: RecordValue = {}) => {
          if (failure) return Promise.reject(failure);
          const id = String(++sequence);
          return guard(
            new Promise<RecordValue>((resolve) => {
              pending.set(id, { command: type, resolve });
              process.stdin.write(
                `${JSON.stringify({ id, type, ...fields })}\n`,
                (error) => {
                  if (error) fail();
                },
              );
            }),
          );
        };
        const state = await command("get_state");
        const model = object(state.model);
        if (model.provider !== options.provider || model.id !== options.model) {
          throw new PiRuntimeError("configuration_invalid");
        }
        const threadId = state.sessionId;
        if (
          typeof threadId !== "string" ||
          !ID.test(threadId) ||
          (input.threadId && threadId !== input.threadId) ||
          state.sessionFile !== sessionFile
        ) {
          throw new PiRuntimeError("session_invalid");
        }
        sessionBytes = await guard(checkSession(sessionFile, cwd, threadId));
        if (!input.threadId) {
          await guard(
            writeFile(
              join(root, `${threadId}.json`),
              JSON.stringify({ cwd, directory: basename(directory) }),
              { flag: "wx", mode: 0o600, flush: true },
            ),
          );
        }
        // Persist the binding and lock entries before the supervisor records the ID.
        for (const path of [directory, root]) {
          const folder = await open(path, "r");
          try {
            await folder.sync();
          } finally {
            await folder.close();
          }
        }
        if (failure) throw failure;
        try {
          await guard(input.onThread(threadId));
        } catch (error) {
          if (error instanceof PiRuntimeError) throw error;
          throw new PiRuntimeError("thread_save_failed");
        }
        if (input.signal.aborted) throw new PiRuntimeError("cancelled");
        // Initialization, binding fsync and onThread all yield before this RPC.
        // Check live host authority without yielding again before prompt write.
        input.assertCurrent?.();
        prompted = true;
        // Prefix prevents built-in slash command dispatch; templates are disabled at startup.
        const accepted = await command("prompt", {
          message: `June coding task:\n${input.prompt}`,
        });
        if (accepted.disposition !== "started")
          throw new PiRuntimeError("outcome_unknown");
        await guard(settled.promise);
        if (!finalMessage) throw new PiRuntimeError("outcome_unknown");
        if (finalMessage.stopReason !== "stop")
          throw new PiRuntimeError("execution_failed");
        const report = Array.isArray(finalMessage.content)
          ? finalMessage.content
              .map(object)
              .filter(
                (block) =>
                  block.type === "text" && typeof block.text === "string",
              )
              .map((block) => block.text)
              .join("\n")
          : "";
        if (!report.trim()) throw new PiRuntimeError("outcome_unknown");
        result = {
          threadId,
          report:
            report.length > MAX_REPORT
              ? report.slice(0, MAX_REPORT - NOTICE.length) + NOTICE
              : report,
        };
      } catch (error) {
        failure ??=
          error instanceof PiRuntimeError
            ? error
            : new PiRuntimeError("outcome_unknown");
      }

      if (deadline) clearTimeout(deadline);
      shuttingDown = true;
      if (child && !exited) {
        try {
          child.stdin.end(`${JSON.stringify({ type: "abort" })}\n`);
        } catch {
          fail();
        }
        const wait = () =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 500);
            void cleanExit.then(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        await wait();
        for (const signal of ["SIGTERM", "SIGKILL"] as const) {
          if (exited) break;
          // Forced shutdown is not a confirmed successful disposal/flush.
          fail();
          try {
            if (child.pid) {
              try {
                process.kill(-child.pid, signal);
              } catch {
                child.kill(signal);
              }
            } else {
              child.kill(signal);
            }
          } catch {
            fail();
          }
          await wait();
        }
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
      input.signal.removeEventListener("abort", abort);
      // A surviving process or a crashed host leaves a fail-closed lock for reconciliation.
      if (child && !exited) throw new PiRuntimeError("outcome_unknown");
      try {
        if (result && !failure)
          await checkSession(
            sessionFile,
            cwd,
            result.threadId,
            finalMessage,
            sessionBytes,
          );
        await rm(lock, { recursive: true });
      } catch {
        fail();
      }
      if (failure) throw failure;
      if (input.signal.aborted) throw new PiRuntimeError("cancelled");
      if (!result) throw new PiRuntimeError("outcome_unknown");
      return result;
    },
  };
}
