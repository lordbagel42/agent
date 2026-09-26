import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { setupTest as setupRivetTest } from "rivetkit/test";
import type { TestContext } from "vitest";
import type { JuneRegistry } from "../src/runtime/registry.js";

async function listen(port: number): Promise<Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

export async function freeEnginePort(): Promise<number> {
  for (;;) {
    const sockets = [await listen(0)];
    const address = sockets[0]?.address();
    if (!address || typeof address === "string")
      throw new Error("No test port");
    try {
      if (address.port > 65525) continue;
      sockets.push(await listen(address.port + 1));
      sockets.push(await listen(address.port + 10));
      return address.port;
    } catch {
      // Rivet's peer/metrics ports must also be free; try a different triple.
    } finally {
      await Promise.all(
        sockets.map(
          (socket) =>
            new Promise<void>((resolve) => socket.close(() => resolve())),
        ),
      );
    }
  }
}

export async function stopTestEngine(directory: string, port: number) {
  const stampPath = join(directory, ".rivetkit/var/engine/runtime.json");
  const raw = await readFile(stampPath, "utf8").catch(() => undefined);
  if (!raw) return;
  const stamp = JSON.parse(raw) as { pid: number; endpoint: string };
  if (stamp.endpoint !== `http://127.0.0.1:${port}`)
    throw new Error("Unexpected test engine endpoint");
  try {
    process.kill(stamp.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(stamp.pid, 0);
    } catch {
      return;
    }
    const status = await readFile(`/proc/${stamp.pid}/status`, "utf8").catch(
      () => "",
    );
    if (/State:\s+Z/.test(status)) return;
    await setTimeout(50);
  }
  throw new Error("Test engine did not stop; retaining its data");
}

/** Real engine, disposable disk and loopback ports; never reuse a developer's engine. */
export async function setupTest(t: TestContext, registry: JuneRegistry) {
  const directory = await mkdtemp(join(tmpdir(), "june-rivet-"));
  const previousStorage = process.env.RIVETKIT_STORAGE_PATH;
  process.env.RIVETKIT_STORAGE_PATH = directory;
  const port = await freeEnginePort();
  Object.assign(registry.config, {
    namespace: "default",
    token: "default",
    enginePort: port,
    engineHost: "127.0.0.1",
    startEngine: true,
    startServices: false,
    envoy: { poolName: "default" },
  });
  t.onTestFinished(async () => {
    await registry.shutdown();
    await stopTestEngine(directory, port);
    try {
      await rm(directory, { recursive: true, force: true });
    } finally {
      if (previousStorage === undefined)
        delete process.env.RIVETKIT_STORAGE_PATH;
      else process.env.RIVETKIT_STORAGE_PATH = previousStorage;
    }
  });
  return setupRivetTest(t, registry);
}
