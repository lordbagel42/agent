import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { createPiRuntime, type PiRuntimeOptions } from "./pi.js";

const SESSION = "73c35d37-cf95-41bd-a1db-86160711f6a5";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(shutdown = "clean") {
  const root = await mkdtemp(join(tmpdir(), "june-pi-test-"));
  roots.push(root);
  const commands: Record<string, unknown>[] = [];
  const prompted = Promise.withResolvers<void>();
  let output: PassThrough;
  let child: EventEmitter;
  let sessionFile: string;
  const kill = vi.fn((signal: string) => {
    if (shutdown === "forced" && signal === "SIGKILL") {
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    }
    return true;
  });
  const emit = (event: unknown) => {
    const line = `${JSON.stringify(event)}\n`;
    // Fragment records to exercise real stream framing, not object injection.
    output.write(line.slice(0, 7));
    output.write(line.slice(7));
  };
  const launch = vi.fn(
    (
      _executable: string,
      args: string[],
      spawnOptions: { cwd: string; env: Record<string, string> },
    ) => {
      child = new EventEmitter();
      output = new PassThrough();
      sessionFile = args[args.indexOf("--session") + 1] as string;
      // Reproduce Pi's explicit-empty-file initialization and native resume.
      if (!readFileSync(sessionFile, "utf8")) {
        writeFileSync(
          sessionFile,
          `${JSON.stringify({ type: "session", version: 3, id: SESSION, timestamp: "2026-09-26T00:00:00.000Z", cwd: spawnOptions.cwd })}\n`,
        );
      }
      const header = JSON.parse(
        readFileSync(sessionFile, "utf8").split("\n")[0] as string,
      );
      const stdin = new Writable({
        write(chunk, _encoding, done) {
          const command = JSON.parse(chunk.toString()) as Record<
            string,
            unknown
          >;
          commands.push(command);
          if (command.type === "get_state")
            emit({
              type: "response",
              id: command.id,
              command: command.type,
              success: true,
              data: {
                model: { provider: "openai", id: "fixture-model" },
                sessionId: header.id,
                sessionFile,
              },
            });
          if (command.type === "prompt") {
            emit({
              type: "response",
              id: command.id,
              command: command.type,
              success: true,
              data: { disposition: "started" },
            });
            prompted.resolve();
          }
          done();
        },
        final(done) {
          if (shutdown === "stream-error")
            output.emit("error", new Error("private"));
          if (shutdown === "partial-record") output.write('{"type":');
          if (!["forced", "stuck", "kill-error"].includes(shutdown)) {
            output.end();
            setImmediate(() =>
              child.emit("close", shutdown === "nonzero" ? 1 : 0),
            );
          }
          done();
        },
      });
      return Object.assign(child, {
        stdin,
        stdout: output,
        stderr: new PassThrough(),
        kill,
      });
    },
  );
  const options: PiRuntimeOptions = {
    executable: "/operator/pi",
    provider: "openai",
    model: "fixture-model",
    agentDir: join(root, "auth"),
    sessionDir: join(root, "sessions"),
    env: { HOME: root, PATH: "/usr/bin" },
    hostSandboxAcknowledged: true,
    spawnProcess: launch as unknown as typeof spawn,
    timeoutMs: 1000,
  };
  return {
    root,
    options,
    launch,
    kill,
    emit,
    commands,
    prompted: prompted.promise,
    input: {
      cwd: root,
      prompt: "/a-task",
      signal: new AbortController().signal,
      onThread: async () => {},
    },
    assistant: (persist = true) => {
      const message = {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: `report\u2028${"x".repeat(40_000)}` }],
        timestamp: 1,
      };
      if (persist)
        appendFileSync(
          sessionFile,
          `${JSON.stringify({ type: "message", id: "assistant-1", parentId: null, timestamp: "2026-09-26T00:00:00.000Z", message })}\n`,
        );
      emit({ type: "message_end", message });
    },
    raw: (line: string) => output.write(line),
    close: () => child.emit("close", 1),
  };
}

