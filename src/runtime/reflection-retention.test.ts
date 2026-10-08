import { randomBytes } from "node:crypto";
import { expect, it, onTestFinished } from "vitest";
import { EvidenceStore } from "../memory/store.js";
import {
  createReflectionActor,
  type ReflectionCandidate,
  type ReflectionDependencies,
  reflectionCandidateId,
} from "./reflection.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

async function fixture(
  beforeRetrieve?: (ids: string[]) => Promise<void>,
  stageInterruption?: ReflectionDependencies["stageInterruption"],
) {
  const now = Date.now();
  const privateScope = JSON.stringify(["private", "owner"]);
  const store = new EvidenceStore(":memory:", randomBytes(32));
  onTestFinished(() => store.close());
  const config = createReflectionActor({
    ownerId: "owner",
    stageInterruption,
    deletionRevision: () => store.deletionRevision(),
    idleMs: 100,
    deepMs: 200,
    pollMs: 100,
    timeoutMs: 1000,
    policy: {
      totalCapacity: 2,
      liveReserve: 1,
      cooldownMs: 1,
      maxAttempts: 1,
      maxNoNewEvidence: 1,
      evidenceMaxAgeMs: 60000,
      quiet: { timeZone: "UTC", startMinute: 0, endMinute: 0 },
    },
    evidenceCurrent(scope, evidence) {
      const current = store.reflectionEvidence(
        scope,
        evidence.map((e) => e.id),
        31000,
      );
      return JSON.stringify(current) === JSON.stringify(evidence);
    },
    async retrieve({ scope, evidenceIds }) {
      await beforeRetrieve?.(evidenceIds);
      return {
        authorized: true,
        evidence: store.reflectionEvidence(scope, evidenceIds, 31000),
      };
    },
    async decide() {
      throw new Error("No generation in action fixture");
    },
  }).config;
  if (
    !("state" in config) ||
    !("createVars" in config) ||
    !config.createVars ||
    !config.actions
  )
    throw new Error("Expected reflection actor");
  const c = {
    key: ["owner"],
    state: structuredClone(config.state),
    async saveState() {},
    queue: { async send() {} },
  } as unknown as Parameters<typeof config.actions.occupancy>[0];
  c.vars = await config.createVars(c, undefined);
  c.state.epoch = 7;
  // An old actor has no format version; migration must establish publication.
  Reflect.deleteProperty(c.state, "candidateFormatVersion");
  const add = (
    name: string,
    phase: "settled" | "started" | "uncertain" = "settled",
    scope = privateScope,
  ) => {
    store.appendSource({
      id: name,
      audiences: [scope],
      platform: "slack",
      account: "T",
      conversation: "D",
      author: "owner",
      observedAt: now - 1000,
      sourceUrl: "https://example.com/fixture",
      text: "private fixture",
    });
    const requestId = JSON.stringify([scope, [name]]);
    const id = JSON.stringify([requestId, 1]);
    c.state.reflection.requests.push({
      id: requestId,
      scope,
      evidenceIds: [name],
      kind: "reflection",
      createdAt: now - 1000,
      attempts: 1,
      status: "stopped",
    });
    const candidate: ReflectionCandidate = {
      id,
      requestId,
      scope,
      attempt: 1,
      mode: "interaction",
      kind: "proposal",
      hypothesisOnly: false,
      decision: { answer: "yes", rationale: name, evidenceIds: [name] },
      createdAt: now,
      epoch: 7,
      publication: { version: 1, expiresAt: now + 20000 },
    };
    c.state.candidates[id] = candidate;
    c.state.invocations[id] = phase;
    return id;
  };
  return { c, actions: config.actions, add, now, store };
}

