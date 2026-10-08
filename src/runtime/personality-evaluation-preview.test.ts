import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "rivetkit/client";
import { expect, it, type TestContext } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { CuratedPersonalityStore } from "../memory/curated.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import type { Decision, DecisionFunction } from "../reflection/evaluator.js";
import { defaultGlobalPersonality } from "./personality.js";
import { createPersonalityPreview } from "./personality-evaluation-preview.js";
import { createJuneRegistry, type JuneClientRegistry } from "./registry.js";

const owner = {
  id: "owner",
  identities: [{ channel: "slack" as const, accountId: "T1", senderId: "U1" }],
};
const source: MessageEvent = {
  type: "message",
  id: "evaluation",
  messageId: "evaluation",
  occurredAt: 200,
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  senderId: "U1",
  direct: true,
  metadata: { channelType: "im" },
  text: "Evaluate the draft in this conversation.",
};
const scope = JSON.stringify(["private", owner.id]);
const request = {
  candidateId: "candidate",
  heldOutSourceIds: ["held-two", "held-one"],
};

function fixture(
  t: TestContext,
  readCandidate?: Parameters<
    typeof createPersonalityPreview
  >[0]["readCandidate"],
  now = 200,
  evidenceMaxAgeMs = 1000,
) {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  for (const id of [
    "support",
    "held-one",
    "held-two",
    "held-three",
    "held-four",
    "held-five",
    "foreign",
    "opt-out",
    "oversized",
  ]) {
    store.appendSource({
      id,
      audiences: [id === "foreign" ? "other-scope" : scope],
      platform: "slack",
      account: "T1",
      conversation: "D1",
      author: "U1",
      observedAt: now - 100,
      sourceUrl: "https://fixture.invalid/interaction",
      text:
        id === "opt-out"
          ? "## private"
          : id === "oversized"
            ? "x".repeat(4001)
            : `PRIVATE ${id}`,
    });
  }
  const state = {
    now,
    decided: false,
    profile: structuredClone(defaultGlobalPersonality),
    proposal: {
      id: "candidate",
      scope,
      expectedVersion: 0,
      changes: { tone: "dry" as const },
      evidenceIds: ["support"],
      sourceIds: ["support"],
      explanation: "PRIVATE explanation",
      confidence: 0.8,
      createdAt: now - 50,
      expiresAt: now + 1800,
      status: "pending" as const,
    },
    calls: [] as Parameters<DecisionFunction>[0][],
    decide: (async (input) => ({
      answer: input.evidence[0]?.id === "held-two" ? "no" : "yes",
      evidenceIds: input.evidence.map((e) => e.id),
      rationale: "PRIVATE rationale",
    })) as DecisionFunction,
  };
  const service = createPersonalityPreview({
    owner,
    store,
    readCandidate:
      readCandidate ??
      (async (event, id) =>
        JSON.stringify(routeEvent(event, owner)?.key) === scope &&
        !state.decided &&
        id === state.proposal.id &&
        state.now < state.proposal.expiresAt &&
        store.source(scope, "support")
          ? structuredClone({
              profile: state.profile,
              proposal: state.proposal,
            })
          : null),
    now: () => state.now,
    evidenceMaxAgeMs,
    decide: async (input, signal) => {
      state.calls.push(structuredClone(input));
      return state.decide(input, signal);
    },
  });
  return { store, state, service };
}

