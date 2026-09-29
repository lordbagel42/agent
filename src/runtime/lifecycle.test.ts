import { expect, test, vi } from "vitest";
import { createLifecycle } from "./lifecycle.js";

test("first failure is attributed without logging abort content or weakening the latch", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const lifecycle = createLifecycle();
    const signal = new AbortController();
    const release = await lifecycle.enter(signal.signal);
    signal.abort(new Error("private message must not be logged"));
    lifecycle.fail();
    release();
    expect(log).toHaveBeenCalledTimes(1);
    const receipt = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(receipt.event).toBe("lifecycle_failed");
    expect(receipt.kind).toBe("lease_abort");
    expect(receipt.active).toBe(1);
    expect(receipt.admittedAt).toEqual(expect.any(Number));
    expect(receipt.admissionStack).toContain("lifecycle.test.ts");
    expect(JSON.stringify(receipt)).not.toContain("private message");
    lifecycle.resume();
    expect(lifecycle.ready).toBe(false);
    expect(await lifecycle.drain()).toBe(false);
  } finally {
    log.mockRestore();
  }
});

test("drain waits for admitted work and holds queued turns without cancelling them", async () => {
  const lifecycle = createLifecycle();
  const release = await lifecycle.enter(new AbortController().signal);
  const draining = lifecycle.drain();
  expect(lifecycle.drain()).toBe(draining);
  expect(lifecycle.tryEnter()).toBeUndefined();
  const queued = lifecycle.enter(new AbortController().signal);
  release();
  release();
  expect(await draining).toBe(true);
  expect(lifecycle.active).toBe(0);
  expect(lifecycle.ready).toBe(false);
  lifecycle.resume();
  const finish = await queued;
  expect(lifecycle.active).toBe(1);
  finish();
  expect(lifecycle.active).toBe(0);
});

test("a timed-out drain resumes admission but retains unsettled work", async () => {
  const lifecycle = createLifecycle();
  const controller = new AbortController();
  const release = await lifecycle.enter(controller.signal);
  expect(await lifecycle.drain(5)).toBe(false);
  expect(controller.signal.aborted).toBe(false);
  expect(lifecycle.ready).toBe(true);
  expect(lifecycle.active).toBe(1);
  const next = lifecycle.tryEnter();
  expect(next).toBeTypeOf("function");
  next?.();
  release();
  expect(await lifecycle.drain()).toBe(true);
});

test("forced aborts cannot certify raw work as drained; waiting aborts admit nothing", async () => {
  const lifecycle = createLifecycle();
  const controller = new AbortController();
  const release = await lifecycle.enter(controller.signal);
  const draining = lifecycle.drain();
  const waiting = new AbortController();
  const queued = lifecycle.enter(waiting.signal);
  waiting.abort();
  await expect(queued).rejects.toThrow();
  expect(lifecycle.active).toBe(1);
  controller.abort();
  release();
  expect(await draining).toBe(false);
  lifecycle.resume();
  expect(lifecycle.ready).toBe(false);
  expect(await lifecycle.drain()).toBe(false);
  expect(lifecycle.tryEnter()).toBeUndefined();
});

test("drain checks durable settlement only behind an idle fence and fails closed", async () => {
  let settled = false;
  let unreadable = false;
  const checks: { active: number; admitted: boolean }[] = [];
  const lifecycle = createLifecycle(async () => {
    const release = lifecycle.tryEnter();
    checks.push({ active: lifecycle.active, admitted: !!release });
    release?.();
    if (unreadable) throw new Error("unreadable lease");
    return settled;
  });
  const release = lifecycle.tryEnter();
  const draining = lifecycle.drain();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(checks).toEqual([]);
  release?.();
  expect(await draining).toBe(false);
  expect(lifecycle.ready).toBe(true);
  unreadable = true;
  expect(await lifecycle.drain()).toBe(false);
  expect(lifecycle.ready).toBe(true);
  unreadable = false;
  settled = true;
  expect(await lifecycle.drain()).toBe(true);
  expect(lifecycle.ready).toBe(false);
  expect(checks).toEqual([
    { active: 0, admitted: false },
    { active: 0, admitted: false },
    { active: 0, admitted: false },
  ]);
});

test.for(["resume", "timeout"] as const)(
  "a durable check cannot certify a newer drain after %s",
  async (stop) => {
    const old = Promise.withResolvers<boolean>();
    const current = Promise.withResolvers<boolean>();
    let checks = 0;
    const lifecycle = createLifecycle(() =>
      ++checks === 1 ? old.promise : current.promise,
    );
    const first = lifecycle.drain(stop === "timeout" ? 5 : 4000);
    await expect.poll(() => checks).toBe(1);
    if (stop === "resume") lifecycle.resume();
    expect(await first).toBe(false);
    const second = lifecycle.drain();
    await expect.poll(() => checks).toBe(2);
    old.resolve(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lifecycle.drain()).toBe(second);
    expect(lifecycle.ready).toBe(false);
    current.resolve(false);
    expect(await second).toBe(false);
    expect(lifecycle.ready).toBe(true);
  },
);
