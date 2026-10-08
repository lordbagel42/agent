import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Options,
  SDKMessage,
  SDKResultSuccess,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type ClaudeQuery,
  type ClaudeRuntimeOptions,
  createClaudeRuntime,
} from "./claude.js";

const SESSION = "bd54df6a-20de-4bab-af84-7f5b73e16245";
let root: string;
let config: ClaudeRuntimeOptions;
let input: Parameters<ReturnType<typeof createClaudeRuntime>["run"]>[0];

function init(
  session_id: string,
  overrides: Partial<SDKSystemMessage> = {},
): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    session_id,
    uuid: SESSION,
    apiKeySource: "ANTHROPIC_API_KEY",
    claude_code_version: "2.1.283",
    cwd: input.cwd,
    tools: [],
    mcp_servers: [],
    model: "fixture-model",
    permissionMode: "dontAsk",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    ...overrides,
  };
}

function result(
  session_id: string,
  text = "Changed the code",
): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    session_id,
    uuid: SESSION,
    is_error: false,
    result: text,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 0,
      },
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: "standard",
      inference_geo: "not_available",
      iterations: [],
      speed: "standard",
      fallback_credit: { status: { type: "redeemed" } },
      output_tokens_details: { thinking_tokens: 0 },
    },
    modelUsage: {},
    permission_denials: [],
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "june-claude-test-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  config = {
    auth: { type: "api-key", apiKey: "fixture-key-not-real" },
    stateDirectory: join(root, "runtime-home"),
  };
  input = {
    prompt: "Review this repository",
    cwd,
    signal: new AbortController().signal,
    onThread: vi.fn(async () => {}),
  };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("keeps ambient credentials and tools out; rejects unsupported auth and desktop credentials", async () => {
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "must-not-leak");
  vi.stubEnv("ANTHROPIC_API_KEY", "ambient-must-not-leak");
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://untrusted.invalid");
  vi.stubEnv("SECRET", "must-not-leak");
  let options: Options | undefined;
  const close = vi.fn();
  const query: ClaudeQuery = (request) => {
    options = request.options;
    return {
      close,
      async *[Symbol.asyncIterator]() {
        yield init(request.options.sessionId ?? "");
        yield result(request.options.sessionId ?? "");
      },
    };
  };
  await createClaudeRuntime({ ...config, query }).run(input);
  expect(options).toMatchObject({
    tools: [],
    allowedTools: [],
    permissionMode: "dontAsk",
    permissionPrompts: "none",
    allowDangerouslySkipPermissions: false,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    plugins: [],
    skills: [],
    settings: { disableAllHooks: true, autoMemoryEnabled: false },
  });
  expect(options?.env).toEqual({
    PATH: process.env.PATH,
    HOME: config.stateDirectory,
    CLAUDE_CONFIG_DIR: join(config.stateDirectory, ".claude"),
    ANTHROPIC_API_KEY: "fixture-key-not-real",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  });
  expect(close).toHaveBeenCalledOnce();
  expect(() =>
    createClaudeRuntime({
      ...config,
      // @ts-expect-error Runtime configuration must reject subscription access.
      auth: { type: "subscription" },
    }),
  ).toThrow("unsupported_auth");
  expect(() =>
    createClaudeRuntime({
      ...config,
      auth: { type: "api-key", apiKey: "sk-ant-oat01-not-an-api-key" },
    }),
  ).toThrow("unsupported_auth");
  expect(() =>
    // @ts-expect-error Permission bypass cannot be configured even from JS.
    createClaudeRuntime({ ...config, permissionMode: "bypassPermissions" }),
  ).toThrow("invalid_configuration");
  await writeFile(
    join(config.stateDirectory, ".claude", ".credentials.json"),
    "{}",
  );
  await expect(
    createClaudeRuntime({ ...config, query }).run(input),
  ).rejects.toMatchObject({
    code: "unsupported_auth",
  });
  expect(close).toHaveBeenCalledOnce();
});

it("rejects public, workspace-overlapping and symlinked state before session admission", async () => {
  const query = vi.fn<ClaudeQuery>();
  await mkdir(config.stateDirectory, { mode: 0o700 });
  await chmod(config.stateDirectory, 0o755);
  for (const stateDirectory of [
    config.stateDirectory,
    join(input.cwd, "..private"),
  ]) {
    await expect(
      createClaudeRuntime({ ...config, stateDirectory, query }).run(input),
    ).rejects.toMatchObject({ code: "state_unavailable" });
  }
  await chmod(config.stateDirectory, 0o700);
  await symlink(input.cwd, join(config.stateDirectory, ".claude"));
  await expect(
    createClaudeRuntime({ ...config, query }).run(input),
  ).rejects.toMatchObject({ code: "state_unavailable" });
  expect(query).not.toHaveBeenCalled();
  expect(input.onThread).not.toHaveBeenCalled();
});