it("keeps held-out evidence private, rejects contaminated/stale inputs and discards revoked in-flight results without writes", async (t) => {
  const { store, state, service } = fixture(t);
  const before = structuredClone({
    profile: state.profile,
    proposal: state.proposal,
  });
  const result = await service.preview(source, request);
  // Independently construct the canonical profile bytes, rather than reusing the digest helper.
  const digest = createHash("sha256")
    .update(
      '{"version":1,"style":{"tone":"dry","verbosity":"balanced","humor":"subtle","curiosity":"occasional"}}',
    )
    .digest("hex");
  expect(result).toMatchObject({
    status: "preview",
    candidateDigest: digest,
    outcomes: [
      { evidenceId: "held-two", answer: "no" },
      { evidenceId: "held-one", answer: "yes" },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect({ profile: state.profile, proposal: state.proposal }).toEqual(before);
  expect(state.calls.map((c) => c.evidence.map((e) => e.id))).toEqual([
    ["held-two"],
    ["held-one"],
  ]);
  expect(JSON.stringify(state.calls)).not.toContain("explanation");
  expect(state.calls.every((c) => c.prior === undefined)).toBe(true);

  for (const ids of [
    ["support"],
    ["foreign"],
    ["missing"],
    ["opt-out"],
    ["oversized"],
    ["held-one", "held-one"],
    ["held-one", "held-two", "held-three", "held-four", "held-five"],
  ]) {
    expect(
      await service.preview(source, { ...request, heldOutSourceIds: ids }),
    ).toEqual({ status: "unavailable" });
  }
  state.profile.version = 1;
  expect(await service.preview(source, request)).toEqual({
    status: "unavailable",
  });
  state.profile.version = 0;
  state.now = 1100;
  expect(await service.preview(source, request)).toEqual({
    status: "unavailable",
  });
  state.now = 200;
  state.decided = true;
  expect(await service.preview(source, request)).toEqual({
    status: "unavailable",
  });
  state.decided = false;
  expect(state.calls).toHaveLength(2);

  const snapshot = await service.snapshot(source, request);
  if (!snapshot) throw new Error("Missing test snapshot");
  snapshot.candidate.style.humor = "none";
  expect(await service.isCurrent(snapshot)).toBe(false);

  const held = Promise.withResolvers<Decision>();
  state.decide = () => held.promise;
  const controller = new AbortController();
  const pending = service.preview(source, request, controller.signal);
  await expect.poll(() => state.calls.length).toBe(3);
  controller.abort();
  expect(await pending).toEqual({ status: "unavailable" });
  expect(await service.preview(source, request)).toMatchObject({
    status: "preview",
    outcomes: [{ answer: "abstain" }, { answer: "abstain" }],
  });
  expect(state.calls).toHaveLength(3); // Cancelled raw work still holds its slot.
  held.resolve({
    answer: "yes",
    evidenceIds: ["held-two"],
    rationale: "PRIVATE late",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  state.decide = async (input) => {
    store.deleteSource("held-one");
    return {
      answer: "yes",
      evidenceIds: [input.evidence[0]?.id ?? ""],
      rationale: "PRIVATE revoked",
    };
  };
  expect(await service.preview(source, request)).toEqual({
    status: "unavailable",
  });
  expect(state.calls).toHaveLength(4); // Never sends the second, forgotten interaction.
  expect({ profile: state.profile, proposal: state.proposal }).toEqual(before);

  const duringFinalRead = new AbortController();
  let reads = 0;
  const cancelled = fixture(t, async () => {
    if (++reads === 3) duringFinalRead.abort();
    return {
      profile: cancelled.state.profile,
      proposal: cancelled.state.proposal,
    };
  });
  expect(
    await cancelled.service.preview(
      source,
      { ...request, heldOutSourceIds: ["held-one"] },
      duringFinalRead.signal,
    ),
  ).toEqual({ status: "unavailable" });
  expect(cancelled.state.calls).toHaveLength(1);
});

it("exposes source-scoped June evaluation without owner-evidence access or mixed/synthesis actions", async (t) => {
  let client: Client<JuneClientRegistry>;
  const { store, state, service } = fixture(
    t,
    (event, id) =>
      client.personality.getOrCreate([owner.id]).evaluationCandidate(event, id),
    Date.now(),
    7 * 24 * 60 * 60 * 1000,
  );
  const root = await mkdtemp(join(tmpdir(), "june-preview-"));
  const curated = new CuratedPersonalityStore(
    join(root, "curated"),
    randomBytes(32),
    store,
    { initialize: true },
  );
  t.onTestFinished(async () => {
    curated.close();
    await rm(root, { recursive: true, force: true });
  });
  const proposal = curated.stageGlobalProposal(
    scope,
    {
      expectedVersion: 0,
      changes: { tone: "dry" },
      evidenceIds: ["support"],
      explanation: "PRIVATE explanation",
      confidence: 0.8,
    },
    state.now,
  );
  const actualRequest = { ...request, candidateId: proposal.id };
  const sent: OutboundMessage[] = [];
  const requests: ModelRequest[] = [];
  let action: CompanionReply = { text: "", personalityEvaluate: actualRequest };
  let web = false;
  const registry = createJuneRegistry({
    owner,
    memory: { store, personality: curated, source: () => undefined },
    personalityEvaluation: service,
    model: {
      async reply(input) {
        requests.push(input);
        const schema = replyJsonSchema([], input);
        expect(Object.hasOwn(schema.properties, "personalityEvaluate")).toBe(
          input.personalityEvaluateAvailable === true,
        );
        expect(schema.required.includes("personalityEvaluate")).toBe(
          input.personalityEvaluateAvailable === true,
        );
        if (web && input.webSearchAvailable)
          return { text: "", webSearch: "public fixture" };
        return action;
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
          sent.push(message);
          return { status: "sent", messageId: `out-${sent.length}` };
        },
      },
    },
    webSearch: {
      available: true,
      description: "fixture",
      async search() {
        return {
          status: "ready",
          results: [
            {
              title: "fixture",
              url: "https://fixture.invalid",
              snippet: "public",
            },
          ],
        };
      },
    },
  });
  ({ client } = (await setupTest(t, registry)) as {
    client: Client<JuneClientRegistry>;
  });
  const profile = await client.personality.getOrCreate([owner.id]).read();
  let serial = 0;
  async function deliver(extra: Partial<MessageEvent> = {}) {
    const event: MessageEvent = {
      type: "message",
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      senderId: "U1",
      direct: true,
      metadata: { channelType: "im" },
      text: "Evaluate this candidate privately",
      ...extra,
      id: `event-${++serial}`,
      messageId: `${serial}`,
    };
    const routed = routeEvent(event, owner);
    if (!routed) throw new Error("Invalid test route");
    const actor = client.conversation.getOrCreate(routed.key);
    const eventKey = createHash("sha256")
      .update(
        JSON.stringify([
          event.address.channel,
          event.address.accountId,
          event.id,
        ]),
      )
      .digest("hex");
    await actor.send("inbox", { type: "event", event });
    await expect
      .poll(async () => (await actor.snapshot()).events[eventKey]?.done, {
        timeout: 10000,
      })
      .toBe(true);
    return actor.snapshot();
  }
  const snapshot = await deliver();
  expect(state.calls).toHaveLength(2);
  expect(requests[0]?.personalityEvaluateAvailable).toBe(true);
  expect(requests[0]?.system).toContain(
    "personalityEvaluate:{candidateId,heldOutSourceIds}",
  );
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.address.conversationId).toBe("D1");
  expect(JSON.stringify(sent[0])).toContain("candidateDigest");
  const comparisonRequest = { ...actualRequest, mode: "compare" as const };
  action = { text: "", personalityEvaluate: comparisonRequest };
  const compared = await deliver();
  expect(state.calls).toHaveLength(6);
  expect(JSON.stringify(compared)).not.toContain("PRIVATE");
  expect(sent).toHaveLength(2);
  expect(sent[1]?.address.conversationId).toBe("D1");
  const content = sent[1]?.content;
  if (content?.type !== "text") throw new Error("Missing comparison report");
  const report = content.text;
  expect(report).toContain('"status":"comparison"');
  expect(report).toContain("A receipt is not approval");
  const evaluationId = report.match(/"evaluationId":"([^"]+)"/)?.[1];
  expect(evaluationId).toBeDefined();
  expect(curated.readEvaluation(scope, evaluationId ?? "")).toMatchObject({
    candidateId: proposal.id,
    expectedVersion: 0,
    status: "complete",
    pairs: [
      {
        evidenceId: "held-two",
        current: "no",
        candidate: "no",
        outcome: "neither",
      },
      {
        evidenceId: "held-one",
        current: "yes",
        candidate: "yes",
        outcome: "both",
      },
    ],
  });
  expect(() =>
    parseReply(
      JSON.stringify({
        text: "",
        personalityEvaluate: {
          ...comparisonRequest,
          candidateDigest: "forged",
        },
      }),
      [],
      { personalityEvaluateAvailable: true },
    ),
  ).toThrow();
  for (const extra of [
    {
      direct: false,
      metadata: { channelType: "channel" as const },
      address: {
        channel: "slack" as const,
        accountId: "T1",
        conversationId: "C1",
      },
    },
    { senderId: "GUEST" },
  ]) {
    await deliver(extra);
    expect(requests.at(-1)?.personalityEvaluateAvailable).toBe(true);
    expect(state.calls).toHaveLength(6);
    expect(sent.at(-1)?.content).toMatchObject({
      text: expect.stringContaining("unavailable"),
    });
  }
  // Host-routed identity and audience, not optional Slack metadata, bind evidence.
  await deliver({ metadata: undefined });
  expect(requests.at(-1)?.personalityEvaluateAvailable).toBe(true);
  expect(state.calls).toHaveLength(10);
  action = {
    text: "",
    personalityEvaluate: comparisonRequest,
    reaction: "wave",
  };
  await deliver();
  expect(state.calls).toHaveLength(10);
  action = { text: "", personalityEvaluate: comparisonRequest };
  web = true;
  await deliver();
  expect(requests.at(-1)?.personalityEvaluateAvailable).toBe(false);
  expect(state.calls).toHaveLength(10);
  await deliver({
    text: `!personality reject ${JSON.stringify({ proposalId: proposal.id })}`,
    personalityCommandEligible: true,
  });
  expect(await service.preview(source, actualRequest)).toEqual({
    status: "unavailable",
  });
  expect(state.calls).toHaveLength(10);
  expect(await client.personality.getOrCreate([owner.id]).read()).toEqual(
    profile,
  );
  expect(() => parseReply(JSON.stringify(action), [])).toThrow();
  expect(
    parseReply(JSON.stringify(action), [], {
      personalityEvaluateAvailable: true,
    }),
  ).toEqual(action);

  // The real June comparison receipt can be reviewed and deliberately approved;
  // neither model output nor a mismatched digest publishes the candidate.
  const approved = curated.stageGlobalProposal(scope, {
    expectedVersion: 0,
    changes: { curiosity: "eager" },
    evidenceIds: ["support"],
    explanation: "PRIVATE grounded style",
    confidence: 0.8,
  });
  web = false;
  action = {
    text: "",
    personalityEvaluate: { ...comparisonRequest, candidateId: approved.id },
  };
  await deliver();
  const approvalReport = sent.at(-1)?.content;
  if (approvalReport?.type !== "text")
    throw new Error("Missing approval comparison");
  const approvalEvaluationId = approvalReport.text.match(
    /"evaluationId":"([^"]+)"/,
  )?.[1];
  const approvalReceipt = curated.readEvaluation(
    scope,
    approvalEvaluationId ?? "",
  );
  if (!approvalReceipt) throw new Error("Missing trusted comparison receipt");
  expect(
    (await client.personality.getOrCreate([owner.id]).read()).version,
  ).toBe(0);
  const approval = {
    proposalId: approved.id,
    expectedVersion: 0,
    evaluationId: approvalReceipt.evaluationId,
    candidateDigest: approvalReceipt.candidateDigest,
    publish: true,
  };
  await deliver({
    text: `!personality approve ${JSON.stringify({ ...approval, candidateDigest: "0".repeat(64) })}`,
    personalityCommandEligible: true,
  });
  expect(sent.at(-1)?.content).toMatchObject({
    text: expect.stringContaining("Personality evaluation is unavailable"),
  });
  expect(
    (await client.personality.getOrCreate([owner.id]).read()).version,
  ).toBe(0);
  await deliver({
    text: `!personality approve ${JSON.stringify(approval)}`,
    personalityCommandEligible: true,
  });
  expect(sent.at(-1)?.content).toMatchObject({
    text: expect.stringContaining("Saved global personality revision 1"),
  });
  const next = curated.stageGlobalProposal(scope, {
    expectedVersion: 1,
    changes: { tone: "direct" },
    evidenceIds: ["held-four"],
    explanation: "PRIVATE independent support",
    confidence: 0.8,
  });
  const nextRequest = { ...request, candidateId: next.id };
  const beforeForgetting = await service.snapshot(source, nextRequest);
  expect(beforeForgetting?.current).toMatchObject({
    version: 1,
    style: { curiosity: "eager" },
  });
  store.deleteSource("support");
  const afterForgetting = await service.snapshot(source, nextRequest);
  expect(afterForgetting?.current).toMatchObject({
    version: 1,
    style: { curiosity: "occasional" },
  });
  expect(afterForgetting?.currentDigest).not.toBe(
    beforeForgetting?.currentDigest,
  );
  if (!beforeForgetting) throw new Error("Missing pre-forgetting snapshot");
  expect(await service.isCurrent(beforeForgetting)).toBe(false);
  expect(state.calls).toHaveLength(14);

  for (const [expectedVersion, scopedSource] of [
    [
      1,
      {
        ...source,
        // Independent requester keeps this four-turn workflow within ingress's
        // per-sender burst limit; the earlier foreign-candidate probe is separate.
        senderId: "SCOPED_GUEST",
        address: { ...source.address, conversationId: "D2" },
      },
    ],
    [
      2,
      {
        ...source,
        direct: false,
        metadata: { channelType: "channel" as const },
        address: { ...source.address, conversationId: "C2" },
      },
    ],
  ] as const) {
    const sourceScope = JSON.stringify(routeEvent(scopedSource, owner)?.key);
    const supportId = `scoped-support-${expectedVersion}`;
    const heldId = `scoped-held-${expectedVersion}`;
    for (const id of [supportId, heldId]) {
      store.appendSource({
        id,
        audiences: [sourceScope],
        platform: "slack",
        account: "T1",
        conversation: scopedSource.address.conversationId,
        author: scopedSource.senderId,
        observedAt: state.now - 100,
        sourceUrl: "https://private.invalid/",
        text: "PRIVATE scoped evidence",
      });
    }
    const scopedDraft = curated.stageGlobalProposal(sourceScope, {
      expectedVersion,
      changes: { humor: "playful" },
      evidenceIds: [supportId],
      explanation: "PRIVATE scoped draft",
      confidence: 0.8,
    });
    const scopedRequest = {
      candidateId: scopedDraft.id,
      heldOutSourceIds: [heldId],
    };
    const beforeCalls = state.calls.length;
    action = { text: "", personalityEvaluate: scopedRequest };
    // Even a known foreign candidate ID does not grant an owner-scope read.
    await deliver();
    expect(sent.at(-1)?.content).toMatchObject({
      text: expect.stringContaining("unavailable"),
    });
    action = {
      text: "",
      personalityEvaluate: { ...scopedRequest, heldOutSourceIds: ["held-one"] },
    };
    await deliver(scopedSource);
    expect(state.calls).toHaveLength(beforeCalls);
    expect(sent.at(-1)?.content).toMatchObject({
      text: expect.stringContaining("unavailable"),
    });
    action = { text: "", personalityEvaluate: scopedRequest };
    await deliver(scopedSource);
    expect(sent.at(-1)?.content).toMatchObject({
      text: expect.stringContaining('"status":"preview"'),
    });
    action = {
      text: "",
      personalityEvaluate: { ...scopedRequest, mode: "compare" },
    };
    await deliver(scopedSource);
    const comparison = sent.at(-1)?.content;
    if (comparison?.type !== "text")
      throw new Error("Missing scoped comparison");
    expect(comparison.text).toContain('"status":"comparison"');
    const receiptId = comparison.text.match(/"evaluationId":"([^"]+)"/)?.[1];
    const receipt = curated.readEvaluation(sourceScope, receiptId ?? "");
    if (!receipt) throw new Error("Missing scoped receipt");
    expect(curated.readEvaluation(scope, receipt.evaluationId)).toBeUndefined();
    expect(
      state.calls.slice(beforeCalls).map((input) => ({
        scope: input.scope,
        ids: input.evidence.map((e) => e.id),
      })),
    ).toEqual([
      { scope: sourceScope, ids: [heldId] },
      { scope: sourceScope, ids: [heldId] },
      { scope: sourceScope, ids: [heldId] },
    ]);
    expect(
      (await client.personality.getOrCreate([owner.id]).read()).version,
    ).toBe(expectedVersion);
    await deliver({
      ...scopedSource,
      personalityCommandEligible: true,
      text: `!personality approve ${JSON.stringify({ proposalId: scopedDraft.id, expectedVersion, evaluationId: receipt.evaluationId, candidateDigest: receipt.candidateDigest, publish: true })}`,
    });
    expect(sent.at(-1)?.content).toMatchObject({
      text: expect.stringContaining(
        `Saved global personality revision ${expectedVersion + 1}`,
      ),
    });
    expect(
      (await client.personality.getOrCreate([owner.id]).read()).style.humor,
    ).toBe("playful");
  }
  expect(JSON.stringify(sent)).not.toContain("PRIVATE");
}, 90_000);
