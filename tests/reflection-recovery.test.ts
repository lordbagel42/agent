import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "rivetkit/client";
import { expect, it } from "vitest";
import type { MessageEvent } from "../src/core/contracts.js";
import type { JuneClientRegistry } from "../src/runtime/registry.js";
import { freeEnginePort, stopTestEngine } from "./rivet.js";

for (const boundary of ["settled", "send"])
  it(`does not regenerate or redeliver private reflection after a hard crash at ${boundary}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "june-reflection-crash-"));
    const port = await freeEnginePort();
    const children: ChildProcess[] = [];
    const messages: { kind: string; stage?: string; id?: string }[] = [];
    const observedAt = Date.now();
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
        ["--import", "tsx", "tests/reflection-recovery-worker.ts"],
        {
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            RIVETKIT_STORAGE_PATH: directory,
            RIVET_RUN_ENGINE_PORT: String(port),
            FIXTURE_PHASE: phase,
            INTERRUPT_AT: boundary,
            OBSERVED_AT: String(observedAt),
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
    };
    const first = start("interrupt");
    await expect
      .poll(() => messages.some((m) => m.kind === "ready"), { timeout: 15000 })
      .toBe(true);
    const scope = JSON.stringify(["private", "fixture"]);
    const reflection = client.reflection.getOrCreate(["fixture"]);
    const request = await reflection.enqueue({
      scope,
      evidenceIds: ["evidence"],
      mode: "interaction",
      kind: "reflection",
    });
    const rawId = JSON.stringify([request.id, 1]);
    const alias = createHash("sha256").update(rawId).digest("hex");
    await expect
      .poll(async () => (await reflection.status()).candidateIds)
      .toContain(rawId);
    const actor = client.conversation.getOrCreate(["private", "fixture"]);
    const event: MessageEvent = {
      id: "review",
      type: "message",
      messageId: "123.456",
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      senderId: "U1",
      direct: true,
      metadata: { channelType: "im" },
      text: `Review ${alias}`,
    };
    await actor.send("inbox", { type: "event", event });
    await expect
      .poll(() => messages.filter((m) => m.kind === boundary).length, {
        timeout: 15000,
      })
      .toBe(1);
    const exited = once(first, "exit");
    first.kill("SIGKILL");
    await exited;
    start("recover");
    await expect
      .poll(
        async () =>
          Object.values((await actor.snapshot()).events).some(
            (record) => record.done,
          ),
        { timeout: 30000 },
      )
      .toBe(true);
    const state = await actor.snapshot();
    expect(Object.values(state.deliveries)).toHaveLength(1);
    expect(Object.values(state.deliveries)[0]?.result?.status).toBe("unknown");
    expect(messages.filter((m) => m.kind === "model")).toHaveLength(2);
    expect(
      messages.filter((m) => m.kind === "model" && m.stage === "synthesis"),
    ).toHaveLength(1);
    expect(messages.filter((m) => m.kind === "send")).toHaveLength(
      boundary === "send" ? 1 : 0,
    );
    expect(JSON.stringify(state)).not.toContain("CRASH PRIVATE HYPOTHESIS");
    expect(JSON.stringify(state)).not.toContain("CRASH PRIVATE SYNTHESIS");
  }, 60000);
