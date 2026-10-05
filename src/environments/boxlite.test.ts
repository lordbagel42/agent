import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createBoxLiteProvider } from "./boxlite.js";
import { openBoxLiteHost } from "./boxlite-host.js";
import { EnvironmentService } from "./service.js";

it("binds persistent VM names to worker and policy, denies ambient access, and drains both output streams", async () => {
  const created: Array<{ options: unknown; name: string }> = [];
  const commands: unknown[][] = [];
  let exitCode = 7;
  const box = {
    id: "fixture",
    name: null,
    async info() {
      return {
        id: "fixture",
        state: { status: "running", running: true, pid: 431 },
      };
    },
    async start() {},
    async stop() {},
    async exec(...args: unknown[]) {
      commands.push(args);
      let out = 0;
      let err = 0;
      return {
        async stdout() {
          return {
            async next() {
              return out++ ? null : "hello\n";
            },
          };
        },
        async stderr() {
          return {
            async next() {
              return err++ ? null : "warning\n";
            },
          };
        },
        async wait() {
          return { exitCode };
        },
      };
    },
  };
  const runtime = {
    async get() {
      return null;
    },
    async listInfo() {
      return [];
    },
    async create(options: unknown, name: string) {
      created.push({ options, name });
      return box;
    },
    async remove() {},
    async shutdown() {},
  };
  const config = { rootfsPath: "/images/reviewed", allowedHosts: [] };
  const dead = Promise.withResolvers<void>();
  let hostClosed = false;
  const host = {
    binding: "boxlite:fixture",
    async retain() {},
    async retained() {
      return [];
    },
    async confirmRemoved() {},
    async witness(id: string, pid: number | undefined) {
      expect([id, pid]).toEqual(["fixture", 431]);
      return () => dead.promise;
    },
    async close() {
      hostClosed = true;
    },
  };
  const provider = createBoxLiteProvider(runtime, config, host);
  const alpha = await provider.connect("alpha");
  const beta = await provider.connect("beta");
  expect(created[0]?.name).not.toBe(created[1]?.name);
  expect(created[0]?.options).toMatchObject({
    rootfsPath: "/images/reviewed",
    user: "1000:1000",
    workingDir: "/workspace",
    autoDelete: 0,
    detach: false,
    env: [],
    volumes: [],
    ports: [],
    secrets: [],
    network: { outbound: { mode: "disabled" }, inbound: { mode: "disabled" } },
  });
  const output: string[] = [];
  expect(
    await alpha.exec("printf 'hello'; exit 7", (stream, text) =>
      output.push(`${stream}:${text}`),
    ),
  ).toBe(7);
  expect(output.sort()).toEqual(["stderr:warning\n", "stdout:hello\n"]);
  expect(commands.at(-1)).toEqual([
    "/bin/bash",
    ["-lc", "printf 'hello'; exit 7"],
    [],
    false,
    "1000:1000",
    30,
    "/workspace",
  ]);
  const stopping = alpha.stop();
  // SDK stop has resolved, but the witnessed process tree is still populated.
  await expect(provider.close()).rejects.toThrow();
  expect(hostClosed).toBe(false);
  dead.resolve();
  await stopping;
  const again = await provider.connect("alpha");
  expect(created[0]?.name).toBe(created[2]?.name);
  await again.stop();
  await beta.stop();
  // BoxLite fulfills wait with -1 (no errorMessage) when the Wait RPC fails.
  exitCode = -1;
  const service = new EnvironmentService(provider);
  const command = { action: "exec" as const, command: "uncertain-effect" };
  const signal = new AbortController().signal;
  expect(await service.run("unknown", command, signal)).toMatchObject({
    status: "error",
    code: "provider_failure",
    cleanup: "confirmed",
  });
  expect((await service.run("unknown", command, signal)).code).toBe(
    "needs_review",
  );
  await service.release("unknown");
  await provider.close();
  expect(hostClosed).toBe(true);
  await createBoxLiteProvider(
    runtime,
    {
      ...config,
      allowedHosts: ["example.com"],
    },
    host,
  ).connect("alpha");
  expect(created.at(-1)?.name).not.toBe(created[0]?.name);
});

