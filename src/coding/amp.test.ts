import type { ExecuteOptions, StreamMessage } from "@ampcode/sdk";
import { describe, expect, it, vi } from "vitest";
import { AmpRuntimeError, createAmpRuntime } from "./amp.js";

function systemMessage(threadId: string): StreamMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: threadId,
    cwd: "/workspaces/project",
    tools: [],
    mcp_servers: [],
  };
}

function successMessage(threadId: string, report: string): StreamMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: threadId,
    is_error: false,
    result: report,
    duration_ms: 10,
    num_turns: 1,
  };
}

function assistantMessage(threadId: string, text: string): StreamMessage {
  return {
    type: "assistant",
    session_id: threadId,
    message: {
      id: "message-1",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
    },
    parent_tool_use_id: null,
  };
}

function errorMessage(threadId: string, error: string): StreamMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    session_id: threadId,
    is_error: true,
    error,
    duration_ms: 10,
    num_turns: 1,
  };
}

describe("createAmpRuntime", () => {
  it("saves a new thread before consuming more output and returns its final report", async () => {
    const order: string[] = [];
    let finishSaving = () => {};
    const saving = new Promise<void>((resolve) => {
      finishSaving = resolve;
    });
    const execute = vi.fn(
      (_options: ExecuteOptions): AsyncIterable<StreamMessage> => ({
        async *[Symbol.asyncIterator]() {
          order.push("thread reported");
          yield systemMessage("T-new");
          order.push("stream continued");
          yield successMessage("T-new", "Finished the requested change.");
        },
      }),
    );
    const signal = new AbortController().signal;
    const runtime = createAmpRuntime({ execute });

    const run = runtime.run({
      prompt: "Implement the change",
      cwd: "/workspaces/project",
      signal,
      onThread: async (threadId) => {
        order.push(`saving ${threadId}`);
        await saving;
        order.push(`saved ${threadId}`);
      },
    });

    await vi.waitFor(() => {
      expect(order).toContain("saving T-new");
    });
    const orderWhileSaving = [...order];
    finishSaving();

    await expect(run).resolves.toEqual({
      threadId: "T-new",
      report: "Finished the requested change.",
    });
    expect(orderWhileSaving).toEqual(["thread reported", "saving T-new"]);
    expect(order).toEqual([
      "thread reported",
      "saving T-new",
      "saved T-new",
      "stream continued",
    ]);
    expect(execute).toHaveBeenCalledWith({
      prompt: "Implement the change",
      options: { cwd: "/workspaces/project" },
      signal,
    });
  });

  it("waits for natural stream settlement and cleanup after a candidate result", async (t) => {
    const settlement = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const order: string[] = [];
    const execute = async function* (): AsyncIterable<StreamMessage> {
      try {
        yield systemMessage("T-settling");
        order.push("result yielded");
        yield successMessage("T-settling", "Candidate report");
        order.push("waiting for exit");
        await settlement.promise;
        order.push("exited cleanly");
      } finally {
        order.push("cleanup started");
        await cleanup.promise;
        order.push("cleanup finished");
      }
    };
    let resolved = false;
    const run = createAmpRuntime({ execute })
      .run({
        prompt: "Do the work",
        cwd: "/workspaces/project",
        signal: new AbortController().signal,
        onThread: async () => {},
      })
      .then((result) => {
        resolved = true;
        return result;
      });
    t.onTestFinished(async () => {
      settlement.resolve();
      cleanup.resolve();
      await run;
    });

    await vi.waitFor(() => expect(order.length).toBeGreaterThanOrEqual(2));
    expect(order).toEqual(["result yielded", "waiting for exit"]);
    expect(resolved).toBe(false);
    settlement.resolve();
    await vi.waitFor(() => expect(order).toContain("cleanup started"));
    expect(resolved).toBe(false);
    cleanup.resolve();
    await expect(run).resolves.toEqual({
      threadId: "T-settling",
      report: "Candidate report",
    });
    expect(order).toEqual([
      "result yielded",
      "waiting for exit",
      "exited cleanly",
      "cleanup started",
      "cleanup finished",
    ]);
  });

  it("continues a supplied thread without saving it again", async () => {
    const execute = vi.fn(async function* (
      _options: ExecuteOptions,
    ): AsyncIterable<StreamMessage> {
      yield systemMessage("T-existing");
      yield successMessage("T-existing", "Continued report");
    });
    const onThread = vi.fn(async () => {});
    const signal = new AbortController().signal;

    const result = await createAmpRuntime({ execute }).run({
      prompt: "Continue the task",
      cwd: "/workspaces/project",
      threadId: "T-existing",
      signal,
      onThread,
    });

    expect(result).toEqual({
      threadId: "T-existing",
      report: "Continued report",
    });
    expect(onThread).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith({
      prompt: "Continue the task",
      options: { cwd: "/workspaces/project", continue: "T-existing" },
      signal,
    });
  });

  it.each([
    ["continued first message", "T-bound", [systemMessage("T-other")]],
    [
      "continued later message",
      "T-bound",
      [systemMessage("T-bound"), assistantMessage("T-other", "Wrong thread")],
    ],
    [
      "new thread assistant",
      undefined,
      [systemMessage("T-bound"), assistantMessage("T-other", "Wrong thread")],
    ],
    [
      "new thread result",
      undefined,
      [systemMessage("T-bound"), successMessage("T-other", "Wrong report")],
    ],
    [
      "drift after candidate result",
      undefined,
      [
        successMessage("T-bound", "Candidate report"),
        assistantMessage("T-other", "Wrong thread"),
      ],
    ],
    [
      "empty session after binding",
      undefined,
      [systemMessage("T-bound"), successMessage("", "Unbound report")],
    ],
  ] as const)(
    "rejects %s without rebinding",
    async (_name, threadId, messages) => {
      const execute = async function* (): AsyncIterable<StreamMessage> {
        yield* messages;
        yield successMessage("T-bound", "Must not repair a broken binding");
      };
      const onThread = vi.fn(async () => {});
      const run = createAmpRuntime({ execute }).run({
        prompt: "Do the work",
        cwd: "/workspaces/project",
        threadId,
        signal: new AbortController().signal,
        onThread,
      });

      await expect(run).rejects.toBeInstanceOf(AmpRuntimeError);
      expect(onThread.mock.calls).toEqual(threadId ? [] : [["T-bound"]]);
    },
  );

  it("rejects an empty continuation thread ID before starting the SDK", async () => {
    const execute = vi.fn(async function* (
      _options: ExecuteOptions,
    ): AsyncIterable<StreamMessage> {
      yield successMessage("T-unexpected", "Unexpected success");
    });

    const error = await createAmpRuntime({ execute })
      .run({
        prompt: "Continue the task",
        cwd: "/workspaces/project",
        threadId: "",
        signal: new AbortController().signal,
        onThread: async () => {},
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AmpRuntimeError);
    expect(error).toMatchObject({
      code: "thread_not_reported",
      message: "Amp execution did not report a thread.",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns only a bounded final result instead of combining partial output", async () => {
    const oversizedReport = "x".repeat(40_000);
    const execute = vi.fn(async function* (
      _options: ExecuteOptions,
    ): AsyncIterable<StreamMessage> {
      yield systemMessage("T-bounded");
      yield assistantMessage("T-bounded", "Unrelated intermediate output");
      yield successMessage("T-bounded", oversizedReport);
    });

    const result = await createAmpRuntime({ execute }).run({
      prompt: "Do the work",
      cwd: "/workspaces/project",
      signal: new AbortController().signal,
      onThread: async () => {},
    });

    expect(result.report).toBe(`${"x".repeat(31_980)}\n\n[Report truncated]`);
    expect(result.report).toHaveLength(32_000);
    expect(result.report).not.toContain("Unrelated intermediate output");
  });

  it("rejects an SDK error after a candidate result without exposing its output", async () => {
    const sensitiveOutput = "failed with token secret-value";
    const execute = vi.fn(async function* (
      _options: ExecuteOptions,
    ): AsyncIterable<StreamMessage> {
      yield systemMessage("T-error");
      yield successMessage("T-error", "Candidate report");
      yield errorMessage("T-error", sensitiveOutput);
    });

    const error = await createAmpRuntime({ execute })
      .run({
        prompt: "Do the work",
        cwd: "/workspaces/project",
        signal: new AbortController().signal,
        onThread: async () => {},
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AmpRuntimeError);
    expect(error).toMatchObject({
      name: "AmpRuntimeError",
      code: "execution_failed",
      message: "Amp execution failed.",
    });
    expect(String(error)).not.toContain(sensitiveOutput);
  });

  it("rejects when the SDK throws after a candidate result", async () => {
    const sensitiveOutput = "Amp CLI process exited with code 7: api-key-value";
    const execute = vi.fn(async function* (
      _options: ExecuteOptions,
    ): AsyncIterable<StreamMessage> {
      yield systemMessage("T-stream-error");
      yield successMessage("T-stream-error", "Candidate report");
      throw new Error(sensitiveOutput);
    });

    const error = await createAmpRuntime({ execute })
      .run({
        prompt: "Do the work",
        cwd: "/workspaces/project",
        signal: new AbortController().signal,
        onThread: async () => {},
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AmpRuntimeError);
    expect(error).toMatchObject({
      code: "stream_failed",
      message: "Amp execution status is unknown.",
    });
    expect(String(error)).not.toContain(sensitiveOutput);
  });

  it("rejects a successful result that does not report a thread", async () => {
    const execute = vi.fn(async function* (
      _options: ExecuteOptions,
    ): AsyncIterable<StreamMessage> {
      yield successMessage("", "This must not be accepted");
    });
    const onThread = vi.fn(async () => {});

    const error = await createAmpRuntime({ execute })
      .run({
        prompt: "Do the work",
        cwd: "/workspaces/project",
        signal: new AbortController().signal,
        onThread,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AmpRuntimeError);
    expect(error).toMatchObject({
      code: "thread_not_reported",
      message: "Amp execution did not report a thread.",
    });
    expect(onThread).not.toHaveBeenCalled();
  });

  it("rejects a stream without a final result instead of using partial text", async () => {
    const execute = vi.fn(async function* (
      _options: ExecuteOptions,
    ): AsyncIterable<StreamMessage> {
      yield systemMessage("T-no-result");
      yield assistantMessage("T-no-result", "Only partial output");
    });

    const error = await createAmpRuntime({ execute })
      .run({
        prompt: "Do the work",
        cwd: "/workspaces/project",
        signal: new AbortController().signal,
        onThread: async () => {},
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AmpRuntimeError);
    expect(error).toMatchObject({
      code: "result_not_reported",
      message: "Amp execution did not report a final result.",
    });
    expect(String(error)).not.toContain("Only partial output");
  });

  it("rejects an already-aborted run without starting the SDK", async () => {
    const execute = vi.fn(async function* (
      _options: ExecuteOptions,
    ): AsyncIterable<StreamMessage> {
      yield successMessage("T-should-not-start", "Unexpected success");
    });
    const controller = new AbortController();
    controller.abort();

    const error = await createAmpRuntime({ execute })
      .run({
        prompt: "Do the work",
        cwd: "/workspaces/project",
        signal: controller.signal,
        onThread: async () => {},
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AmpRuntimeError);
    expect(error).toMatchObject({
      code: "cancelled",
      message: "Amp execution was cancelled.",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not continue after a late onThread resolves on an aborted run and awaits cleanup", async (t) => {
    const saving = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    let streamContinued = false;
    let cleanupStarted = false;
    const execute = vi.fn(async function* (
      _options: ExecuteOptions,
    ): AsyncIterable<StreamMessage> {
      try {
        yield systemMessage("T-cancelled");
        streamContinued = true;
        yield successMessage("T-cancelled", "Unexpected success");
      } finally {
        cleanupStarted = true;
        await cleanup.promise;
      }
    });
    const controller = new AbortController();
    const onThread = vi.fn(() => saving.promise);
    let rejected = false;

    const run = createAmpRuntime({ execute })
      .run({
        prompt: "Do the work",
        cwd: "/workspaces/project",
        signal: controller.signal,
        onThread,
      })
      .catch((caught: unknown) => {
        rejected = true;
        return caught;
      });
    t.onTestFinished(async () => {
      saving.resolve();
      cleanup.resolve();
      await run;
    });

    await vi.waitFor(() =>
      expect(onThread).toHaveBeenCalledWith("T-cancelled"),
    );
    controller.abort();
    saving.resolve();
    await vi.waitFor(() => expect(cleanupStarted).toBe(true));
    expect(rejected).toBe(false);
    expect(streamContinued).toBe(false);
    cleanup.resolve();
    const error = await run;

    expect(error).toBeInstanceOf(AmpRuntimeError);
    expect(error).toMatchObject({
      code: "cancelled",
      message: "Amp execution was cancelled.",
    });
    expect(streamContinued).toBe(false);
  });

  it("reports cancellation when the SDK aborts during iteration", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async function* (
      _options: ExecuteOptions,
    ): AsyncIterable<StreamMessage> {
      yield systemMessage("T-sdk-cancelled");
      controller.abort();
      throw new Error("raw SDK abort details");
    });

    const error = await createAmpRuntime({ execute })
      .run({
        prompt: "Do the work",
        cwd: "/workspaces/project",
        signal: controller.signal,
        onThread: async () => {},
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AmpRuntimeError);
    expect(error).toMatchObject({
      code: "cancelled",
      message: "Amp execution was cancelled.",
    });
    expect(String(error)).not.toContain("raw SDK abort details");
  });

  it("does not accept a result yielded after cancellation", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async function* (
      _options: ExecuteOptions,
    ): AsyncIterable<StreamMessage> {
      yield systemMessage("T-existing");
      controller.abort();
      yield successMessage("T-existing", "Unexpected success");
    });

    const error = await createAmpRuntime({ execute })
      .run({
        prompt: "Continue the work",
        cwd: "/workspaces/project",
        threadId: "T-existing",
        signal: controller.signal,
        onThread: async () => {},
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AmpRuntimeError);
    expect(error).toMatchObject({
      code: "cancelled",
      message: "Amp execution was cancelled.",
    });
  });

  it("rejects cancellation during settlement after a candidate result", async () => {
    const controller = new AbortController();
    const execute = async function* (): AsyncIterable<StreamMessage> {
      yield successMessage("T-cancelled", "Candidate report");
      controller.abort();
    };

    await expect(
      createAmpRuntime({ execute }).run({
        prompt: "Do the work",
        cwd: "/workspaces/project",
        signal: controller.signal,
        onThread: async () => {},
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("reports cancellation when an aborted stream ends without output", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async function* (
      _options: ExecuteOptions,
    ): AsyncIterable<StreamMessage> {
      controller.abort();
      yield* [];
    });

    const error = await createAmpRuntime({ execute })
      .run({
        prompt: "Do the work",
        cwd: "/workspaces/project",
        signal: controller.signal,
        onThread: async () => {},
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AmpRuntimeError);
    expect(error).toMatchObject({
      code: "cancelled",
      message: "Amp execution was cancelled.",
    });
  });

  it("stops safely when a new thread cannot be saved", async () => {
    let streamContinued = false;
    const sensitiveOutput = "database password leaked here";
    const execute = vi.fn(async function* (
      _options: ExecuteOptions,
    ): AsyncIterable<StreamMessage> {
      yield systemMessage("T-unsaved");
      streamContinued = true;
      yield successMessage("T-unsaved", "Unexpected success");
    });

    const error = await createAmpRuntime({ execute })
      .run({
        prompt: "Do the work",
        cwd: "/workspaces/project",
        signal: new AbortController().signal,
        onThread: async () => {
          throw new Error(sensitiveOutput);
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AmpRuntimeError);
    expect(error).toMatchObject({
      code: "thread_save_failed",
      message: "Amp thread could not be saved.",
    });
    expect(String(error)).not.toContain(sensitiveOutput);
    expect(streamContinued).toBe(false);
  });
});
