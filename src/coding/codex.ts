import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CodingRuntime } from "../core/contracts.js";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_REPORT_LENGTH = 32_000;
const NOTICE = "\n\n[Report truncated]";
// The pinned stdio server has its own 45-second EOF/SIGTERM watchdog.
const SHUTDOWN_TIMEOUT_MS = 50_000;

export type CodexRuntimeErrorCode =
  | "invalid_configuration"
  | "cancelled"
  | "authentication_required"
  | "interaction_required"
  | "thread_mismatch"
  | "thread_save_failed"
  | "execution_failed"
  | "completion_unknown";

export class CodexRuntimeError extends Error {
  constructor(readonly code: CodexRuntimeErrorCode) {
    super(`Codex coding runtime: ${code}.`);
    this.name = "CodexRuntimeError";
  }
}

/** Private stdio app-server connection, never a desktop/daemon attachment. */
export interface CodexConnection {
  messages: AsyncIterable<unknown>;
  send(message: Record<string, unknown>): void;
  /** Send EOF, drain stdio, and require a clean owned-process exit. */
  close(): Promise<void>;
}

export type CodexRunner = (options: {
  executable?: string;
  cwd: string;
  home: string;
  signal: AbortSignal;
}) => CodexConnection;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0")
  );
}

const runAppServer: CodexRunner = ({ executable, cwd, home, signal }) => {
  // No ambient API keys, HOME, keyring/desktop session, SSH agent, or browser env.
  const env: NodeJS.ProcessEnv = { CODEX_HOME: home, HOME: home };
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const args = [
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    'cli_auth_credentials_store="file"',
    "-c",
    "thread_unload_delay_secs=0",
  ];
  // Resolve the pinned package rather than accidentally selecting a desktop CLI.
  const child = spawn(
    executable ?? process.execPath,
    executable
      ? args
      : [
          createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js"),
          ...args,
        ],
    {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    },
  );
  let failed = false;
  let exited = false;
  let settled = false;
  let closing = false;
  let bytes = 0;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const forceStop = () => {
    failed = true;
    if (!exited && child.pid !== undefined && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
    if (!exited) child.kill("SIGKILL");
    // A detached descendant may still own pipe handles. Releasing our handles
    // does not certify that descendant stopped; this path can never succeed.
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const beginShutdown = () => {
    if (closing || settled) return;
    closing = true;
    if (!exited) child.stdin.end();
    shutdownTimer = setTimeout(forceStop, SHUTDOWN_TIMEOUT_MS);
  };
  const closed = new Promise<void>((resolve) => {
    child.once("close", (code, exitSignal) => {
      settled = true;
      failed ||= code !== 0 || exitSignal !== null;
      clearTimeout(shutdownTimer);
      signal.removeEventListener("abort", beginShutdown);
      resolve();
    });
  });
  child.once("exit", () => {
    exited = true;
    // Bound inherited pipes even when the parent exits before its descendants.
    beginShutdown();
  });
  child.on("error", () => {
    failed = true;
  });
  child.stdin.on("error", () => {
    failed = true;
    beginShutdown();
  });
  const count = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) forceStop();
  };
  child.stderr.on("data", count); // Drain without logging potentially sensitive content.
  child.stdout.on("error", () => {
    failed = true;
    beginShutdown();
  });
  child.stderr.on("error", () => {
    failed = true;
    beginShutdown();
  });
  signal.addEventListener("abort", beginShutdown, { once: true });
  if (signal.aborted) beginShutdown();
  let closeResult: Promise<void> | undefined;
  return {
    send(message) {
      if (failed || closing || exited || signal.aborted)
        throw new CodexRuntimeError("completion_unknown");
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    messages: (async function* () {
      let buffer = "";
      const decoder = new StringDecoder("utf8");
      // Leaving the protocol loop must not destroy stdout before EOF cleanup.
      for await (const chunk of child.stdout.iterator({
        destroyOnReturn: false,
      })) {
        count(chunk as Buffer);
        if (failed) throw new CodexRuntimeError("completion_unknown");
        buffer += decoder.write(chunk as Buffer);
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim()) yield JSON.parse(line) as unknown;
          newline = buffer.indexOf("\n");
        }
      }
      buffer += decoder.end();
      if (failed || buffer.trim())
        throw new CodexRuntimeError("completion_unknown");
    })(),
    close() {
      closeResult ??= (async () => {
        beginShutdown();
        // The protocol consumer has finished. Keep pipes drained so the server
        // can flush persistence and finish shutdown rather than block on output.
        child.stdout.on("data", count);
        child.stdout.resume();
        await closed;
        if (failed) throw new CodexRuntimeError("completion_unknown");
      })();
      return closeResult;
    },
  };
};

