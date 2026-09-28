import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { fstatSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

const lockPath = "/run/june-runtime/owner.lock";
const lockFd = 9;

/** Validate before opening any mutable state, including in legacy mode. */
export function validateSlotLauncher(input: {
  enabled: boolean;
  revision?: string;
  releaseRoot: string;
}): { host: "127.0.0.1"; port: 3081 | 3082 } | undefined {
  const slot = process.env.JUNE_SLOT;
  const fd = process.env.JUNE_RUNTIME_LOCK_FD;
  if (!input.enabled) {
    if (slot !== undefined || fd !== undefined)
      throw new Error("Slot launcher requires blueGreen configuration");
    return undefined;
  }
  if (
    (slot !== "blue" && slot !== "green") ||
    fd !== "9" ||
    !input.revision ||
    !/^[a-f0-9]{40}$/.test(input.revision) ||
    input.releaseRoot !== `/opt/june/releases/${input.revision}` ||
    realpathSync(process.cwd()) !== input.releaseRoot
  )
    throw new Error("Invalid immutable slot launcher identity");
  const inherited = fstatSync(lockFd);
  const provisioned = lstatSync(lockPath);
  const flags = /^flags:\s+([0-7]+)$/m.exec(
    readFileSync(`/proc/self/fdinfo/${lockFd}`, "utf8"),
  );
  if (
    !inherited.isFile() ||
    !provisioned.isFile() ||
    inherited.nlink !== 1 ||
    inherited.dev !== provisioned.dev ||
    inherited.ino !== provisioned.ino ||
    realpathSync(`/proc/self/fd/${lockFd}`) !== lockPath ||
    !flags?.[1] ||
    (Number.parseInt(flags[1], 8) & 3) !== 2
  )
    throw new Error("Invalid inherited runtime lock");
  return { host: "127.0.0.1", port: slot === "blue" ? 3081 : 3082 };
}

/** Pass the SAME open file description, never reopen the lock pathname. */
export async function acquireRuntimeLock(fd = lockFd): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/flock", ["-n", "9"], {
      stdio: [
        "ignore",
        "ignore",
        "ignore",
        "ignore",
        "ignore",
        "ignore",
        "ignore",
        "ignore",
        "ignore",
        fd,
      ],
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(true);
      else if (code === 1) resolve(false);
      else reject(new Error("Runtime lock acquisition failed"));
    });
  });
}

export function createStandbyApp(input: {
  revision: string;
  token: string;
  acquire(): Promise<boolean>;
  activated(): void;
}) {
  if (!/^[a-f0-9]{40}$/.test(input.revision) || input.token.length < 32)
    throw new Error("Standby requires a release and deployment credential");
  let state: "standby" | "acquiring" | "activated" = "standby";
  const app = new Hono();
  app.onError((_error, c) => c.json({ error: "activation_failed" }, 503));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/health", (c) =>
    c.json({ revision: input.revision, ready: false }, 503),
  );
  app.use("/operator/*", async (c, next) => {
    const expected = Buffer.from(`Bearer ${input.token}`);
    const supplied = Buffer.from(c.req.header("authorization") ?? "");
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.use("*", bodyLimit({ maxSize: 1024 }));
  app.get("/operator/deployment/standby", (c) =>
    c.json({ revision: input.revision, standby: state === "standby" }),
  );
  app.post("/operator/deployment/activate", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("revision" in body) ||
      body.revision !== input.revision
    )
      return c.json({ error: "revision_mismatch" }, 409);
    if (state !== "standby")
      return c.json({ error: "activation_already_started" }, 409);
    state = "acquiring";
    // An uncertain lock operation is not retried in this process.
    if (!(await input.acquire())) {
      state = "standby";
      return c.json({ error: "runtime_owned" }, 409);
    }
    state = "activated";
    // Let the HTTP adapter send the receipt before closing its listener.
    setImmediate(input.activated);
    return c.json({ revision: input.revision, activated: true });
  });
  return app;
}

/** Resolves only after ownership and listener close; FD9 lives until process exit. */
export async function awaitSlotActivation(input: {
  revision: string;
  token: string;
  host: "127.0.0.1";
  port: 3081 | 3082;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      server.close();
      process.exit(0);
    };
    const app = createStandbyApp({
      ...input,
      acquire: () => acquireRuntimeLock(),
      activated: () => {
        server.close((error) => {
          process.removeListener("SIGTERM", stop);
          process.removeListener("SIGINT", stop);
          if (error) reject(error);
          else resolve();
        });
        if ("closeIdleConnections" in server) server.closeIdleConnections();
      },
    });
    const server = serve({
      fetch: app.fetch,
      hostname: input.host,
      port: input.port,
    });
    server.once("error", reject);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}
