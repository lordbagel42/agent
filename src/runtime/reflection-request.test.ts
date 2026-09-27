import { createHash, randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
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
import { reflectionCandidateId } from "./reflection.js";
import {
  createJuneRegistry,
  type Dependencies,
  type JuneClientRegistry,
} from "./registry.js";

it("admits explicit private reflection once without bypassing evidence or scheduler boundaries", async (t) => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const audience = JSON.stringify(["private", owner.id]);
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  for (const id of ["a", "b", "c", "hidden", "stale", "deleted"]) {
    store.appendSource({
      id,
      audiences: [id === "hidden" ? "other-audience" : audience],
      platform: "slack",
      account: "T1",
      conversation: "D1",
      author: "U1",
      observedAt: Date.now() - (id === "stale" ? 120000 : 0),
      sourceUrl: `https://example.com/${id}`,
      text: `PRIVATE evidence ${id}`,
    });
  }
  store.deleteSource("deleted");
  const sent: OutboundMessage[] = [];
  const requests: ModelRequest[] = [];
  const decisions: { at: number; ids: string[]; question: string }[] = [];
  const skillChange = {
    proposedBehavior: "Ask one clarifying question before estimating.",
    rationale: "PRIVATE evidence a omits a required detail.",
    evidenceIds: ["a"],
  };
  const action: CompanionReply = {
    text: "",
    reflectionRequest: {
      evidenceIds: ["b", "a", "a"],
      mode: "deep",
      kind: "curiosity",
    },
  };
  let search = false;
  let searches = 0;
  const policy = {
    totalCapacity: 1,
    liveReserve: 1,
    cooldownMs: 1,
    maxAttempts: 1,
    maxNoNewEvidence: 1,
    evidenceMaxAgeMs: 60000,
    quiet: { timeZone: "UTC", startMinute: 0, endMinute: 0 },
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
          return { status: "sent", messageId: `out${sent.length}` };
        },
      },
    },
    model: {
      async reply(request) {
        requests.push(request);
        expect(
          Object.hasOwn(
            replyJsonSchema([], request).properties,
            "reflectionRequest",
          ),
        ).toBe(request.reflectionRequestAvailable);
        if (request.reflectionRequestAvailable) {
          expect(request.system).toContain("set reflectionRequest");
          expect(request.system).toContain(
            "Curiosity performs no public search",
          );
          expect(request.system).toContain("explicitly hypothetical");
          expect(request.system).toContain("optional skill-change proposal");
        }
        if (search && request.webSearchAvailable)
          return { text: "", webSearch: "public query" };
        // Custom providers must not bypass host revalidation.
        return action;
      },
    },
    webSearch: {
      available: true,
      description: "fixture",
      async search() {
        searches++;
        return {
          status: "ready",
          results: [
            { title: "public", url: "https://example.com", snippet: "public" },
          ],
        };
      },
    },
    reflection: {
      ownerId: owner.id,
      policy,
      idleMs: 300,
      deepMs: 800,
      pollMs: 20,
      timeoutMs: 1000,
      evidenceCurrent: (scope, evidence) =>
        scope === audience &&
        JSON.stringify(
          store.reflectionEvidence(
            scope,
            evidence.map((e) => e.id),
            60000,
          ),
        ) === JSON.stringify(evidence),
      async retrieve({ scope, evidenceIds }) {
        return {
          authorized: scope === audience,
          evidence: store.reflectionEvidence(scope, evidenceIds, 60000),
        };
      },
      async decide(input) {
        decisions.push({
          at: Date.now(),
          ids: input.evidence.map((e) => e.id),
          question: input.question,
        });
        return {
          answer: "yes",
          rationale: "PRIVATE interpretation",
          evidenceIds: input.simulateResponses
            ? ["a"]
            : input.evidence.map((e) => e.id),
          ...(input.simulateResponses
            ? {
                alternativeResponses: ["PRIVATE hypothetical alternative"],
                skillChange,
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
  let serial = 0;
  const deliver = async (extra: Partial<MessageEvent> = {}) => {
    const event: MessageEvent = {
      id: `in${++serial}`,
      type: "message",
      messageId: `ts${serial}`,
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      direct: true,
      senderId: "U1",
      text: "Reflect on this evidence",
      ...extra,
    };
    const scope = routeEvent(event, owner, true);
    if (!scope) throw new Error("Missing fixture scope");
    const actor = client.conversation.getOrCreate(scope.key);
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
    const content = sent.at(-1)?.content;
    return content?.type === "text" ? content.text : "";
  };
  expect(await deliver()).toContain("Reflection queued");
  action.reflectionRequest = { evidenceIds: ["a", "b"], mode: "idle" };
  expect(await deliver()).toContain("already requested");
  expect((await reflection.status()).reflection.requests).toMatchObject([
    {
      scope: audience,
      evidenceIds: ["a", "b"],
      kind: "curiosity",
      status: "pending",
      attempts: 0,
    },
  ]);
  for (const evidenceIds of [["missing"], ["hidden"], ["stale"], ["deleted"]]) {
    action.reflectionRequest = { evidenceIds, mode: "idle", kind: "curiosity" };
    expect(await deliver()).toContain("Reflection unavailable");
  }
  action.reflectionRequest = { evidenceIds: ["c"], mode: "idle" };
  for (const extra of [
    { direct: false },
    { senderId: "U2", metadata: { channelType: "im" as const } },
  ]) {
    expect(await deliver(extra)).toContain("require an owner-private turn");
    expect(requests.at(-1)?.reflectionRequestAvailable).toBe(false);
  }
  expect(searches).toBe(0); // Missing evidence never expands into public search.
  search = true;
  expect(await deliver()).toContain("require an owner-private turn");
  expect(requests.at(-1)?.usageStage).toBe("synthesis");
  expect(requests.at(-1)?.reflectionRequestAvailable).toBe(false);
  expect(searches).toBe(1); // Only the separate explicit webSearch directive.
  search = false;
  const enabled = deps.reflection;
  deps.reflection = undefined;
  expect(await deliver()).toContain("reflection enabled");
  expect(requests.at(-1)?.reflectionRequestAvailable).toBe(false);
  deps.reflection = enabled;
  const memory = deps.memory;
  deps.memory = undefined;
  expect(await deliver()).toContain("retained memory and reflection enabled");
  expect(requests.at(-1)?.reflectionRequestAvailable).toBe(false);
  deps.memory = memory;
  action.inspection = "reflection";
  expect(await deliver()).toContain("could not be confirmed");
  delete action.inspection;
  expect((await reflection.status()).reflection.requests).toHaveLength(1);
  await setTimeout(900); // exceed deep delay so capacity alone is tested
  expect(decisions).toHaveLength(0); // live reserve leaves no reflection capacity

  const minute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  policy.quiet = {
    timeZone: "UTC",
    startMinute: minute,
    endMinute: (minute + 2) % 1440,
  };
  policy.totalCapacity = 2;
  await setTimeout(900);
  expect(decisions).toHaveLength(0);
  await reflection.occupancy("live-hold", true);
  policy.quiet.endMinute = policy.quiet.startMinute;
  await setTimeout(900);
  expect(decisions).toHaveLength(0);
  const interactionAt = Date.now();
  await reflection.occupancy("new-live-hold", true);
  await reflection.occupancy("new-live-hold", false);
  await reflection.occupancy("live-hold", false);
  await expect.poll(() => decisions.length, { timeout: 5000 }).toBe(1);
  expect(decisions[0]?.at).toBeGreaterThanOrEqual(interactionAt + 800);
  expect(decisions[0]?.ids).toEqual(["a", "b"]);
  expect(decisions[0]?.question).toBe("novelty"); // Deep curiosity never stages an interruption.
  await expect
    .poll(
      async () => (await reflection.status()).reflection.requests[0]?.status,
    )
    .toBe("stopped");
  const candidateId = (await reflection.status()).candidateIds[0];
  expect(candidateId).toBeDefined();
  const candidate = await reflection.candidate(candidateId as string);
  expect(candidate).toMatchObject({
    mode: "deep",
    kind: "proposal",
    hypothesisOnly: true,
    skillChange: {
      ...skillChange,
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      hypothesisOnly: true,
      createdAt: candidate?.createdAt,
    },
    decision: {
      evidenceIds: ["a"],
      alternativeResponses: ["PRIVATE hypothetical alternative"],
    },
  });
  expect(candidate?.skillChange?.digest).toBe(
    createHash("sha256")
      .update(
        JSON.stringify([
          "skill-change-v1",
          candidateId,
          candidate?.epoch,
          ["a", "b"],
          {
            answer: "yes",
            rationale: "PRIVATE interpretation",
            evidenceIds: ["a"],
            skillChange,
            alternativeResponses: ["PRIVATE hypothetical alternative"],
          },
        ]),
      )
      .digest("hex"),
  );
  expect(
    await reflection.inspectCandidate(
      audience,
      reflectionCandidateId(candidateId as string),
    ),
  ).toMatchObject({
    candidate: {
      hypothesisOnly: true,
      skillChange: candidate?.skillChange,
      decision: {
        alternativeResponses: ["PRIVATE hypothetical alternative"],
      },
    },
  });
  expect(
    (await reflection.candidate(candidateId as string))?.skillChange,
  ).toEqual(candidate?.skillChange);
  await reflection.occupancy("skill-review-turn", true);
  expect(await reflection.candidate(candidateId as string)).toBeNull();
  expect(
    await reflection.inspectCandidate(
      audience,
      reflectionCandidateId(candidateId as string),
    ),
  ).toMatchObject({ candidate: { skillChange: candidate?.skillChange } });
  await reflection.occupancy("skill-review-turn", false);
  expect(
    (await client.conversation.getOrCreate(["private", owner.id]).snapshot())
      .jobs,
  ).toEqual({});
  // Even a source cited by neither decision nor skill remains training provenance.
  store.deleteSource("b");
  expect(await reflection.candidate(candidateId as string)).toBeNull();
  expect(
    await reflection.inspectCandidate(
      audience,
      reflectionCandidateId(candidateId as string),
    ),
  ).toBeNull();
  expect(await deliver()).toContain("Reflection queued");
  const idleRequest = (await reflection.status()).reflection.requests[1];
  await expect.poll(() => decisions.length, { timeout: 5000 }).toBe(2);
  expect(decisions[1]?.at).toBeGreaterThanOrEqual(
    (idleRequest?.createdAt ?? Infinity) + 300,
  );
  expect(decisions[1]?.ids).toEqual(["c"]);
  expect(decisions[1]?.question).toBe("novelty"); // Older replies omit kind.
  expect(await deliver()).toContain("already requested");
  await setTimeout(900);
  expect(decisions).toHaveLength(2);
  expect((await reflection.status()).reflection.requests).toHaveLength(2);
  expect(searches).toBe(1);
  expect(JSON.stringify(sent)).not.toContain("PRIVATE");
  for (const input of [
    { evidenceIds: [], mode: "idle" },
    { evidenceIds: ["a"], mode: "interaction" },
    {
      evidenceIds: Array.from({ length: 21 }, (_, i) => `source-${i}`),
      mode: "idle",
    },
    { evidenceIds: ["a"], mode: "idle", scope: "other-audience" },
    { evidenceIds: ["a"], mode: "idle", kind: "public-search" },
    {
      evidenceIds: ["a"],
      mode: "idle",
      kind: "curiosity",
      query: "private account query",
    },
  ])
    expect(() =>
      parseReply(JSON.stringify({ text: "", reflectionRequest: input }), [], {
        reflectionRequestAvailable: true,
      }),
    ).toThrow();
  expect(() => parseReply(JSON.stringify(action), [])).toThrow();
});
