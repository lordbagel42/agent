import { randomBytes } from "node:crypto";
import type { Client } from "rivetkit/client";
import { expect, it, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  CodingRuntime,
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import type { SkillChangeProposal } from "../reflection/domain.js";
import { type CodingDependencies, skillCodingRequest } from "./coding.js";
import {
  createJuneRegistry,
  type Dependencies,
  type JuneClientRegistry,
} from "./registry.js";

// Pause only the real job consumer, not reflection's shared lifecycle admission.
const jobGate = vi.hoisted(() => ({
  enter: undefined as undefined | (() => Promise<void>),
  exit: undefined as undefined | (() => void),
}));
vi.mock("./coding.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./coding.js")>();
  return {
    ...real,
    createCodingActor: (
      ...[coding, lifecycle, current, deletionRevision]: Parameters<
        typeof real.createCodingActor
      >
    ) =>
      real.createCodingActor(
        coding,
        {
          async enter(signal) {
            await jobGate.enter?.();
            const release = await lifecycle?.enter(signal);
            return () => {
              release?.();
              jobGate.exit?.();
            };
          },
          fail: () => lifecycle?.fail(),
        },
        current,
        deletionRevision,
      ),
  };
});

it("allows only an enabled exact candidate and permitted workspace, never supplied authority", () => {
  const capability = { skillCodingProposalAvailable: true };
  const action = { candidateId: "a".repeat(64), workspace: "june" };
  const reply = { text: "", skillCodingProposal: action };
  expect(parseReply(JSON.stringify(reply), ["june"], capability)).toEqual(
    reply,
  );
  expect(replyJsonSchema(["june"], capability).properties).toHaveProperty(
    "skillCodingProposal",
  );
  expect(replyJsonSchema(["june"]).properties).not.toHaveProperty(
    "skillCodingProposal",
  );
  expect(replyJsonSchema([], capability).properties).not.toHaveProperty(
    "skillCodingProposal",
  );
  expect(() => parseReply(JSON.stringify(reply), ["june"])).toThrow();
  expect(() => parseReply(JSON.stringify(reply), [], capability)).toThrow();
  for (const value of [
    { ...reply, text: "already approved" },
    { ...reply, coding: { workspace: "june", goal: "run a different task" } },
    { ...reply, reaction: "thumbsup" },
    {
      ...reply,
      skillCodingProposal: { ...action, candidateId: "a".repeat(12) },
    },
    { ...reply, skillCodingProposal: { ...action, workspace: "foreign" } },
    ...["goal", "digest", "approved", "scope"].map((key) => ({
      ...reply,
      skillCodingProposal: { ...action, [key]: "model supplied" },
    })),
  ])
    expect(() =>
      parseReply(JSON.stringify(value), ["june"], capability),
    ).toThrow();
});

it("copies evaluated behavior exactly and keeps identity independent of workspace or evaluation attempts", () => {
  const skill: SkillChangeProposal = {
    id: "a".repeat(64),
    digest: "b".repeat(64),
    proposedBehavior: `  Preserve meaningful whitespace.\n${"x".repeat(1166)}`,
    rationale: "PRIVATE RATIONALE NOT NEEDED BY CODING",
    evidenceIds: ["training-b", "training-a"],
    createdAt: 1,
    hypothesisOnly: true,
  };
  expect(skill.proposedBehavior).toHaveLength(1200);
  const request = skillCodingRequest("owner", "june", skill);
  expect(request?.goal.endsWith(skill.proposedBehavior)).toBe(true);
  expect(request?.goal).toContain(skill.digest);
  expect(request?.goal).not.toContain(skill.rationale);
  expect(request?.goal.length).toBeLessThanOrEqual(2000);
  expect(request?.id).toMatch(/^[a-f0-9]{64}$/);
  expect(skillCodingRequest("owner", "other", skill)?.id).toBe(request?.id);
  expect(skillCodingRequest("other-owner", "june", skill)?.id).not.toBe(
    request?.id,
  );
  expect(
    skillCodingRequest("owner", "june", { ...skill, id: "c".repeat(64) })?.id,
  ).not.toBe(request?.id);
  expect(
    skillCodingRequest("owner", "june", {
      ...skill,
      proposedBehavior: "x".repeat(2001),
    }),
  ).toBeNull(); // Never truncate a scope into a different reviewed task.
});

