import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireRuntimeLock,
  createStandbyApp,
  validateSlotLauncher,
} from "./standby.js";

const revision = "a".repeat(40);
const token = "standby-deployment-token-32-characters";
const headers = { authorization: `Bearer ${token}` };
const activation = {
  method: "POST",
  headers,
  body: JSON.stringify({ revision }),
};

describe("exclusive standby activation", () => {
  it("requires exact authenticated revision and starts once despite concurrent requests", async () => {
    const pending = Promise.withResolvers<boolean>();
    const acquire = vi.fn(() => pending.promise);
    const activated = vi.fn();
    const app = createStandbyApp({ revision, token, acquire, activated });
    expect((await app.request("/health")).status).toBe(503);
    expect((await app.request("/operator/deployment/standby")).status).toBe(
      401,
    );
    expect(
      await (
        await app.request("/operator/deployment/standby", { headers })
      ).json(),
    ).toEqual({ revision, standby: true });
    expect(
      (
        await app.request("/operator/deployment/activate", {
          ...activation,
          headers: {},
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/operator/deployment/activate", {
          ...activation,
          body: JSON.stringify({ revision: "b".repeat(40) }),
        })
      ).status,
    ).toBe(409);
    expect(acquire).not.toHaveBeenCalled();
    const first = app.request("/operator/deployment/activate", activation);
    await expect.poll(() => acquire.mock.calls.length).toBe(1);
    expect(
      (await app.request("/operator/deployment/activate", activation)).status,
    ).toBe(409);
    pending.resolve(true);
    expect(await (await first).json()).toEqual({ revision, activated: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(activated).toHaveBeenCalledTimes(1);
    expect(
      (await app.request("/operator/deployment/activate", activation)).status,
    ).toBe(409);
  });

  it("retains the kernel lock after flock exits and refuses a competing open description", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "june-lock-"));
    const first = await open(join(directory, "owner.lock"), "w+");
    const second = await open(join(directory, "owner.lock"), "r+");
    t.onTestFinished(async () => {
      await first.close();
      await second.close();
      await rm(directory, { recursive: true, force: true });
    });
    expect(await acquireRuntimeLock(first.fd)).toBe(true);
    const activated = vi.fn();
    const app = createStandbyApp({
      revision,
      token,
      activated,
      acquire: () => acquireRuntimeLock(second.fd),
    });
    expect(
      (await app.request("/operator/deployment/activate", activation)).status,
    ).toBe(409);
    expect(activated).not.toHaveBeenCalled();
    await first.close();
    expect(
      (await app.request("/operator/deployment/activate", activation)).status,
    ).toBe(200);
    expect(await acquireRuntimeLock(second.fd)).toBe(true);
  });

  it("stops standby cleanly without crossing the live-state barrier", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "june-standby-"));
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("No port");
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { awaitSlotActivation } from ${JSON.stringify(new URL("./standby.ts", import.meta.url).href)};
      import { writeFile } from 'node:fs/promises';
      await awaitSlotActivation(${JSON.stringify({ revision, token, host: "127.0.0.1", port: address.port })});
      await writeFile(${JSON.stringify(join(directory, "live-state"))}, 'must not happen');
    `,
      ],
      { stdio: "ignore" },
    );
    t.onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    });
    await expect
      .poll(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${address.port}/health`))
            .status;
        } catch {
          return 0;
        }
      })
      .toBe(503);
    expect(await readdir(directory)).toEqual([]);
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    expect(await exited).toEqual([0, null]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects launcher/config mismatch before mutable startup", () => {
    const previous = {
      slot: process.env.JUNE_SLOT,
      fd: process.env.JUNE_RUNTIME_LOCK_FD,
    };
    try {
      delete process.env.JUNE_SLOT;
      delete process.env.JUNE_RUNTIME_LOCK_FD;
      expect(
        validateSlotLauncher({ enabled: false, releaseRoot: "/tmp" }),
      ).toBeUndefined();
      expect(() =>
        validateSlotLauncher({ enabled: true, releaseRoot: "/tmp", revision }),
      ).toThrow();
      process.env.JUNE_SLOT = "blue";
      process.env.JUNE_RUNTIME_LOCK_FD = "9";
      expect(() =>
        validateSlotLauncher({ enabled: false, releaseRoot: "/tmp" }),
      ).toThrow();
      expect(() =>
        validateSlotLauncher({ enabled: true, releaseRoot: "/tmp", revision }),
      ).toThrow();
    } finally {
      if (previous.slot === undefined) delete process.env.JUNE_SLOT;
      else process.env.JUNE_SLOT = previous.slot;
      if (previous.fd === undefined) delete process.env.JUNE_RUNTIME_LOCK_FD;
      else process.env.JUNE_RUNTIME_LOCK_FD = previous.fd;
    }
  });
});
