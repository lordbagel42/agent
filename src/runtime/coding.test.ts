import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, type TestContext } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { createWorktreeManager } from "../coding/worktree.js";
import type {
  CodingRuntime,
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
  SendResult,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import type { CodingDependencies } from "./coding.js";
import { executionKey } from "./execution.js";
import { createJuneRegistry, type Dependencies } from "./registry.js";

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
async function fixture(
  t: TestContext,
  runtime: CodingRuntime,
  memory?: Dependencies["memory"],
  options?: {
    reply?: () => CompanionReply;
    disabled?: boolean;
    send?: (message: OutboundMessage) => Promise<SendResult>;
  },
) {
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
    runtimeKind: "amp",
    runtimeId: "fixture-runtime-v1",
    workspaces: { june: repositoryRoot },
    timeoutMs: 5000,
    isolation: { june: manager },
  };
  const codingRequest = {
    workspace: "june",
    goal: "Fix reaction handling. Run its tests.",
  };
  const sent: OutboundMessage[] = [];
  const modelRequests: ModelRequest[] = [];
  const registry = createJuneRegistry({
    owner,
    memory,
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(JSON.parse(JSON.stringify(message)) as OutboundMessage);
          if (options?.send) return options.send(message);
          return { status: "sent", messageId: `sent-${sent.length}` };
        },
      },
    },
    model: {
      async reply(request) {
        modelRequests.push(structuredClone(request));
        if (request.system.includes("Coding completion"))
          return {
            text: "The worker reports the change; its claims are not independently verified.",
          };
        if (request.system.includes("Execution completion"))
          return { text: "Scope ready for approval." };
        if (options?.reply) return options.reply();
        return {
          text: "I'll prepare the change.",
          execution: [
            {
              agent: "coding-plan",
              action: "run",
              task: "Fix reaction handling. Run its tests.",
            },
          ],
        };
      },
    },
    execution: {
      model: {
        async reply() {
          return {
            text: "Scope prepared, not executed.",
            coding: { ...codingRequest },
          };
        },
      },
    },
    coding: options?.disabled ? undefined : coding,
  });
  return {
    registry,
    sent,
    modelRequests,
    manager,
    repositoryRoot,
    worktreeRoot,
    coding,
    codingRequest,
  };
}

