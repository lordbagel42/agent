import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openBoxLiteHost, witnessBoxLiteProcess } from "./boxlite-host.js";

afterEach(() => vi.restoreAllMocks());

it("retains exclusive crash admission until explicit clean shutdown and refuses unmanaged homes", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "june-vm-host-"));
  try {
    const host = await openBoxLiteHost(directory);
    await expect(openBoxLiteHost(directory)).rejects.toThrow();
    // A new caller cannot treat the previous process's marker as stale permission.
    expect((await fs.readdir(directory)).sort()).toEqual([
      "june-active",
      "june-boxes",
      "june-managed-v1",
    ]);
    await host.close();
    const next = await openBoxLiteHost(directory);
    expect(next.binding).toBe(host.binding);
    await host.close();
    await expect(openBoxLiteHost(directory)).rejects.toThrow();
    await next.close();
    await fs.unlink(join(directory, "june-managed-v1"));
    await fs.writeFile(join(directory, "unmanaged-box.db"), "unrelated");
    await expect(openBoxLiteHost(directory)).rejects.toThrow();
    expect(await fs.readFile(join(directory, "unmanaged-box.db"), "utf8")).toBe(
      "unrelated",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("enumerates one worker's deletion targets while another retires its record", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "june-vm-retire-"));
  try {
    const host = await openBoxLiteHost(directory);
    await host.retain("alpha", "box-a");
    await host.retain("beta", "box-b");
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementationOnce(async (path, options) => {
      await host.confirmRemoved("beta", "box-b");
      return readFile(path, options);
    });
    expect(await host.retained("alpha")).toEqual(["box-a"]);
    await host.close();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("requires witnessed containment and waits for the same cgroup to empty instead of trusting launcher death", async () => {
  let populated = true;
  let launched = true;
  const stat = `431 (boxlite shim) S ${Array(18).fill("0").join(" ")} 12345`;
  const read = vi.spyOn(fs, "readFile").mockImplementation(async (path) => {
    if (path === "/proc/431/stat") {
      if (launched) return stat;
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    }
    if (path === "/proc/431/cgroup") return "0::/boxlite/box-a\n";
    if (path === "/sys/fs/cgroup/boxlite/box-a/cgroup.procs") return "431\n";
    if (path === "/sys/fs/cgroup/boxlite/box-a/cgroup.events")
      return `populated ${populated ? 1 : 0}\nfrozen 0\n`;
    throw new Error("unexpected path");
  });
  vi.spyOn(fs, "stat").mockResolvedValue({ dev: 1, ino: 22 } as Awaited<
    ReturnType<typeof fs.stat>
  >);
  const proof = await witnessBoxLiteProcess("box-a", 431);
  launched = false;
  let settled = false;
  const stopped = proof().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(settled).toBe(false);
  populated = false;
  await stopped;
  expect(settled).toBe(true);

  read.mockImplementation(async (path) => {
    if (path === "/proc/431/stat") return stat;
    if (path === "/proc/431/cgroup") return "0::/shared-service\n";
    return "";
  });
  await expect(witnessBoxLiteProcess("box-a", 431)).rejects.toThrow();
});

it("does not accept a missing or replaced witnessed cgroup as successful teardown", async () => {
  vi.spyOn(fs, "readFile").mockImplementation(async (path) => {
    if (path === "/proc/431/stat")
      return `431 (shim) S ${Array(18).fill("0").join(" ")} 12345`;
    if (path === "/proc/431/cgroup") return "0::/boxlite/box-a\n";
    if (path === "/sys/fs/cgroup/boxlite/box-a/cgroup.procs") return "431\n";
    return "populated 0\n";
  });
  const stat = vi
    .spyOn(fs, "stat")
    .mockResolvedValue({ dev: 1, ino: 22 } as Awaited<
      ReturnType<typeof fs.stat>
    >);
  const proof = await witnessBoxLiteProcess("box-a", 431);
  stat.mockResolvedValue({ dev: 1, ino: 23 } as Awaited<
    ReturnType<typeof fs.stat>
  >);
  await expect(proof()).rejects.toThrow();
});
