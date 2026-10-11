import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type {
  Options,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Schema } from "effect";
import type { CodingResult, CodingRuntime } from "../core/contracts.js";
import type { JuneRuntime } from "../effect/runtime.js";

/** An explicit capability grant, not a filesystem or network sandbox. */
export type ClaudeTool = "Read" | "Glob" | "Grep" | "Edit" | "Write" | "Bash";
export type ClaudeQuery = (input: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage> & Pick<Query, "close">;

export interface ClaudeRuntimeOptions {
  auth: { type: "api-key"; apiKey: string };
  /** Dedicated private persistent home; never a desktop Claude directory. */
  stateDirectory: string;
  /** Defaults to no tools. Bash grants arbitrary native command execution. */
  allowedTools?: ClaudeTool[];
  model?: string;
  maxTurns?: number;
  query?: ClaudeQuery;
  effectRuntime: JuneRuntime;
}

const ERROR_CODES = [
  "unsupported_auth",
  "invalid_configuration",
  "state_unavailable",
  "cancelled",
  "thread_save_failed",
  "thread_mismatch",
  "execution_failed",
  "stream_failed",
  "result_not_reported",
] as const;
export type ClaudeRuntimeErrorCode = (typeof ERROR_CODES)[number];

/** Deliberately excludes provider errors, prompts, paths and credentials. */
export class ClaudeRuntimeError extends Schema.TaggedError<ClaudeRuntimeError>()(
  "ClaudeRuntimeError",
  { code: Schema.Literals(ERROR_CODES) },
) {
  override readonly message = `Claude Code runtime: ${this.code}.`;
}
const failure = (code: ClaudeRuntimeErrorCode) =>
  new ClaudeRuntimeError({ code });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOLS: ClaudeTool[] = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"];
const REPORT_PREFIX = "Claude Code reported (not independently verified):\n\n";
const MAX_REPORT_LENGTH = 32_000;
const TRUNCATION_NOTICE = "\n\n[Report truncated]";

function boundedReport(text: string): string {
  const report = REPORT_PREFIX + text;
  return report.length <= MAX_REPORT_LENGTH
    ? report
    : report.slice(0, MAX_REPORT_LENGTH - TRUNCATION_NOTICE.length) +
        TRUNCATION_NOTICE;
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

const prepareState = (directory: string, cwd: string) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const [home, workspace, desktop, info] = await Promise.all([
        realpath(directory),
        realpath(cwd),
        realpath(homedir()),
        stat(directory),
      ]);
      // Native execution is trusted, but accidental transcript/credential mixing
      // with the desktop profile or the editable repository must fail closed.
      if (
        !info.isDirectory() ||
        (info.mode & 0o077) !== 0 ||
        contains(home, desktop) ||
        contains(workspace, home) ||
        contains(home, workspace) ||
        contains(join(desktop, ".claude"), home)
      ) {
        throw failure("state_unavailable");
      }
      const configDirectory = join(home, ".claude");
      await mkdir(configDirectory, { recursive: true, mode: 0o700 });
      const configInfo = await lstat(configDirectory);
      if (!configInfo.isDirectory() || (configInfo.mode & 0o077) !== 0) {
        throw failure("state_unavailable");
      }
      for (const path of [
        join(configDirectory, ".credentials.json"),
        join(configDirectory, "settings.json"),
      ]) {
        try {
          await access(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        throw failure("unsupported_auth");
      }
      return home;
    },
    catch: (error) =>
      error instanceof ClaudeRuntimeError
        ? error
        : failure("state_unavailable"),
  });

/**
 * API-key integration, not a Claude subscription login bridge. Run only on a
 * trusted isolated host: managed host/server policy still loads despite empty
 * settingSources, and native tools can access the host and their API key.
 * https://code.claude.com/docs/en/legal-and-compliance
 * https://code.claude.com/docs/en/agent-sdk/claude-code-features
 */
export function createClaudeRuntime(
  config: ClaudeRuntimeOptions,
): CodingRuntime {
  // No ambient auth fallback, OAuth token conversion, cloud routing or proxies.
  if (
    config.auth?.type !== "api-key" ||
    typeof config.auth.apiKey !== "string" ||
    !config.auth.apiKey.trim() ||
    config.auth.apiKey !== config.auth.apiKey.trim() ||
    config.auth.apiKey.startsWith("sk-ant-oat") ||
    Object.keys(config.auth).some((key) => !["type", "apiKey"].includes(key))
  ) {
    throw failure("unsupported_auth");
  }
  const tools = [...(config.allowedTools ?? [])];
  const maxTurns = config.maxTurns ?? 40;
  if (
    !isAbsolute(config.stateDirectory) ||
    Object.keys(config).some(
      (key) =>
        ![
          "auth",
          "stateDirectory",
          "allowedTools",
          "model",
          "maxTurns",
          "query",
          "effectRuntime",
        ].includes(key),
    ) ||
    tools.some((tool) => !TOOLS.includes(tool)) ||
    !Number.isSafeInteger(maxTurns) ||
    maxTurns < 1
  ) {
    throw failure("invalid_configuration");
  }
  const { apiKey } = config.auth;
  const { stateDirectory, model, query = sdkQuery } = config;

  const run = Effect.fn("june.coding.claude.run")(function* (
    input: Parameters<CodingRuntime["run"]>[0],
  ) {
    const cancelled = () => input.signal.aborted;
    if (cancelled()) return yield* failure("cancelled");
    if (input.threadId !== undefined && !UUID.test(input.threadId))
      return yield* failure("thread_mismatch");
    const home = yield* prepareState(stateDirectory, input.cwd);
    if (cancelled()) return yield* failure("cancelled");
    const threadId = input.threadId ?? randomUUID();
    // SDK supports choosing a UUID up front: persist before any launch or
    // external side effect, not merely before reading the second stream item.
    if (input.threadId === undefined)
      yield* Effect.tryPromise({
        try: () => input.onThread(threadId),
        catch: () => failure(cancelled() ? "cancelled" : "thread_save_failed"),
      });
    if (cancelled()) return yield* failure("cancelled");

    const abortController = new AbortController();
    let stream: ReturnType<ClaudeQuery> | undefined;
    const abort = () => abortController.abort();
    let closeFailed = false;
    const consume = Effect.tryPromise({
      try: async () => {
        let report: string | undefined;
        let initialized = false;
        if (cancelled()) throw failure("cancelled");
        // Both prepareState and onThread can outlive the originating context.
        // Recheck synchronously at provider admission, including saved resumes.
        input.assertCurrent?.();
        stream = query({
          prompt: input.prompt,
          options: {
            cwd: input.cwd,
            ...(input.threadId
              ? { resume: threadId }
              : { sessionId: threadId }),
            abortController,
            persistSession: true,
            model,
            maxTurns,
            tools,
            allowedTools: tools,
            permissionMode: "dontAsk",
            permissionPrompts: "none",
            allowDangerouslySkipPermissions: false,
            settingSources: [],
            settings: { disableAllHooks: true, autoMemoryEnabled: false },
            strictMcpConfig: true,
            mcpServers: {},
            plugins: [],
            skills: [],
            env: {
              PATH: process.env.PATH,
              HOME: home,
              CLAUDE_CONFIG_DIR: join(home, ".claude"),
              ANTHROPIC_API_KEY: apiKey,
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
              ENABLE_CLAUDEAI_MCP_SERVERS: "false",
            },
          },
        });
        for await (const message of stream) {
          if (cancelled()) throw failure("cancelled");
          if (message.type === "system" && message.subtype === "init") {
            if (message.apiKeySource !== "ANTHROPIC_API_KEY")
              throw failure("unsupported_auth");
            if (
              message.permissionMode !== "dontAsk" ||
              message.tools.some(
                (tool) => !tools.includes(tool as ClaudeTool),
              ) ||
              message.mcp_servers.length > 0 ||
              message.plugins.length > 0 ||
              message.skills.length > 0
            )
              throw failure("invalid_configuration");
            initialized = true;
          }
          if ("session_id" in message && message.session_id !== threadId)
            throw failure("thread_mismatch");
          if (message.type === "result") {
            if (
              report !== undefined ||
              message.subtype !== "success" ||
              message.is_error
            )
              throw failure("execution_failed");
            if (!initialized) throw failure("invalid_configuration");
            report = boundedReport(message.result);
          }
        }
        if (cancelled()) throw failure("cancelled");
        if (report === undefined) throw failure("result_not_reported");
        return report;
      },
      catch: (error) =>
        cancelled()
          ? failure("cancelled")
          : error instanceof ClaudeRuntimeError
            ? error
            : failure("stream_failed"),
    });
    const report = yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        input.signal.addEventListener("abort", abort, { once: true }),
      ),
      () => consume,
      () =>
        Effect.sync(() => {
          input.signal.removeEventListener("abort", abort);
          abortController.abort();
          try {
            stream?.close();
          } catch {
            closeFailed = true;
          }
        }),
    );
    if (cancelled()) return yield* failure("cancelled");
    if (closeFailed) return yield* failure("stream_failed");
    // Only return after the stream settles; a result followed by transport
    // failure is unknown, not success. The report itself is still a claim.
    return { threadId, report } satisfies CodingResult;
  });
  return { run: (input) => config.effectRuntime.runPromise(run(input)) };
}