describe("separate coding supervisor", () => {
  it.for(["runtime", "workspace"] as const)(
    "keeps June's approval bound when the %s changes before the queued proposal is consumed",
    async (change, t) => {
      const launches: string[] = [];
      const { registry, coding, sent, repositoryRoot, worktreeRoot } =
        await fixture(
          t,
          {
            async run(input) {
              launches.push(input.cwd);
              return { threadId: "T-fresh", report: "Fresh approved task." };
            },
          },
          undefined,
          {
            reply: () => ({
              text: "",
              coding: { workspace: "june", goal: "Approved scope" },
            }),
          },
        );
      // Hold only the consumer: June can persist, enqueue and deliver the actual
      // preview before a replacement process/configuration consumes the queue.
      const consume = Promise.withResolvers<void>();
      const jobConfig = registry.config.use.job.config;
      const run = jobConfig.run;
      if (typeof run !== "function") throw new Error("Expected workflow run");
      jobConfig.run = async (c) => {
        await consume.promise;
        await run(c);
      };
      const { client } = await setupTest(t, registry);
      t.onTestFinished(() => consume.resolve());
      const june = client.conversation.getOrCreate(["private", "raygen"]);
      const preview = () =>
        sent.flatMap((m) =>
          m.content.type === "text"
            ? [...m.content.text.matchAll(/\/approve ([a-f0-9]+)/g)].map(
                (match) => match[0],
              )
            : [],
        );
      await june.send("inbox", { type: "event", event: source });
      await expect.poll(() => preview().length, { timeout: 15000 }).toBe(1);
      const id = Object.keys((await june.snapshot()).jobs)[0];
      if (!id) throw new Error("No proposal");
      const job = client.job.getOrCreate(["raygen", id]);
      expect((await job.snapshot()).proposal).toBeNull();
      coding.runtimeId = "fixture-runtime-v2";
      let expectedRoot = worktreeRoot;
      if (change === "workspace") {
        const replacement = path.join(repositoryRoot, "..", "replacement");
        expectedRoot = path.join(worktreeRoot, "..", "replacement-worktrees");
        execFileSync("git", ["clone", "--quiet", repositoryRoot, replacement]);
        await mkdir(expectedRoot);
        coding.workspaces.june = replacement;
        coding.isolation = {
          june: createWorktreeManager({
            repositoryRoot: replacement,
            worktreeRoot: expectedRoot,
          }),
        };
      }
      consume.resolve();
      await june.send("inbox", {
        type: "event",
        event: {
          ...source,
          id: "stale-approval",
          messageId: "123.568",
          text: preview()[0] ?? "",
        },
      });
      await expect
        .poll(async () =>
          Object.values((await job.snapshot()).commandApprovals),
        )
        .toEqual([null]);
      expect(launches).toEqual([]);
      expect((await job.snapshot()).worktree).toBeUndefined();

      // A fresh proposal under the new binding still traverses the same June
      // confirmation path and starts exactly once in the current workspace.
      await june.send("inbox", {
        type: "event",
        event: { ...source, id: "fresh-proposal", messageId: "123.569" },
      });
      await expect.poll(() => preview().length, { timeout: 15000 }).toBe(2);
      await june.send("inbox", {
        type: "event",
        event: {
          ...source,
          id: "fresh-approval",
          messageId: "123.570",
          text: preview()[1] ?? "",
        },
      });
      await expect.poll(() => launches.length).toBe(1);
      expect(launches[0]?.startsWith(`${expectedRoot}/job-`)).toBe(true);
    },
  );

  it.for(["queued", "persisted", "recorded-approval"] as const)(
    "rejects a legacy %s proposal without a producer binding through June's confirmation path",
    async (legacy, t) => {
      let launches = 0;
      const { registry } = await fixture(t, {
        async run() {
          launches++;
          return { threadId: "T-forbidden", report: "Must not run" };
        },
      });
      const id = "a".repeat(64);
      const proposal = { id, source, workspace: "june", goal: "Legacy scope" };
      const conversationConfig = registry.config.use.conversation.config;
      const jobConfig = registry.config.use.job.config;
      if (!("state" in conversationConfig) || !("state" in jobConfig))
        throw new Error("Expected initial state");
      Object.assign(conversationConfig.state, { jobs: { [id]: proposal } });
      const approval = {
        ...source,
        id: "legacy-approval",
        text: `/approve ${id.slice(0, 12)}`,
      };
      const commandId = createHash("sha256")
        .update(JSON.stringify(["slack", "T1", approval.id]))
        .digest("hex");
      if (legacy !== "queued") {
        Object.assign(jobConfig.state, {
          proposal,
          runtimeId: "fixture-runtime-v1",
          status: "awaiting_approval",
          // A recorded check-approval step must not bypass run-worker's check.
          commandApprovals:
            legacy === "recorded-approval" ? { [commandId]: 1 } : {},
        });
      }
      const { client } = await setupTest(t, registry);
      const june = client.conversation.getOrCreate(["private", "raygen"]);
      const job = client.job.getOrCreate(["raygen", id]);
      if (legacy === "queued")
        await job.send("commands", { type: "propose", proposal });
      await june.send("inbox", { type: "event", event: approval });
      if (legacy === "recorded-approval") {
        await expect
          .poll(async () => (await job.snapshot()).status)
          .toBe("needs_review");
      } else {
        await expect
          .poll(async () => (await job.snapshot()).commandApprovals[commandId])
          .toBeNull();
      }
      expect(launches).toBe(0);
      expect((await job.snapshot()).worktree).toBeUndefined();
    },
  );

  it("exposes private lifecycle commands without granting launch or stop authority", async (t) => {
    let action: CompanionReply = {
      text: "",
      codingJob: { action: "list", id: null },
    };
    let launches = 0;
    const pending = Promise.withResolvers<{
      threadId: string;
      report: string;
    }>();
    t.onTestFinished(() =>
      pending.resolve({ threadId: "T-late", report: "SECRET LATE REPORT" }),
    );
    const store = new EvidenceStore(":memory:", randomBytes(32));
    t.onTestFinished(() => store.close());
    const { registry, manager, coding, modelRequests } = await fixture(
      t,
      {
        async run() {
          launches++;
          // Model the uncertain pre-ID startup gap, including an uncooperative
          // process. Cancelling it cannot permit a replacement launch.
          return pending.promise;
        },
      },
      {
        store,
        source(event, audience) {
          return {
            id: event.id,
            platform: "slack",
            account: "T1",
            conversation: "D1",
            author: "U1",
            audiences: [audience],
            observedAt: event.occurredAt,
            sourceUrl: "https://example.invalid/source",
            text: event.text,
          };
        },
      },
      { reply: () => action },
    );
    coding.timeoutMs = 60000;
    const { client } = await setupTest(t, registry);
    let sequence = 0;
    const deliver = async (extra: Partial<MessageEvent> = {}) => {
      const event = { ...source, id: `lifecycle-${sequence++}`, ...extra };
      event.messageId = event.id;
      const scope = routeEvent(event, owner, true);
      if (!scope) throw new Error("Missing fixture scope");
      const actor = client.conversation.getOrCreate(scope.key);
      const key = createHash("sha256")
        .update(JSON.stringify(["slack", "T1", event.id]))
        .digest("hex");
      await actor.send("inbox", { type: "event", event });
      await expect
        .poll(async () => (await actor.snapshot()).events[key]?.done, {
          timeout: 15000,
        })
        .toBe(true);
      const state = await actor.snapshot();
      const content = state.deliveries[`${key}:text`]?.message.content;
      return { key, text: content?.type === "text" ? content.text : "" };
    };
    const available = (await deliver()).text;
    expect(available).toContain("login and provider health are not verified");
    expect(available).not.toContain("Keep native execution disabled");
    const request = modelRequests.at(-1);
    expect(request?.system).toContain("Use codingJob");
    expect(replyJsonSchema([], request).properties).toHaveProperty("codingJob");
    expect(parseReply(JSON.stringify(action), [], request)).toEqual(action);
    expect(() => parseReply(JSON.stringify(action), [])).toThrow();
    for (const codingJob of [
      { action: "approve", id: "a".repeat(64) },
      { action: "cancel", id: null },
      { action: "list", id: "a".repeat(64) },
      { action: "inspect", id: "a".repeat(11) },
    ])
      expect(() =>
        parseReply(JSON.stringify({ text: "", codingJob }), [], request),
      ).toThrow();

    action = { text: "", coding: { workspace: "june", goal: "SECRET GOAL" } };
    const proposal = await deliver();
    expect(proposal.text).toContain(`/approve ${proposal.key.slice(0, 12)}`);
    expect(launches).toBe(0);
    const job = client.job.getOrCreate([owner.id, proposal.key]);
    await expect
      .poll(async () => (await job.snapshot()).status)
      .toBe("awaiting_approval");
    action = {
      text: "",
      codingJob: { action: "inspect", id: proposal.key.slice(0, 12) },
    };
    const inspection = (await deliver()).text;
    expect(inspection).toContain('"attempts":0');
    expect(inspection).not.toContain("SECRET");
    action = { text: "", codingJob: { action: "cancel", id: proposal.key } };
    for (const extra of [
      {
        direct: false,
        botMentioned: true,
        address: { ...source.address, conversationId: "C1" },
      },
      { senderId: "U2", metadata: { channelType: "im" as const } },
    ]) {
      expect((await deliver(extra)).text).toContain("owner-private turn");
      expect(modelRequests.at(-1)?.codingJobsAvailable).toBe(false);
      expect((await job.snapshot()).cancelRequested).toBeUndefined();
    }
    action = {
      ...action,
      coding: { workspace: "june", goal: "FORBIDDEN MIX" },
    };
    await deliver();
    expect((await job.snapshot()).cancelRequested).toBeUndefined();
    action = { text: "", codingJob: { action: "cancel", id: "f".repeat(64) } };
    expect((await deliver()).text).toContain("missing or ambiguous");
    expect((await job.snapshot()).cancelRequested).toBeUndefined();
    await deliver({ text: `/approve ${proposal.key}` });
    await expect.poll(() => launches).toBe(1);
    action = { text: "", codingJob: { action: "cancel", id: proposal.key } };
    const cancellation = await deliver({ id: "cancel-native" });
    expect(cancellation.text).toContain(
      "Cancellation requested durably; not confirmed stopped",
    );
    await expect
      .poll(async () => (await job.snapshot()).status)
      .toBe("needs_review");
    await expect(manager.admit("other-job", 1)).rejects.toThrow("occupied");
    action = { text: "", codingJob: { action: "inspect", id: proposal.key } };
    const unknown = (await deliver()).text;
    expect(unknown).toContain('"cancelRequested":true');
    expect(unknown).toContain('"threadId":null');
    expect(unknown).toContain('"manualReconciliationRequired":true');
    expect(unknown).not.toContain("SECRET");
    const resume = await deliver({ text: `/resume-stopped ${proposal.key}` });
    await expect
      .poll(async () => (await job.snapshot()).commandApprovals[resume.key])
      .toBeNull();
    expect(launches).toBe(1);
    pending.resolve({ threadId: "T-late", report: "SECRET LATE REPORT" });
    await deliver({ id: "cancel-native" }); // duplicate event, never a new operation
    expect((await job.snapshot()).threadId).toBeUndefined();
    expect((await job.snapshot()).verification).toBeUndefined();
    await expect(manager.admit("other-job", 1)).rejects.toThrow("occupied");
    store.deleteSource("lifecycle-1");
    await client.conversation
      .getOrCreate(["private", owner.id])
      .forget("lifecycle-1");
    expect((await deliver()).text).toContain("missing or ambiguous");
    action = { text: "", codingJob: { action: "list", id: null } };
    expect((await deliver()).text).not.toContain(proposal.key);
    expect((await job.snapshot()).revoked).toBe(true);
  });

  it("lets June discover disabled native coding without enabling it", async (t) => {
    const { registry, modelRequests, sent } = await fixture(
      t,
      {
        async run() {
          throw new Error("must not launch");
        },
      },
      undefined,
      {
        disabled: true,
        reply: () => ({ text: "", codingJob: { action: "list", id: null } }),
      },
    );
    const { client } = await setupTest(t, registry);
    await client.conversation
      .getOrCreate(["private", owner.id])
      .send("inbox", { type: "event", event: source });
    await expect.poll(() => sent.length).toBe(1);
    expect(modelRequests[0]?.workspaces).toEqual([]);
    expect(modelRequests[0]?.codingJobsAvailable).toBe(true);
    const content = sent[0]?.content;
    const recovery = content?.type === "text" ? content.text : "";
    expect(recovery).toContain(
      "disabled or unavailable; no native execution can be requested",
    );
    expect(recovery).toContain("Configuration: an authorized operator");
    expect(recovery).toContain(
      "Authentication: unverified, not necessarily signed out",
    );
    expect(recovery).toContain("Never paste tokens into chat");
    expect(recovery).toContain("Isolation: unverified");
    expect(recovery).toContain("worktrees are not a sandbox");
    expect(recovery).toContain("native-coding preflight when available");
    expect(recovery).toContain("separate owner authorization to activate it");
    expect(recovery).toContain("no push or deployment is authorized");
    expect(modelRequests[0]?.system).toContain("how to recover it");
    expect(replyJsonSchema([], modelRequests[0]).properties.coding).toEqual({
      type: "null",
    });
    expect(
      (await client.conversation.getOrCreate(["private", owner.id]).snapshot())
        .jobs,
    ).toEqual({});
    for (const extra of [
      {
        id: "public-recovery",
        direct: false,
        botMentioned: true,
        address: { ...source.address, conversationId: "C1" },
      },
      {
        id: "guest-recovery",
        senderId: "U2",
        metadata: { channelType: "im" as const },
      },
    ]) {
      const event = { ...source, ...extra, messageId: extra.id };
      const scope = routeEvent(event, owner, true);
      if (!scope) throw new Error("Missing fixture scope");
      const count = sent.length;
      await client.conversation
        .getOrCreate(scope.key)
        .send("inbox", { type: "event", event });
      await expect.poll(() => sent.length).toBe(count + 1);
      const content = sent.at(-1)?.content;
      const text = content?.type === "text" ? content.text : "";
      expect(text).toContain("owner-private turn");
      expect(text).not.toContain("Configuration:");
      expect(modelRequests.at(-1)?.codingJobsAvailable).toBe(false);
    }
  });

  it.for([false, true])(
    "redacts pending completion after forgetting without discarding job metadata (cleanup=%s)",
    async (cleanup, t) => {
      const store = new EvidenceStore(":memory:", randomBytes(32));
      t.onTestFinished(() => store.close());
      const audience = JSON.stringify(["private", "raygen"]);
      store.appendSource({
        id: "ancestor",
        platform: "slack",
        account: "T1",
        conversation: "D1",
        author: "U1",
        audiences: [audience],
        observedAt: Date.now(),
        sourceUrl: "https://fixture.slack.com/archives/D1/p1000001",
        text: "Fix the reaction handling in June. ANCESTOR",
      });
      let completionSends = 0;
      const { registry } = await fixture(
        t,
        {
          async run() {
            return {
              threadId: "T-finished",
              report: "ANCESTOR-derived report",
            };
          },
        },
        {
          store,
          source(e, scope) {
            return {
              id: `live:${e.id}`,
              platform: "slack",
              account: "T1",
              conversation: "D1",
              author: "U1",
              audiences: [scope],
              observedAt: e.occurredAt,
              sourceUrl: "https://fixture.slack.com/archives/D1/p2000001",
              text: e.text,
            };
          },
        },
        {
          async send(message) {
            if (
              message.content.type === "text" &&
              message.content.text.startsWith("The worker reports")
            ) {
              completionSends++;
              return {
                status: "rejected",
                code: "rate_limited",
                retryable: true,
                retryAfterMs: 2000,
              };
            }
            return { status: "sent", messageId: "fixture-message" };
          },
        },
      );
      const { client } = await setupTest(t, registry);
      const june = client.conversation.getOrCreate(["private", "raygen"]);
      await june.send("inbox", { type: "event", event: source });
      await expect
        .poll(async () => Object.keys((await june.snapshot()).jobs).length, {
          timeout: 15000,
        })
        .toBe(1);
      const proposal = await june.snapshot();
      const id = Object.keys(proposal.jobs)[0];
      if (!id) throw new Error("No proposal");
      expect(proposal.memoryContexts?.[id]?.contextSourceIds).toContain(
        "ancestor",
      );
      await june.send("inbox", {
        type: "event",
        event: {
          ...source,
          id: "approve-pending",
          messageId: "200.000001",
          text: `/approve ${id}`,
        },
      });
      await expect.poll(() => completionSends, { timeout: 15000 }).toBe(1);
      const pending = Object.entries((await june.snapshot()).deliveries).find(
        ([, delivery]) =>
          delivery.message.content.type === "text" &&
          delivery.message.content.text.startsWith("The worker reports"),
      );
      if (!pending) throw new Error("Missing completion delivery");
      const [deliveryId, delivery] = pending;
      // Tombstoning commits first; runtime cleanup may fail or be delayed.
      store.deleteSource("ancestor");
      if (cleanup) await june.forget("ancestor");
      await expect
        .poll(
          async () => (await june.snapshot()).deliveries[deliveryId]?.result,
          { timeout: 15000 },
        )
        .toEqual({
          status: "rejected",
          code: "memory_invalidated",
          retryable: false,
        });
      const state = await june.snapshot();
      expect(completionSends).toBe(1);
      expect(state.deliveries[deliveryId]?.message).toEqual({
        ...delivery.message,
        content: { type: "text", text: "" },
      });
      expect(
        state.history.some(
          (entry) => entry.id === `${deliveryId.slice(0, -5)}:reply`,
        ),
      ).toBe(false);
      expect(state.jobs[id]?.workspace).toBe("june");
      expect(await june.canResumeJob(id)).toBe(false);
      expect(
        await client.job.getOrCreate(["raygen", id]).snapshot(),
      ).toMatchObject({
        status: "completed",
        attempts: 1,
        threadId: "T-finished",
        proposal: { id, workspace: "june" },
      });
    },
  );

  it.for([false, true])(
    "invalidates execution-derived coding before approval or completion (approved=%s)",
    async (approved, t) => {
      const store = new EvidenceStore(":memory:", randomBytes(32));
      const pending = Promise.withResolvers<{
        threadId: string;
        report: string;
      }>();
      t.onTestFinished(() => {
        pending.resolve({ threadId: "T-finished", report: "DELETED REPORT" });
        store.close();
      });
      const audience = JSON.stringify(["private", "raygen"]);
      store.appendSource({
        id: "ancestor",
        platform: "slack",
        account: "T1",
        conversation: "D1",
        author: "U1",
        audiences: [audience],
        observedAt: Date.now(),
        sourceUrl: "https://fixture.slack.com/archives/D1/p1000001",
        text: "Fix the reaction handling in June. ANCESTOR",
      });
      let launches = 0;
      const { registry, sent, modelRequests } = await fixture(
        t,
        {
          async run() {
            launches++;
            return pending.promise;
          },
        },
        {
          store,
          source(e, scope) {
            return {
              id: `live:${e.id}`,
              platform: "slack",
              account: "T1",
              conversation: "D1",
              author: "U1",
              audiences: [scope],
              observedAt: e.occurredAt,
              sourceUrl: "https://fixture.slack.com/archives/D1/p2000001",
              text: e.text,
            };
          },
        },
      );
      const { client } = await setupTest(t, registry);
      const june = client.conversation.getOrCreate(["private", "raygen"]);
      await june.send("inbox", { type: "event", event: source });
      await expect
        .poll(async () => Object.keys((await june.snapshot()).jobs).length, {
          timeout: 15000,
        })
        .toBe(1);
      // Repeated snapshots must not retain/nest actor read proxies in history.
      for (let i = 0; i < 10; i++) await june.snapshot();
      const snapshot = await june.snapshot();
      const id = Object.keys(snapshot.jobs)[0];
      if (!id) throw new Error("No proposal");
      expect(snapshot.memoryContexts?.[id]?.contextSourceIds).toContain(
        "ancestor",
      );
      await expect
        .poll(
          async () =>
            Object.values((await june.snapshot()).events).every((e) => e.done),
          { timeout: 15000 },
        )
        .toBe(true);
      expect(await june.canResumeJob(id)).toBe(true);
      if (!approved) {
        store.deleteSource("ancestor");
        expect(await june.canResumeJob(id)).toBe(false);
      }
      await june.send("inbox", {
        type: "event",
        event: {
          ...source,
          id: "approve-deletion",
          messageId: "200.000001",
          text: `/approve ${id}`,
        },
      });
      if (approved) {
        await expect.poll(() => launches, { timeout: 15000 }).toBe(1);
        store.deleteSource("ancestor");
        expect(await june.canResumeJob(id)).toBe(false);
        pending.resolve({ threadId: "T-finished", report: "DELETED REPORT" });
        await expect
          .poll(
            async () =>
              Object.values((await june.snapshot()).events).filter(
                (e) => e.done,
              ).length,
            { timeout: 15000 },
          )
          .toBe(4);
        expect(
          modelRequests.some((r) => r.system.includes("DELETED REPORT")),
        ).toBe(false);
        expect(
          sent.some(
            (m) =>
              m.content.type === "text" &&
              m.content.text.includes("DELETED REPORT"),
          ),
        ).toBe(false);
      } else {
        await expect
          .poll(
            async () =>
              Object.values((await june.snapshot()).events).filter(
                (e) => e.done,
              ).length,
            { timeout: 15000 },
          )
          .toBe(3);
        expect(launches).toBe(0);
        expect(
          (await client.job.getOrCreate(["raygen", id]).snapshot()).status,
        ).toBe("awaiting_approval");
      }
      expect(snapshot.jobs[id]?.preview).toContain(
        "Fix reaction handling. Run its tests.",
      );
      await june.forget("ancestor");
      const forgotten = (await june.snapshot()).jobs;
      expect(forgotten[id]?.goal).toBe("");
      expect(forgotten[id]?.preview).toBeUndefined();
      expect(JSON.stringify(forgotten)).not.toContain(
        "Fix reaction handling. Run its tests.",
      );
    },
  );

  it("requires a private approval, then reports the worker result without pretending it verified it", async (t) => {
    const launches: { prompt: string; cwd: string }[] = [];
    const { registry, sent, modelRequests, repositoryRoot, worktreeRoot } =
      await fixture(t, {
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
    await expect
      .poll(
        () =>
          sent.some(
            (m) =>
              m.content.type === "text" && m.content.text.includes("/approve"),
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    const content = sent.find(
      (m) => m.content.type === "text" && m.content.text.includes("/approve"),
    )?.content;
    expect(content).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        `Repository: ${JSON.stringify(repositoryRoot)}\nRuntime: amp`,
      ),
    });
    expect(content).toMatchObject({
      text: expect.stringContaining(
        "No push, deployment, publication, shared-infrastructure changes, or credential access is authorized.",
      ),
    });
    const approval =
      content?.type === "text"
        ? content.text.match(/\/approve ([a-f0-9]+)/)?.[1]
        : undefined;
    expect(approval).toBeTruthy();
    expect(launches).toEqual([]);
    if (!approval) throw new Error("No approval command");
    await june.send("inbox", {
      type: "event",
      event: {
        ...source,
        id: "approve1",
        messageId: "123.568",
        text: `/approve ${approval}`,
      },
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
    expect(modelRequests.at(-1)?.system).toContain(
      "Changed reactions and ran the checks.",
    );
    expect(modelRequests.at(-1)?.system).toContain(
      "Separate operator verifier: passed",
    );
    expect(modelRequests.at(-1)?.workspaces).toEqual([]);
    expect(modelRequests.at(-1)?.executionAvailable).toBe(false);
    const plannerId = (await june.snapshot()).agents?.["coding-plan"];
    if (!plannerId) throw new Error("Planner missing");
    const planner = client.execution.getOrCreate(
      executionKey(["private", "raygen"], plannerId),
    );
    expect((await planner.summary()).report).toContain(
      "Changed reactions and ran the checks.",
    );
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
      event: {
        ...source,
        id: "approve2",
        messageId: "123.569",
        text: `/approve ${approval}`,
      },
    });
    await expect
      .poll(
        async () =>
          Object.values((await june.snapshot()).events).filter(
            (record) => record.done,
          ).length,
        { timeout: 3000 },
      )
      .toBe(5);
    expect(launches).toHaveLength(1);
  });

  it("gives changed June requests separate previews without widening the original approval", async (t) => {
    const launches: { prompt: string; cwd: string }[] = [];
    const { registry, sent, coding, codingRequest, repositoryRoot } =
      await fixture(t, {
        async run(input) {
          launches.push({ prompt: input.prompt, cwd: input.cwd });
          await input.onThread("T-original-task");
          return { threadId: "T-original-task", report: "Local edits only." };
        },
      });
    // The second repository need not exist: previewing must not prepare or run it.
    coding.workspaces.other = path.join(path.dirname(repositoryRoot), "other");
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(["private", "raygen"]);
    const previews = () =>
      sent.flatMap((m) =>
        m.content.type === "text" &&
        m.content.text.startsWith("Coding proposal for ")
          ? [m.content.text]
          : [],
      );
    await june.send("inbox", { type: "event", event: source });
    await expect.poll(() => previews().length, { timeout: 15000 }).toBe(1);
    const original = previews()[0] ?? "";
    const approval = original.match(/\/approve ([a-f0-9]+)/)?.[1];
    if (!approval) throw new Error("No original approval");
    codingRequest.workspace = "other";
    codingRequest.goal = "Change the other repository, push it, and deploy it.";
    await june.send("inbox", {
      type: "event",
      event: {
        ...source,
        id: "changed-request",
        messageId: "123.570",
        text: codingRequest.goal,
      },
    });
    await expect.poll(() => previews().length, { timeout: 15000 }).toBe(2);
    const changed = previews()[1] ?? "";
    expect(changed).toContain("Coding proposal for other:");
    expect(changed).toContain(
      `Repository: ${JSON.stringify(coding.workspaces.other)}\nRuntime: amp`,
    );
    expect(changed).toContain(codingRequest.goal);
    expect(changed).toContain(
      "No push, deployment, publication, shared-infrastructure changes, or credential access is authorized.",
    );
    expect(changed.match(/\/approve ([a-f0-9]+)/)?.[1]).not.toBe(approval);
    expect(launches).toEqual([]);
    await june.send("inbox", {
      type: "event",
      event: {
        ...source,
        id: "approve-original",
        messageId: "123.571",
        text: `/approve ${approval}`,
      },
    });
    await expect.poll(() => launches.length, { timeout: 5000 }).toBe(1);
    expect(launches[0]?.prompt).toContain(
      "Fix reaction handling. Run its tests.",
    );
    expect(launches[0]?.prompt).not.toContain(codingRequest.goal);
    expect(launches[0]?.prompt).toContain("Do not push, deploy, publish");
    const jobs = Object.keys((await june.snapshot()).jobs);
    const originalId = jobs.find((id) => id.startsWith(approval));
    const changedId = jobs.find((id) => !id.startsWith(approval));
    if (!originalId || !changedId) throw new Error("Missing proposals");
    const originalJob = client.job.getOrCreate(["raygen", originalId]);
    await expect
      .poll(async () => (await originalJob.snapshot()).status)
      .toBe("completed");
    expect((await originalJob.snapshot()).worktree?.repositoryRoot).toBe(
      repositoryRoot,
    );
    expect(
      (await client.job.getOrCreate(["raygen", changedId]).snapshot()).status,
    ).toBe("awaiting_approval");
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
        runtimeId: "fixture-runtime-v1",
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

  it("rejects approvals and resumes under a different runtime binding without releasing admission", async (t) => {
    let launches = 0;
    const { registry, coding, manager } = await fixture(t, {
      async run(input) {
        launches++;
        await input.onThread("T-original-runtime");
        throw new Error("Unknown completion");
      },
    });
    const { client } = await setupTest(t, registry);
    const job = client.job.getOrCreate(["raygen", "bound-runtime"]);
    // Simulate a config change between the preview and queued proposal delivery.
    coding.runtimeId = "different-runtime";
    await job.send("commands", {
      type: "propose",
      proposal: {
        id: "bound-runtime",
        runtimeId: "fixture-runtime-v1",
        source,
        workspace: "june",
        goal: "Task",
      },
    });
    await expect
      .poll(async () => (await job.snapshot()).runtimeId)
      .toBe("fixture-runtime-v1");
    await job.send("commands", {
      type: "approve",
      commandId: "wrong-approval",
    });
    await expect
      .poll(
        async () => (await job.snapshot()).commandApprovals["wrong-approval"],
      )
      .toBeNull();
    expect(launches).toBe(0);
    coding.runtimeId = "fixture-runtime-v1";
    await job.send("commands", {
      type: "approve",
      commandId: "original-approval",
    });
    await expect
      .poll(async () => (await job.snapshot()).status)
      .toBe("needs_review");
    expect(launches).toBe(1);
    coding.runtimeId = "different-runtime";
    await job.send("commands", {
      type: "resume",
      commandId: "wrong-resume",
      confirmedStopped: true,
    });
    await expect
      .poll(async () => (await job.snapshot()).commandApprovals["wrong-resume"])
      .toBeNull();
    expect(launches).toBe(1);
    expect((await job.snapshot()).threadId).toBe("T-original-runtime");
    await expect(manager.admit("other-job", 1)).rejects.toThrow("occupied");
  });

  it("keeps revocation when forgetting overtakes a queued proposal", async (t) => {
    let launches = 0;
    const { registry } = await fixture(t, {
      async run() {
        launches++;
        throw new Error("Revoked work must not start");
      },
    });
    const { client } = await setupTest(t, registry);
    const job = client.job.getOrCreate(["raygen", "forgotten-proposal"]);
    await job.cancel(true);
    await job.send("commands", {
      type: "propose",
      proposal: {
        id: "forgotten-proposal",
        runtimeId: "fixture-runtime-v1",
        source,
        workspace: "june",
        goal: "Deleted task",
      },
    });
    await job.send("commands", { type: "approve", commandId: "old-approval" });
    await expect
      .poll(async () => (await job.snapshot()).commandApprovals["old-approval"])
      .toBeNull();
    expect((await job.snapshot()).proposal).toBeNull();
    expect((await job.snapshot()).revoked).toBe(true);
    expect(launches).toBe(0);
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
        runtimeId: "fixture-runtime-v1",
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

  it.for(["T-cancelled", undefined])(
    "cancels an uncooperative runtime without releasing uncertain execution capacity (saved ID=%s)",
    async (threadId, t) => {
      let launches = 0;
      let lateThread: ((thread: string) => Promise<void>) | undefined;
      const { registry, manager } = await fixture(t, {
        async run(input) {
          launches++;
          lateThread = input.onThread;
          if (threadId) await input.onThread(threadId);
          return new Promise<never>(() => {});
        },
      });
      const { client } = await setupTest(t, registry);
      const job = client.job.getOrCreate(["raygen", "cancelled"]);
      await job.send("commands", {
        type: "propose",
        proposal: {
          id: "cancelled",
          runtimeId: "fixture-runtime-v1",
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
      expect((await job.snapshot()).threadId).toBe(threadId);
      if (!threadId) {
        expect((await job.snapshot()).report).toContain(
          "No native session/thread ID was saved",
        );
        expect((await job.snapshot()).report).toContain(
          "/resume-stopped cannot resume this job",
        );
      }
      await expect(manager.admit("other-job", 1)).rejects.toThrow("occupied");
      await job.send("commands", { type: "approve", commandId: "approval" });
      await expect
        .poll(async () => (await job.snapshot()).cancelRequested)
        .toBe(true);
      expect(launches).toBe(1);
      expect((await job.snapshot()).verification).toBeUndefined();
      await job.cancel(true);
      await job.send("commands", {
        type: "resume",
        commandId: "revoked-resume",
        confirmedStopped: true,
      });
      await expect
        .poll(
          async () => (await job.snapshot()).commandApprovals["revoked-resume"],
        )
        .toBeNull();
      expect(launches).toBe(1);
      expect((await job.snapshot()).cancelRequested).toBe(true);
      await expect(manager.admit("other-job", 1)).rejects.toThrow("occupied");
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
    },
  );

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
          runtimeId: "fixture-runtime-v1",
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
        runtimeId: "fixture-runtime-v1",
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
