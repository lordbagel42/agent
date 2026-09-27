import { createHash, randomBytes } from "node:crypto";
import type { Client } from "rivetkit/client";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type { MessageEvent, OutboundMessage } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { EvidenceStore } from "../memory/store.js";
import {
  createJuneRegistry,
  type Dependencies,
  type JuneClientRegistry,
} from "./registry.js";

it("lists only current private candidates without inference, extraction, retention or stale retry payloads", async (t) => {
  const owner = {
    id: "owner",
    identities: [{ channel: "slack" as const, accountId: "T", senderId: "U" }],
  };
  const scope = JSON.stringify(["private", owner.id]);
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const sent: OutboundMessage[] = [];
  const denied = new Set<string>();
  let stale = false;
  let fail = false;
  let retry = false;
  let modelCalls = 0;
  let extractionCalls = 0;
  let reads = 0;
  let hold: Promise<void> | undefined;
  const quiet = { timeZone: "UTC", startMinute: 0, endMinute: 0 };
  const deps: Dependencies = {
    owner,
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          if (retry) {
            retry = false;
            denied.add("PRIVATE-0");
            return { status: "rejected", code: "fixture", retryable: true };
          }
          return { status: "sent", messageId: `sent-${sent.length}` };
        },
      },
    },
    model: {
      async reply() {
        modelCalls++;
        return { text: "ordinary reply" };
      },
    },
    memory: {
      store,
      source(event, audience) {
        return {
          id: event.id,
          audiences: [audience],
          platform: "slack",
          account: "T",
          conversation: "D",
          author: "U",
          observedAt: Date.now(),
          sourceUrl: "https://example.com/fixture",
          text: event.text,
        };
      },
      async extract() {
        extractionCalls++;
      },
    },
    reflection: {
      ownerId: owner.id,
      policy: {
        totalCapacity: 2,
        liveReserve: 1,
        cooldownMs: 0,
        maxAttempts: 1,
        maxNoNewEvidence: 100,
        evidenceMaxAgeMs: 60000,
        quiet,
      },
      idleMs: 86400000,
      deepMs: 86400000,
      pollMs: 100,
      timeoutMs: 1000,
      async retrieve({ scope, evidenceIds }) {
        reads++;
        await hold;
        if (fail) throw new Error("PRIVATE failure");
        return {
          authorized: !evidenceIds.some((id) => denied.has(id)),
          evidence: evidenceIds.map((id) => ({
            id,
            scope,
            text: "PRIVATE evidence",
            source: "episode" as const,
            observedAt: Date.now(),
            expiresAt: Date.now() + 60000,
            invalidated: stale && id === "PRIVATE-1",
          })),
        };
      },
      async decide(input) {
        return {
          answer: "yes",
          rationale: "PRIVATE rationale",
          evidenceIds: input.evidence.map((e) => e.id),
        };
      },
    },
  };
  const registry = createJuneRegistry(deps);
  const { client } = await setupTest(t, registry);
  const reflection = (
    client as Client<JuneClientRegistry>
  ).reflection.getOrCreate([owner.id]);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const result = await reflection.enqueue({
      scope: i === 2 ? "other-audience" : scope,
      evidenceIds: [`PRIVATE-${i}`],
      kind: "reflection",
      mode: "interaction",
    });
    ids.push(
      createHash("sha256")
        .update(JSON.stringify([result.id, 1]))
        .digest("hex"),
    );
  }
  await expect
    .poll(async () => (await reflection.status()).candidateIds.length, {
      timeout: 15000,
    })
    .toBe(3);
  const before = await reflection.status();
  reads = 0;
  const listed = await reflection.listCandidates(scope);
  // Candidate insertion follows scheduler completion, not enqueue order.
  expect({ ...listed, ids: [...listed.ids].sort() }).toMatchObject({
    status: "ready",
    ids: ids.slice(0, 2).sort(),
    truncated: false,
  });
  expect(reads).toBe(2);
  await expect(reflection.listCandidates("other-audience")).rejects.toThrow();
  expect(reads).toBe(2);

  let eventIndex = 0;
  const deliver = async (extra: Partial<MessageEvent> = {}) => {
    const event: MessageEvent = {
      id: `review-${eventIndex++}`,
      type: "message",
      messageId: `ts-${eventIndex}`,
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T", conversationId: "D" },
      direct: true,
      senderId: "U",
      text: "!reflection list",
      reflectionReviewEligible: true,
      ...extra,
    };
    const routed = routeEvent(event, owner);
    if (!routed) throw new Error("fixture route missing");
    const actor = client.conversation.getOrCreate(routed.key);
    const done = Object.values((await actor.snapshot()).events).filter(
      (e) => e.done,
    ).length;
    await actor.send("inbox", { type: "event", event });
    await expect
      .poll(
        async () =>
          Object.values((await actor.snapshot()).events).filter((e) => e.done)
            .length,
        { timeout: 10000 },
      )
      .toBe(done + 1);
    const content = sent.at(-1)?.content;
    return {
      text: content?.type === "text" ? content.text : "",
      state: await actor.snapshot(),
    };
  };
  retry = true;
  const result = await deliver();
  expect(result.text).toContain(ids[1]);
  expect(result.text).not.toContain(ids[0]);
  expect(result.text).not.toContain(ids[2]);
  expect(result.text).toContain("showing 1");
  expect(result.text).not.toContain("PRIVATE");
  expect(Buffer.byteLength(result.text)).toBeLessThan(2000);
  expect(sent).toHaveLength(2);
  expect(JSON.stringify(result.state)).not.toContain(ids[1]);
  expect(store.source(scope, "review-0")).toBeUndefined();
  expect(modelCalls).toBe(0);
  expect(extractionCalls).toBe(0);
  expect(await reflection.status()).toEqual(before);

  stale = true;
  expect((await deliver()).text).toContain("showing 0");
  fail = true;
  expect((await deliver()).text).toContain("unavailable; no candidate status");
  fail = false;
  const now = new Date();
  quiet.startMinute = now.getUTCHours() * 60 + now.getUTCMinutes();
  quiet.endMinute = (quiet.startMinute + 1) % 1440;
  expect((await deliver()).text).toContain("blocked by quiet hours");
  quiet.startMinute = quiet.endMinute = 0;

  let release = () => {};
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const readCount = reads;
  const racing = reflection.listCandidates(scope);
  await expect.poll(() => reads).toBeGreaterThan(readCount);
  await reflection.occupancy("concurrent-live", true);
  release();
  hold = undefined;
  expect(await racing).toMatchObject({ status: "live", ids: [] });
  expect((await deliver()).text).toContain(
    "blocked by active or unresolved live work",
  );
  await reflection.occupancy("concurrent-live", false);
  expect((await deliver()).text).toContain("showing 0");

  // Non-private/quoted input cannot select the review bypass.
  for (const extra of [
    { senderId: "G", metadata: { channelType: "im" as const } },
    {
      direct: false,
      address: {
        channel: "slack" as const,
        accountId: "T",
        conversationId: "C",
      },
    },
    { text: "Please say !reflection list" },
    { reflectionReviewEligible: false },
  ])
    expect((await deliver(extra)).text).toBe("ordinary reply");
  expect(modelCalls).toBe(4);
  expect(extractionCalls).toBe(2);
  deps.reflection = undefined;
  expect((await deliver()).text).toContain("Reflection is unavailable");
  expect(modelCalls).toBe(4);
});
