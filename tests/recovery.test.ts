import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "rivetkit/client";
import { expect, it } from "vitest";
import type { MessageEvent } from "../src/core/contracts.js";
import type { JuneRegistry } from "../src/runtime/registry.js";
import { freeEnginePort, stopTestEngine } from "./rivet.js";

it("recovers a hard-killed host's durable retry without repeating an ambiguous send or Amp launch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "june-crash-"));
  const port = await freeEnginePort();
  const children: ChildProcess[] = [];
  const messages: { kind: string; id?: string }[] = [];
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
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    children.push(child);
    child.on("message", (message) => {
      messages.push(message as { kind: string; id?: string });
    });
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
    .poll(() => messages.some((message) => message.kind === "ready"), {
      timeout: 15_000,
    })
    .toBe(true);
  const source: MessageEvent = {
    id: "Ev-crash",
    type: "message",
    messageId: "123.456",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    senderId: "U1",
    direct: true,
    text: "Remember the heron.",
  };
  const june = client.conversation.getOrCreate(["private", "fixture"]);
  await june.send("inbox", { type: "event", event: source });
  const job = client.job.getOrCreate(["fixture", "crash-job"]);
  await job.send("commands", {
    type: "propose",
    proposal: {
      id: "crash-job",
      source,
      workspace: "june",
      goal: "Change a fixture",
    },
  });
  await job.send("commands", { type: "approve", commandId: "approve-crash" });
  await expect
    .poll(
      () =>
        messages.filter((message) => ["send", "coding"].includes(message.kind))
          .length,
      { timeout: 5000 },
    )
    .toBe(2);
  const delayed = client.conversation.getOrCreate([
    "slack",
    "T1",
    "C-backoff",
    "thread",
  ]);
  await delayed.send("inbox", {
    type: "event",
    event: {
      ...source,
      id: "Ev-backoff",
      direct: false,
      address: {
        channel: "slack",
        accountId: "T1",
        conversationId: "C-backoff",
        threadId: "thread",
      },
    },
  });
  await expect
    .poll(
      async () =>
        Object.values((await delayed.snapshot()).deliveries)[0]?.result,
      { timeout: 3000 },
    )
    .toEqual({
      status: "rejected",
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 2000,
    });
  const uncertainSend = messages.find((message) => message.kind === "send")?.id;
  const exited = once(first, "exit");
  first.kill("SIGKILL");
  await exited;
  start("recover");
  await expect
    .poll(async () => (await job.snapshot()).status, { timeout: 30_000 })
    .toBe("needs_review");
  await expect
    .poll(
      async () =>
        Object.values((await june.snapshot()).deliveries).find(
          (delivery) => delivery.message.id === uncertainSend,
        )?.result,
      { timeout: 15_000 },
    )
    .toEqual({ status: "unknown", code: "interrupted_send" });
  await expect
    .poll(async () => Object.values((await delayed.snapshot()).deliveries)[0], {
      timeout: 15_000,
    })
    .toMatchObject({
      attempts: 2,
      result: { status: "sent", messageId: "fixture-after-backoff" },
    });
  expect(messages.filter((message) => message.kind === "backoff")).toHaveLength(
    2,
  );
  expect(
    new Set(
      messages
        .filter((message) => message.kind === "backoff")
        .map((message) => message.id),
    ).size,
  ).toBe(1);
  expect((await job.snapshot()).threadId).toBe("T-fixture-saved");
  expect((await job.snapshot()).attempts).toBe(1);
  expect(messages.filter((message) => message.kind === "coding")).toHaveLength(
    1,
  );
  expect(
    messages.filter(
      (message) => message.kind === "send" && message.id === uncertainSend,
    ),
  ).toHaveLength(1);
}, 60_000);
