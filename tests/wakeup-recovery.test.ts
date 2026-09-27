import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "rivetkit/client";
import { expect, it } from "vitest";
import type { MessageEvent } from "../src/core/contracts.js";
import type { JuneClientRegistry } from "../src/runtime/registry.js";
import { freeEnginePort, stopTestEngine } from "./rivet.js";

for (const boundary of ["send", "settled"])
  it(`recovers a hard crash at ${boundary} without repeating an uncertain model/send or a cancelled run`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "june-wakeup-crash-"));
    const port = await freeEnginePort();
    const children: ChildProcess[] = [];
    const messages: { kind: string; id?: string }[] = [];
    let output = "";
    const client = createClient<JuneClientRegistry>({
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
    const start = (phase: string) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "tests/wakeup-recovery-worker.ts"],
        {
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            RIVETKIT_STORAGE_PATH: directory,
            RIVET_RUN_ENGINE_PORT: String(port),
            FIXTURE_PHASE: phase,
            INTERRUPT_AT: boundary,
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      children.push(child);
      child.on("message", (message) =>
        messages.push(message as { kind: string; id?: string }),
      );
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        output += String(chunk);
      });
      return child;
    };
    const first = start("interrupt");
    await expect
      .poll(() => messages.some((m) => m.kind === "ready"), { timeout: 15000 })
      .toBe(true);
    const source: MessageEvent = {
      id: "request",
      type: "message",
      messageId: "123.456",
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      senderId: "U1",
      direct: true,
      text: "Notify me",
    };
    const wakeups = client.wakeups.getOrCreate(["fixture"]);
    await wakeups.snapshot();
    const timer = {
      action: "create" as const,
      name: "Timer",
      instruction: "Notify me",
      once: true,
      trigger: {
        kind: "at" as const,
        at: new Date(Date.now() + 2000).toISOString(),
      },
    };
    await wakeups.manage(timer, source, "timer");
    await expect
      .poll(() => messages.filter((m) => m.kind === boundary).length, {
        timeout: 15000,
      })
      .toBe(1);
    const watch = {
      ...timer,
      trigger: {
        kind: "event" as const,
        source: "webhook.fixture",
        type: "done",
        filters: [],
      },
    };
    await wakeups.manage(watch, source, "event");
    await wakeups.manage(watch, source, "cancelled");
    const external = {
      id: "fixture-1",
      source: "webhook.fixture",
      type: "done",
      occurredAt: Date.now(),
      data: {},
    };
    await wakeups.publish(external);
    await expect
      .poll(
        async () =>
          Object.values((await wakeups.snapshot()).runs).filter(
            (run) => run.status === "queued",
          ).length,
      )
      .toBe(2);
    await wakeups.manage(
      { action: "cancel", id: "cancelled" },
      source,
      "cancel",
    );
    const exited = once(first, "exit");
    first.kill("SIGKILL");
    await exited;
    start("recover");
    await expect
      .poll(
        async () =>
          Object.values((await wakeups.snapshot()).runs)
            .map((run) => run.status)
            .sort(),
        { timeout: 30000 },
      )
      .toEqual(["cancelled", "completed", "unknown"]);
    expect(await wakeups.publish(external)).toMatchObject({ duplicate: true });
    expect(messages.filter((m) => m.kind === "model")).toHaveLength(2);
    const sends = boundary === "send" ? 2 : 1;
    expect(messages.filter((m) => m.kind === "send")).toHaveLength(sends);
    expect(
      new Set(messages.filter((m) => m.kind === "send").map((m) => m.id)).size,
    ).toBe(sends);
  }, 60000);
