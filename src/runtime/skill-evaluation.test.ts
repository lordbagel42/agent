import { randomBytes } from "node:crypto";
import type { Client } from "rivetkit/client";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import {
  DecisionExecutor,
  type DecisionInput,
} from "../reflection/evaluator.js";
import {
  createJuneRegistry,
  type Dependencies,
  type JuneClientRegistry,
} from "./registry.js";

it("mounts scoped exclusive held-out requests, never accepts candidate content or authority", async (t) => {
  const owner = {
    id: "owner",
    identities: [{ channel: "slack" as const, accountId: "T", senderId: "U" }],
  };
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const sent: OutboundMessage[] = [];
  const requests: ModelRequest[] = [];
  const action: CompanionReply = {
    text: "",
    skillEvaluationRequest: {
      candidateId: "a".repeat(64),
      heldOutEvidenceIds: ["held-a", "held-b"],
    },
  };
  const deps: Dependencies = {
    owner,
    memory: { store, source: () => undefined },
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
        requests.push(request);
        return action;
      },
    },
    reflection: {
      ownerId: owner.id,
      policy: {
        totalCapacity: 2,
        liveReserve: 1,
        cooldownMs: 0,
        maxAttempts: 1,
        maxNoNewEvidence: 10,
        evidenceMaxAgeMs: 60000,
        quiet: { timeZone: "UTC", startMinute: 0, endMinute: 0 },
      },
      idleMs: 10,
      deepMs: 20,
      pollMs: 20,
      timeoutMs: 1000,
      async retrieve() {
        return { authorized: false, evidence: [] };
      },
      async decide() {
        throw new Error("No evaluator call allowed for nonexistent candidate");
      },
    },
  };
  const { client } = await setupTest(t, createJuneRegistry(deps));
  const reflection = (
    client as Client<JuneClientRegistry>
  ).reflection.getOrCreate([owner.id]);
  let sequence = 0;
  const deliver = async (direct: boolean) => {
    const event: MessageEvent = {
      id: `skill-request-${++sequence}`,
      type: "message",
      messageId: `ts-${sequence}`,
      occurredAt: Date.now(),
      address: {
        channel: "slack",
        accountId: "T",
        conversationId: direct ? "D" : "C",
      },
      direct,
      senderId: "U",
      text: "Evaluate the retained candidate using separate examples.",
    };
    const routed = routeEvent(event, owner);
    if (!routed) throw new Error("Missing fixture route");
    const conversation = client.conversation.getOrCreate(routed.key);
    await conversation.send("inbox", { type: "event", event });
    await expect
      .poll(
        async () =>
          Object.values((await conversation.snapshot()).events).some(
            (e) => e.done,
          ),
        { timeout: 10000 },
      )
      .toBe(true);
    await expect.poll(() => sent.length, { timeout: 10000 }).toBe(sequence);
  };
  await deliver(true);
  expect(requests[0]?.skillEvaluationRequestAvailable).toBe(true);
  expect(sent.at(-1)?.content).toMatchObject({
    type: "text",
    text: expect.stringContaining("unavailable"),
  });
  expect((await reflection.status()).reflection.requests).toHaveLength(0);
  expect((await reflection.status()).liveActive).toBe(0);
  await deliver(false);
  expect(requests.at(-1)?.skillEvaluationRequestAvailable).toBe(true);
  expect(sent.at(-1)?.content).toMatchObject({
    type: "text",
    text: expect.stringContaining("unavailable"),
  });
  expect((await reflection.status()).reflection.requests).toHaveLength(0);

  const capabilities = { skillEvaluationRequestAvailable: true };
  expect(replyJsonSchema([], capabilities).properties).toHaveProperty(
    "skillEvaluationRequest",
  );
  expect(replyJsonSchema([], {}).properties).not.toHaveProperty(
    "skillEvaluationRequest",
  );
  expect(parseReply(JSON.stringify(action), [], capabilities)).toEqual(action);
  for (const value of [
    { ...action, text: "approved" },
    { ...action, coding: { workspace: "workspace", goal: "install" } },
    {
      ...action,
      skillEvaluationRequest: {
        ...action.skillEvaluationRequest,
        digest: "b".repeat(64),
      },
    },
    {
      ...action,
      skillEvaluationRequest: {
        ...action.skillEvaluationRequest,
        proposedBehavior: "replace it",
      },
    },
    {
      ...action,
      skillEvaluationRequest: {
        ...action.skillEvaluationRequest,
        heldOutEvidenceIds: ["x", "x"],
      },
    },
    {
      ...action,
      skillEvaluationRequest: {
        ...action.skillEvaluationRequest,
        heldOutEvidenceIds: ["x"],
      },
    },
    {
      ...action,
      skillEvaluationRequest: {
        ...action.skillEvaluationRequest,
        heldOutEvidenceIds: ["a", "b", "c", "d", "e", "f"],
      },
    },
  ])
    expect(() =>
      parseReply(JSON.stringify(value), ["workspace"], capabilities),
    ).toThrow();
  expect(() => parseReply(JSON.stringify(action), [], {})).toThrow();
});

