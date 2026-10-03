import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEnginePath } from "@rivetkit/engine-cli";
import { createClient } from "rivetkit/client";
import { expect, it, type TestContext } from "vitest";
import { freeEnginePort } from "./rivet.js";

async function fixture(t: TestContext, delay: number, mode = "normal") {
  const directory = await mkdtemp(join(tmpdir(), "june-slot-engine-"));
  const port = await freeEnginePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const wrapper = join(directory, "engine");
  const pids = join(directory, "pids");
  await writeFile(
    wrapper,
    `#!/bin/sh\necho $$ >> '${pids}'\nsleep ${delay}\nexec '${getEnginePath()}' "$@"\n`,
    { mode: 0o700 },
  );
  const children: ChildProcess[] = [];
  let output = "";
  const client = createClient({
    endpoint,
    namespace: "default",
    token: "default",
    disableMetadataLookup: true,
  });
  async function stopHost(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  async function stopEngines() {
    for (const line of (await readFile(pids, "utf8").catch(() => ""))
      .trim()
      .split("\n")) {
      if (!line) continue;
      const pid = Number(line);
      try {
        process.kill(pid, "SIGCONT");
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await expect
        .poll(
          async () => {
            const status = await readFile(`/proc/${pid}/status`, "utf8").catch(
              () => "",
            );
            return !status || /State:\s+Z/.test(status);
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    }
  }
  t.onTestFinished(async () => {
    if (t.task.result?.state === "fail") console.error(output);
    await client.dispose();
    for (const child of children) await stopHost(child);
    await stopEngines();
    await rm(directory, { recursive: true, force: true });
  });
  function startHost() {
    const messages: string[] = [];
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "tests/slot-engine-worker.ts"],
      {
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          RIVETKIT_STORAGE_PATH: directory,
          RIVET_RUN_ENGINE_PORT: String(port),
          RIVET_ENGINE_BINARY: wrapper,
          FIXTURE_MODE: mode,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    children.push(child);
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("message", (message) =>
      messages.push((message as { kind: string }).kind),
    );
    return { child, messages };
  }
  return { startHost, stopHost, stopEngines, pids, client, endpoint };
}

it("keeps one slow-starting engine alive past ten seconds and preserves actor state on restart", async (t) => {
  const { startHost, stopHost, stopEngines, pids, client } = await fixture(
    t,
    12,
  );
  const first = startHost();
  await expect.poll(() => first.messages[0], { timeout: 25_000 }).toBe("ready");
  expect((await readFile(pids, "utf8")).trim().split("\n")).toHaveLength(1);
  const counter = client.getOrCreate("counter", ["persisted"]);
  expect(await counter.action({ name: "add", args: [7] })).toBe(7);
  await stopHost(first.child);
  await stopEngines();
  const second = startHost();
  await expect
    .poll(() => second.messages[0], { timeout: 25_000 })
    .toBe("ready");
  expect(await counter.action({ name: "add", args: [4] })).toBe(11);
  expect((await readFile(pids, "utf8")).trim().split("\n")).toHaveLength(2);
}, 75_000);

it("cannot spawn a replacement when the native handoff health probe fails", async (t) => {
  const { startHost, pids } = await fixture(t, 0, "handoff");
  const { child, messages } = startHost();
  await expect.poll(() => messages[0], { timeout: 15_000 }).toBe("prestarted");
  const pid = Number((await readFile(pids, "utf8")).trim());
  // Stall only this disposable child, after successful prestart but before the
  // native reuse probe. Without both resolver fences it launches another engine.
  process.kill(pid, "SIGSTOP");
  try {
    child.send("register");
    await expect
      .poll(() => messages.at(-1), { timeout: 8000 })
      .toBe("failed-fenced");
    expect((await readFile(pids, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(child.exitCode).toBeNull();
  } finally {
    process.kill(pid, "SIGCONT");
  }
});

it("retains the timed-out engine and refuses late readiness instead of killing or retrying", async (t) => {
  const { startHost, pids, endpoint } = await fixture(t, 65);
  const { child, messages } = startHost();
  await expect
    .poll(() => messages.at(-1), { timeout: 63_000 })
    .toBe("failed-fenced");
  const pid = Number((await readFile(pids, "utf8")).trim());
  expect(() => process.kill(pid, 0)).not.toThrow();
  await expect
    .poll(
      () =>
        fetch(`${endpoint}/health`)
          .then((r) => r.status)
          .catch(() => 0),
      { timeout: 15_000 },
    )
    .toBe(200);
  expect(messages).not.toContain("ready");
  expect(child.exitCode).toBeNull();
  expect((await readFile(pids, "utf8")).trim().split("\n")).toHaveLength(1);
}, 85_000);
