import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "rivetkit/client";
import { expect, it } from "vitest";
import type { MessageEvent } from "../src/core/contracts.js";
import { executionKey } from "../src/runtime/execution.js";
import type { JuneRegistry } from "../src/runtime/registry.js";
import { freeEnginePort, stopTestEngine } from "./rivet.js";

it.for(["before-session", "after-session"])(
  "recovers a hard-killed host (%s) without repeating an ambiguous send or native launch",
  { timeout: 60_000 },
  async (boundary, t) => {
    const directory = await mkdtemp(join(tmpdir(), "june-crash-"));
    const port = await freeEnginePort();
    const children: ChildProcess[] = [];
    const messages: { kind: string; id?: string; text?: string }[] = [];
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
            FIXTURE_CODING_BOUNDARY: boundary,
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
    const worker = client.execution.getOrCreate(
      executionKey(["private", "fixture"], "crash-worker"),
    );
    const requestId = `${"a".repeat(64)}:crash`;
    await worker.submit({
      id: requestId,
      source,
      task: "Interrupted research",
      workspaces: [],
      web: false,
      evidenceIds: [],
    });
    await expect
      .poll(
        () =>
          messages.filter((message) =>
            ["send", "coding", "execution"].includes(message.kind),
          ).length,
        { timeout: 5000 },
      )
      .toBe(3);
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
    const uncertainSend = messages.find(
      (message) => message.kind === "send",
    )?.id;
    const beforeCrash = await job.snapshot();
    expect(beforeCrash.status).toBe("running");
    expect(beforeCrash.attempts).toBe(1);
    expect(beforeCrash.worktree?.jobId).toBe("crash-job");
    expect(beforeCrash.threadId).toBe(
      boundary === "before-session" ? undefined : "T-fixture-saved",
    );
    const exited = once(first, "exit");
    first.kill("SIGKILL");
    await exited;
    start("recover");
    await expect
      .poll(async () => (await job.snapshot()).status, { timeout: 30_000 })
      .toBe("needs_review");
    await expect
      .poll(async () => (await worker.result(requestId))?.status, {
        timeout: 15000,
      })
      .toBe("needs_review");
    expect(
      messages.filter((message) => message.kind === "execution"),
    ).toHaveLength(1);
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
      .poll(
        async () => Object.values((await delayed.snapshot()).deliveries)[0],
        {
          timeout: 15_000,
        },
      )
      .toMatchObject({
        attempts: 2,
        result: { status: "sent", messageId: "fixture-after-backoff" },
      });
    expect(
      messages.filter((message) => message.kind === "backoff"),
    ).toHaveLength(2);
    expect(
      new Set(
        messages
          .filter((message) => message.kind === "backoff")
          .map((message) => message.id),
      ).size,
    ).toBe(1);
    expect((await job.snapshot()).threadId).toBe(beforeCrash.threadId);
    expect((await job.snapshot()).worktree).toEqual(beforeCrash.worktree);
    expect((await job.snapshot()).attempts).toBe(1);
    if (boundary === "before-session") {
      const report = (await job.snapshot()).report;
      expect(report).toContain("No native session/thread ID was saved");
      expect(report).toContain("external run may still be active");
      expect(report).toContain("Do not retry or launch a replacement");
      expect(report).toContain("/resume-stopped cannot resume this job");
      expect(report).toContain("Manual operator reconciliation is required");
      await expect
        .poll(() => messages.find((m) => m.kind === "coding-report")?.text, {
          timeout: 15_000,
        })
        .toContain(report);
      await job.send("commands", {
        type: "approve",
        commandId: "approve-crash",
      });
      await job.send("commands", {
        type: "approve",
        commandId: "approve-again",
      });
      await job.send("commands", {
        type: "resume",
        commandId: "resume-unconfirmed",
        confirmedStopped: false,
      });
      await job.send("commands", {
        type: "resume",
        commandId: "resume-confirmed",
        confirmedStopped: true,
      });
      await expect
        .poll(
          async () =>
            (await job.snapshot()).commandApprovals["resume-confirmed"],
        )
        .toBeNull();
      expect((await job.snapshot()).commandApprovals).toEqual({
        "approve-crash": 1,
        "approve-again": null,
        "resume-unconfirmed": null,
        "resume-confirmed": null,
      });
      expect((await job.snapshot()).attempts).toBe(1);
      expect((await job.snapshot()).status).toBe("needs_review");
      expect((await job.snapshot()).threadId).toBeUndefined();
      expect((await job.snapshot()).verification).toBeUndefined();
      const replacement = client.job.getOrCreate([
        "fixture",
        "replacement-job",
      ]);
      await replacement.send("commands", {
        type: "propose",
        proposal: {
          id: "replacement-job",
          source,
          workspace: "june",
          goal: "Must not replace uncertain work",
        },
      });
      await replacement.send("commands", {
        type: "approve",
        commandId: "approve-replacement",
      });
      await expect
        .poll(async () => (await replacement.snapshot()).status)
        .toBe("needs_review");
      expect(
        JSON.parse(
          await readFile(
            join(
              directory,
              "coding-worktrees",
              ".june-jobs",
              "active",
              "owner.json",
            ),
            "utf8",
          ),
        ),
      ).toEqual({ jobId: "crash-job", attempt: 1 });
    } else {
      expect((await job.snapshot()).report).toContain("Check its saved thread");
    }
    expect(
      messages.filter((message) => message.kind === "coding"),
    ).toHaveLength(1);
    expect(
      messages.filter(
        (message) => message.kind === "send" && message.id === uncertainSend,
      ),
    ).toHaveLength(1);
  },
);
