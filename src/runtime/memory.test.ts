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
import { slackSource } from "../imports/index.js";
import { type Claim, EvidenceStore, extractMemory } from "../memory/store.js";
import { createMemoryExtractor } from "../models/extraction.js";
import { createJuneRegistry, type JuneClientRegistry } from "./registry.js";

it.for(["reply", "deep"] as const)(
  "keeps private memory scoped and suppresses deleted in-flight $0 work",
  async (phase, t) => {
    const store = new EvidenceStore(":memory:", randomBytes(32));
    const scope = JSON.stringify(["private", "owner"]);
    const source = (event: MessageEvent, audience: string) =>
      slackSource({
        workspace: "T1",
        channel: event.address.conversationId,
        ts: event.messageId,
        author: "U1",
        text: event.text,
        workspaceUrl: "https://fixture.slack.com/",
        audiences: [audience],
      });
    const event: MessageEvent = {
      type: "message",
      id: "private-1",
      messageId: `${Math.floor(Date.now() / 1000)}.000001`,
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      direct: true,
      senderId: "U1",
      text: "PRIVATE heron observation",
    };
    store.appendSource(source(event, scope));
    const claim: Claim = {
      id: "private-claim",
      entity: JSON.stringify(["slack", "T1", "U1"]),
      text: "PRIVATE heron hypothesis",
      audiences: [scope],
      kind: "evidence",
      dependsOn: [source(event, scope).id],
      contradicts: [],
      supersedes: [],
    };
    store.appendClaim(claim);
    const relationshipClaims: Claim[] = [];
    for (const [id, entity, kind, text] of [
      ["alex-a", '["slack","T1","U2"]', "evidence", "Alex likes herons"],
      ["alex-b", '["slack","T1","U3"]', "evidence", "Alex avoids herons"],
      ["alex-c", '["slack","T2","U2"]', "evidence", "Alex studies herons"],
      ["alex-d", '["slack","T1","U2"]', "evidence", "Alex helps with herons"],
      ["dream", '["slack","T1","U9"]', "dream", "Alex might like herons"],
    ] as const) {
      relationshipClaims.push({
        id,
        entity,
        kind,
        text: `PRIVATE ${text}`,
        audiences: [scope],
        dependsOn: [source(event, scope).id],
        contradicts: [],
        supersedes: [],
      });
    }
    for (const related of relationshipClaims) store.appendClaim(related);
    const learnedPattern = "Prefer short debugging sessions";
    const original = source(event, scope);
    const supporting = source(
      {
        ...event,
        messageId: event.messageId.replace("000001", "000000"),
        text: "Evening sessions end early",
      },
      scope,
    );
    store.appendSource(supporting);
    const [pattern] = store.stageProposals(
      scope,
      [original.id, supporting.id],
      [
        {
          subjectSourceId: original.id,
          text: learnedPattern,
          category: "pattern",
          citations: [
            { sourceId: original.id, quote: event.text },
            { sourceId: supporting.id, quote: supporting.text },
          ],
          confidence: 0.6,
          validFrom: null,
          validTo: null,
          contradicts: [],
          supersedes: [],
        },
      ],
    );
    if (!pattern) throw new Error("Missing proposal");
    store.reviewProposal(scope, pattern.id, "accepted");
    // This pattern must not depend on a keyword match in the current turn.
    expect(store.retrieve(scope, event.text).claims).not.toContainEqual(
      pattern.claim,
    );
    const requests: ModelRequest[] = [];
    const sent: OutboundMessage[] = [];
    const extracted: string[][] = [];
    const contexts: unknown[] = [];
    const extractor = createMemoryExtractor({
      protocol: "anthropic",
      model: "fixture",
      apiKey: "fixture",
      async fetch(_url, init) {
        contexts.push(
          JSON.parse(JSON.parse(String(init?.body)).messages[0].content),
        );
        return Response.json({
          type: "message",
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: '{"proposals":[]}' }],
        });
      },
    });
    const pending = Promise.withResolvers<CompanionReply>();
    t.onTestFinished(() => {
      pending.resolve({ text: "" });
      store.close();
    });
    const registry = createJuneRegistry({
      owner: {
        id: "owner",
        identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
      },
      memory: {
        store,
        source,
        async extract(audience, ids, signal) {
          await extractMemory(store, audience, ids, extractor, signal);
          extracted.push(ids);
        },
      },
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, reactions: true, threads: true },
          async receive() {
            return { response: new Response(), events: [] };
          },
          async context(current) {
            return [event, current].map(({ type: _type, text, ...source }) => ({
              role: "user" as const,
              content: text,
              source,
            }));
          },
          async send(message) {
            sent.push(JSON.parse(JSON.stringify(message)));
            return { status: "sent", messageId: "out" };
          },
        },
      },
      model: {
        async reply(request) {
          requests.push(structuredClone(request));
          return requests.length === 3
            ? phase === "deep"
              ? { text: "", escalate: true }
              : pending.promise
            : { text: "" };
        },
      },
      deepModel: {
        async reply(request) {
          requests.push(structuredClone(request));
          return pending.promise;
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(["private", "owner"]);
    const done = async () =>
      Object.values((await june.snapshot()).events).filter(
        (event) => event.done,
      ).length;
    await june.send("inbox", { type: "event", event });
    await expect.poll(done).toBe(1);
    expect(extracted).toEqual([[source(event, scope).id]]);
    expect(contexts).toEqual([
      {
        sources: [source(event, scope)],
        existingClaims: [...relationshipClaims, claim, pattern.claim],
      },
    ]);
    expect(requests[0]?.system).toContain(learnedPattern);
    expect(requests[0]?.system).toContain(original.sourceUrl);
    expect(requests[0]?.system).toContain("not public global personality");
    const snapshot = await june.snapshot();
    const eventKey = Object.entries(snapshot.events).find(
      ([, record]) => record.event.id === event.id,
    )?.[0];
    if (!eventKey) throw new Error("Missing event");
    expect(snapshot.memoryContexts?.[eventKey]?.sourceIds).toContain(
      supporting.id,
    );
    const retained = source(
      {
        ...event,
        messageId: event.messageId.replace("000001", "000010"),
        text: "unrelated fresh heron evidence",
      },
      scope,
    );
    store.appendSource(retained);
    store.appendClaim({
      id: "grounding-only",
      entity: claim.entity,
      text: "PRIVATE derived fresh heron hypothesis",
      audiences: [scope],
      kind: "evidence",
      dependsOn: [retained.id],
      contradicts: [],
      supersedes: [],
      grounding: {
        subjectSourceId: source(event, scope).id,
        text: "PRIVATE derived fresh heron hypothesis",
        category: "claim",
        citations: [{ sourceId: source(event, scope).id, quote: event.text }],
        confidence: 0.5,
        validFrom: null,
        validTo: null,
        contradicts: [],
        supersedes: [],
      },
    });
    await june.send("inbox", { type: "event", event });
    const publicJune = client.conversation.getOrCreate([
      "slack",
      "T1",
      "C1",
      "root",
    ]);
    await publicJune.send("inbox", {
      type: "event",
      event: {
        ...event,
        direct: false,
        id: "public",
        text: "public heron question",
        address: { ...event.address, conversationId: "C1", threadId: "root" },
      },
    });
    await expect
      .poll(async () =>
        Object.values((await publicJune.snapshot()).events).every(
          (event) => event.done,
        ),
      )
      .toBe(true);
    await expect.poll(() => requests.length).toBe(2);
    expect(JSON.stringify(requests[1])).not.toContain("PRIVATE");
    expect(JSON.stringify(requests[1])).not.toContain("alex-a");
    expect(JSON.stringify(requests[1])).not.toContain("relationships");
    expect(JSON.stringify(requests[1])).not.toContain(learnedPattern);
    expect(extracted).toHaveLength(1);
    expect(contexts).toHaveLength(1);
    await june.send("inbox", {
      type: "event",
      event: {
        ...event,
        id: "private-2",
        messageId: event.messageId.replace("000001", "000002"),
        text: "more heron context",
      },
    });
    await expect.poll(() => requests.length).toBe(phase === "deep" ? 4 : 3);
    expect(requests[2]?.system).toContain("PRIVATE heron observation");
    expect(requests[2]?.system).toContain(
      "PRIVATE derived fresh heron hypothesis",
    );
    for (const request of requests.slice(2)) {
      const encoded = request.system.match(
        /Supplied memory text \(JSON string\): (.+)/,
      )?.[1];
      const memory = JSON.parse(
        JSON.parse(encoded ?? '""')
          .split("\n")
          .at(-1),
      );
      expect(memory.relationships).toEqual([
        { entity: '["slack","T1","U2"]', claimIds: ["alex-a", "alex-d"] },
        { entity: '["slack","T1","U3"]', claimIds: ["alex-b"] },
        { entity: '["slack","T2","U2"]', claimIds: ["alex-c"] },
        {
          entity: '["slack","T1","U1"]',
          claimIds: ["grounding-only", "private-claim"],
        },
      ]);
      expect(memory.style).toEqual({});
      expect(memory.evidence.claims).toHaveLength(7);
      expect(
        memory.evidence.sources.length + memory.evidence.claims.length,
      ).toBeLessThanOrEqual(12);
      expect(JSON.stringify(memory.evidence).length).toBeLessThanOrEqual(16000);
    }
    expect(requests.at(-1)?.system).toContain(learnedPattern);
    store.deleteSource(source(event, scope).id);
    await june.forget(source(event, scope).id);
    pending.resolve({
      text: "PRIVATE generated leak",
      reaction: "eyes",
      coding: { workspace: "no", goal: "no" },
    });
    await expect.poll(done).toBe(2);
    expect(sent).toEqual([]);
    expect(extracted).toHaveLength(1);
    expect((await june.snapshot()).history).toEqual([]);
    // Same-surface context must not resurrect a source from the platform after
    // forgetting it locally, even on a newly authorized later turn.
    await june.send("inbox", {
      type: "event",
      event: {
        ...event,
        id: "after-forget",
        text: "a fresh heron question",
        messageId: event.messageId.replace("000001", "000003"),
      },
    });
    await expect.poll(done).toBe(3);
    expect(JSON.stringify(requests.at(-1))).not.toContain("PRIVATE");
    expect(JSON.stringify(requests.at(-1))).not.toContain("alex-a");
    expect(JSON.stringify(requests.at(-1))).not.toContain(learnedPattern);
    expect(requests.at(-1)?.system).toContain("unrelated fresh heron evidence");
  },
);