it("requires API-key initialization without extra permissions, tools, MCP, plugins or skills", async () => {
  const close = vi.fn();
  let metadata: Partial<SDKSystemMessage> = { tools: ["Read", "Grep"] };
  let sendInit = true;
  const query: ClaudeQuery = (request) => ({
    close,
    async *[Symbol.asyncIterator]() {
      expect(request.options.tools).toEqual(["Read", "Grep"]);
      expect(request.options.allowedTools).toEqual(["Read", "Grep"]);
      if (sendInit) yield init(request.options.sessionId ?? "", metadata);
      yield result(request.options.sessionId ?? "");
    },
  });
  const runtime = createClaudeRuntime({
    ...config,
    allowedTools: ["Read", "Grep"],
    query,
  });
  await runtime.run(input);
  for (const [override, code] of [
    [{ apiKeySource: "none" }, "unsupported_auth"],
    [{ permissionMode: "bypassPermissions" }, "invalid_configuration"],
    [{ tools: ["Read", "Bash"] }, "invalid_configuration"],
    [
      { mcp_servers: [{ name: "unexpected", status: "connected" }] },
      "invalid_configuration",
    ],
    [
      { plugins: [{ name: "unexpected", path: "/fixture/plugin" }] },
      "invalid_configuration",
    ],
    [{ skills: ["unexpected"] }, "invalid_configuration"],
  ] satisfies [Partial<SDKSystemMessage>, string][]) {
    metadata = override;
    await expect(runtime.run(input)).rejects.toMatchObject({ code });
  }
  sendInit = false;
  await expect(runtime.run(input)).rejects.toMatchObject({
    code: "invalid_configuration",
  });
  expect(close).toHaveBeenCalledTimes(8);
});

it("awaits durable session admission before launch and never launches on failed persistence", async () => {
  const gate = Promise.withResolvers<void>();
  const close = vi.fn();
  const query = vi.fn<ClaudeQuery>((request) => ({
    close,
    async *[Symbol.asyncIterator]() {
      yield init(request.options.sessionId ?? "");
      yield result(request.options.sessionId ?? "");
    },
  }));
  input.onThread = vi.fn(async () => gate.promise);
  const runtime = createClaudeRuntime({ ...config, query });
  const run = runtime.run(input);
  await vi.waitFor(() => expect(input.onThread).toHaveBeenCalledOnce());
  expect(query).not.toHaveBeenCalled();
  gate.resolve();
  const completed = await run;
  expect(input.onThread).toHaveBeenCalledWith(completed.threadId);
  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0]?.[0].options.sessionId).toBe(completed.threadId);
  expect((await stat(config.stateDirectory)).mode & 0o777).toBe(0o700);
  expect(
    (await stat(join(config.stateDirectory, ".claude"))).mode & 0o777,
  ).toBe(0o700);
  input.onThread = async () => {
    throw new Error("private database failure");
  };
  await expect(runtime.run(input)).rejects.toMatchObject({
    code: "thread_save_failed",
  });
  expect(query).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "rechecks host validity after onThread without signal cancellation (invalidated: %s)",
  async (invalidate) => {
    const saved = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    const query = vi.fn<ClaudeQuery>((request) => ({
      close() {},
      async *[Symbol.asyncIterator]() {
        yield init(request.options.sessionId ?? "");
        yield result(request.options.sessionId ?? "");
      },
    }));
    let revision = 0;
    const frozenRevision = revision;
    const run = createClaudeRuntime({ ...config, query }).run({
      ...input,
      assertCurrent: () => {
        if (revision !== frozenRevision) throw new Error("stale context");
      },
      onThread: async () => {
        observed.resolve();
        await saved.promise;
      },
    });
    const outcome = run.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await observed.promise;
    expect(query).not.toHaveBeenCalled();
    if (invalidate) revision++;
    saved.resolve();
    const completed = await outcome;
    expect(input.signal.aborted).toBe(false);
    expect(query).toHaveBeenCalledTimes(invalidate ? 0 : 1);
    if (invalidate) {
      expect(completed.value).toBeUndefined();
      expect(completed.error).toMatchObject({ code: "stream_failed" });
    } else {
      expect(completed.error).toBeUndefined();
      expect(completed.value?.report).toContain("Changed the code");
    }
  },
);