/**
 * Codex 0.157.1 app-server protocol. Auth must already be provisioned by the
 * operator in a dedicated CODEX_HOME/auth.json (ChatGPT or API-key login).
 * Never signs in, copies credentials, or overrides configured approval/sandbox
 * policy. A cwd/worktree is NOT a sandbox. Interactive requests fail closed.
 */
export function createCodexRuntime({
  home,
  model,
  executable,
  timeoutMs = 30 * 60_000,
  runner = runAppServer,
}: {
  home: string;
  model?: string;
  executable?: string;
  timeoutMs?: number;
  runner?: CodexRunner;
}): CodingRuntime {
  if (
    !nonempty(home) ||
    !isAbsolute(home) ||
    (model !== undefined && !nonempty(model)) ||
    (executable !== undefined && !nonempty(executable)) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new CodexRuntimeError("invalid_configuration");
  }
  return {
    async run(input) {
      if (input.signal.aborted) throw new CodexRuntimeError("cancelled");
      if (
        !nonempty(input.cwd) ||
        !isAbsolute(input.cwd) ||
        (input.threadId !== undefined && !nonempty(input.threadId))
      )
        throw new CodexRuntimeError("invalid_configuration");
      const controller = new AbortController();
      const cancel = () => controller.abort();
      input.signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, timeoutMs);
      let connection: CodexConnection | undefined;
      let threadId: string | undefined;
      let turnId: string | undefined;
      let report = "";
      let expectedResponse = 1;
      let completed = false;
      let unsubscribing = false;
      let threadClosed = false;
      try {
        input.assertCurrent?.();
        connection = runner({
          executable,
          cwd: input.cwd,
          home,
          signal: controller.signal,
        });
        const request = (
          id: number,
          method: string,
          params: Record<string, unknown>,
        ) => {
          if (controller.signal.aborted)
            throw new CodexRuntimeError("completion_unknown");
          expectedResponse = id;
          connection?.send({ id, method, params });
        };
        request(1, "initialize", {
          clientInfo: { name: "june_coding", version: "0.1.0" },
          capabilities: { experimentalApi: false },
        });
        for await (const message of connection.messages) {
          if (controller.signal.aborted)
            throw new CodexRuntimeError("completion_unknown");
          if (!object(message))
            throw new CodexRuntimeError("completion_unknown");
          if ("id" in message) {
            // Never approve a server request, including command/file changes or login.
            if ("method" in message)
              throw new CodexRuntimeError("interaction_required");
            if (
              expectedResponse === 0 ||
              message.id !== expectedResponse ||
              "error" in message ||
              !object(message.result)
            )
              throw new CodexRuntimeError("completion_unknown");
            const result = message.result;
            if (message.id === 1) {
              connection.send({ method: "initialized" });
              request(2, "account/read", { refreshToken: false });
            } else if (message.id === 2) {
              if (
                !object(result.account) ||
                (result.account.type !== "chatgpt" &&
                  result.account.type !== "apiKey")
              )
                throw new CodexRuntimeError("authentication_required");
              input.assertCurrent?.();
              request(
                3,
                input.threadId === undefined ? "thread/start" : "thread/resume",
                {
                  cwd: input.cwd,
                  ...(model === undefined ? {} : { model }),
                  ...(input.threadId === undefined
                    ? { ephemeral: false }
                    : { threadId: input.threadId, excludeTurns: true }),
                },
              );
            } else if (message.id === 3) {
              if (!object(result.thread) || !nonempty(result.thread.id))
                throw new CodexRuntimeError("completion_unknown");
              threadId = result.thread.id;
              if (input.threadId !== undefined && threadId !== input.threadId)
                throw new CodexRuntimeError("thread_mismatch");
              if (
                !object(result.thread.status) ||
                result.thread.status.type !== "idle"
              )
                throw new CodexRuntimeError("completion_unknown");
              try {
                await input.onThread(threadId);
              } catch {
                throw new CodexRuntimeError("thread_save_failed");
              }
              // Persistence may yield across deletion before abort reaches us.
              // No await between this host check and the coding turn submission.
              input.assertCurrent?.();
              request(4, "turn/start", {
                threadId,
                cwd: input.cwd,
                input: [{ type: "text", text: input.prompt, textElements: [] }],
              });
            } else if (message.id === 4) {
              if (
                !object(result.turn) ||
                !nonempty(result.turn.id) ||
                (turnId !== undefined && turnId !== result.turn.id)
              )
                throw new CodexRuntimeError("completion_unknown");
              turnId = result.turn.id;
              expectedResponse = 0;
            } else if (message.id === 5) {
              if (result.status !== "unsubscribed")
                throw new CodexRuntimeError("completion_unknown");
              expectedResponse = 0;
            }
          } else if (message.method === "thread/closed") {
            if (
              !unsubscribing ||
              !object(message.params) ||
              message.params.threadId !== threadId
            )
              throw new CodexRuntimeError("completion_unknown");
            threadClosed = true;
          } else if (
            message.method === "turn/started" ||
            message.method === "turn/completed" ||
            message.method === "item/completed"
          ) {
            const params = message.params;
            if (
              !object(params) ||
              threadId === undefined ||
              params.threadId !== threadId
            )
              throw new CodexRuntimeError("completion_unknown");
            if (message.method === "item/completed") {
              if (params.turnId !== turnId || !object(params.item))
                throw new CodexRuntimeError("completion_unknown");
              if (params.item.type === "agentMessage") {
                if (typeof params.item.text !== "string")
                  throw new CodexRuntimeError("completion_unknown");
                report =
                  params.item.text.length <= MAX_REPORT_LENGTH
                    ? params.item.text
                    : `${params.item.text.slice(0, MAX_REPORT_LENGTH - NOTICE.length)}${NOTICE}`;
              }
            } else {
              if (
                !object(params.turn) ||
                !nonempty(params.turn.id) ||
                (turnId !== undefined && params.turn.id !== turnId)
              )
                throw new CodexRuntimeError("completion_unknown");
              turnId = params.turn.id;
              if (message.method === "turn/completed") {
                if (params.turn.status === "interrupted")
                  throw new CodexRuntimeError("cancelled");
                if (params.turn.status === "failed")
                  throw new CodexRuntimeError("execution_failed");
                if (params.turn.status !== "completed")
                  throw new CodexRuntimeError("completion_unknown");
                completed = true;
              }
            }
          }
          if (completed && expectedResponse === 0 && !unsubscribing) {
            unsubscribing = true;
            // A completed turn may leave managed tool sessions alive. In the
            // pinned server, thread/closed follows shutdown_and_wait, unlike
            // process EOF cleanup which can merely warn on a thread timeout.
            request(5, "thread/unsubscribe", { threadId });
          }
          if (threadClosed && expectedResponse === 0) break;
        }
        if (
          !completed ||
          !threadClosed ||
          expectedResponse !== 0 ||
          threadId === undefined
        )
          throw new CodexRuntimeError("completion_unknown");
        await connection.close();
        connection = undefined;
        if (controller.signal.aborted)
          throw new CodexRuntimeError("completion_unknown");
        return { threadId, report };
      } catch (error) {
        if (input.signal.aborted) throw new CodexRuntimeError("cancelled");
        if (error instanceof CodexRuntimeError) throw error;
        throw new CodexRuntimeError("completion_unknown");
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", cancel);
        try {
          await connection?.close();
        } catch {
          // Preserve the sanitized primary error (including cancellation).
        }
      }
    },
  };
}