it("evaluates the immutable proposal after inference settles and preserves each asymmetric outcome", async (t) => {
  const owner = {
    id: "owner",
    identities: [{ channel: "slack" as const, accountId: "T", senderId: "U" }],
  };
  const scope = JSON.stringify(["private", owner.id]);
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const sources = {
    "train-a":
      "PRIVATE training: answer a question before offering optional details.",
    "train-b": "PRIVATE additional training not cited in the proposal.",
    "train-next": "PRIVATE second training: prioritize the requested result.",
    "train-abort":
      "PRIVATE cancellation training: keep the first answer short.",
    "held-a":
      "Baseline buries the requested answer after 300 words. Desired outcome is the answer first.",
    "held-b":
      "Baseline confirms recipient identity before exposing a secret. Desired outcome requires that check, not an immediate answer.",
    "held-c":
      "Baseline skips a safety constraint. Desired outcome preserves the constraint.",
    "held-d":
      "Baseline omits uncertainty. Desired outcome reports uncertainty.",
    "held-e":
      "Baseline gives unrelated history first. Desired outcome gives the requested date first.",
    "held-abort-a":
      "Baseline delays the requested number. Desired outcome gives that number first.",
    "held-abort-b":
      "Baseline obscures the requested location. Desired outcome leads with the location.",
  };
  for (const [id, text] of Object.entries(sources))
    store.appendSource({
      id,
      audiences: [scope],
      platform: "slack",
      account: "T",
      conversation: "D",
      author: "U",
      observedAt: Date.now(),
      sourceUrl: `https://example.com/${id}`,
      text,
    });
  const seen: DecisionInput[] = [];
  const sent: OutboundMessage[] = [];
  const denied = new Set<string>();
  const quiet = { timeZone: "UTC", startMinute: 0, endMinute: 0 };
  let modelCalls = 0;
  let releaseReply = () => {};
  t.onTestFinished(() => releaseReply());
  let holdEvaluation = false;
  let providerSignal: AbortSignal | undefined;
  let releaseEvaluation = () => {};
  t.onTestFinished(() => releaseEvaluation());
  let reviewId: string | undefined;
  let reviewAttack = false;
  let revokeReview: (() => void) | undefined;
  const reviewRequests: ModelRequest[] = [];
  const action: CompanionReply = { text: "" };
  const executor = new DecisionExecutor(1, 2000);
  const deps: Dependencies = {
    owner,
    memory: { store, source: () => undefined },
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
        if (reviewId) {
          if (request.usageStage !== "synthesis") {
            expect(request.reflectionReviewAvailable).toBe(true);
            return {
              text: "",
              reflectionReview: { action: "inspect", id: reviewId },
            };
          }
          reviewRequests.push(request);
          expect(request.workspaces).toEqual([]);
          expect(
            Object.entries(request).filter(
              ([key, value]) => key.endsWith("Available") && value === true,
            ),
          ).toEqual([]);
          revokeReview?.();
          return {
            text: "PRIVATE evaluated receipt synthesis.",
            ...(reviewAttack
              ? {
                  skillEvaluationRequest: {
                    candidateId: reviewId,
                    heldOutEvidenceIds: ["held-a", "held-e"],
                  },
                }
              : {}),
          };
        }
        expect(request.skillEvaluationRequestAvailable).toBe(true);
        modelCalls++;
        await new Promise<void>((resolve) => {
          releaseReply = resolve;
        });
        return action;
      },
    },
    reflection: {
      ownerId: owner.id,
      policy: {
        totalCapacity: 2,
        liveReserve: 1,
        cooldownMs: 0,
        maxAttempts: 3,
        maxNoNewEvidence: 1,
        evidenceMaxAgeMs: 60000,
        quiet,
      },
      idleMs: 10,
      deepMs: 20,
      pollMs: 20,
      timeoutMs: 3000,
      evidenceCurrent(requestedScope, evidence) {
        return (
          requestedScope === scope &&
          !evidence.some((e) => denied.has(e.id)) &&
          JSON.stringify(
            store.reflectionEvidence(
              scope,
              evidence.map((e) => e.id),
              60000,
            ),
          ) === JSON.stringify(evidence)
        );
      },
      async retrieve({ scope: requestedScope, evidenceIds }) {
        return {
          authorized:
            requestedScope === scope &&
            !evidenceIds.some((id) => denied.has(id)),
          evidence: store.reflectionEvidence(
            requestedScope,
            evidenceIds,
            60000,
          ),
        };
      },
      decide: (input, signal) =>
        executor.evaluateSettled(
          input,
          async (context, callSignal) => {
            seen.push(structuredClone(context));
            if (context.question === "novelty")
              return {
                answer: "yes",
                rationale:
                  "Use the original cases to suggest answer-first formatting.",
                evidenceIds: [context.evidence[0]?.id ?? ""],
                alternativeResponses: [
                  "Answer first, followed by optional context.",
                ],
                skillChange: {
                  proposedBehavior:
                    "Give the requested answer before optional background.",
                  rationale:
                    "The first training episode favors answer-first formatting.",
                  evidenceIds: [context.evidence[0]?.id ?? ""],
                },
              };
            expect(context.question).toBe("skill-improvement");
            expect(context.evidence).toHaveLength(1);
            expect(context.prior).toBeUndefined();
            expect(JSON.stringify(context)).not.toContain("PRIVATE");
            if (holdEvaluation) {
              providerSignal = callSignal;
              await new Promise<void>((resolve) => {
                releaseEvaluation = resolve;
              });
            }
            const id = context.evidence[0]?.id;
            if (id === "held-c") throw new Error("PRIVATE provider error");
            return {
              answer: id === "held-b" ? "no" : "yes",
              rationale:
                id === "held-b"
                  ? "Regresses recipient checking."
                  : "Supported improvement.",
              evidenceIds: [id === "held-d" ? "train-a" : (id ?? "")],
            };
          },
          signal,
        ),
    },
  };
  const { client } = await setupTest(t, createJuneRegistry(deps));
  const reflection = (
    client as Client<JuneClientRegistry>
  ).reflection.getOrCreate([owner.id]);
  await reflection.enqueue({
    scope,
    evidenceIds: ["train-a", "train-b"],
    kind: "reflection",
    mode: "deep",
  });
  await expect
    .poll(async () => (await reflection.listCandidates(scope)).ids.length, {
      timeout: 10000,
    })
    .toBe(1);
  const alias = (await reflection.listCandidates(scope)).ids[0];
  if (!alias) throw new Error("Missing candidate");
  const candidateRead = await reflection.candidate(alias, scope);
  if (!candidateRead) throw new Error("Missing candidate read");
  const { evidenceIds: trainingIds, ...candidate } = candidateRead;
  expect(trainingIds).toEqual(["train-a", "train-b"]);
  expect(candidate).toHaveProperty(
    "skillChange.proposedBehavior",
    "Give the requested answer before optional background.",
  );
  expect(seen[0]?.evidence.map((e) => e.id)).toEqual(["train-a", "train-b"]);
  expect(
    await reflection.requestSkillEvaluation(
      {
        candidateId: alias,
        heldOutEvidenceIds: ["train-b", "held-a"],
      },
      store.deletionRevision(),
    ),
  ).toMatchObject({ status: "unavailable" });
  expect(seen).toHaveLength(1);
  action.skillEvaluationRequest = {
    candidateId: alias,
    heldOutEvidenceIds: ["held-a", "held-b", "held-c", "held-d"],
  };
  const event: MessageEvent = {
    id: "request-evaluation",
    type: "message",
    messageId: "ts",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T", conversationId: "D" },
    direct: true,
    senderId: "U",
    text: "Evaluate this existing skill proposal against the separate cases.",
  };
  const routed = routeEvent(event, owner);
  if (!routed) throw new Error("Missing fixture scope");
  const conversation = client.conversation.getOrCreate(routed.key);
  await conversation.send("inbox", { type: "event", event });
  await expect.poll(() => modelCalls, { timeout: 10000 }).toBe(1);
  expect((await reflection.status()).liveActive).toBe(1);
  expect((await reflection.status()).reflection.requests).toHaveLength(1);
  releaseReply();
  await expect
    .poll(
      async () =>
        Object.values((await conversation.snapshot()).events).some(
          (record) => record.done,
        ),
      { timeout: 10000 },
    )
    .toBe(true);
  await expect.poll(() => sent.length, { timeout: 10000 }).toBe(1);
  expect(sent.at(-1)?.content).toMatchObject({
    type: "text",
    text: expect.stringContaining("queued"),
  });
  await expect
    .poll(
      async () =>
        (await reflection.skillEvaluation(alias, scope))?.receipt.status,
      { timeout: 10000 },
    )
    .toBe("settled");
  const result = await reflection.skillEvaluation(alias, scope);
  expect(result).toMatchObject({
    eligible: false,
    candidate,
    evidenceIds: ["held-a", "held-b", "held-c", "held-d", "train-a", "train-b"],
  });
  expect(
    result?.receipt.cases.map((item) => [
      item.evidenceId,
      item.status,
      item.decision?.answer,
    ]),
  ).toEqual([
    ["held-a", "settled", "yes"],
    ["held-b", "settled", "no"],
    ["held-c", "settled", "abstain"],
    ["held-d", "settled", "abstain"],
  ]);
  expect(result?.receipt.cases[2]?.decision?.rationale).toBe(
    "evaluator-failed",
  );
  expect(result?.receipt.cases[3]?.decision?.rationale).toBe(
    "malformed-decision",
  );
  expect(result?.receipt.candidateId).toBe(alias);
  expect(result?.receipt.candidateDigest).toBe(
    result?.candidate.skillChange?.digest,
  );
  expect(result?.receipt.skillChangeId).toBe(result?.candidate.skillChange?.id);
  expect(seen).toHaveLength(5);
  const inspected = await reflection.inspectCandidate(scope, alias);
  expect(inspected?.skillEvaluation).toEqual(result?.receipt);
  expect(inspected?.candidate.skillChange).toEqual(candidate?.skillChange);
  expect(inspected?.evidence.map((e) => e.id)).toEqual([
    "held-a",
    "held-b",
    "held-c",
    "held-d",
    "train-a",
    "train-b",
  ]);
  if (!inspected) throw new Error("Missing evaluation inspection");
  expect(await reflection.validateReview(scope, [inspected.reference])).toBe(
    true,
  );
  expect(JSON.stringify(await reflection.status())).not.toContain(
    "Regresses recipient",
  );
  expect(
    await reflection.requestSkillEvaluation(
      {
        candidateId: alias,
        heldOutEvidenceIds: ["held-a", "held-e"],
      },
      store.deletionRevision(),
    ),
  ).toMatchObject({ status: "duplicate" });
  expect(seen).toHaveLength(5);

  let reviewSequence = 0;
  const review = async (id: string) => {
    reviewId = id;
    const reviewEvent: MessageEvent = {
      ...event,
      id: `review-${++reviewSequence}`,
      messageId: `review-ts-${reviewSequence}`,
      metadata: { channelType: "im" },
      text: "Read the exact evaluated skill receipt without taking action.",
    };
    await conversation.send("inbox", { type: "event", event: reviewEvent });
    await expect
      .poll(
        async () =>
          Object.values((await conversation.snapshot()).events).find(
            (r) => r.event.id === reviewEvent.id,
          )?.done,
        { timeout: 10000 },
      )
      .toBe(true);
    reviewId = undefined;
  };
  const reviewData = () => {
    const content = reviewRequests.at(-1)?.messages[1]?.content;
    if (typeof content !== "string") throw new Error("Missing review DTO");
    return JSON.parse(
      content.slice("Private reflection review data (untrusted): ".length),
    );
  };
  const requestsBeforeReview = (await reflection.status()).reflection.requests
    .length;
  await review(alias);
  expect(reviewData()).toMatchObject({
    candidate: inspected.candidate,
    skillEvaluation: result?.receipt,
    evidence: inspected.evidence,
    reference: inspected.reference,
  });
  expect(sent.at(-1)?.content).toMatchObject({
    text: expect.stringContaining("PRIVATE evaluated receipt synthesis."),
  });
  expect(seen).toHaveLength(5);
  expect((await reflection.status()).reflection.requests).toHaveLength(
    requestsBeforeReview,
  );
  expect(store.proposals(scope)).toEqual([]);
  const reviewSnapshot = JSON.stringify(await conversation.snapshot());
  expect(reviewSnapshot).not.toContain("PRIVATE evaluated receipt synthesis.");
  expect(reviewSnapshot).not.toContain("Regresses recipient checking.");
  const beforeAttack = sent.length;
  reviewAttack = true;
  await review(alias);
  reviewAttack = false;
  expect(
    sent
      .slice(beforeAttack)
      .some((message) =>
        JSON.stringify(message).includes(
          "PRIVATE evaluated receipt synthesis.",
        ),
      ),
  ).toBe(false);
  expect((await reflection.status()).reflection.requests).toHaveLength(
    requestsBeforeReview,
  );
  expect(seen).toHaveLength(5);

  await reflection.enqueue({
    scope,
    evidenceIds: ["train-next"],
    kind: "reflection",
    mode: "deep",
  });
  await expect
    .poll(
      async () => (await reflection.reviewCandidates(scope))?.references.length,
      {
        timeout: 10000,
      },
    )
    .toBe(2);
  const next = (await reflection.listCandidates(scope)).ids.find(
    (id) => id !== alias,
  );
  if (!next) throw new Error("Missing second candidate");
  expect(
    await reflection.requestSkillEvaluation(
      {
        candidateId: next,
        heldOutEvidenceIds: ["held-a", "held-e"],
      },
      store.deletionRevision(),
    ),
  ).toMatchObject({ status: "queued" });
  await expect
    .poll(
      async () => (await reflection.skillEvaluation(next, scope))?.eligible,
      { timeout: 10000 },
    )
    .toBe(true);
  await reflection.occupancy("competing-turn", true);
  expect(await reflection.skillEvaluation(next, scope)).toMatchObject({
    eligible: false,
    receipt: { status: "settled" },
  });
  await reflection.occupancy("competing-turn", false);
  expect((await reflection.skillEvaluation(next, scope))?.eligible).toBe(true);
  const minute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  quiet.startMinute = minute;
  quiet.endMinute = (minute + 2) % 1440;
  expect((await reflection.skillEvaluation(next, scope))?.eligible).toBe(false);
  quiet.endMinute = quiet.startMinute;
  denied.add("train-b");
  expect(await reflection.skillEvaluation(alias, scope)).toBeNull();
  expect(await reflection.validateReview(scope, [inspected.reference])).toBe(
    false,
  );
  denied.clear();
  const nextInspection = await reflection.inspectCandidate(scope, next);
  if (!nextInspection) throw new Error("Missing all-yes inspection");
  const beforeRevokedReview = sent.length;
  revokeReview = () => store.deleteSource("held-e");
  await review(next);
  revokeReview = undefined;
  expect(reviewData()).toMatchObject({
    candidate: nextInspection.candidate,
    skillEvaluation: nextInspection.skillEvaluation,
    evidence: nextInspection.evidence,
    reference: nextInspection.reference,
  });
  expect(
    sent
      .slice(beforeRevokedReview)
      .some((message) =>
        JSON.stringify(message).includes(
          "PRIVATE evaluated receipt synthesis.",
        ),
      ),
  ).toBe(false);
  expect(await reflection.skillEvaluation(next, scope)).toBeNull();
  expect(
    await reflection.validateReview(scope, [nextInspection.reference]),
  ).toBe(false);
  expect(seen).toHaveLength(8);

  const interrupted = await reflection.enqueue({
    scope,
    evidenceIds: ["train-abort"],
    kind: "reflection",
    mode: "deep",
  });
  await expect
    .poll(async () => (await reflection.listCandidates(scope)).ids.length)
    .toBe(1);
  const abortAlias = (await reflection.listCandidates(scope)).ids[0];
  if (!abortAlias) throw new Error("Missing cancellation candidate");
  holdEvaluation = true;
  expect(
    await reflection.requestSkillEvaluation(
      {
        candidateId: abortAlias,
        heldOutEvidenceIds: ["held-abort-a", "held-abort-b"],
      },
      store.deletionRevision(),
    ),
  ).toMatchObject({ status: "queued" });
  await expect.poll(() => providerSignal).toBeDefined();
  const evaluation = (await reflection.status()).reflection.requests.find(
    (r) => r.evaluationFor === abortAlias,
  );
  if (!evaluation) throw new Error("Missing cancellation request");
  expect(evaluation.id).not.toBe(interrupted.id);
  store.deleteSource("train-abort");
  await reflection.cancel(evaluation.id);
  expect(providerSignal?.aborted).toBe(true);
  expect(await reflection.isSettled()).toBe(false);
  expect(await reflection.skillEvaluation(abortAlias, scope)).toBeNull();
  expect(
    (await reflection.status()).reflection.requests.find(
      (r) => r.id === evaluation.id,
    )?.status,
  ).toBe("cancelling");
  expect(seen).toHaveLength(10); // One new generation and only the first evaluation case.
  releaseEvaluation();
  await expect.poll(() => reflection.isSettled()).toBe(true);
  expect(
    (await reflection.status()).reflection.requests.find(
      (r) => r.id === evaluation.id,
    )?.status,
  ).toBe("cancelled");
  expect(await reflection.skillEvaluation(abortAlias, scope)).toBeNull();
  expect(seen).toHaveLength(10);
});

