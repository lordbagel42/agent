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
import { EvidenceStore } from "../memory/store.js";
import { reflectionCandidateId } from "./reflection.js";
import { createJuneRegistry, type JuneClientRegistry } from "./registry.js";

it("stages only current original-source reflection hypotheses through private June review, never accepts, and forgets all context", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const scope = JSON.stringify(["private", "owner"]);
  const now = Date.now();
  for (const id of ["support", "subject", "uncited"])
    store.appendSource({
      id,
      audiences: [scope],
      platform: "slack",
      account: "T1",
      conversation: "D1",
      author: id === "subject" ? "U2" : "U1",
      observedAt: now,
      sourceUrl: `https://example.com/${id}`,
      text: `Original ${id} observation`,
    });
  store.stageProposals(scope, ["support", "subject", "uncited"], []);
  let modelCalls = 0;
  let extracts = 0;
  let rejections = 0;
  let failRejection = false;
  let revokeAfterValidation = false;
  let revoked = false;
  let dream: string | undefined;
  let pause = false;
  let entered = Promise.withResolvers<void>();
  let release = Promise.withResolvers<void>();
  t.onTestFinished(() => release.resolve());
  let pauseBeforeStage = false;
  const stageEntered = Promise.withResolvers<void>();
  const stageRelease = Promise.withResolvers<void>();
  t.onTestFinished(() => stageRelease.resolve());
  const sent: OutboundMessage[] = [];
  const registry = createJuneRegistry({
    owner: {
      id: "owner",
      identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
    },
    memory: {
      store,
      source(event, audience) {
        return {
          id: `inbound:${event.id}`,
          audiences: [audience],
          platform: "slack",
          account: "T1",
          conversation: "D1",
          author: "U1",
          observedAt: event.occurredAt,
          sourceUrl: `https://example.com/inbound/${event.id}`,
          text: event.text,
        };
      },
      async extract() {
        extracts++;
      },
    },
    reflection: {
      ownerId: "owner",
      policy: {
        totalCapacity: 2,
        liveReserve: 1,
        cooldownMs: 1,
        maxAttempts: 1,
        maxNoNewEvidence: 1,
        evidenceMaxAgeMs: 120000,
        quiet: { timeZone: "UTC", startMinute: 0, endMinute: 0 },
      },
      idleMs: 1,
      deepMs: 2,
      pollMs: 20,
      timeoutMs: 10000,
      rejectProposals() {
        rejections++;
        if (failRejection) {
          failRejection = false;
          throw new Error("Fixture rejection interrupted after ledger write");
        }
      },
      evidenceCurrent(scope, evidence) {
        if (revokeAfterValidation) {
          revokeAfterValidation = false;
          queueMicrotask(() => {
            revoked = true;
          });
        }
        return (
          !revoked &&
          JSON.stringify(
            store
              .reflectionEvidence(
                scope,
                evidence.map((item) => item.id),
                120000,
              )
              .map((item) => ({
                ...item,
                source: item.id === dream ? "dream" : item.source,
              })),
          ) === JSON.stringify(evidence)
        );
      },
      async retrieve({ scope, evidenceIds }) {
        if (pause) {
          entered.resolve();
          await release.promise;
        }
        return {
          authorized: true,
          evidence: store
            .reflectionEvidence(scope, evidenceIds, 120000)
            .map((item) => ({
              ...item,
              source: item.id === dream ? "dream" : item.source,
            })),
        };
      },
      async decide() {
        return {
          answer: "yes",
          rationale: "Possible shared preference",
          evidenceIds: ["support", "subject"],
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
      async reply(request: ModelRequest): Promise<CompanionReply> {
        modelCalls++;
        expect(request.reflectionMemoryAvailable).toBe(true);
        expect((await reflection.status()).liveActive).toBe(1);
        expect(
          await reflection.stageMemory(
            scope,
            id,
            "subject",
            store.deletionRevision(),
          ),
        ).toBeNull();
        return {
          text: "",
          reflectionMemory: { id, subjectSourceId: "subject" },
        };
      },
    },
  });
  const actorConfig = registry.config.use.reflection?.config;
  if (!actorConfig?.actions) throw new Error("Missing reflection actions");
  const stage = actorConfig.actions.stageMemory;
  actorConfig.actions.stageMemory = async (c, ...args) => {
    // Hold the RPC after the registry's caller check but before actor entry.
    // The fake model's live-occupancy probe must not enter this window.
    if (pauseBeforeStage && c.state.liveActive === 0) {
      pauseBeforeStage = false;
      stageEntered.resolve();
      await stageRelease.promise;
    }
    return stage(c, ...args);
  };
  const { client } = await setupTest(t, registry);
  const reflection = (
    client as Client<JuneClientRegistry>
  ).reflection.getOrCreate(["owner"]);
  await reflection.enqueue({
    scope,
    kind: "reflection",
    mode: "interaction",
    evidenceIds: ["support", "subject", "uncited"],
  });
  await expect
    .poll(async () => (await reflection.status()).candidateIds.length, {
      timeout: 10000,
    })
    .toBe(1);
  const raw = (await reflection.status()).candidateIds[0];
  if (!raw) throw new Error("Missing fixture candidate");
  const id = reflectionCandidateId(raw);
  expect(
    await reflection.stageMemory(
      "public",
      id,
      "subject",
      store.deletionRevision(),
    ),
  ).toBeNull();
  expect(
    await reflection.stageMemory(
      scope,
      id,
      "uncited",
      store.deletionRevision(),
    ),
  ).toBeNull();
  for (const source of ["support", "uncited"]) {
    dream = source;
    expect(
      await reflection.stageMemory(
        scope,
        id,
        "subject",
        store.deletionRevision(),
      ),
    ).toBeNull();
  }
  dream = undefined;
  expect(store.proposals(scope)).toEqual([]);

  revokeAfterValidation = true;
  expect(
    await reflection.stageMemory(
      scope,
      id,
      "subject",
      store.deletionRevision(),
    ),
  ).toBeNull();
  expect(store.proposals(scope)).toEqual([]);
  revoked = false;

  const generationEpoch = (await reflection.candidate(id, scope))?.epoch;
  pause = true;
  const interrupted = reflection.stageMemory(
    scope,
    id,
    "subject",
    store.deletionRevision(),
  );
  await entered.promise;
  await reflection.occupancy("intervening-live-turn", true);
  await reflection.occupancy("intervening-live-turn", false);
  release.resolve();
  expect(await interrupted).toBeNull();
  expect(store.proposals(scope)).toEqual([]);
  expect(await reflection.candidate(id, scope)).toBeNull();
  pause = false;
  expect((await reflection.inspectCandidate(scope, id))?.candidate.epoch).toBe(
    generationEpoch,
  );

  const june = client.conversation.getOrCreate(["private", "owner"]);
  const event: MessageEvent = {
    type: "message",
    id: "inspect",
    messageId: "1790000000.000001",
    occurredAt: now,
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    direct: true,
    senderId: "U1",
    reflectionReviewEligible: true,
    text: `!reflection inspect ${id}`,
  };
  await june.send("inbox", { type: "event", event });
  await expect
    .poll(
      async () =>
        Object.values((await june.snapshot()).events).find(
          (record) => record.event.id === "inspect",
        )?.done,
      {
        timeout: 10000,
      },
    )
    .toBe(true);
  const command = {
    ...event,
    id: "stage",
    messageId: "1790000000.000002",
    text: `Stage reflection ${id} about subject as a pending memory hypothesis.`,
  };
  const sentBeforeInvalidation = sent.length;
  pauseBeforeStage = true;
  await june.send("inbox", {
    type: "event",
    event: {
      ...command,
      id: "invalidated-stage",
      messageId: "1790000000.000004",
    },
  });
  await stageEntered.promise;
  expect(store.source(scope, "inbound:invalidated-stage")).toBeDefined();
  const beforeDeletion = await reflection.status();
  store.deleteSource("inbound:invalidated-stage");
  // No reflection.cancel or actor cleanup: all candidate evidence remains current.
  expect(await reflection.status()).toEqual(beforeDeletion);
  expect(await reflection.inspectCandidate(scope, id)).not.toBeNull();
  stageRelease.resolve();
  await expect
    .poll(
      async () =>
        Object.values((await june.snapshot()).events).find(
          (record) => record.event.id === "invalidated-stage",
        )?.done,
      { timeout: 10000 },
    )
    .toBe(true);
  expect(sent).toHaveLength(sentBeforeInvalidation);
  expect(store.proposals(scope)).toEqual([]);

  await june.send("inbox", { type: "event", event: command });
  await expect
    .poll(
      async () =>
        Object.values((await june.snapshot()).events).find(
          (record) => record.event.id === "stage",
        )?.done,
      {
        timeout: 10000,
      },
    )
    .toBe(true);
  const [proposal] = store.proposals(scope);
  if (!proposal) throw new Error("Missing staged proposal");
  expect(proposal).toMatchObject({
    status: "pending",
    claim: {
      entity: '["slack","T1","U2"]',
      text: "Reflection hypothesis: Possible shared preference",
      dependsOn: ["subject", "support"],
      extractionContext: {
        sourceIds: ["subject", "support", "uncited"],
        claimIds: [],
      },
      grounding: {
        confidence: null,
        citations: [
          { sourceId: "subject", quote: "Original subject observation" },
          { sourceId: "support", quote: "Original support observation" },
        ],
      },
    },
  });
  expect(JSON.stringify(sent)).toContain(proposal.id);
  expect(JSON.stringify(await june.snapshot())).not.toContain(
    "Possible shared preference",
  );
  expect(store.retrieve(scope, "").claims).toEqual([]);
  expect(store.source(scope, "subject")?.observedAt).toBe(now);
  expect(store.retrieve(scope, "").sources).toHaveLength(4);
  expect(store.source(scope, "inbound:stage")?.text).toBe(command.text);
  expect(store.source(scope, "inbound:inspect")).toBeUndefined();
  expect([modelCalls, extracts]).toEqual([2, 0]);
  expect((await reflection.status()).candidateIds).toEqual([raw]);
  expect(
    await reflection.stageMemory(
      scope,
      id,
      "support",
      store.deletionRevision(),
    ),
  ).toEqual({
    id: proposal.id,
    status: "pending",
  });
  expect(store.proposals(scope)).toEqual([proposal]);
  await june.send("inbox", { type: "event", event: command });
  await june.send("inbox", {
    type: "event",
    event: {
      ...command,
      id: "retry",
      messageId: "1790000000.000003",
      text: `!reflection memory ${id} support`,
    },
  });
  await expect
    .poll(
      async () =>
        Object.values((await june.snapshot()).events).find(
          (record) => record.event.id === "retry",
        )?.done,
      {
        timeout: 10000,
      },
    )
    .toBe(true);
  expect(store.proposals(scope)).toEqual([proposal]);
  expect([modelCalls, extracts]).toEqual([2, 0]);
  expect(store.source(scope, "inbound:retry")).toBeUndefined();

  entered = Promise.withResolvers<void>();
  release = Promise.withResolvers<void>();
  pause = true;
  const staging = reflection.stageMemory(
    scope,
    id,
    "subject",
    store.deletionRevision(),
  );
  await entered.promise;
  store.deleteSource("uncited");
  release.resolve();
  expect(await staging).toBeNull();
  expect(store.proposals(scope)).toEqual([]);
  expect(store.isDeleted(proposal.id)).toBe(true);
  expect(store.source(scope, "subject")).toBeDefined();
  expect(
    await reflection.stageMemory(
      scope,
      id,
      "subject",
      store.deletionRevision(),
    ),
  ).toBeNull();

  pause = false;
  const original = store.source(scope, "support");
  if (!original) throw new Error("Missing original fixture source");
  store.appendSource({
    ...original,
    id: "fresh",
    sourceUrl: "https://example.com/fresh",
    text: "A new original episode",
    observedAt: Date.now(),
  });
  await reflection.enqueue({
    scope,
    kind: "reflection",
    mode: "interaction",
    evidenceIds: ["support", "subject", "fresh"],
  });
  await expect
    .poll(
      async () =>
        (await reflection.status()).candidateIds.some((value) => value !== raw),
      { timeout: 10000 },
    )
    .toBe(true);
  const next = (await reflection.status()).candidateIds.find(
    (value) => value !== raw,
  );
  if (!next) throw new Error("Missing second fixture candidate");
  const alias = reflectionCandidateId(next);
  const staged = await reflection.stageMemory(
    scope,
    alias,
    "subject",
    store.deletionRevision(),
  );
  if (!staged) throw new Error("Missing second proposal");
  expect(staged.status).toBe("pending");
  failRejection = true;
  await expect(reflection.rejectCandidate(scope, alias)).rejects.toThrow();
  expect((await reflection.status()).candidateIds).toContain(next);
  expect(store.proposal(scope, staged.id)?.status).toBe("rejected");
  expect(
    await reflection.stageMemory(
      scope,
      alias,
      "subject",
      store.deletionRevision(),
    ),
  ).toBeNull();
  expect(await reflection.rejectCandidate(scope, alias)).toBe(true);
  expect(await reflection.rejectCandidate(scope, alias)).toBe(true);
  expect(rejections).toBe(3);
  expect(store.proposal(scope, staged.id)?.status).toBe("rejected");
  expect(() => store.reviewProposal(scope, staged.id, "accepted")).toThrow(
    "already reviewed",
  );
  expect(
    await reflection.stageMemory(
      scope,
      alias,
      "subject",
      store.deletionRevision(),
    ),
  ).toBeNull();
  expect(store.source(scope, "subject")).toBeDefined();
});
