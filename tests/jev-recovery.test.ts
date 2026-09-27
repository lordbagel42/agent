import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "rivetkit/client";
import { expect, it } from "vitest";
import type { JuneRegistry } from "../src/runtime/registry.js";
import { freeEnginePort, stopTestEngine } from "./rivet.js";

it("reports a hard-killed Jev attempt as unknown without relaunching either provider", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "june-jev-crash-"));
  const port = await freeEnginePort();
  const children: ChildProcess[] = [];
  const messages: { kind: string }[] = [];
  let output = "";
  const client = createClient<JuneRegistry>({
    endpoint: `http://127.0.0.1:${port}`,
    token: "default",
    namespace: "default",
  });
  t.onTestFinished(async () => {
    if (t.task.result?.state === "fail") console.error(output);
    await client.dispose();
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await stopTestEngine(directory, port);
    await rm(directory, { recursive: true, force: true });
  });
  function start(phase: string) {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "tests/recovery-worker.ts"],
      {
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          RIVETKIT_STORAGE_PATH: directory,
          RIVET_RUN_ENGINE_PORT: String(port),
          FIXTURE_PHASE: phase,
          // This fixture exercises the legacy conversation-owned Jev receipt.
          FIXTURE_EXECUTION: "disabled",
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    children.push(child);
    child.on("message", (message) =>
      messages.push(message as { kind: string }),
    );
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    return child;
  }
  const first = start("interrupt");
  await expect
    .poll(() => messages.some((m) => m.kind === "ready"), { timeout: 15000 })
    .toBe(true);
  const june = client.conversation.getOrCreate(["private", "fixture"]);
  await june.send("inbox", {
    type: "event",
    event: {
      id: "jev-crash",
      type: "message",
      messageId: "1.123",
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      senderId: "U1",
      direct: true,
      text: "Jev fixture",
    },
  });
  await expect
    .poll(() => messages.some((m) => m.kind === "jev"), { timeout: 10000 })
    .toBe(true);
  expect(
    Object.values((await june.snapshot()).events)[0]?.jevObservation,
  ).toEqual({ status: "started" });
  const exited = once(first, "exit");
  first.kill("SIGKILL");
  await exited;
  start("recover");
  await expect
    .poll(async () => Object.values((await june.snapshot()).events)[0]?.done, {
      timeout: 30000,
    })
    .toBe(true);
  const snapshot = await june.snapshot();
  expect(Object.values(snapshot.events)[0]?.jevObservation).toEqual({
    status: "unknown",
    code: "interrupted_observation",
  });
  const delivery = Object.values(snapshot.deliveries)[0];
  expect(delivery?.result?.status).toBe("sent");
  expect(delivery?.message.content).toMatchObject({
    type: "text",
    text: expect.stringContaining("Jev observation outcome is unknown"),
  });
  expect(messages.filter((m) => m.kind === "jev")).toHaveLength(1);
  expect(messages.filter((m) => m.kind === "jev-model")).toHaveLength(1);
}, 60000);