it("rechecks host validity after prepareState when resuming without onThread", async () => {
  const query = vi.fn<ClaudeQuery>((request) => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      yield init(request.options.resume ?? "");
      yield result(request.options.resume ?? "");
    },
  }));
  let current = true;
  const run = createClaudeRuntime({ ...config, query }).run({
    ...input,
    threadId: SESSION,
    assertCurrent: () => {
      if (!current) throw new Error("stale context");
    },
  });
  current = false;
  await expect(run).rejects.toMatchObject({ code: "stream_failed" });
  expect(input.signal.aborted).toBe(false);
  expect(input.onThread).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});

it("resumes only the saved UUID and rejects any replacement without relaunching", async () => {
  const close = vi.fn();
  let sessionId = SESSION;
  const query = vi.fn<ClaudeQuery>((request) => ({
    close,
    async *[Symbol.asyncIterator]() {
      expect(request.options.resume).toBe(SESSION);
      expect(request.options.sessionId).toBeUndefined();
      expect(request.options.continue).toBeUndefined();
      expect(request.options.forkSession).toBeUndefined();
      yield init(SESSION);
      yield result(sessionId);
    },
  }));
  const runtime = createClaudeRuntime({ ...config, query });
  await expect(
    runtime.run({ ...input, threadId: SESSION }),
  ).resolves.toMatchObject({ threadId: SESSION });
  sessionId = "c3a1ba58-a2c4-46ec-b911-c538ac0e3c02";
  await expect(
    runtime.run({ ...input, threadId: SESSION }),
  ).rejects.toMatchObject({ code: "thread_mismatch" });
  expect(input.onThread).not.toHaveBeenCalled();
  expect(query).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
});

it("requires settled success rather than a missing, duplicate, failed or unclosed result", async () => {
  const close = vi.fn();
  const query: ClaudeQuery = (request) => ({
    close,
    async *[Symbol.asyncIterator]() {
      yield init(request.options.sessionId ?? "");
      yield result(request.options.sessionId ?? "");
      throw new Error("private provider error containing credentials");
    },
  });
  await expect(
    createClaudeRuntime({ ...config, query }).run(input),
  ).rejects.toMatchObject({
    code: "stream_failed",
    message: "Claude Code runtime: stream_failed.",
  });
  expect(close).toHaveBeenCalledOnce();
  const success = result(SESSION);
  for (const [messages, code] of [
    [[], "result_not_reported"],
    [[success, success], "execution_failed"],
    [[{ ...success, is_error: true }], "execution_failed"],
    [
      [
        {
          ...success,
          subtype: "error_max_turns" as const,
          errors: ["private error"],
        },
      ],
      "execution_failed",
    ],
  ] satisfies [SDKMessage[], string][]) {
    await expect(
      createClaudeRuntime({
        ...config,
        query: () => ({
          close,
          async *[Symbol.asyncIterator]() {
            yield init(SESSION);
            yield* messages;
          },
        }),
      }).run({ ...input, threadId: SESSION }),
    ).rejects.toMatchObject({ code });
  }
  expect(close).toHaveBeenCalledTimes(5);
  close.mockImplementation(() => {
    throw new Error("private close failure");
  });
  await expect(
    createClaudeRuntime({
      ...config,
      query: () => ({
        close,
        async *[Symbol.asyncIterator]() {
          yield init(SESSION);
          yield success;
        },
      }),
    }).run({ ...input, threadId: SESSION }),
  ).rejects.toMatchObject({ code: "stream_failed" });
});

it("propagates cancellation, closes execution, and never launches after cancellation during persistence", async () => {
  const controller = new AbortController();
  input.signal = controller.signal;
  const started = Promise.withResolvers<void>();
  const close = vi.fn();
  const query = vi.fn<ClaudeQuery>((request) => ({
    close,
    async *[Symbol.asyncIterator]() {
      yield init(request.options.sessionId ?? "");
      const aborted = new Promise<void>((resolve) => {
        request.options.abortController?.signal.addEventListener(
          "abort",
          () => resolve(),
          { once: true },
        );
      });
      started.resolve();
      await aborted;
      yield result(request.options.sessionId ?? "");
    },
  }));
  const run = createClaudeRuntime({ ...config, query }).run(input);
  const rejection = expect(run).rejects.toMatchObject({ code: "cancelled" });
  await started.promise;
  controller.abort();
  await rejection;
  expect(close).toHaveBeenCalledOnce();
  const second = new AbortController();
  input.signal = second.signal;
  input.onThread = async () => {
    second.abort();
  };
  await expect(
    createClaudeRuntime({ ...config, query }).run(input),
  ).rejects.toMatchObject({ code: "cancelled" });
  expect(query).toHaveBeenCalledOnce();
});