it("reserves the last retained-box slot across concurrent worker creation", async () => {
  type Runtime = Parameters<typeof createBoxLiteProvider>[0];
  const info = {
    id: "fixture",
    state: { status: "stopped", running: false },
    createdAt: "2026-10-05T00:00:00Z",
    image: "fixture",
    cpus: 2,
    memoryMib: 2048,
    network: null,
    autoStop: 0,
    autoDelete: 0,
    autoResume: false,
    healthStatus: { state: "None" as const, failures: 0 },
  };
  const retained = Array.from({ length: 127 }, (_, i) => ({
    ...info,
    id: `retained-${i}`,
  }));
  let created = 0;
  const runtime: Runtime = {
    async get() {
      return null;
    },
    async listInfo() {
      return [...retained];
    },
    async create() {
      created++;
      retained.push(info);
      return {
        async info() {
          return {
            ...info,
            state: { status: "running", running: true, pid: 431 },
          };
        },
        async start() {},
        async stop() {},
        async exec() {
          throw new Error("No commands requested");
        },
      };
    },
    async remove() {},
    async shutdown() {},
  };
  const provider = createBoxLiteProvider(
    runtime,
    { rootfsPath: "/images/reviewed", allowedHosts: [] },
    {
      binding: "boxlite:fixture",
      async retain() {},
      async retained() {
        return [];
      },
      async confirmRemoved() {},
      async witness() {
        return async () => {};
      },
      async close() {},
    },
  );
  const results = await Promise.allSettled([
    provider.connect("alpha"),
    provider.connect("beta"),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(created).toBe(1);
  const service = new EnvironmentService(provider);
  expect(
    await service.run(
      "gamma",
      { action: "exec", command: "work" },
      new AbortController().signal,
    ),
  ).toMatchObject({
    status: "unavailable",
    code: "busy",
  });
  await service.release("gamma");
  expect(service.isSettled()).toBe(true);
  for (const result of results)
    if (result.status === "fulfilled") await result.value.stop();
  await provider.close();
});

it("retains deletion targets across restart when SDK removal drops metadata but leaves a disk", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "june-vm-deletion-"));
  try {
    const boxDirectory = join(directory, "boxes", "box-a");
    const info = {
      id: "box-a",
      name: "",
      state: {
        status: "stopped",
        running: false,
        pid: undefined as number | undefined,
      },
      createdAt: "2026-10-05T00:00:00Z",
      image: "fixture",
      cpus: 2,
      memoryMib: 2048,
      network: null,
      autoStop: 0,
      autoDelete: 0,
      autoResume: false,
      healthStatus: { state: "None" as const, failures: 0 },
    };
    let recorded = false;
    const runtime = {
      async get() {
        return null;
      },
      async listInfo() {
        return recorded ? [info] : [];
      },
      async create(_options: unknown, name: string) {
        info.name = name;
        recorded = true;
        return {
          async info() {
            return info;
          },
          async start() {
            info.state = { status: "running", running: true, pid: 431 };
            await fs.mkdir(boxDirectory, { recursive: true });
            await fs.writeFile(
              join(boxDirectory, "disk.qcow2"),
              "private fixture",
            );
          },
          async stop() {
            info.state = { status: "stopped", running: false, pid: undefined };
          },
          async exec() {
            throw new Error("No commands requested");
          },
        };
      },
      async remove() {
        recorded = false;
      },
      async shutdown() {},
    };
    const host = await openBoxLiteHost(directory);
    const provider = createBoxLiteProvider(
      runtime,
      { rootfsPath: "/image", allowedHosts: [] },
      {
        ...host,
        async witness() {
          return async () => {};
        },
      },
    );
    const environment = await provider.connect("owner");
    await environment.stop();
    await expect(provider.destroy("owner")).rejects.toThrow();
    expect(recorded).toBe(false);
    await provider.close();

    const reopened = await openBoxLiteHost(directory);
    const recovered = createBoxLiteProvider(
      runtime,
      { rootfsPath: "/image", allowedHosts: [] },
      reopened,
    );
    expect(recovered.binding).toBe(provider.binding);
    await expect(recovered.destroy("owner")).rejects.toThrow();
    expect(await fs.readFile(join(boxDirectory, "disk.qcow2"), "utf8")).toBe(
      "private fixture",
    );
    // Simulate separately authorized operator reconciliation of this disposable fixture.
    await fs.rm(boxDirectory, { recursive: true });
    await recovered.destroy("owner");
    await recovered.destroy("owner");
    await recovered.close();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