it("uses host channel scope for reflection requests and review without exposing owner-private evidence", async () => {
  const { c, actions, add, store } = await fixture();
  c.state.candidateFormatVersion = 1;
  const scope = JSON.stringify(["slack", "T", "C", ""]);
  const privateScope = JSON.stringify(["private", "owner"]);
  const privateId = add("owner-private");
  const id = add("channel-evidence", "settled", scope);
  const alias = reflectionCandidateId(id);
  const privateAlias = reflectionCandidateId(privateId);
  for (const candidate of Object.values(c.state.candidates)) {
    candidate.kind = "interruption-candidate";
    required(
      c.state.reflection.requests.find((r) => r.id === candidate.requestId),
    ).kind = "curiosity";
  }
  // The payload cannot select another audience, even with a forged scope field.
  const forged = {
    mode: "idle" as const,
    evidenceIds: ["owner-private"],
    scope: privateScope,
  };
  expect(await actions.request(c, forged, scope)).toEqual({
    status: "unavailable",
  });
  const input = { mode: "idle" as const, evidenceIds: ["channel-evidence"] };
  expect(await actions.request(c, input, scope)).toEqual({
    status: "duplicate",
  });
  expect(await actions.request(c, input)).toEqual({ status: "unavailable" });
  const extra = store.source(scope, "channel-evidence");
  if (!extra) throw new Error("Missing channel source");
  store.appendSource({ ...extra, id: "channel-request" });
  expect(
    await actions.request(
      c,
      { ...input, evidenceIds: ["channel-request"] },
      scope,
    ),
  ).toEqual({ status: "queued" });
  expect(c.state.reflection.requests.at(-1)).toMatchObject({
    scope,
    evidenceIds: ["channel-request"],
    attempts: 0,
  });
  expect(await actions.candidate(c, alias, scope)).toMatchObject({
    scope,
    evidenceIds: ["channel-evidence"],
  });
  expect(await actions.candidate(c, id, scope)).toBeNull();
  expect(await actions.candidate(c, privateAlias, scope)).toBeNull();
  expect(await actions.listCandidates(c, scope)).toMatchObject({
    status: "ready",
    ids: [alias],
  });
  const progress = await actions.curiosityProgress(c, scope);
  expect(progress.rows).toHaveLength(1);
  expect(progress.rows[0]).toMatchObject({
    currentInputs: { episodes: 1, ownerCorrections: 0, dreamHypotheses: 0 },
    invocation: "settled",
  });
  const inspected = await actions.inspectCandidate(c, scope, alias);
  if (!inspected) throw new Error("Missing channel review");
  expect(inspected.evidence.map((e) => e.id)).toEqual(["channel-evidence"]);
  expect((await actions.reviewCandidates(c, scope))?.references).toEqual([
    inspected.reference,
  ]);
  expect(await actions.validateReview(c, scope, [inspected.reference])).toBe(
    true,
  );
  expect(
    await actions.validateReview(c, privateScope, [inspected.reference]),
  ).toBe(false);
  expect(await actions.inspectCandidate(c, scope, privateAlias)).toBeNull();
  expect(await actions.rejectCandidate(c, scope, privateAlias)).toBe(false);
  expect(await actions.rejectCandidate(c, privateScope, privateAlias)).toBe(
    true,
  );
  expect(await actions.rejectCandidate(c, scope, privateAlias)).toBe(false);

  const receipts = structuredClone(c.state.reflection.requests);
  expect(await actions.rejectCandidate(c, scope, alias)).toBe(true);
  expect(await actions.rejectCandidate(c, scope, alias)).toBe(true);
  expect(await actions.inspectCandidate(c, scope, alias)).toBeNull();
  expect(await actions.validateReview(c, scope, [inspected.reference])).toBe(
    false,
  );
  expect(await actions.request(c, input, scope)).toEqual({
    status: "duplicate",
  });
  expect(c.state.reflection.requests).toEqual(receipts);
  expect(c.state.invocations[id]).toBe("settled");
});