it("holds owner-wide reflection occupancy for overlapping live calls until each actually settles", async (t) => {
  const first = Promise.withResolvers<CompanionReply>();
  const second = Promise.withResolvers<CompanionReply>();
  const seen: string[] = [];
  t.onTestFinished(() => {
    first.resolve({ text: "" });
    second.resolve({ text: "" });
  });
  const registry = createJuneRegistry({
    owner: {
      id: "owner",
      identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
    },
    channels: {},
    model: {
      async reply(request) {
        const text = JSON.parse(request.messages[0]?.content ?? "{}").text;
        seen.push(text);
        return text === "first" ? first.promise : second.promise;
      },
    },
    reflection: {
      ownerId: "owner",
      idleMs: 60000,
      deepMs: 120000,
      pollMs: 60000,
      timeoutMs: 1000,
      policy: {
        totalCapacity: 2,
        liveReserve: 1,
        cooldownMs: 1000,
        maxNoNewEvidence: 1,
        maxAttempts: 1,
        evidenceMaxAgeMs: 60000,
        quiet: { timeZone: "UTC", startMinute: 0, endMinute: 0 },
      },
      async retrieve() {
        return { authorized: false, evidence: [] };
      },
      async decide() {
        throw new Error("No background evidence supplied");
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const reflection = (
    client as Client<JuneClientRegistry>
  ).reflection.getOrCreate(["owner"]);
  const event: MessageEvent = {
    type: "message",
    id: "one",
    messageId: "123.456",
    senderId: "U1",
    occurredAt: Date.now(),
    direct: true,
    text: "first",
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  };
  await client.conversation
    .getOrCreate(["private", "owner"])
    .send("inbox", { type: "event", event });
  await client.conversation
    .getOrCreate(["slack", "T1", "C1", "root"])
    .send("inbox", {
      type: "event",
      event: {
        ...event,
        id: "two",
        direct: false,
        text: "second",
        address: { ...event.address, conversationId: "C1", threadId: "root" },
      },
    });
  await expect.poll(() => seen.length).toBe(2);
  expect((await reflection.status()).activeTurnIds).toHaveLength(2);
  first.resolve({ text: "" });
  await expect.poll(async () => (await reflection.status()).liveActive).toBe(1);
  expect((await reflection.status()).activeTurnIds[0]).toContain("C1");
  second.resolve({ text: "" });
  await expect.poll(async () => (await reflection.status()).liveActive).toBe(0);
  await client.conversation
    .getOrCreate(["private", "owner"])
    .send("inbox", { type: "event", event });
  expect((await reflection.status()).activeTurnIds).toEqual([]);
});
