import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, type TestContext } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { createWorktreeManager } from "../coding/worktree.js";
import type {
  CodingRuntime,
  MessageEvent,
  OutboundMessage,
} from "../core/contracts.js";
import type { CodingDependencies } from "./coding.js";
import { createJuneRegistry } from "./registry.js";

const owner = {
  id: "raygen",
  identities: [{ channel: "slack" as const, accountId: "T1", senderId: "U1" }],
};
const source: MessageEvent = {
  id: "coding-request",
  type: "message",
  messageId: "123.567",
  occurredAt: Date.now(),
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  senderId: "U1",
  direct: true,
  text: "Fix the reaction handling in June.",
};
async function fixture(t: TestContext, runtime: CodingRuntime) {
  const root = await mkdtemp(path.join(os.tmpdir(), "june-supervisor-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, "repo");
  const worktreeRoot = path.join(root, "worktrees");
  await mkdir(repositoryRoot);
  await mkdir(worktreeRoot);
  execFileSync("git", ["init"], { cwd: repositoryRoot, stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
  await writeFile(
    path.join(repositoryRoot, "private"),
    "shared checkout secret",
  );
  const manager = createWorktreeManager({
    repositoryRoot,
    worktreeRoot,
    verifier: {
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('verified', 'separate-process')",
      ],
      timeoutMs: 5000,
    },
  });
  const coding: CodingDependencies = {
    runtime,
    workspaces: { june: repositoryRoot },
    timeoutMs: 5000,
    isolation: { june: manager },
  };
  const sent: OutboundMessage[] = [];
  const registry = createJuneRegistry({
    owner,
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(JSON.parse(JSON.stringify(message)) as OutboundMessage);
          return { status: "sent", messageId: `sent-${sent.length}` };
        },
      },
    },
    model: {
      async reply() {
        return {
          text: "I can propose that change.",
          coding: {
            workspace: "june",
            goal: "Fix reaction handling. Run its tests.",
          },
        };
      },
    },
    coding,
  });
  return { registry, sent, manager, repositoryRoot, worktreeRoot };
}

