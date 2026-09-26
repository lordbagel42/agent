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
import type { CodingRuntime } from "../core/contracts.js";

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
}

export type ClaudeRuntimeErrorCode =
  | "unsupported_auth"
  | "invalid_configuration"
  | "state_unavailable"
  | "cancelled"
  | "thread_save_failed"
  | "thread_mismatch"
  | "execution_failed"
  | "stream_failed"
  | "result_not_reported";

/** Deliberately excludes provider errors, prompts, paths and credentials. */
export class ClaudeRuntimeError extends Error {
  constructor(readonly code: ClaudeRuntimeErrorCode) {
    super(`Claude Code runtime: ${code}.`);
    this.name = "ClaudeRuntimeError";
  }
}

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

async function prepareState(directory: string, cwd: string): Promise<string> {
  try {
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
      throw new ClaudeRuntimeError("state_unavailable");
    }
    const configDirectory = join(home, ".claude");
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    const configInfo = await lstat(configDirectory);
    if (!configInfo.isDirectory() || (configInfo.mode & 0o077) !== 0) {
      throw new ClaudeRuntimeError("state_unavailable");
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
      throw new ClaudeRuntimeError("unsupported_auth");
    }
    return home;
  } catch (error) {
    if (error instanceof ClaudeRuntimeError) throw error;
    throw new ClaudeRuntimeError("state_unavailable");
  }
}

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
    throw new ClaudeRuntimeError("unsupported_auth");
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
        ].includes(key),
    ) ||
    tools.some((tool) => !TOOLS.includes(tool)) ||
    !Number.isSafeInteger(maxTurns) ||
    maxTurns < 1
  ) {
    throw new ClaudeRuntimeError("invalid_configuration");
  }
  const { apiKey } = config.auth;
  const { stateDirectory, model, query = sdkQuery } = config;

  return {
    async run(input) {
      const cancelled = () => {
        if (input.signal.aborted) throw new ClaudeRuntimeError("cancelled");
      };
      cancelled();
      if (input.threadId !== undefined && !UUID.test(input.threadId)) {
        throw new ClaudeRuntimeError("thread_mismatch");
      }
      const home = await prepareState(stateDirectory, input.cwd);
      cancelled();
      const threadId = input.threadId ?? randomUUID();
      // SDK supports choosing a UUID up front: persist before any launch or
      // external side effect, not merely before reading the second stream item.
      if (input.threadId === undefined) {
        try {
          await input.onThread(threadId);
        } catch {
          cancelled();
          throw new ClaudeRuntimeError("thread_save_failed");
        }
      }
      cancelled();

      const abortController = new AbortController();
      let stream: ReturnType<ClaudeQuery> | undefined;
      const abort = () => abortController.abort();
      input.signal.addEventListener("abort", abort, { once: true });
      let report: string | undefined;
      let initialized = false;
      let closeFailed = false;
      try {
        cancelled();
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
          cancelled();
          if (message.type === "system" && message.subtype === "init") {
            if (message.apiKeySource !== "ANTHROPIC_API_KEY") {
              throw new ClaudeRuntimeError("unsupported_auth");
            }
            if (
              message.permissionMode !== "dontAsk" ||
              message.tools.some(
                (tool) => !tools.includes(tool as ClaudeTool),
              ) ||
              message.mcp_servers.length > 0 ||
              message.plugins.length > 0 ||
              message.skills.length > 0
            ) {
              throw new ClaudeRuntimeError("invalid_configuration");
            }
            initialized = true;
          }
          if ("session_id" in message) {
            if (message.session_id !== threadId) {
              throw new ClaudeRuntimeError("thread_mismatch");
            }
          }
          if (message.type === "result") {
            if (
              report !== undefined ||
              message.subtype !== "success" ||
              message.is_error
            ) {
              throw new ClaudeRuntimeError("execution_failed");
            }
            if (!initialized)
              throw new ClaudeRuntimeError("invalid_configuration");
            report = boundedReport(message.result);
          }
        }
        cancelled();
        if (report === undefined) {
          throw new ClaudeRuntimeError("result_not_reported");
        }
      } catch (error) {
        cancelled();
        if (error instanceof ClaudeRuntimeError) throw error;
        throw new ClaudeRuntimeError("stream_failed");
      } finally {
        input.signal.removeEventListener("abort", abort);
        abortController.abort();
        try {
          stream?.close();
        } catch {
          closeFailed = true;
        }
      }
      cancelled();
      if (closeFailed) throw new ClaudeRuntimeError("stream_failed");
      // Only return after the stream settles; a result followed by transport
      // failure is unknown, not success. The report itself is still a claim.
      return { threadId, report };
    },
  };
}