it("binds held-out evaluation and interruption staging to the host channel scope", async () => {
  const staged: Parameters<
    NonNullable<ReflectionDependencies["stageInterruption"]>
  >[] = [];
  const { c, actions, add, store, now } = await fixture(
    undefined,
    (...args) => {
      staged.push(args);
      return "staged";
    },
  );
  c.state.candidateFormatVersion = 1;
  const scope = JSON.stringify(["guest", "slack", "T", "C", "", "GUEST"]);
  const privateScope = JSON.stringify(["private", "owner"]);
  const privateId = add("owner-private");
  const id = add("channel-evidence", "settled", scope);
  const alias = reflectionCandidateId(id);
  const candidate = required(c.state.candidates[id]);
  candidate.skillChange = {
    id: "a".repeat(64),
    digest: "b".repeat(64),
    proposedBehavior: "Give the requested answer before optional details.",
    rationale: "The channel episode supports this hypothesis.",
    evidenceIds: ["channel-evidence"],
    createdAt: now,
    hypothesisOnly: true,
  };
  for (const name of ["held-a", "held-b"]) {
    const source = store.source(scope, "channel-evidence");
    if (!source) throw new Error("Missing channel source");
    store.appendSource({
      ...source,
      id: name,
      text: `${name}: baseline omits the requested answer; desired outcome is answer first.`,
    });
  }
  const input = {
    candidateId: alias,
    heldOutEvidenceIds: ["held-a", "held-b"],
  };
  const revision = store.deletionRevision();
  expect(await actions.requestSkillEvaluation(c, input, revision)).toEqual({
    status: "unavailable",
  });
  expect(
    await actions.requestSkillEvaluation(
      c,
      { ...input, candidateId: reflectionCandidateId(privateId) },
      revision,
      scope,
    ),
  ).toEqual({ status: "unavailable" });
  expect(
    await actions.requestSkillEvaluation(
      c,
      { ...input, heldOutEvidenceIds: ["held-a", "owner-private"] },
      revision,
      scope,
    ),
  ).toEqual({ status: "unavailable" });
  expect(
    await actions.requestSkillEvaluation(c, input, revision, scope),
  ).toEqual({ status: "queued" });
  expect(c.state.reflection.requests.at(-1)).toMatchObject({
    scope,
    evidenceIds: ["channel-evidence", "held-a", "held-b"],
    evaluationFor: alias,
  });
  expect(
    await actions.requestSkillEvaluation(c, input, revision, scope),
  ).toEqual({ status: "duplicate" });

  const event = {
    id: "guest-request",
    type: "message" as const,
    messageId: "1",
    occurredAt: now,
    address: { channel: "slack" as const, accountId: "T", conversationId: "C" },
    direct: false,
    senderId: "GUEST",
    text: "Stage this candidate.",
  };
  const interruptionId = add("channel-interruption", "settled", scope);
  required(c.state.candidates[interruptionId]).kind = "interruption-candidate";
  required(
    c.state.reflection.requests.find(
      (r) => r.id === c.state.candidates[interruptionId]?.requestId,
    ),
  ).kind = "curiosity";
  const draft = {
    candidateId: reflectionCandidateId(interruptionId),
    userId: "RECIPIENT",
    text: "An inert draft.",
  };
  expect(await actions.stageInterruption(c, event, draft, revision)).toContain(
    "unavailable",
  );
  expect(
    await actions.stageInterruption(c, event, draft, revision, false, scope),
  ).toBe("staged");
  expect(staged).toHaveLength(1);
  expect(staged[0]?.[2]).toMatchObject({
    scope,
    evidenceIds: ["channel-interruption"],
  });
  expect(staged[0]?.[3]).toBe(true);
  expect(
    await actions.stageInterruption(
      c,
      event,
      { ...draft, candidateId: reflectionCandidateId(privateId) },
      revision,
      true,
      scope,
    ),
  ).toContain("unavailable");
  expect(await actions.candidate(c, alias, privateScope)).toBeNull();
  store.deleteSource("channel-interruption");
  expect(
    await actions.stageInterruption(c, event, draft, revision, true, scope),
  ).toContain("unavailable");
  expect(
    await actions.stageInterruption(
      c,
      event,
      draft,
      store.deletionRevision(),
      true,
      scope,
    ),
  ).toContain("unavailable");
  expect(staged).toHaveLength(1);
});

it("preserves published bodies across interactions without rearming effects or releasing uncertain work", async () => {
  const { c, actions, add } = await fixture();
  const id = add("published");
  c.state.invocations.unknown = "uncertain";
  const controller = new AbortController();
  c.vars.active.set("unfinished", controller);
  await actions.occupancy(c, "owner-turn", true);
  expect(c.state.candidates[id]?.decision.rationale).toBe("published");
  expect(c.state.candidates[id]?.epoch).toBe(7);
  expect(c.state.epoch).toBe(8);
  expect(controller.signal.aborted).toBe(true);
  expect(c.state.invocations.unknown).toBe("uncertain");
  await actions.occupancy(c, "owner-turn", false);
  expect(await actions.candidate(c, id)).toBeNull();
  await actions.trigger(c, {
    id: "legacy",
    type: "interaction",
    liveActive: 0,
  });
  expect(c.state.candidates[id]?.epoch).toBe(7);
  expect(c.state.epoch).toBe(9);
});

