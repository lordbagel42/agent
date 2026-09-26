import { describe, expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  CodingRuntime,
  MessageEvent,
  OutboundMessage,
} from "../core/contracts.js";
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
function fixture(runtime: CodingRuntime) {
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
    coding: {
      runtime,
      workspaces: { june: "/workspaces/june" },
      timeoutMs: 5000,
    },
  });
  return { registry, sent };
}

describe("separate coding supervisor", () => {
  it("requires a private approval, then reports the worker result without pretending it verified it", async (t) => {
    const launches: { prompt: string; cwd: string }[] = [];
    const { registry, sent } = fixture({
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
    expect(launches[0]?.cwd).toBe("/workspaces/june");
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
    const { registry } = fixture({
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
    const { registry } = fixture({
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
});
