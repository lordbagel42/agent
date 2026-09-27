import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompanionReply, ModelRequest } from "../core/contracts.js";
import {
  type CodexProviderOptions,
  codexEnvironment,
  codexPrompt,
  stopProcess,
  validateOptions,
} from "./codex.js";
import {
  assertHotCodexFiles,
  assertHotCodexPolicy,
} from "./codex-hot-policy.js";
import { ModelError, parseReply, replyJsonSchema } from "./provider.js";
import { observeUsage, type TokenUsage, tokenUsage } from "./usage.js";

// Pinned official temporary_structured_request.rs, plus exec's disabled features.
const disabled = [
  "apps",
  "code_mode",
  "code_mode_only",
  "code_mode_host",
  "context_management",
  "current_time_reminder",
  "deferred_executor",
  "enable_fanout",
  "goals",
  "hooks",
  "image_generation",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "request_permissions_tool",
  "shell_snapshot",
  "shell_tool",
  "standalone_web_search",
  "token_budget",
  "tool_suggest",
  "unified_exec",
  "view_image",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "in_app_browser",
  "computer_use",
  "skill_search",
  "skill_mcp_dependency_install",
  "sleep_tool",
  "auth_elicitation",
  "network_proxy",
];
const safeConfig: Record<string, unknown> = {
  ...Object.fromEntries(disabled.map((name) => [`features.${name}`, false])),
  "features.skip_host_skill_discovery": true,
  "cloud.skills.enabled": false,
  "skills.include_instructions": false,
  "tools.experimental_request_user_input.enabled": false,
  "tools.update_plan.enabled": false,
  web_search: "disabled",
  default_permissions: ":read-only",
  approval_policy: "never",
  model_provider: "openai",
  openai_base_url: "",
  project_doc_max_bytes: 0,
  "shell_environment_policy.inherit": "none",
  notify: [],
  thread_unload_delay_secs: 0,
};
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const failure = (code = "generation_failed") => new ModelError(code, false);
const CAPACITY = 3;
const MAX_BYTES = 1024 * 1024;
interface ActiveTurn {
  turn?: string;
  answer?: string;
  usage?: TokenUsage;
  bytes: number;
  terminal: boolean;
  timing?: ModelRequest["onProviderTiming"];
  ended: PromiseWithResolvers<void>;
  resolve(): void;
  reject(e: unknown): void;
}