it("migrates only verifiable capped publications and preserves failed/unknown receipts", async () => {
  const { c, actions, add, now } = await fixture();
  const good = add("good");
  const uncapped = add("unknown-original-ttl");
  Reflect.deleteProperty(required(c.state.candidates[uncapped]), "publication");
  const uncertain = add("uncertain", "uncertain");
  add("started", "started");
  const old = add("old-epoch");
  required(c.state.candidates[old]).epoch = 6;
  const cancelled = add("cancelled");
  required(
    c.state.reflection.requests.find(
      (r) => r.id === c.state.candidates[cancelled]?.requestId,
    ),
  ).status = "cancelled";
  const malformed = add("malformed");
  required(c.state.candidates[malformed]).decision.evidenceIds = ["invented"];
  const mismatch = add("mismatch");
  required(c.state.candidates[mismatch]).attempt = 2;
  const hypothesis = add("wrong-hypothesis");
  required(c.state.candidates[hypothesis]).hypothesisOnly = true;
  const badKey = add("wrong-map-key");
  required(c.state.candidates[badKey]).id = good;
  Reflect.set(c.state.candidates, "null-record", null);
  Reflect.set(c.state.candidates, "string-record", "invalid");
  Reflect.set(c.state.candidates, "empty-record", {});
  await actions.occupancy(c, "migration-turn", true);
  expect(Object.keys(c.state.candidates)).toEqual([good]);
  expect(c.state.invocations[uncertain]).toBe("uncertain");
  expect(c.state.invocations[uncapped]).toBe("settled");
  expect(c.state.reflection.requests).toHaveLength(10);
  expect(c.state).toHaveProperty("candidateFormatVersion", 1);
  // Current retrieval permits another 30 seconds, but migration cannot extend
  // the recorded 20-second original ceiling.
  expect(c.state.candidates[good]?.publication).toEqual({
    version: 1,
    expiresAt: now + 20000,
  });
});

it("evicts oldest and expired bodies within count/byte bounds without erasing dedupe receipts", async () => {
  const { c, actions, add, now } = await fixture();
  Object.assign(c.state, { candidateFormatVersion: 1 });
  const ids: string[] = [];
  for (let index = 0; index < 52; index++) {
    const id = add(`entry-${index}`);
    ids.push(id);
    Object.assign(required(c.state.candidates[id]), {
      createdAt: now - 1000 + index,
      publication: {
        version: 1,
        expiresAt: index === 2 ? now - 1 : now + 30000,
      },
    });
  }
  await actions.occupancy(c, "bounded", true);
  expect(Object.keys(c.state.candidates)).toEqual(
    ids.slice(1).filter((_, i) => i !== 1),
  );
  expect(c.state.reflection.requests).toHaveLength(52);
  expect(Object.keys(c.state.invocations)).toHaveLength(52);
  for (const candidate of Object.values(c.state.candidates))
    candidate.decision.rationale = "夢".repeat(4000);
  await actions.occupancy(c, "byte-bound", true);
  expect(
    Buffer.byteLength(JSON.stringify(c.state.candidates)),
  ).toBeLessThanOrEqual(256 * 1024);
  expect(Object.keys(c.state.candidates).length).toBeLessThan(50);
  expect(c.state.candidates[required(ids[51])]).toBeDefined();
  expect(c.state.candidates[required(ids[1])]).toBeUndefined();
  expect(c.state.reflection.requests).toHaveLength(52);
});

it.each(["cancel", "delete"])(
  "revalidates earlier publications after the last batch read settles: %s",
  async (revoke) => {
    let pause: Promise<void> | undefined;
    let entered = false;
    const { c, actions, add, store } = await fixture(async (ids) => {
      if (ids.includes("last") && pause) {
        entered = true;
        await pause;
      }
    });
    c.state.candidateFormatVersion = 1;
    const first = add("first");
    add("last");
    const scope = JSON.stringify(["private", "owner"]);
    const references =
      (await actions.reviewCandidates(c, scope))?.references ?? [];
    expect(references).toHaveLength(2);
    let release = () => {};
    pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const validation = actions.validateReview(c, scope, references);
    const listing = actions.reviewCandidates(c, scope);
    await expect.poll(() => entered).toBe(true);
    if (revoke === "cancel")
      await actions.cancel(c, required(c.state.candidates[first]).requestId);
    else store.deleteSource("first");
    release();
    expect(await validation).toBe(false);
    expect((await listing)?.references).toEqual(references.slice(1));
  },
);

