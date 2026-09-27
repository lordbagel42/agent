import { expect, test } from "vitest";
import { createLifecycle } from "./lifecycle.js";

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
