import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "rivetkit/client";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { CuratedPersonalityStore } from "../memory/curated.js";
import { EvidenceStore } from "../memory/store.js";
import { reflectionCandidateId } from "./reflection.js";
import { createJuneRegistry, type JuneClientRegistry } from "./registry.js";

it("stages retained reflection through June without applying it or bypassing live, quiet, privacy and rejection gates", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "june-reflection-personality-"));
  const store = new EvidenceStore(":memory:", randomBytes(32));
  const curated = new CuratedPersonalityStore(
    join(root, "curated"),
    randomBytes(32),
    store,
    { initialize: true },
  );
  t.onTestFinished(() => {
    curated.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const owner = {
    id: "owner",
    identities: [{ channel: "slack" as const, accountId: "T", senderId: "U" }],
  };
  const scope = JSON.stringify(["private", owner.id]);
  const append = (id: string) =>
    store.appendSource({
      id,
      audiences: [scope],
      platform: "slack",
      account: "T",
      conversation: "D",
      author: "U",
      observedAt: Date.now(),
      sourceUrl: "https://example.invalid/source",
      text: "PRIVATE source body",
    });
  for (const id of ["a", "b", "context-only"]) append(id);
  const quiet = { timeZone: "UTC", startMinute: 0, endMinute: 0 };
  const requests: ModelRequest[] = [];
  const sent: OutboundMessage[] = [];
  let candidateId = "";
  let tone: "dry" | "playful" = "dry";
  let confidence: number | undefined = 0.7;
  let stageCalls = 0;
  let rejectedCallbacks = 0;
  let beforeRetrieve: (() => Promise<void>) | undefined;
  let beforeStage: (() => Promise<void>) | undefined;
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
          sent.push(message);
          return { status: "sent", messageId: `sent-${sent.length}` };
        },
      },
    },
    memory: {
      store,
      personality: curated,
      source(event, audience) {
        if (event.id !== "origin-turn") return undefined;
        return {
          id: event.id,
          audiences: [audience],
          platform: "slack",
          account: "T",
          conversation: "D",
          author: "U",
          observedAt: event.occurredAt,
          sourceUrl: "https://example.invalid/inbound",
          text: event.text,
        };
      },
    },
    model: {
      async reply(request) {
        requests.push(request);
        return {
          text: "",
          reflectionPersonalitySuggestion: {
            candidateId,
            expectedVersion: 0,
            changes: { tone },
          },
        };
      },
    },
    reflection: {
      ownerId: owner.id,
      policy: {
        totalCapacity: 2,
        liveReserve: 1,
        cooldownMs: 0,
        maxAttempts: 1,
        maxNoNewEvidence: 1,
        evidenceMaxAgeMs: 600_000,
        quiet,
      },
      idleMs: 86400000,
      deepMs: 86400000,
      pollMs: 100,
      timeoutMs: 1000,
      async retrieve({ scope, evidenceIds }) {
        const barrier = beforeRetrieve;
        beforeRetrieve = undefined;
        await barrier?.();
        return {
          authorized: scope === JSON.stringify(["private", owner.id]),
          evidence: store.reflectionEvidence(scope, evidenceIds, 600_000),
        };
      },
      evidenceCurrent(scope, evidence) {
        return (
          JSON.stringify(
            store.reflectionEvidence(
              scope,
              evidence.map((item) => item.id),
              600_000,
            ),
          ) === JSON.stringify(evidence)
        );
      },
      async decide(input) {
        return {
          answer: "yes",
          rationale: "PRIVATE hypothesis, not new evidence",
          evidenceIds: input.evidence
            .filter((item) => !item.id.endsWith("context-only"))
            .map((item) => item.id)
            .reverse(),
          ...(confidence === undefined ? {} : { confidence }),
        };
      },
      rejectProposals() {
        rejectedCallbacks++;
        return undefined;
      },
    },
  });
  const config = registry.config.use.personality.config;
  if (!("actions" in config) || !config.actions)
    throw new Error("Missing personality actions");
  const stage = config.actions.stage;
  config.actions.stage = async (c, ...args) => {
    stageCalls++;
    const barrier = beforeStage;
    beforeStage = undefined;
    await barrier?.();
    return stage(c, ...args);
  };
  const { client } = await setupTest(t, registry);
  const reflection = (
    client as Client<JuneClientRegistry>
  ).reflection.getOrCreate([owner.id]);
  const profile = client.personality.getOrCreate([owner.id]);
  const initial = await profile.read();
  const queued = await reflection.enqueue({
    scope,
    evidenceIds: ["a", "b", "context-only"],
    mode: "interaction",
    kind: "reflection",
  });
  candidateId = reflectionCandidateId(JSON.stringify([queued.id, 1]));
  await expect
    .poll(() => reflection.candidate(candidateId, scope), { timeout: 10000 })
    .not.toBeNull();
  const publication = await reflection.candidate(candidateId, scope);
  const originalEpoch = (await reflection.status()).epoch;
  let sequence = 0;
  async function deliver(extra: Partial<MessageEvent> = {}) {
    const event: MessageEvent = {
      id: `suggestion-${++sequence}`,
      messageId: `ts-${sequence}`,
      type: "message",
      senderId: "U",
      text: "Stage the reviewed reflection as a private tone suggestion",
      occurredAt: Date.now(),
      direct: true,
      metadata: { channelType: "im" },
      address: { channel: "slack", accountId: "T", conversationId: "D" },
      ...extra,
    };
    const route = routeEvent(event, owner);
    if (!route) throw new Error("Invalid test route");
    const conversation = client.conversation.getOrCreate(route.key);
    const before = sent.length;
    await conversation.send("inbox", { type: "event", event });
    await expect
      .poll(
        async () =>
          Object.values((await conversation.snapshot()).events).find(
            (record) => record.event.id === event.id,
          )?.done,
        { timeout: 10000 },
      )
      .toBe(true);
    return sent.slice(before).at(-1)?.content;
  }

  // Admission is not a distributed epoch lock through the destination RPC.
  // New work starting after admission may overlap an inert pending write.
  beforeStage = () => reflection.occupancy("after-admission", true);
  expect(await deliver()).toMatchObject({
    text: expect.stringContaining("Staged private personality suggestion"),
  });
  expect(requests.at(-1)?.reflectionPersonalitySuggestionAvailable).toBe(true);
  const [staged] = curated.pendingGlobalProposals(scope);
  expect(staged).toMatchObject({
    reflectionCandidateId: candidateId,
    expectedVersion: 0,
    changes: { tone: "dry" },
    evidenceIds: ["b", "a"],
    sourceIds: ["a", "b", "context-only"],
    expiresAt: publication?.publication?.expiresAt,
  });
  expect((await reflection.status()).epoch).toBeGreaterThan(originalEpoch);
  expect(await reflection.candidate(candidateId, scope)).toBeNull();
  expect(await profile.read()).toEqual(initial);
  expect((await reflection.status()).activeTurnIds).toEqual([
    "after-admission",
  ]);
  await reflection.occupancy("after-admission", false);
  expect(await deliver()).toMatchObject({
    text: expect.stringContaining("Staged private personality suggestion"),
  });
  expect(curated.pendingGlobalProposals(scope)).toEqual([staged]);
  // Retained staging must not restamp the publication or relax legacy reads.
  expect(await reflection.candidate(candidateId, scope)).toBeNull();
  tone = "playful";
  await deliver();
  expect(curated.pendingGlobalProposals(scope)).toEqual([staged]);
  tone = "dry";

  // An overlap DURING admission must fail even if the new work has already
  // settled again: checking only the final live count would incorrectly pass.
  beforeRetrieve = async () => {
    await reflection.occupancy("during-admission", true);
    await reflection.occupancy("during-admission", false);
  };
  expect(await deliver()).toMatchObject({
    text: expect.stringContaining("not staged"),
  });
  expect(curated.pendingGlobalProposals(scope)).toEqual([staged]);

  for (const extra of [
    { senderId: "guest" },
    {
      direct: false,
      metadata: { channelType: "channel" as const },
      address: {
        channel: "slack" as const,
        accountId: "T",
        conversationId: "C",
      },
    },
  ]) {
    await deliver(extra);
    expect(requests.at(-1)?.reflectionPersonalitySuggestionAvailable).toBe(
      false,
    );
    expect(curated.pendingGlobalProposals(scope)).toEqual([staged]);
  }
  await reflection.occupancy("other-unsettled-inference", true);
  expect(await deliver()).toMatchObject({
    text: expect.stringContaining("not staged"),
  });
  expect((await reflection.status()).activeTurnIds).toEqual([
    "other-unsettled-inference",
  ]);
  expect(curated.pendingGlobalProposals(scope)).toEqual([staged]);
  await reflection.occupancy("other-unsettled-inference", false);
  const now = new Date();
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  quiet.startMinute = minute;
  quiet.endMinute = (minute + 2) % 1440;
  expect(await deliver()).toMatchObject({
    text: expect.stringContaining("not staged"),
  });
  expect(curated.pendingGlobalProposals(scope)).toEqual([staged]);
  quiet.startMinute = quiet.endMinute = 0;

  for (let retry = 0; retry < 2; retry++)
    await deliver({
      text: `!reflection reject ${candidateId}`,
      reflectionReviewEligible: true,
    });
  expect(rejectedCallbacks).toBe(2);
  expect(curated.pendingGlobalProposals(scope)).toEqual([]);
  expect(await deliver()).toMatchObject({
    text: expect.stringContaining("not staged"),
  });
  expect(curated.pendingGlobalProposals(scope)).toEqual([]);
  expect(await profile.read()).toEqual(initial);

  // Each new publication proves the destination still rejects changes after
  // admission. The uncited source must be protected too, not just citations.
  for (const race of [
    "missing-confidence",
    "rejection",
    "forgetting",
    "origin",
    "unrelated-deletion",
    "head",
  ]) {
    const ids = [race, `${race}-context-only`];
    for (const id of ids) append(id);
    confidence = race === "missing-confidence" ? undefined : 0.7;
    const queued = await reflection.enqueue({
      scope,
      evidenceIds: ids,
      mode: "interaction",
      kind: "reflection",
    });
    candidateId = reflectionCandidateId(JSON.stringify([queued.id, 1]));
    await expect
      .poll(() => reflection.candidate(candidateId, scope), { timeout: 10000 })
      .not.toBeNull();
    const calls = stageCalls;
    let deletedOrigin = false;
    const evidenceBefore = store.reflectionEvidence(scope, ids, 600_000);
    if (race === "unrelated-deletion") append("unrelated-turn-context");
    beforeStage = async () => {
      if (race === "rejection")
        expect(await reflection.rejectCandidate(scope, candidateId)).toBe(true);
      if (race === "forgetting") store.deleteSource(`${race}-context-only`);
      // Cross the registry allowed() -> actor entry boundary using only the
      // ledger tombstone: no candidate deletion and no reflection.cancel RPC.
      if (race === "origin") {
        deletedOrigin =
          store.reflectionEvidence(scope, ["origin-turn"], 600_000).length ===
          1;
        store.deleteSource("origin-turn");
      }
      if (race === "unrelated-deletion")
        store.deleteSource("unrelated-turn-context");
      if (race === "head")
        expect(
          await profile.command({
            type: "message",
            id: "concurrent-owner-revision",
            messageId: "concurrent-owner-revision",
            senderId: "U",
            occurredAt: Date.now(),
            direct: true,
            metadata: { channelType: "im" },
            personalityCommandEligible: true,
            address: { channel: "slack", accountId: "T", conversationId: "D" },
            text: '!personality revise {"expectedVersion":0,"changes":{"humor":"none"},"explanation":"Explicit owner revision","publish":true}',
          }),
        ).toContain("Saved global personality revision 1");
    };
    const receipt = await deliver(
      race === "origin" ? { id: "origin-turn" } : {},
    );
    expect(stageCalls - calls).toBe(race === "missing-confidence" ? 0 : 1);
    beforeStage = undefined;
    if (race === "origin" || race === "unrelated-deletion") {
      if (race === "origin") expect(deletedOrigin).toBe(true);
      expect(store.reflectionEvidence(scope, ids, 600_000)).toEqual(
        evidenceBefore,
      );
    }
    expect(curated.pendingGlobalProposals(scope)).toEqual([]);
    if (race === "origin" || race === "unrelated-deletion") {
      // Revocation invalidates this caller, not the still-supported candidate.
      // A fresh turn captures the new revision and can stage normally.
      expect(await deliver()).toMatchObject({
        text: expect.stringContaining("Staged private personality suggestion"),
      });
      expect(curated.pendingGlobalProposals(scope)).toEqual([
        expect.objectContaining({ reflectionCandidateId: candidateId }),
      ]);
      await reflection.rejectCandidate(scope, candidateId);
    }
    if (race === "head") {
      expect(receipt).toMatchObject({
        text: expect.stringContaining("current version is 1"),
      });
      expect(await profile.read()).toMatchObject({
        version: 1,
        style: { tone: "warm", humor: "none" },
      });
    } else expect(await profile.read()).toEqual(initial);
  }
  expect(JSON.stringify(sent)).not.toContain("PRIVATE");
}, 60000);
