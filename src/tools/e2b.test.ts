import { Sandbox } from "@e2b/code-interpreter";
import { afterEach, expect, it, vi } from "vitest";
import { createE2BProvider, formatE2BResult } from "./e2b.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const request = { language: "python" as const, code: "print(7 * 9)" };

it("refuses ambient SDK endpoint/debug overrides rather than risking local execution or credential disclosure", async () => {
  for (const name of [
    "E2B_DEBUG",
    "E2B_API_URL",
    "E2B_SANDBOX_URL",
    "E2B_DOMAIN",
  ]) {
    vi.stubEnv(
      name,
      name === "E2B_DEBUG" ? "true" : "https://unexpected.invalid",
    );
    const provider = createE2BProvider({ apiKey: "fixture-secret" });
    expect(provider.available).toBe(false);
    expect(await provider.run(request)).toMatchObject({
      status: "unavailable",
      code: "unsupported_environment",
      cleanup: "not_needed",
    });
    vi.unstubAllEnvs();
  }
});

it("keeps serialized chat receipts inert and small without losing outcome or cleanup", () => {
  for (const output of [
    "x".repeat(5000),
    "\u0000".repeat(7900),
    "<@U123> <https://example.com|click> ```",
  ]) {
    const text = formatE2BResult({
      status: "error",
      code: "execution_error",
      cleanup: "unknown",
      stdout: [output],
      stderr: [],
      results: [],
    });
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).not.toMatch(/[<>`]/);
    expect(JSON.parse(text)).toMatchObject({
      status: "error",
      code: "execution_error",
      cleanup: "unknown",
    });
    if (output.length > 3000) expect(JSON.parse(text).outputOmitted).toBe(true);
    else expect(JSON.parse(text).stdout).toEqual([output]);
  }
});

it("runs in a fresh isolated sandbox, returns bounded text and always kills it", async () => {
  const kill = vi.fn(async () => true);
  const runCode = vi.fn(async (_code, options) => {
    options.onStdout({ line: "63\n" });
    options.onResult({ text: "'done'" });
    return { error: undefined };
  });
  const create = vi
    .spyOn(Sandbox, "create")
    .mockResolvedValue({ runCode, kill } as unknown as Sandbox);
  const provider = createE2BProvider({ apiKey: "fixture-secret" });
  expect(await provider.run(request)).toEqual({
    status: "ok",
    stdout: ["63\n"],
    stderr: [],
    results: ["'done'"],
    cleanup: "confirmed",
  });
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      apiKey: "fixture-secret",
      timeoutMs: 60000,
      retries: 0,
      allowInternetAccess: false,
      network: { allowPublicTraffic: false },
      envs: {},
    }),
  );
  expect(kill).toHaveBeenCalledTimes(1);
  await provider.run(request);
  expect(create).toHaveBeenCalledTimes(2);
  expect(kill).toHaveBeenCalledTimes(2);
});

it("rejects invalid/disabled/cancelled requests before creation and never leaks provider errors", async () => {
  const create = vi
    .spyOn(Sandbox, "create")
    .mockRejectedValue(new Error("fixture-secret"));
  expect((await createE2BProvider({}).run(request)).status).toBe("unavailable");
  const provider = createE2BProvider({ apiKey: "fixture-secret" });
  expect(
    (await provider.run({ ...request, code: "x".repeat(24001) })).status,
  ).toBe("error");
  expect((await provider.run(request, AbortSignal.abort())).status).toBe(
    "error",
  );
  expect(create).not.toHaveBeenCalled();
  const failed = await provider.run(request);
  expect(failed).toMatchObject({
    status: "error",
    code: "provider_failure",
    cleanup: "unknown",
  });
  expect(JSON.stringify(failed)).not.toContain("fixture-secret");
  expect(create).toHaveBeenCalledTimes(1);
});

it("stops on excessive output and distinguishes remote errors and unconfirmed cleanup", async () => {
  const kill = vi.fn(async (): Promise<boolean> => {
    throw new Error("private details");
  });
  const runCode = vi.fn(async (_code, options) => {
    options.onStdout({ line: "🦆".repeat(2001) });
    return {};
  });
  vi.spyOn(Sandbox, "create").mockResolvedValue({
    runCode,
    kill,
  } as unknown as Sandbox);
  const provider = createE2BProvider({ apiKey: "fixture" });
  expect(await provider.run(request)).toMatchObject({
    status: "error",
    code: "output_limit",
    cleanup: "unknown",
    stdout: [],
  });
  expect(kill).toHaveBeenCalledTimes(1);
  // An uncertain teardown retains the local capacity slot until the lifetime backstop.
  expect(await provider.run(request)).toMatchObject({
    status: "unavailable",
    code: "busy",
  });
  const another = createE2BProvider({ apiKey: "fixture" });
  runCode.mockImplementation(async () => ({
    error: {
      name: "ValueError",
      value: "bad input",
      traceback: "unneeded trace",
    },
  }));
  kill.mockImplementation(async () => true);
  expect(await another.run(request)).toMatchObject({
    status: "error",
    code: "execution_error",
    error: "ValueError: bad input",
    cleanup: "confirmed",
  });
});

it("cancels creation without running late code and cleans up a late sandbox", async () => {
  const pending = Promise.withResolvers<Sandbox>();
  const kill = vi.fn(async () => true);
  const runCode = vi.fn();
  vi.spyOn(Sandbox, "create").mockReturnValue(pending.promise);
  const provider = createE2BProvider({ apiKey: "fixture" });
  const controller = new AbortController();
  const result = provider.run(request, controller.signal);
  controller.abort();
  expect(await result).toMatchObject({
    status: "error",
    code: "cancelled",
    cleanup: "unknown",
  });
  expect(await provider.run(request)).toMatchObject({
    status: "unavailable",
    code: "busy",
  });
  pending.resolve({ runCode, kill } as unknown as Sandbox);
  await expect.poll(() => kill.mock.calls.length).toBe(1);
  expect(runCode).not.toHaveBeenCalled();
});

it.for(["cancelled", "timeout"] as const)(
  "kills running code on %s and ignores late output",
  async (code) => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<{ error?: undefined }>();
    const kill = vi.fn(async () => false);
    let emit: ((output: { line: string }) => void) | undefined;
    const runCode = vi.fn(async (_code, options) => {
      emit = options.onStdout;
      return pending.promise;
    });
    vi.spyOn(Sandbox, "create").mockResolvedValue({
      runCode,
      kill,
    } as unknown as Sandbox);
    const controller = new AbortController();
    const result = createE2BProvider({ apiKey: "fixture" }).run(
      request,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(runCode).toHaveBeenCalledTimes(1);
    if (code === "cancelled") controller.abort();
    else await vi.advanceTimersByTimeAsync(45000);
    const outcome = await result;
    expect(outcome).toMatchObject({
      status: "error",
      code,
      cleanup: "confirmed",
      stdout: [],
    });
    expect(kill).toHaveBeenCalledTimes(1);
    emit?.({ line: "late output" });
    pending.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome.stdout).toEqual([]);
  },
);
