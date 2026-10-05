import { createHash } from "node:crypto";
import type { JsBoxlite } from "@boxlite-ai/boxlite";
import type { BoxLiteHost } from "./boxlite-host.js";
import {
  EnvironmentCapacityError,
  type EnvironmentProvider,
} from "./contracts.js";

type NativeRuntime = InstanceType<typeof JsBoxlite>;
type NativeBox = NonNullable<Awaited<ReturnType<NativeRuntime["get"]>>>;
type Execution = Awaited<ReturnType<NativeBox["exec"]>>;
type Box = Pick<NativeBox, "start" | "stop"> & {
  info(): Promise<{
    id: string;
    state: { status: string; running: boolean; pid?: number };
  }>;
  exec(
    ...args: Parameters<NativeBox["exec"]>
  ): Promise<Pick<Execution, "stdout" | "stderr" | "wait">>;
};
type Runtime = Pick<NativeRuntime, "listInfo" | "remove" | "shutdown"> & {
  get(name: string): Promise<Box | null>;
  create(
    options: Parameters<NativeRuntime["create"]>[0],
    name: string,
  ): Promise<Box>;
};

/** Native SDK is loaded only by the enabled host's composition root. */
export function createBoxLiteProvider(
  runtime: Runtime,
  config: {
    image?: string;
    rootfsPath?: string;
    allowedHosts: string[];
  },
  host: BoxLiteHost,
): EnvironmentProvider {
  const options = {
    image: config.image,
    rootfsPath: config.rootfsPath,
    cpus: 2,
    memoryMib: 2048,
    diskSizeGb: 8,
    user: "1000:1000",
    workingDir: "/workspace",
    autoDelete: 0,
    autoResume: false,
    detach: false,
    env: [],
    volumes: [],
    ports: [],
    secrets: [],
    network: {
      outbound: config.allowedHosts.length
        ? { mode: "enabled" as const, allowNet: config.allowedHosts }
        : { mode: "disabled" as const },
      inbound: { mode: "disabled" as const },
    },
  };
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const prefix = (owner: string) => `june-${hash(owner).slice(0, 32)}-`;
  const policy = hash(JSON.stringify(options)).slice(0, 16);
  const pending = new Set<string>();
  let creation = Promise.resolve();
  return {
    name: "boxlite",
    binding: host.binding,
    persistence: "worker",
    async connect(owner) {
      const name = `${prefix(owner)}${policy}`;
      if (pending.has(name)) throw new Error("Environment already admitted");
      pending.add(name);
      // Serialize metadata admission, not VM boots or commands.
      const opening = creation.then(async () => {
        const box = await runtime.get(name);
        if (!box) {
          if ((await runtime.listInfo()).length >= 128) {
            pending.delete(name);
            throw new EnvironmentCapacityError(
              "Retained environment capacity exhausted",
            );
          }
          return runtime.create(options, name);
        }
        const { state } = await box.info();
        if (
          state.running ||
          state.pid ||
          state.status.toLowerCase() !== "stopped"
        )
          throw new Error("Existing environment requires reconciliation");
        return box;
      });
      creation = opening.then(
        () => {},
        () => {},
      );
      const instance = await opening;
      let verifyStopped: () => Promise<void>;
      try {
        // Capture the concrete ID before any guest code can write task data.
        await host.retain(owner, (await instance.info()).id);
        await instance.start();
        const info = await instance.info();
        verifyStopped = await host.witness(info.id, info.state.pid);
      } catch {
        // No containment witness: stop best-effort but retain the durable fence.
        await instance.stop();
        throw new Error("Environment start failed");
      }
      let stopping: Promise<void> | undefined;
      return {
        async exec(command, output) {
          const execution = await instance.exec(
            "/bin/bash",
            ["-lc", command],
            [],
            false,
            "1000:1000",
            30,
            "/workspace",
          );
          const drain = async (stream: "stdout" | "stderr") => {
            const reader = await execution[stream]();
            for (;;) {
              const text = await reader.next();
              if (text === null) return;
              output(stream, text);
            }
          };
          // Join all readers even when one fails; no orphaned promise or stream.
          const settled = await Promise.allSettled([
            execution.wait(),
            drain("stdout"),
            drain("stderr"),
          ]);
          if (settled.some((result) => result.status === "rejected"))
            throw new Error("Environment command failed");
          const result = settled[0];
          if (
            result?.status !== "fulfilled" ||
            !result.value ||
            // 0.10.5 uses -1 without errorMessage when the Wait RPC fails.
            result.value.exitCode < 0 ||
            result.value.errorMessage
          )
            throw new Error("Environment command outcome unknown");
          return result.value.exitCode;
        },
        stop() {
          stopping ??= (async () => {
            await instance.stop();
            await verifyStopped();
            pending.delete(name);
          })();
          return stopping;
        },
      };
    },
    async destroy(owner) {
      // Revoke every policy generation, not only today's configured image.
      if ([...pending].some((name) => name.startsWith(prefix(owner))))
        throw new Error("Environment cleanup unconfirmed");
      const boxes = await runtime.listInfo();
      for (const box of boxes)
        if (box.name?.startsWith(prefix(owner))) {
          if (
            box.state.running ||
            box.state.pid ||
            !["stopped", "configured"].includes(box.state.status.toLowerCase())
          )
            throw new Error(
              "Environment destruction requires confirmed teardown",
            );
          await host.retain(owner, box.id);
        }
      for (const id of await host.retained(owner)) {
        const box = boxes.find((box) => box.id === id);
        if (box) {
          if (!box.name?.startsWith(prefix(owner)))
            throw new Error("Environment ownership changed");
          await runtime.remove(id, false);
        }
        // SDK deletion may have removed metadata while silently leaving disk bytes.
        await host.confirmRemoved(owner, id);
      }
    },
    async close() {
      if (pending.size) throw new Error("Environment cleanup unconfirmed");
      await runtime.shutdown(-1);
      await host.close();
    },
  };
}
