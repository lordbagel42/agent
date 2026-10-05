import { expect, it } from "vitest";
import type { Environment, EnvironmentProvider } from "./contracts.js";
import { EnvironmentService } from "./service.js";

it("keeps each worker's environment separate, reuses it across commands, and stops it at task end", async () => {
  const opened: string[] = [];
  const stopped: string[] = [];
  const service = new EnvironmentService({
    name: "fixture",
    binding: "fixture:original",
    persistence: "worker",
    async connect(owner) {
      opened.push(owner);
      let calls = 0;
      return {
        async exec(_command, output) {
          output("stdout", `${owner}:${++calls}`);
          return 0;
        },
        async stop() {
          stopped.push(owner);
        },
      };
    },
    async destroy() {},
    async close() {},
  });
  const run = (owner: string) =>
    service.run(
      owner,
      { action: "exec", command: "pwd" },
      new AbortController().signal,
    );
  expect((await run("alpha")).stdout).toBe("alpha:1");
  expect((await run("beta")).stdout).toBe("beta:1");
  expect((await run("alpha")).stdout).toBe("alpha:2");
  expect(opened).toEqual(["alpha", "beta"]);
  expect(service.isSettled()).toBe(false);
  await service.release("alpha");
  expect(stopped).toEqual(["alpha"]);
  await service.release("beta");
  expect(service.isSettled()).toBe(true);
});

it("holds cancelled late creation through cleanup and never executes the command", async () => {
  const created = Promise.withResolvers<Environment>();
  const stopping = Promise.withResolvers<void>();
  let executed = false;
  const provider: EnvironmentProvider = {
    name: "fixture",
    binding: "fixture:original",
    persistence: "worker",
    connect: () => created.promise,
    async destroy() {},
    async close() {},
  };
  const service = new EnvironmentService(provider);
  const controller = new AbortController();
  const running = service.run(
    "alpha",
    { action: "exec", command: "unexpected" },
    controller.signal,
  );
  controller.abort();
  created.resolve({
    async exec() {
      executed = true;
      return 0;
    },
    stop: () => stopping.promise,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(executed).toBe(false);
  expect(service.isSettled()).toBe(false);
  stopping.resolve();
  expect((await running).code).toBe("cancelled");
  await service.release("alpha");
  expect(service.isSettled()).toBe(true);
});

it("bounds UTF-8 output and fences uncertain cleanup rather than reopening or freeing capacity", async () => {
  let opened = 0;
  const service = new EnvironmentService({
    name: "fixture",
    binding: "fixture:original",
    persistence: "worker",
    async connect() {
      opened++;
      return {
        async exec(_command, output) {
          output("stdout", "🐈".repeat(3000));
          return 0;
        },
        async stop() {
          throw new Error("private provider detail");
        },
      };
    },
    async destroy() {},
    async close() {},
  });
  const command = { action: "exec" as const, command: "generate-output" };
  const result = await service.run(
    "alpha",
    command,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    status: "error",
    code: "output_limit",
    cleanup: "unknown",
  });
  expect(Buffer.byteLength(result.stdout ?? "")).toBeLessThanOrEqual(8000);
  expect(JSON.stringify(result)).not.toContain("private provider detail");
  expect(
    (await service.run("alpha", command, new AbortController().signal)).code,
  ).toBe("needs_review");
  await expect(service.release("alpha")).rejects.toThrow();
  expect(opened).toBe(1);
  expect(service.isSettled()).toBe(false);
});

it("rejects new commands as soon as task cleanup begins", async () => {
  let executed = 0;
  const stopped = Promise.withResolvers<void>();
  const service = new EnvironmentService({
    name: "fixture",
    binding: "fixture:original",
    persistence: "worker",
    async connect() {
      return {
        async exec() {
          executed++;
          return 0;
        },
        stop: () => stopped.promise,
      };
    },
    async destroy() {},
    async close() {},
  });
  const command = { action: "exec" as const, command: "work" };
  const signal = new AbortController().signal;
  await service.run("worker", command, signal);
  const releasing = service.release("worker");
  expect((await service.run("worker", command, signal)).code).toBe("busy");
  expect(executed).toBe(1);
  stopped.resolve();
  await releasing;
  expect(service.isSettled()).toBe(true);
});

it("revalidates authorization after a slow VM boot before executing", async () => {
  const boot = Promise.withResolvers<Environment>();
  let authorized = true;
  let executed = false;
  let stopped = false;
  const service = new EnvironmentService({
    name: "fixture",
    binding: "fixture:original",
    persistence: "worker",
    connect: () => boot.promise,
    async destroy() {},
    async close() {},
  });
  const running = service.run(
    "worker",
    { action: "exec", command: "work" },
    new AbortController().signal,
    () => authorized,
  );
  authorized = false;
  boot.resolve({
    async exec() {
      executed = true;
      return 0;
    },
    async stop() {
      stopped = true;
    },
  });
  expect(await running).toMatchObject({
    status: "error",
    code: "cancelled",
    cleanup: "confirmed",
  });
  expect(executed).toBe(false);
  expect(stopped).toBe(true);
  await service.release("worker");
});