test("persists native identity before execution, waits for settlement, and resumes only that session", async () => {
  const f = await fixture();
  const saved = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<void>();
  const runtime = createPiRuntime(f.options);
  const result = runtime.run({
    ...f.input,
    onThread: async (id) => {
      expect(id).toBe(SESSION);
      const bindingFile = join(f.options.sessionDir, `${id}.json`);
      const binding = JSON.parse(await readFile(bindingFile, "utf8"));
      expect(binding.cwd).toBe(f.root);
      const session = join(
        f.options.sessionDir,
        binding.directory,
        "session.jsonl",
      );
      expect(
        JSON.parse((await readFile(session, "utf8")).trim()),
      ).toMatchObject({
        type: "session",
        version: 3,
        id: SESSION,
        cwd: f.root,
      });
      expect((await stat(bindingFile)).mode & 0o777).toBe(0o600);
      expect((await stat(session)).mode & 0o777).toBe(0o600);
      observed.resolve();
      await saved.promise;
    },
  });
  await observed.promise;
  expect(f.commands.map((c) => c.type)).toEqual(["get_state"]);
  saved.resolve();
  await f.prompted;
  expect(f.commands[1]?.message).toBe("June coding task:\n/a-task");
  const invocation = f.launch.mock.calls[0] as NonNullable<
    (typeof f.launch.mock.calls)[0]
  >;
  expect(invocation[2].cwd).toBe(f.root);
  expect(invocation[1]).toEqual([
    "--mode",
    "rpc",
    "--provider",
    "openai",
    "--model",
    "fixture-model",
    "--session",
    expect.stringMatching(/\/run-[A-Za-z0-9]+\/session.jsonl$/),
    "--session-dir",
    expect.stringMatching(/\/run-[A-Za-z0-9]+$/),
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--tools",
    "read,bash,edit,write,grep,find,ls",
  ]);
  expect(invocation[2].env).toEqual({
    ...f.options.env,
    PI_CODING_AGENT_DIR: f.options.agentDir,
  });
  let finished = false;
  void result.then(
    () => {
      finished = true;
    },
    () => {},
  );
  f.assistant();
  f.emit({ type: "agent_end" });
  await new Promise((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);
  f.emit({ type: "agent_settled" });
  const report = await result;
  expect(report.threadId).toBe(SESSION);
  expect(report.report).toHaveLength(32_000);
  expect(report.report).toMatch(/^report\u2028/);
  expect(report.report).toMatch(/\[Report truncated\]$/);
  const resumed = runtime.run({ ...f.input, threadId: SESSION });
  await vi.waitFor(() =>
    expect(f.commands.filter((c) => c.type === "prompt")).toHaveLength(2),
  );
  expect(f.launch.mock.calls[1]?.[1]).toEqual(f.launch.mock.calls[0]?.[1]);
  f.assistant();
  f.emit({ type: "agent_settled" });
  expect((await resumed).threadId).toBe(SESSION);
  const lostAppend = runtime.run({ ...f.input, threadId: SESSION });
  const rejected = expect(lostAppend).rejects.toMatchObject({
    code: "outcome_unknown",
  });
  await vi.waitFor(() =>
    expect(f.commands.filter((c) => c.type === "prompt")).toHaveLength(3),
  );
  // Exactly the same prior message must not mask a failed append on resume.
  f.assistant(false);
  f.emit({ type: "agent_settled" });
  await rejected;
});

test("rejects unregistered, path, cross-workspace, and symlink session resumes before spawning", async () => {
  const f = await fixture();
  const runtime = createPiRuntime(f.options);
  for (const threadId of ["../../outside", "/tmp/session.jsonl", SESSION]) {
    await expect(runtime.run({ ...f.input, threadId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  }
  expect(f.launch).not.toHaveBeenCalled();
  const first = runtime.run(f.input);
  await f.prompted;
  f.assistant();
  f.emit({ type: "agent_settled" });
  await first;
  await expect(
    runtime.run({ ...f.input, cwd: tmpdir(), threadId: SESSION }),
  ).rejects.toMatchObject({ code: "session_invalid" });
  const binding = JSON.parse(
    await readFile(join(f.options.sessionDir, `${SESSION}.json`), "utf8"),
  );
  const session = join(
    f.options.sessionDir,
    binding.directory,
    "session.jsonl",
  );
  const valid = await readFile(session, "utf8");
  const header = JSON.parse(valid.split("\n")[0] as string);
  for (const invalid of [
    "",
    `${JSON.stringify({ ...header, cwd: tmpdir() })}\n`,
    `${JSON.stringify({ ...header, id: "bca1e852-a929-42a5-9366-ff491f09e948" })}\n`,
  ]) {
    await writeFile(session, invalid);
    await expect(
      runtime.run({ ...f.input, threadId: SESSION }),
    ).rejects.toMatchObject({ code: "session_invalid" });
  }
  await writeFile(session, valid);
  const bindingPath = join(f.options.sessionDir, `${SESSION}.json`);
  const copiedBinding = join(f.options.sessionDir, "copied.json");
  await writeFile(copiedBinding, JSON.stringify(binding));
  await rm(bindingPath);
  await symlink(copiedBinding, bindingPath);
  await expect(
    runtime.run({ ...f.input, threadId: SESSION }),
  ).rejects.toMatchObject({ code: "session_invalid" });
  await rm(bindingPath);
  await writeFile(bindingPath, JSON.stringify(binding));
  await rm(session);
  await symlink(join(f.options.sessionDir, `${SESSION}.json`), session);
  await expect(
    runtime.run({ ...f.input, threadId: SESSION }),
  ).rejects.toMatchObject({ code: "session_invalid" });
  expect(f.launch).toHaveBeenCalledTimes(1);
});

test("failed persistence and cancellation never dispatch a late prompt", async () => {
  const f = await fixture();
  await expect(
    createPiRuntime(f.options).run({
      ...f.input,
      onThread: async () => {
        throw new Error("private");
      },
    }),
  ).rejects.toMatchObject({ code: "thread_save_failed" });
  expect(f.commands.some((c) => c.type === "prompt")).toBe(false);
  const g = await fixture();
  const saved = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<void>();
  const controller = new AbortController();
  const result = createPiRuntime(g.options).run({
    ...g.input,
    signal: controller.signal,
    onThread: async () => {
      observed.resolve();
      await saved.promise;
    },
  });
  const rejected = expect(result).rejects.toMatchObject({ code: "cancelled" });
  await observed.promise;
  controller.abort();
  await rejected;
  saved.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  expect(g.commands.some((c) => c.type === "prompt")).toBe(false);
});

test.each([false, true])(
  "rechecks host validity after onThread without signal cancellation (invalidated: %s)",
  async (invalidate) => {
    const f = await fixture();
    const saved = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    let revision = 0;
    const frozenRevision = revision;
    const run = createPiRuntime(f.options).run({
      ...f.input,
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
    expect(f.commands.map((c) => c.type)).toEqual(["get_state"]);
    if (invalidate) revision++;
    saved.resolve();
    // Finish any submitted prompt, including an erroneous stale submission,
    // so failure demonstrates dispatch rather than relying on a timeout.
    await Promise.race([f.prompted, outcome]);
    if (f.commands.some((c) => c.type === "prompt")) {
      f.assistant();
      f.emit({ type: "agent_settled" });
    }
    const completed = await outcome;
    expect(f.input.signal.aborted).toBe(false);
    expect(f.commands.filter((c) => c.type === "prompt")).toHaveLength(
      invalidate ? 0 : 1,
    );
    if (invalidate) {
      expect(completed.value).toBeUndefined();
      expect(completed.error).toMatchObject({ code: "outcome_unknown" });
    } else {
      expect(completed.error).toBeUndefined();
      expect(completed.value?.threadId).toBe(SESSION);
    }
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.commands.at(-1)?.type).toBe("abort");
  },
);

test("holds concurrent session admission and reports unknown rather than retrying a lost run", async () => {
  const f = await fixture();
  const runtime = createPiRuntime(f.options);
  const run = runtime.run(f.input);
  const rejected = expect(run).rejects.toMatchObject({
    code: "outcome_unknown",
  });
  await f.prompted;
  await expect(
    runtime.run({ ...f.input, threadId: SESSION }),
  ).rejects.toMatchObject({ code: "session_busy" });
  f.assistant();
  f.close();
  await rejected;
  expect(f.launch).toHaveBeenCalledTimes(1);
  expect(f.commands.filter((c) => c.type === "prompt")).toHaveLength(1);
});

test("settled text is not success after shutdown errors or missing session persistence", async () => {
  for (const shutdown of [
    "nonzero",
    "stream-error",
    "partial-record",
    "missing-append",
    "forced",
    "stuck",
    "kill-error",
  ]) {
    const f = await fixture(shutdown);
    if (shutdown === "kill-error")
      f.kill.mockImplementation(() => {
        throw new Error("private");
      });
    const runtime = createPiRuntime(f.options);
    const run = runtime.run(f.input);
    const rejected = expect(run).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    await f.prompted;
    f.assistant(shutdown !== "missing-append");
    f.emit({ type: "agent_settled" });
    await rejected;
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.commands.filter((c) => c.type === "prompt")).toHaveLength(1);
    expect(f.commands.at(-1)?.type).toBe("abort");
    if (["forced", "stuck", "kill-error"].includes(shutdown)) {
      expect(f.kill.mock.calls.map(([signal]) => signal)).toEqual([
        "SIGTERM",
        "SIGKILL",
      ]);
    }
    if (["stuck", "kill-error"].includes(shutdown)) {
      await expect(
        runtime.run({ ...f.input, threadId: SESSION }),
      ).rejects.toMatchObject({ code: "session_busy" });
      expect(f.launch).toHaveBeenCalledTimes(1);
    }
  }
});

test("malformed protocol and cancellation after dispatch never return or repeat a report", async () => {
  for (const interruption of [
    "cancel",
    "malformed",
    "multibyte-oversize",
    "deadline",
  ]) {
    const f = await fixture();
    const controller = new AbortController();
    const runtime = createPiRuntime({ ...f.options, timeoutMs: 100 });
    const run = runtime.run({ ...f.input, signal: controller.signal });
    const rejected = expect(run).rejects.toMatchObject({
      code: interruption === "cancel" ? "cancelled" : "outcome_unknown",
    });
    await f.prompted;
    f.assistant();
    if (interruption === "cancel") controller.abort();
    if (interruption === "malformed") f.raw("not-json\n");
    if (interruption === "multibyte-oversize")
      f.emit({ type: "message_update", text: "é".repeat(2_100_000) });
    await rejected;
    expect(f.commands.filter((c) => c.type === "prompt")).toHaveLength(1);
    expect(f.commands.at(-1)?.type).toBe("abort");
  }
});
