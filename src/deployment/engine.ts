import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { getEnginePath } from "@rivetkit/engine-cli";

/** Call once, only after slot activation acquired the runtime lock. The slot
 * cgroup owns the engine through registry shutdown, including failed startup. */
export async function startSlotEngine(input: {
  endpoint: string;
  storagePath: string;
  onFailure(): void;
}): Promise<void> {
  const endpoint = new URL(input.endpoint);
  const port = Number(endpoint.port);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65525
  )
    throw new Error("slot_engine_endpoint_invalid");

  // Never adopt an unidentified listener. The controller already proved the
  // previous slot's entire cgroup empty before transferring the runtime lock.
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
  });
  const binary = getEnginePath();
  const environment = { ...process.env };
  // RivetKit 2.3.21 has a hard-coded 10s cold-start deadline that SIGKILLs
  // an engine still recovering its WAL. Own that one launch instead. Both JS
  // and Rust resolvers must fail exec if their later reuse probe fails: neither
  // startEngine:false nor RIVETKIT_ENGINE_SPAWN=never fences Node's native path.
  if (
    await access("/dev/null", constants.X_OK).then(
      () => true,
      () => false,
    )
  )
    throw new Error("slot_engine_spawn_fence_unavailable");
  await access("/dev/null", constants.F_OK);
  process.env.RIVET_ENGINE_BINARY = "/dev/null";
  process.env.RIVET_ENGINE_BINARY_PATH = "/dev/null";

  const root = join(input.storagePath, ".rivetkit", "var");
  const logs = join(root, "logs", "rivet-engine");
  await mkdir(logs, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "engine", "db"), { recursive: true, mode: 0o700 });
  const log = await open(
    join(logs, `slot-${process.pid}-${Date.now()}.log`),
    "ax",
    0o600,
  );
  let failed = false;
  const fail = () => {
    failed = true;
    input.onFailure();
  };
  // Exact local engine_env defaults from rivet-dev/rivet at 64416b29 (2.3.21).
  // Keep these and the resolver fence verified when upgrading the dependency.
  const child = spawn(binary, ["start"], {
    stdio: ["ignore", log.fd, log.fd],
    env: {
      ...environment,
      RIVET__AUTH__ADMIN_TOKEN:
        environment.RIVET__AUTH__ADMIN_TOKEN ?? "default",
      RIVET__GUARD__HOST: "127.0.0.1",
      RIVET__GUARD__PORT: String(port),
      RIVET__API_PEER__HOST: "127.0.0.1",
      RIVET__API_PEER__PORT: String(port + 1),
      RIVET__METRICS__HOST: "127.0.0.1",
      RIVET__METRICS__PORT: String(port + 10),
      RIVET__FILE_SYSTEM__PATH: join(root, "engine", "db"),
      RIVET__PEGBOARD__RETRY_RESET_DURATION: "100",
      RIVET__PEGBOARD__BASE_RETRY_TIMEOUT: "100",
      RIVET__PEGBOARD__RESCHEDULE_BACKOFF_MAX_EXPONENT: "1",
      RIVET__PEGBOARD__RUNNER_ELIGIBLE_THRESHOLD: "5000",
      RIVET__PEGBOARD__RUNNER_LOST_THRESHOLD: "7000",
      RIVET__PEGBOARD__ENVOY_ELIGIBLE_THRESHOLD: "5000",
      RIVET__PEGBOARD__ENVOY_LOST_THRESHOLD: "7000",
      RIVET__PEGBOARD__MIN_METADATA_POLL_INTERVAL: "1000",
      RIVET__FEATURES__GUARD_GATEWAY_V3__MODE: "on",
      RIVET__FEATURES__GUARD_GATEWAY_V3__PERCENTAGE: "100",
      RIVET__RUNTIME__WORKER_SHUTDOWN_DURATION: "1",
      RIVET__RUNTIME__GUARD_SHUTDOWN_DURATION: "1",
      RIVET__RUNTIME__FORCE_SHUTDOWN_DURATION: "2",
    },
  });
  child.once("error", fail);
  child.once("exit", fail);
  await log.close();
  const deadline = performance.now() + 60_000;
  while (!failed && performance.now() < deadline) {
    const healthy = await fetch(new URL("/health", endpoint), {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    })
      .then(async (response) => {
        if (!response.ok) return false;
        const health = (await response.json()) as {
          runtime?: string;
          version?: string;
        };
        return health.runtime === "engine" && health.version === "2.3.21";
      })
      .catch(() => false);
    if (healthy && !failed && performance.now() < deadline) return;
    await setTimeout(100);
  }
  // Observation timeout is NOT cancellation or settlement. Never kill/retry;
  // keep the child, FD9 and failed lifecycle for the designated recovery owner.
  fail();
  throw new Error("slot_engine_startup_unavailable");
}