describe("separate coding supervisor", () => {
  it("requires a private approval, then reports the worker result without pretending it verified it", async (t) => {
    const launches: { prompt: string; cwd: string }[] = [];
    const { registry, sent, repositoryRoot, worktreeRoot } = await fixture(t, {
      async run(input) {
        launches.push({ prompt: input.prompt, cwd: input.cwd });
        await input.onThread("T-coding-worker");
        return {
          threadId: "T-coding-worker",
          report: "Changed reactions and ran the checks.",
        };
      },
    });
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(["private", "raygen"]);
    await june.send("inbox", {
      type: "event",
      event: {
        ...source,
        text: `My favorite bird is the heron. ${source.text}`,
      },
    });
    await expect.poll(() => sent.length, { timeout: 3000 }).toBe(1);
    const content = sent[0]?.content;
    const approval =
      content?.type === "text"
        ? content.text.match(/\/approve ([a-f0-9]+)/)?.[1]
        : undefined;
    expect(approval).toBeTruthy();
    expect(launches).toEqual([]);
    if (!approval) throw new Error("No approval command");
    await june.send("inbox", {
      type: "event",
      event: { ...source, id: "approve1", text: `/approve ${approval}` },
    });
    await expect
      .poll(
        () =>
          sent.some(
            (outbound) =>
              outbound.content.type === "text" &&
              outbound.content.text.includes("not independently verified"),
          ),
        { timeout: 5000 },
      )
      .toBe(true);
    expect(launches).toHaveLength(1);
    const cwd = launches[0]?.cwd ?? "";
    expect(cwd.startsWith(`${worktreeRoot}/job-`)).toBe(true);
    expect(await readFile(path.join(cwd, "verified"), "utf8")).toBe(
      "separate-process",
    );
    await expect(readFile(path.join(cwd, "private"))).rejects.toThrow();
    expect(await readFile(path.join(repositoryRoot, "private"), "utf8")).toBe(
      "shared checkout secret",
    );
    expect(launches[0]?.prompt).toContain(
      "Fix reaction handling. Run its tests.",
    );
    expect(launches[0]?.prompt).not.toContain("My favorite bird");
    await june.send("inbox", {
      type: "event",
      event: { ...source, id: "approve2", text: `/approve ${approval}` },
    });
    await expect
      .poll(
        async () =>
          Object.values((await june.snapshot()).events).filter(
            (record) => record.done,
          ).length,
        { timeout: 3000 },
      )
      .toBe(4);
    expect(launches).toHaveLength(1);
  });

  it("holds an interrupted worker for review and resumes only a confirmed-stopped saved thread", async (t) => {
    const threads: (string | undefined)[] = [];
    const { registry } = await fixture(t, {
      async run(input) {
        threads.push(input.threadId);
        if (threads.length === 1) {
          await input.onThread("T-saved");
          throw new Error("transport disappeared");
        }
        return { threadId: "T-saved", report: "Resumed and finished." };
      },
    });
    const { client } = await setupTest(t, registry);
    const job = client.job.getOrCreate(["raygen", "job-1"]);
    await job.send("commands", {
      type: "propose",
      proposal: {
        id: "job-1",
        source,
        workspace: "june",
        goal: "Fix reactions",
      },
    });
    await expect
      .poll(async () => (await job.snapshot()).status, { timeout: 3000 })
      .toBe("awaiting_approval");
    await job.send("commands", { type: "approve", commandId: "approve-1" });
    await expect
      .poll(async () => (await job.snapshot()).status, { timeout: 3000 })
      .toBe("needs_review");
    expect((await job.snapshot()).threadId).toBe("T-saved");
    await job.send("commands", { type: "approve", commandId: "approve-2" });
    await job.send("commands", {
      type: "resume",
      commandId: "resume-1",
      confirmedStopped: false,
    });
    await job.send("commands", {
      type: "resume",
      commandId: "resume-2",
      confirmedStopped: true,
    });
    await expect
      .poll(async () => (await job.snapshot()).status, { timeout: 3000 })
      .toBe("completed");
    expect(threads).toEqual([undefined, "T-saved"]);
  });

  it("does not relaunch when a failed resume command is delivered twice", async (t) => {
    const threads: (string | undefined)[] = [];
    const { registry } = await fixture(t, {
      async run(input) {
        threads.push(input.threadId);
        await input.onThread("T-saved");
        if (threads.length <= 2) throw new Error("connection interrupted");
        return { threadId: "T-saved", report: "Finished." };
      },
    });
    const { client } = await setupTest(t, registry);
    const job = client.job.getOrCreate(["raygen", "resume-dedup"]);
    await job.send("commands", {
      type: "propose",
      proposal: {
        id: "resume-dedup",
        source,
        workspace: "june",
        goal: "Fix reactions",
      },
    });
    await job.send("commands", { type: "approve", commandId: "approve-1" });
    await expect
      .poll(async () => (await job.snapshot()).status, { timeout: 3000 })
      .toBe("needs_review");
    await job.send("commands", {
      type: "resume",
      commandId: "resume-1",
      confirmedStopped: true,
    });
    await expect
      .poll(async () => (await job.snapshot()).attempts, { timeout: 3000 })
      .toBe(2);
    await job.send("commands", {
      type: "resume",
      commandId: "resume-1",
      confirmedStopped: true,
    });
    await job.send("commands", {
      type: "resume",
      commandId: "resume-2",
      confirmedStopped: true,
    });
    await expect
      .poll(async () => (await job.snapshot()).status, { timeout: 3000 })
      .toBe("completed");
    expect(threads).toEqual([undefined, "T-saved", "T-saved"]);
    expect((await job.snapshot()).commandApprovals).toMatchObject({
      "resume-1": 2,
      "resume-2": 3,
    });
  });

  it("cancels an uncooperative runtime without releasing uncertain execution capacity", async (t) => {
    let launches = 0;
    let lateThread: ((thread: string) => Promise<void>) | undefined;
    const { registry, manager } = await fixture(t, {
      async run(input) {
        launches++;
        lateThread = input.onThread;
        await input.onThread("T-cancelled");
        return new Promise<never>(() => {});
      },
    });
    const { client } = await setupTest(t, registry);
    const job = client.job.getOrCreate(["raygen", "cancelled"]);
    await job.send("commands", {
      type: "propose",
      proposal: {
        id: "cancelled",
        source,
        workspace: "june",
        goal: "Approved task",
      },
    });
    await job.send("commands", { type: "approve", commandId: "approval" });
    await expect.poll(() => launches).toBe(1);
    await job.cancel();
    await expect
      .poll(async () => (await job.snapshot()).status)
      .toBe("needs_review");
    await lateThread?.("T-late-untrusted");
    expect((await job.snapshot()).threadId).toBe("T-cancelled");
    await expect(manager.admit("other-job", 1)).rejects.toThrow("occupied");
    await job.send("commands", { type: "approve", commandId: "approval" });
    await expect
      .poll(async () => (await job.snapshot()).cancelRequested)
      .toBe(true);
    expect(launches).toBe(1);
    expect((await job.snapshot()).verification).toBeUndefined();
    await expect
      .poll(
        async () =>
          Object.values(
            (
              await client.conversation
                .getOrCreate(["private", "raygen"])
                .snapshot()
            ).events,
          ).filter((event) => event.done).length,
      )
      .toBe(1);
  });

  it("cancels an unsettled verifier and ignores its late receipt without releasing admission", async (t) => {
    const { registry, manager } = await fixture(t, {
      async run() {
        return { threadId: "T-verified-late", report: "Worker finished." };
      },
    });
    const releaseReceipt = Promise.withResolvers<void>();
    const verify = manager.verify;
    let verifying = false;
    manager.verify = async (...args) => {
      const receipt = await verify(...args);
      verifying = true;
      // Model a verifier that has not acknowledged process settlement yet.
      await releaseReceipt.promise;
      return receipt;
    };
    const { client } = await setupTest(t, registry);
    const job = client.job.getOrCreate(["raygen", "verifier-cancelled"]);
    try {
      await job.send("commands", {
        type: "propose",
        proposal: {
          id: "verifier-cancelled",
          source,
          workspace: "june",
          goal: "Approved task",
        },
      });
      await job.send("commands", { type: "approve", commandId: "approval" });
      await expect.poll(() => verifying).toBe(true);
      await job.cancel();
      await expect
        .poll(async () => (await job.snapshot()).status, { timeout: 1000 })
        .toBe("needs_review");
      await expect(manager.admit("other-job", 1)).rejects.toThrow("occupied");
      releaseReceipt.resolve();
      await expect
        .poll(
          async () =>
            Object.values(
              (
                await client.conversation
                  .getOrCreate(["private", "raygen"])
                  .snapshot()
              ).events,
            ).filter((event) => event.done).length,
        )
        .toBe(1);
      const state = await job.snapshot();
      expect(state.status).toBe("needs_review");
      expect(state.verification).toBeUndefined();
      expect(state.workerClaim).toBe("Worker finished.");
      await expect(manager.admit("other-job", 1)).rejects.toThrow("occupied");
    } finally {
      releaseReceipt.resolve();
    }
  });

  it("does not promote a historical verifier receipt after the worker changes files", async (t) => {
    const { registry, manager } = await fixture(t, {
      async run(input) {
        await writeFile(path.join(input.cwd, "later-change"), "unchecked");
        return { threadId: "T-worker", report: "Everything passes!" };
      },
    });
    await manager.prepare("historical");
    await manager.verify("historical", undefined, 1);
    const { client } = await setupTest(t, registry);
    const job = client.job.getOrCreate(["raygen", "historical"]);
    await job.send("commands", {
      type: "propose",
      proposal: {
        id: "historical",
        source,
        workspace: "june",
        goal: "Approved change",
      },
    });
    await job.send("commands", { type: "approve", commandId: "approval" });
    await expect
      .poll(async () => (await job.snapshot()).status)
      .toBe("needs_review");
    const state = await job.snapshot();
    expect(state.verification).toMatchObject({ passed: true, replayed: true });
    expect(state.report).toContain(
      "current workspace changes are not verified",
    );
    expect(state.workerClaim).toBe("Everything passes!");
    await expect
      .poll(
        async () =>
          Object.values(
            (
              await client.conversation
                .getOrCreate(["private", "raygen"])
                .snapshot()
            ).events,
          ).filter((event) => event.done).length,
      )
      .toBe(1);
  });
});