it.for([
  "current",
  "delegated",
  "deleted-before-save",
  "deleted-before-enqueue",
  "quiet-before-enqueue",
  "deleted-during-handoff",
  "deleted-during-consumer-read",
] as const)(
  "admits June's fresh evaluated task once without stale provenance (%s)",
  async (boundary, t) => {
    const owner = {
      id: "owner",
      identities: [
        { channel: "slack" as const, accountId: "T1", senderId: "U1" },
      ],
    };
    const scope = JSON.stringify(["private", owner.id]);
    const store = new EvidenceStore(":memory:", randomBytes(32));
    t.onTestFinished(() => store.close());
    for (const id of ["training-a", "training-b", "held-a", "held-b", "origin"])
      store.appendSource({
        id,
        audiences: [scope],
        platform: "slack",
        account: "T1",
        conversation: "D1",
        author: "U1",
        observedAt: Date.now(),
        sourceUrl: `https://example.test/${id}`,
        text: `Private evidence ${id}`,
      });
    const sent: OutboundMessage[] = [];
    const modelRequests: ModelRequest[] = [];
    const executionRequests: ModelRequest[] = [];
    let action: CompanionReply = {
      text: "",
      reflectionRequest: {
        evidenceIds: ["training-a", "training-b"],
        mode: "deep",
      },
    };
    let afterRetrieve: ((evidenceIds: string[]) => void) | undefined;
    let beforeReply: (() => Promise<void>) | undefined;
    const quiet = { timeZone: "UTC", startMinute: 0, endMinute: 0 };
    const handoff = Promise.withResolvers<void>();
    const handoffFinished = Promise.withResolvers<void>();
    const worker = Promise.withResolvers<void>();
    let jobEntered = false;
    t.onTestFinished(() => {
      handoff.resolve();
      worker.resolve();
      jobGate.enter = undefined;
      jobGate.exit = undefined;
    });
    // Model the isolation adapter without touching Git or launching real processes.
    type Isolation = NonNullable<CodingDependencies["isolation"]>[string];
    const isolation: Isolation = {
      checkArtifact: async () => null,
      isSettled: async () => true,
      diffSummary: async () => {
        throw new Error("This fixture does not inspect worktree diffs");
      },
      capacity: async () => ({ occupied: false, admissionLocked: false }),
      admit: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
      prepare: vi.fn<Isolation["prepare"]>(async (jobId) => ({
        disposition: "created",
        manifest: {
          version: 1,
          jobId,
          repositoryRoot: "/fixture/june",
          worktreeRoot: "/fixture/worktrees",
          cwd: `/fixture/worktrees/${jobId}`,
          baseCommit: "a".repeat(40),
        },
      })),
      verify: vi.fn<Isolation["verify"]>(async () => ({
        status: "not_configured",
        passed: null,
        exitCode: null,
        signal: null,
        baseCommit: "a".repeat(40),
        headCommit: "a".repeat(40),
        finishedAt: new Date().toISOString(),
        replayed: false,
        output: "omitted",
      })),
    };
    const run = vi.fn<CodingRuntime["run"]>(async (input) => {
      expect(input.cwd).toMatch(/^\/fixture\/worktrees\/[a-f0-9]{64}$/);
      expect(input.prompt).toContain("do not change permissions");
      await input.onThread("fixture-thread");
      await worker.promise;
      return { threadId: "fixture-thread", report: "Fixture worker result" };
    });
    const deps: Dependencies = {
      owner,
      memory: { store, source: () => undefined },
      coding: {
        runtime: { run },
        runtimeKind: "amp",
        runtimeId: "original-runtime",
        workspaces: { june: "/fixture/june", other: "/fixture/other" },
        isolation: { june: isolation },
        timeoutMs: 60000,
      },
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, reactions: true, threads: true },
          async receive() {
            return { response: new Response(), events: [] };
          },
          async send(message) {
            sent.push(JSON.parse(JSON.stringify(message)));
            return { status: "sent", messageId: `out-${sent.length}` };
          },
        },
      },
      model: {
        async reply(request) {
          modelRequests.push(request);
          if (request.system.includes("Coding completion ("))
            return { text: "Coding outcome noted." };
          if (request.skillCodingProposalAvailable)
            expect(request.system).toContain("skillCodingProposal");
          await beforeReply?.();
          if (request.agentRole === "interaction")
            return request.system.includes("Execution completion")
              ? { text: "" }
              : {
                  text: "Checking the evaluated skill.",
                  execution: [
                    {
                      agent: "skill",
                      action: "run",
                      task: "Prepare the evaluated skill proposal.",
                    },
                  ],
                };
          return structuredClone(action);
        },
      },
      reflection: {
        ownerId: owner.id,
        policy: {
          totalCapacity: 2,
          liveReserve: 1,
          cooldownMs: 1,
          maxAttempts: 1,
          maxNoNewEvidence: 1,
          evidenceMaxAgeMs: 60000,
          quiet,
        },
        idleMs: 10,
        deepMs: 20,
        pollMs: 20,
        timeoutMs: 1000,
        evidenceCurrent: (audience, evidence) =>
          audience === scope &&
          JSON.stringify(
            store.reflectionEvidence(
              audience,
              evidence.map((e) => e.id),
              60000,
            ),
          ) === JSON.stringify(evidence),
        async retrieve({ scope: audience, evidenceIds }) {
          const evidence = store.reflectionEvidence(
            audience,
            evidenceIds,
            60000,
          );
          afterRetrieve?.(evidenceIds);
          return { authorized: audience === scope, evidence };
        },
        async decide(input) {
          return {
            answer: "yes",
            rationale: "Grounded fixture comparison, not a permission grant.",
            evidenceIds: input.evidence.map((e) => e.id),
            ...(input.simulateResponses
              ? {
                  alternativeResponses: [
                    "Hypothetical: ask about the missing detail.",
                  ],
                  skillChange: {
                    proposedBehavior:
                      "Ask about missing details before estimating.",
                    rationale: "PRIVATE rationale is not a coding task.",
                    evidenceIds: ["training-a"],
                  },
                }
              : {}),
          };
        },
      },
    };
    const { client } = await setupTest(t, createJuneRegistry(deps));
    const reflection = (
      client as Client<JuneClientRegistry>
    ).reflection.getOrCreate([owner.id]);
    const conversation = client.conversation.getOrCreate(["private", owner.id]);
    let serial = 0;
    const turn = async (
      extra: Partial<MessageEvent> = {},
      expectDelivery = true,
    ) => {
      const before = sent.length;
      const event: MessageEvent = {
        id: `turn-${++serial}`,
        type: "message",
        messageId: `ts-${serial}`,
        occurredAt: Date.now(),
        address: { channel: "slack", accountId: "T1", conversationId: "D1" },
        senderId: "U1",
        direct: true,
        metadata: { channelType: "im" },
        text: "Private evidence origin",
        ...extra,
      };
      const route = routeEvent(event, owner, true);
      if (!route) throw new Error("Invalid fixture route");
      const actor = client.conversation.getOrCreate(route.key);
      await actor.send("inbox", { type: "event", event });
      await expect
        .poll(
          async () =>
            Object.values((await actor.snapshot()).events).find(
              (record) => record.event.id === event.id,
            )?.done,
          { timeout: 5000 },
        )
        .toBe(true);
      if (expectDelivery)
        await expect
          .poll(() => sent.length, { timeout: 5000 })
          .toBeGreaterThan(before + (deps.execution ? 1 : 0));
      const content = sent.at(-1)?.content;
      return content?.type === "text" ? content.text : "";
    };
    expect(await turn()).toContain("Reflection queued");
    await expect
      .poll(
        async () =>
          (await reflection.reviewCandidates(scope))?.references.length,
        { timeout: 5000 },
      )
      .toBe(1);
    const candidateId = (await reflection.reviewCandidates(scope))
      ?.references[0]?.id;
    if (!candidateId) throw new Error("Missing generated candidate");
    action = {
      text: "",
      skillCodingProposal: { candidateId, workspace: "june" },
    };
    expect(await turn()).toContain("No skill coding task was queued");
    expect((await conversation.snapshot()).jobs).toEqual({});
    action = {
      text: "",
      skillEvaluationRequest: {
        candidateId,
        heldOutEvidenceIds: ["held-b", "held-a"],
      },
    };
    await turn();
    await expect
      .poll(
        async () =>
          (await reflection.skillEvaluation(candidateId, scope))?.eligible,
        { timeout: 5000 },
      )
      .toBe(true);
    const evaluated = await reflection.skillEvaluation(candidateId, scope);
    const skill = evaluated?.candidate.skillChange;
    if (!skill) throw new Error("Missing evaluated skill");
    action = {
      text: "",
      skillCodingProposal: { candidateId, workspace: "june" },
    };
    if (boundary === "delegated")
      deps.execution = {
        model: {
          async reply(request) {
            executionRequests.push(request);
            expect(request.agentRole).toBe("execution");
            expect(request.skillCodingProposalAvailable).toBe(true);
            return structuredClone(action);
          },
        },
      };
    if (boundary !== "current" && boundary !== "delegated") {
      let unionReads = 0;
      const invalidatingRead =
        boundary === "deleted-before-save"
          ? 1
          : boundary === "deleted-during-consumer-read"
            ? 3
            : 2;
      if (boundary === "deleted-during-consumer-read")
        jobGate.exit = () => handoffFinished.resolve();
      afterRetrieve = (evidenceIds) => {
        if (!evidenceIds.includes("held-a")) return;
        if (++unionReads !== invalidatingRead) return;
        if (boundary === "deleted-during-handoff") {
          jobGate.enter = async () => {
            jobEntered = true;
            await handoff.promise;
          };
          jobGate.exit = () => handoffFinished.resolve();
        } else if (boundary === "quiet-before-enqueue") {
          const now = new Date();
          const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
          quiet.startMinute = (minute + 1439) % 1440;
          quiet.endMinute = (minute + 2) % 1440;
        } else store.deleteSource("origin");
        afterRetrieve = undefined;
      };
      const text = await turn(
        {},
        boundary === "quiet-before-enqueue" ||
          boundary === "deleted-during-handoff",
      );
      if (boundary === "deleted-during-handoff") {
        await expect.poll(() => jobEntered).toBe(true);
        store.deleteSource("origin");
        handoff.resolve();
        await handoffFinished.promise;
      }
      if (boundary === "deleted-during-consumer-read")
        await handoffFinished.promise;
      expect(unionReads).toBe(invalidatingRead);
      const id = skillCodingRequest(owner.id, "june", skill)?.id;
      if (!id) throw new Error("Missing fixture identity");
      const snapshot = await client.job.getOrCreate([owner.id, id]).snapshot();
      expect(snapshot).toMatchObject({ status: "empty", attempts: 0 });
      expect(snapshot.proposal).toBeNull();
      if (boundary === "deleted-before-save")
        expect((await conversation.snapshot()).jobs).toEqual({});
      if (boundary === "quiet-before-enqueue")
        expect(text).toContain("No skill coding task was queued");
      else expect(await conversation.canResumeJob(id)).toBe(false);
      expect(run).not.toHaveBeenCalled();
      return;
    }
    const settled = Promise.withResolvers<void>();
    t.onTestFinished(() => settled.resolve());
    beforeReply = () => settled.promise;
    const before = modelRequests.length;
    const pending = turn();
    await expect.poll(() => modelRequests.length).toBe(before + 1);
    expect((await conversation.snapshot()).jobs).toEqual({});
    expect((await reflection.status()).liveActive).toBe(1);
    settled.resolve();
    const preview = await pending;
    beforeReply = undefined;
    expect(preview).toContain(skill.proposedBehavior);
    expect(preview).toContain("No separate approval command is required");
    expect(preview).toContain(
      "do not change permissions, access credentials, push, publish or deploy",
    );
    const state = await conversation.snapshot();
    const ids = Object.keys(state.jobs);
    expect(ids).toHaveLength(1);
    const id = ids[0] as string;
    expect(state.memoryContexts?.[id]?.sourceIds).toEqual(
      expect.arrayContaining([
        "training-a",
        "training-b",
        "held-a",
        "held-b",
        "origin",
      ]),
    );
    const job = client.job.getOrCreate([owner.id, id]);
    await expect.poll(() => run.mock.calls.length).toBe(1);
    await expect
      .poll(async () => (await job.snapshot()).status)
      .toBe("running");
    expect(await job.snapshot()).toMatchObject({
      attempts: 1,
      commandApprovals: { [`model-selected:${id}`]: 1 },
      proposal: {
        runtimeId: "original-runtime",
        workspace: "june",
        runImmediately: true,
        conversationKey: ["private", owner.id],
      },
      worktree: {
        repositoryRoot: "/fixture/june",
        cwd: `/fixture/worktrees/${id}`,
      },
    });
    expect(isolation.admit).toHaveBeenCalledTimes(1);
    expect(isolation.prepare).toHaveBeenCalledTimes(1);
    expect(await turn()).toBe(preview);
    action.skillCodingProposal = { candidateId, workspace: "other" };
    expect(await turn()).toContain("no retargeting or second job");
    expect((await conversation.snapshot()).jobs).toEqual(state.jobs);
    action.skillCodingProposal.workspace = "june";
    if (deps.coding) deps.coding.runtimeId = "changed-runtime";
    expect(await turn()).toBe(preview);
    expect((await job.snapshot()).proposal?.runtimeId).toBe("original-runtime");
    // Available task tools cannot reuse a private candidate from another scope.
    // In delegated mode the task belongs to execution, not its interaction recap.
    const taskRequests = deps.execution ? executionRequests : modelRequests;
    expect(await turn({ senderId: "U2" })).toContain(
      "No skill coding task was queued",
    );
    expect(taskRequests.at(-1)?.skillCodingProposalAvailable).toBe(true);
    expect(
      await turn({ direct: false, metadata: { channelType: "channel" } }),
    ).toContain("No skill coding task was queued");
    expect(taskRequests.at(-1)?.skillCodingProposalAvailable).toBe(true);
    expect((await conversation.snapshot()).jobs).toEqual(state.jobs);
    // An unrelated original conversation source disappears while the authoritative
    // RPC is suspended. Evaluation evidence is still valid; original context is not.
    const deleted = Promise.withResolvers<void>();
    afterRetrieve = () => {
      store.deleteSource("origin");
      afterRetrieve = undefined;
      deleted.resolve();
    };
    await turn({}, false);
    // Interaction completion is not execution completion. Await the actual read
    // boundary, as with the handoff gates, before asserting deletion fences.
    await deleted.promise;
    expect(afterRetrieve).toBeUndefined();
    expect(await conversation.canResumeJob(id)).toBe(false);
    worker.resolve();
    await expect
      .poll(async () => (await job.snapshot()).status)
      .toBe("needs_review");
    expect((await job.snapshot()).attempts).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(isolation.verify).toHaveBeenCalledTimes(1);
    expect(isolation.release).toHaveBeenCalledTimes(1);
  },
);