/** One process, three single-use sessions. Never resume, steer, replay, or share a used thread. */
export function createHotCodexProvider(options: CodexProviderOptions) {
  const { home, model, executable = "codex", timeoutMs = 75_000 } = options;
  validateOptions({ ...options, executable, timeoutMs });
  let child: ChildProcessWithoutNullStreams | undefined;
  let root: string | undefined;
  let closed: Promise<void> | undefined;
  let processClosed: Promise<void> = Promise.resolve();
  let stopping = false;
  let errorCode: string | undefined;
  let sequence = 0;
  let creating = 0;
  let consumed = 0;
  let buffer = Buffer.alloc(0);
  let refresh: NodeJS.Timeout | undefined;
  const idle: { id: string; born: number }[] = [];
  const retiring = new Map<
    string,
    { resolve(): void; reject(e: unknown): void }
  >();
  const pending = new Map<
    number,
    {
      resolve(v: unknown): void;
      reject(e: unknown): void;
      timer: NodeJS.Timeout;
    }
  >();
  const active = new Map<string, ActiveTurn>();
  const operations = new Set<Promise<CompanionReply>>();

  function fail(code: string) {
    errorCode ??= code;
    if (refresh) clearInterval(refresh);
    idle.length = 0;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(failure(code));
    }
    pending.clear();
    for (const a of active.values()) {
      a.reject(failure(code));
      a.ended.reject(failure(code));
    }
    for (const r of retiring.values()) r.reject(failure(code));
    if (child) stopProcess(child);
  }
  async function retire(threadId: string) {
    const done = Promise.withResolvers<void>();
    retiring.set(threadId, done);
    void done.promise.catch(() => {});
    const timer = setTimeout(() => fail("cleanup_failed"), 15_000);
    try {
      await rpc("thread/unsubscribe", { threadId });
      // Unsubscribe alone does not prove shutdown. Bound actual live sessions,
      // not merely references in our idle array, before replacing this slot.
      await done.promise;
    } finally {
      clearTimeout(timer);
      retiring.delete(threadId);
    }
  }
  function rpc(method: string, params: unknown): Promise<unknown> {
    if (!child || errorCode)
      return Promise.reject(failure(errorCode ?? "provider_unavailable"));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(
        () => fail("timeout"),
        Math.min(timeoutMs, 15_000),
      );
      pending.set(id, { resolve, reject, timer });
      child?.stdin.write(
        `${JSON.stringify({ id, method, params })}\n`,
        (error) => {
          if (error) fail("provider_unavailable");
        },
      );
    });
  }
  function receive(value: unknown, bytes: number) {
    const msg = object(value);
    // No approvals, sampling, dynamic tools, or unexpected server requests.
    if (msg.method && msg.id !== undefined) return fail("unexpected_tool_use");
    if (msg.id !== undefined) {
      const p = pending.get(Number(msg.id));
      if (!p) return fail("malformed_response");
      pending.delete(Number(msg.id));
      clearTimeout(p.timer);
      if (msg.error) p.reject(failure());
      else p.resolve(msg.result);
      return;
    }
    const params = object(msg.params);
    if (msg.method === "thread/closed" && typeof params.threadId === "string") {
      retiring.get(params.threadId)?.resolve();
      return;
    }
    const a =
      typeof params.threadId === "string"
        ? active.get(params.threadId)
        : undefined;
    if (!a) return;
    a.bytes += bytes;
    if (a.bytes > MAX_BYTES) return fail("response_too_large");
    if (typeof params.turnId === "string") {
      if (a.turn && a.turn !== params.turnId) return fail("malformed_response");
      a.turn = params.turnId;
    }
    if (msg.method === "item/started" || msg.method === "item/completed") {
      const item = object(params.item);
      if (
        !["userMessage", "agentMessage", "reasoning"].includes(
          String(item.type),
        )
      )
        return fail("unexpected_tool_use");
      if (
        msg.method === "item/completed" &&
        item.type === "agentMessage" &&
        item.phase !== "commentary"
      ) {
        if (
          typeof item.text !== "string" ||
          Buffer.byteLength(item.text) > 65536
        )
          return fail("malformed_response");
        a.answer = item.text;
      }
    }
    if (msg.method === "thread/tokenUsage/updated") {
      const u = object(object(params.tokenUsage).last);
      a.usage = tokenUsage("codex", {
        input_tokens: u.inputTokens,
        output_tokens: u.outputTokens,
        cached_input_tokens: u.cachedInputTokens,
        cache_write_input_tokens: u.cacheWriteInputTokens,
        reasoning_output_tokens: u.reasoningOutputTokens,
      });
    }
    if (msg.method === "turn/completed") {
      const turn = object(params.turn);
      if (
        typeof turn.id !== "string" ||
        (a.turn && a.turn !== turn.id) ||
        !["completed", "failed", "interrupted"].includes(String(turn.status))
      )
        return fail("malformed_response");
      a.turn = turn.id;
      a.terminal = true;
      a.timing?.("terminal");
      a.ended.resolve();
      if (turn.status === "completed") a.resolve();
      else a.reject(failure());
    }
  }

  async function replenish() {
    if (stopping || errorCode) return;
    creating++;
    try {
      // Read before every thread, not once: config may have changed on disk.
      await assertHotCodexFiles(home);
      const config = await rpc("config/read", {
        includeLayers: true,
        cwd: root,
      });
      const requirements = await rpc("configRequirements/read", {});
      assertHotCodexPolicy(config, requirements, safeConfig);
      if (stopping || errorCode) return;
      const result = object(
        await rpc("thread/start", {
          model,
          modelProvider: "openai",
          serviceTier: options.serviceTier ?? "default",
          cwd: root,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
          baseInstructions:
            "Generate a structured conversational reply. Never use tools. The supplied conversation system field defines your instructions.",
          developerInstructions:
            "Do not execute actions or consult files, saved memories, or other threads.",
          environments: [],
          dynamicTools: [],
          selectedCapabilityRoots: [],
          runtimeWorkspaceRoots: [],
          config: {
            ...safeConfig,
            mcp_servers: {},
            ...(options.reasoningEffort
              ? { model_reasoning_effort: options.reasoningEffort }
              : {}),
          },
        }),
      );
      const id = object(result.thread).id;
      if (
        typeof id !== "string" ||
        !id ||
        result.approvalPolicy !== "never" ||
        result.modelProvider !== "openai" ||
        !Array.isArray(result.instructionSources) ||
        result.instructionSources.length !== 0 ||
        object(result.sandbox).type !== "readOnly"
      )
        throw failure("invalid_configuration");
      if (stopping) await rpc("thread/unsubscribe", { threadId: id });
      else idle.push({ id, born: Date.now() });
    } catch (error) {
      fail(error instanceof ModelError ? error.code : "provider_unavailable");
    } finally {
      creating--;
    }
  }
  const startup = (async () => {
    try {
      // Stock app-server lacks exec's ignore-user-config flags. Require an auth-only
      // home rather than silently inheriting arbitrary user instructions/providers.
      await assertHotCodexFiles(home);
      root = await mkdtemp(join(tmpdir(), "june-hot-codex-"));
      if (stopping) return;
      const args = ["app-server", "--listen", "stdio://"];
      for (const [key, value] of Object.entries(safeConfig))
        args.push("-c", `${key}=${JSON.stringify(value)}`);
      child = spawn(executable, args, {
        cwd: root,
        env: codexEnvironment(home),
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      processClosed = new Promise((resolve) =>
        child?.once("close", () => {
          if (!stopping) fail("provider_unavailable");
          resolve();
        }),
      );
      child.on("error", () => fail("provider_unavailable"));
      child.stdin.on("error", () => fail("provider_unavailable"));
      // Drain diagnostics without retaining credentials, prompts, or provider errors.
      child.stderr.on("data", () => {});
      child.stdout.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_BYTES) return fail("response_too_large");
        while (buffer.includes(10)) {
          const end = buffer.indexOf(10);
          const line = buffer.subarray(0, end);
          buffer = buffer.subarray(end + 1);
          try {
            receive(
              JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(line)),
              line.length,
            );
          } catch {
            fail("malformed_response");
          }
        }
      });
      await rpc("initialize", {
        clientInfo: { name: "june_hot_inference", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      await Promise.all(Array.from({ length: CAPACITY }, () => replenish()));
      if (errorCode) return;
      // Bounded rotation: refresh at most one unused session every 20 seconds.
      refresh = setInterval(() => {
        const slot = idle[0];
        if (!slot || Date.now() - slot.born < 60_000 || creating || stopping)
          return;
        idle.shift();
        void retire(slot.id)
          .then(() => replenish())
          .catch(() => fail("cleanup_failed"));
      }, 20_000);
      refresh.unref();
    } catch (error) {
      fail(error instanceof ModelError ? error.code : "provider_unavailable");
    }
  })();

  return {
    async ready() {
      await startup;
      if (errorCode || stopping)
        throw failure(errorCode ?? "provider_unavailable");
    },
    inspect() {
      return {
        transport: "codex-app-server",
        model,
        serviceTier: options.serviceTier ?? "default",
        state: stopping
          ? "draining"
          : errorCode
            ? "failed"
            : creating
              ? "warming"
              : "running",
        capacity: CAPACITY,
        idle: idle.length,
        active: active.size,
        creating,
        consumed,
        prewarm: "scheduled_not_confirmed",
        ...(errorCode ? { error: errorCode } : {}),
      };
    },
    async reply(request: ModelRequest, signal?: AbortSignal) {
      signal?.throwIfAborted();
      await startup;
      signal?.throwIfAborted();
      if (stopping || errorCode)
        throw failure(errorCode ?? "provider_unavailable");
      const answer = Promise.withResolvers<CompanionReply>();
      // Telemetry must never change inference or retirement behavior.
      const timing: NonNullable<ModelRequest["onProviderTiming"]> = (stage) => {
        try {
          request.onProviderTiming?.(stage);
        } catch {
          /* observational only */
        }
      };
      const operation = observeUsage(
        options.usage,
        { provider: "codex", model, stage: request.usageStage ?? "fast" },
        async (report) => {
          const slot = idle.shift();
          if (!slot) throw new ModelError("provider_busy", true); // No inference submitted.
          consumed++;
          const done = Promise.withResolvers<void>();
          // Notifications may precede the turn/start response. Install first.
          const a: ActiveTurn = {
            ...done,
            bytes: 0,
            terminal: false,
            timing,
            ended: Promise.withResolvers<void>(),
          };
          active.set(slot.id, a);
          void done.promise.catch(() => {});
          void a.ended.promise.catch(() => {});
          const cancel = () =>
            a.reject(failure(signal?.aborted ? "cancelled" : "timeout"));
          const timer = setTimeout(cancel, timeoutMs);
          signal?.addEventListener("abort", cancel, { once: true });
          let reply: CompanionReply | undefined;
          let requestError: unknown;
          try {
            // Never race/drop this RPC: without its ID, cancellation would orphan a turn.
            timing("submitted");
            const result = object(
              await rpc("turn/start", {
                threadId: slot.id,
                input: [
                  {
                    type: "text",
                    text: codexPrompt(request),
                    textElements: [],
                  },
                ],
                outputSchema: replyJsonSchema(request.workspaces, request),
              }),
            );
            const id = object(result.turn).id;
            if (typeof id !== "string" || (a.turn && a.turn !== id))
              throw failure("malformed_response");
            a.turn = id;
            if (signal?.aborted) cancel();
            await done.promise;
            signal?.throwIfAborted();
            if (stopping || errorCode)
              throw failure(errorCode ?? "provider_closed");
            if (!a.answer) throw failure("malformed_response");
            reply = parseReply(a.answer, request.workspaces, request);
            timing("validated");
            // A completed, validated answer no longer depends on session disposal.
            // Keep the operation/slot tracked until cleanup and usage recording finish.
            answer.resolve(reply);
          } catch (error) {
            requestError = error;
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancel);
            try {
              if (!errorCode) {
                if (!a.terminal && a.turn) {
                  try {
                    await rpc("turn/interrupt", {
                      threadId: slot.id,
                      turnId: a.turn,
                    });
                  } catch {
                    // An interrupt can lose the race with completion. Only a
                    // matching validated terminal event proves it is safe to retire.
                    const cleanupTimer = setTimeout(
                      () => fail("cleanup_failed"),
                      Math.min(timeoutMs, 15_000),
                    );
                    try {
                      await a.ended.promise;
                    } finally {
                      clearTimeout(cleanupTimer);
                    }
                  }
                }
                if (!a.turn) fail("generation_failed");
                else {
                  await retire(slot.id);
                  timing("retired");
                }
              }
            } catch {
              fail("cleanup_failed");
            }
            if (errorCode) await processClosed;
            if (a.usage) report(a.usage);
            active.delete(slot.id);
            if (!stopping && !errorCode) void replenish();
          }
          // Disposal failure disables future calls, not an answer already delivered.
          if (reply) return reply;
          if (errorCode) throw failure(errorCode);
          if (requestError) throw requestError;
          throw failure("malformed_response");
        },
      );
      operations.add(operation);
      void operation
        .then(answer.resolve, answer.reject)
        .finally(() => operations.delete(operation));
      return answer.promise;
    },
    close(): Promise<void> {
      closed ??= (async () => {
        stopping = true;
        if (refresh) clearInterval(refresh);
        await startup;
        // Caller drains workflows first. Force-close also settles any remaining calls.
        fail("provider_closed");
        await processClosed;
        await Promise.allSettled(operations);
        if (root) await rm(root, { recursive: true, force: true });
      })();
      return closed;
    },
  };
}