it.for(["actor-entry", "retrieval"] as const)(
  "does not enqueue evaluation after originating input deletion at %s without cancellation",
  async (phase, t) => {
    const scope = JSON.stringify(["private", "owner"]);
    const store = new EvidenceStore(":memory:", randomBytes(32));
    t.onTestFinished(() => store.close());
    for (const id of ["training", "held-a", "held-b"])
      store.appendSource({
        id,
        audiences: [scope],
        platform: "slack",
        account: "T",
        conversation: "D",
        author: "U",
        observedAt: Date.now(),
        sourceUrl: `https://example.com/${id}`,
        text: `${id}: baseline delays the answer; desired outcome answers first.`,
      });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.onTestFinished(() => release.resolve());
    let pause = false;
    let candidateId = "";
    const decisions: DecisionInput[] = [];
    const sent: OutboundMessage[] = [];
    const registry = createJuneRegistry({
      owner: {
        id: "owner",
        identities: [{ channel: "slack", accountId: "T", senderId: "U" }],
      },
      memory: {
        store,
        source(event, audience) {
          return {
            id: `inbound:${event.id}`,
            audiences: [audience],
            platform: "slack",
            account: "T",
            conversation: "D",
            author: "U",
            observedAt: event.occurredAt,
            sourceUrl: `https://example.com/inbound/${event.id}`,
            text: event.text,
          };
        },
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
            return { status: "sent", messageId: "out" };
          },
        },
      },
      model: {
        async reply(request) {
          expect(request.skillEvaluationRequestAvailable).toBe(true);
          return {
            text: "",
            skillEvaluationRequest: {
              candidateId,
              heldOutEvidenceIds: ["held-a", "held-b"],
            },
          };
        },
      },
      reflection: {
        ownerId: "owner",
        policy: {
          totalCapacity: 2,
          liveReserve: 1,
          cooldownMs: 0,
          maxAttempts: 1,
          maxNoNewEvidence: 1,
          evidenceMaxAgeMs: 60000,
          quiet: { timeZone: "UTC", startMinute: 0, endMinute: 0 },
        },
        idleMs: 10,
        deepMs: 20,
        pollMs: 20,
        timeoutMs: 5000,
        evidenceCurrent(audience, evidence) {
          return (
            JSON.stringify(
              store.reflectionEvidence(
                audience,
                evidence.map((e) => e.id),
                60000,
              ),
            ) === JSON.stringify(evidence)
          );
        },
        async retrieve({ scope, evidenceIds }) {
          if (pause && phase === "retrieval") {
            pause = false;
            entered.resolve();
            await release.promise;
          }
          return {
            authorized: true,
            evidence: store.reflectionEvidence(scope, evidenceIds, 60000),
          };
        },
        async decide(input) {
          decisions.push(structuredClone(input));
          return {
            answer: "yes",
            rationale: "Fixture comparison.",
            evidenceIds: [input.evidence[0]?.id ?? ""],
            ...(input.simulateResponses
              ? {
                  alternativeResponses: ["Answer first."],
                  skillChange: {
                    proposedBehavior: "Answer first.",
                    rationale: "Training supports it.",
                    evidenceIds: ["training"],
                  },
                }
              : {}),
          };
        },
      },
    });
    const config = registry.config.use.reflection?.config;
    if (!config?.actions) throw new Error("Missing reflection actions");
    const request = config.actions.requestSkillEvaluation;
    config.actions.requestSkillEvaluation = async (c, ...args) => {
      if (pause && phase === "actor-entry") {
        pause = false;
        entered.resolve();
        await release.promise;
      }
      return request(c, ...args);
    };
    const { client } = await setupTest(t, registry);
    const reflection = (
      client as Client<JuneClientRegistry>
    ).reflection.getOrCreate(["owner"]);
    await reflection.enqueue({
      scope,
      evidenceIds: ["training"],
      kind: "reflection",
      mode: "deep",
    });
    await expect
      .poll(async () => (await reflection.listCandidates(scope)).ids.length)
      .toBe(1);
    candidateId = (await reflection.listCandidates(scope)).ids[0] ?? "";
    const june = client.conversation.getOrCreate(["private", "owner"]);
    const event: MessageEvent = {
      id: "invalidated-evaluation",
      type: "message",
      messageId: "ts1",
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T", conversationId: "D" },
      direct: true,
      senderId: "U",
      text: "Evaluate the retained skill using the held-out cases.",
    };
    pause = true;
    await june.send("inbox", { type: "event", event });
    await entered.promise;
    const before = await reflection.status();
    expect(store.isDeleted(`inbound:${event.id}`)).toBe(false);
    store.deleteSource(`inbound:${event.id}`);
    expect(await reflection.status()).toEqual(before);
    expect(
      await reflection.inspectCandidate(scope, candidateId),
    ).not.toBeNull();
    release.resolve();
    await expect
      .poll(
        async () =>
          Object.values((await june.snapshot()).events).find(
            (r) => r.event.id === event.id,
          )?.done,
      )
      .toBe(true);
    expect((await reflection.status()).reflection.requests).toHaveLength(1);
    expect(decisions).toHaveLength(1);
    expect(sent).toHaveLength(0);
    // A later valid turn carries the new revision, not a permanent block.
    await june.send("inbox", {
      type: "event",
      event: { ...event, id: "valid-evaluation", messageId: "ts2" },
    });
    await expect
      .poll(
        async () =>
          (await reflection.skillEvaluation(candidateId, scope))?.eligible,
      )
      .toBe(true);
    expect(
      decisions
        .filter((input) => input.question === "skill-improvement")
        .map((input) => input.evidence.map((e) => e.id)),
    ).toEqual([["held-a"], ["held-b"]]);
    expect(
      (await reflection.status()).reflection.requests.filter(
        (request) => request.evaluationFor === candidateId,
      ),
    ).toHaveLength(1);
  },
);
