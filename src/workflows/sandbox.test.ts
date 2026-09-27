import { expect, it } from "vitest";
import { runWorkflowSource } from "./sandbox.js";

it("runs ordinary JS through the capability bridge without host files, credentials or network", async () => {
  process.env.JUNE_WORKFLOW_TEST_SECRET = "host-only-canary";
  const calls: unknown[] = [];
  try {
    const value = await runWorkflowSource(
      `const rows = input.rows.filter(x => x > 3);
       const total = await workflow.step("sum", "sum", {rows});
       return {total, env: ({}).constructor.constructor("return typeof process")(), fetch: typeof fetch, fixed: new Date().constructor.now(), hidden: typeof NativeDate};`,
      { rows: [2, 7, 11] },
      123456,
      async (operation) => {
        calls.push(operation);
        return 18;
      },
      new AbortController().signal,
    );
    expect(value).toEqual({
      total: 18,
      env: "undefined",
      fetch: "undefined",
      fixed: 123456,
      hidden: "undefined",
    });
    expect(calls).toEqual([
      { kind: "step", name: "sum", tool: "sum", args: { rows: [7, 11] } },
    ]);
  } finally {
    delete process.env.JUNE_WORKFLOW_TEST_SECRET;
  }
}, 30_000);

it("preserves native suspension even when guest code tries to catch it and continue", async () => {
  const suspension = new Error("native suspension identity");
  let calls = 0;
  await expect(
    runWorkflowSource(
      `try { await workflow.sleep("later", 1000); } catch {}
     await workflow.step("must-not-run", "send", {}); return "wrong";`,
      null,
      0,
      async () => {
        calls++;
        throw suspension;
      },
      new AbortController().signal,
    ),
  ).rejects.toBe(suspension);
  expect(calls).toBe(1);
}, 30_000);

it("bounds computation and rejects overlapping primitives instead of corrupting a journal", async () => {
  await expect(
    runWorkflowSource(
      "while (true) {}",
      null,
      0,
      async () => null,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  const calls: string[] = [];
  await expect(
    runWorkflowSource(
      `await Promise.all([workflow.step("a", "one", {}), workflow.step("b", "two", {})]);`,
      null,
      0,
      async (operation) => {
        calls.push(operation.name);
        await new Promise((resolve) => setTimeout(resolve, 80));
        return null;
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("concurrent");
  // Guest RPC delivery order is unspecified for illegal overlapping calls.
  expect(calls).toHaveLength(1);
  const controller = new AbortController();
  let settled = false;
  await expect(
    runWorkflowSource(
      'await workflow.step("pending","one",{});',
      null,
      0,
      async () => {
        controller.abort(new Error("cancelled"));
        await new Promise((resolve) => setTimeout(resolve, 30));
        settled = true;
        return null;
      },
      controller.signal,
    ),
  ).rejects.toThrow("cancelled");
  expect(settled).toBe(true);
}, 30_000);