it("reads both historical and simulated deep curiosity without rewriting either publication", async () => {
  const { c, actions, add } = await fixture();
  c.state.candidateFormatVersion = 1;
  for (const modern of [false, true]) {
    const id = add(modern ? "simulated" : "historical");
    const candidate = required(c.state.candidates[id]);
    required(
      c.state.reflection.requests.find((r) => r.id === candidate.requestId),
    ).kind = "curiosity";
    candidate.mode = "deep";
    candidate.kind = modern ? "proposal" : "interruption-candidate";
    candidate.hypothesisOnly = modern;
    if (modern)
      candidate.decision.alternativeResponses = ["One hypothetical reply"];
    const original = structuredClone(candidate);
    c.state.epoch++;
    const result = await actions.inspectCandidate(
      c,
      candidate.scope,
      reflectionCandidateId(id),
    );
    expect(result?.candidate).toMatchObject({
      kind: original.kind,
      hypothesisOnly: original.hypothesisOnly,
      epoch: original.epoch,
      publication: original.publication,
      decision: original.decision,
    });
    expect(c.state.candidates[id]).toEqual(original);
    expect(await actions.candidate(c, id)).toBeNull();
  }
});

it("bounds held-out result bodies with their publication while retaining dedupe and unknown holds", async () => {
  const { c, actions, add, now } = await fixture();
  c.state.candidateFormatVersion = 1;
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const id = add(`evaluated-${i}`);
    ids.push(id);
    const candidate = required(c.state.candidates[id]);
    candidate.createdAt = now - 1000 + i;
    c.state.reflection.requests.push({
      id: `evaluation-${i}`,
      scope: candidate.scope,
      evidenceIds: [
        `evaluated-${i}`,
        ...Array.from({ length: 5 }, (_, j) => `case-${i}-${j}`),
      ],
      kind: "reflection",
      evaluationFor: reflectionCandidateId(id),
      createdAt: now,
      attempts: 1,
      status: "stopped",
      skillEvaluation: {
        candidateId: reflectionCandidateId(id),
        skillChangeId: `skill-${i}`,
        candidateDigest: "c".repeat(64),
        sourceRequestId: candidate.requestId,
        heldOutEvidenceIds: Array.from(
          { length: 5 },
          (_, j) => `case-${i}-${j}`,
        ),
        status: "settled",
        cases: Array.from({ length: 5 }, (_, j) => ({
          evidenceId: `case-${i}-${j}`,
          status: "settled",
          decision: {
            answer: "yes",
            rationale: `PRIVATE${"夢".repeat(3993)}`,
            evidenceIds: [`case-${i}-${j}`],
          },
        })),
      },
    });
  }
  c.state.invocations["uncertain-evaluation"] = "uncertain";
  expect(JSON.stringify(actions.status(c)).includes("PRIVATE")).toBe(false);
  await actions.occupancy(c, "trim-results", true);
  expect(
    Buffer.byteLength(
      JSON.stringify({
        candidates: c.state.candidates,
        evaluations: c.state.reflection.requests.flatMap((r) =>
          r.skillEvaluation ? [r.skillEvaluation] : [],
        ),
      }),
    ),
  ).toBeLessThanOrEqual(256 * 1024);
  expect(c.state.candidates[required(ids[0])]).toBeUndefined();
  expect(c.state.candidates[required(ids[5])]?.decision.rationale).toBe(
    "evaluated-5",
  );
  expect(c.state.reflection.requests).toHaveLength(12);
  expect(
    c.state.reflection.requests.find((r) => r.id === "evaluation-0")
      ?.evaluationFor,
  ).toBe(reflectionCandidateId(required(ids[0])));
  expect(c.state.invocations["uncertain-evaluation"]).toBe("uncertain");
  expect(
    c.state.reflection.requests.find((r) => r.id === "evaluation-0")
      ?.skillEvaluation,
  ).toMatchObject({ status: "invalidated" });
});
