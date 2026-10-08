import { createHash, randomBytes } from "node:crypto";
import type { Client } from "rivetkit/client";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { createSlackAdapter } from "../channels/slack.js";
import type { MessageEvent, OutboundMessage } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReflectionReviewCommand } from "./reflection.js";
import { createJuneRegistry, type JuneClientRegistry } from "./registry.js";

it("inspects exact scoped hypotheses without retention or inference and revalidates at reads and send retries", async (t) => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const scope = JSON.stringify(["private", owner.id]);
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const append = (id: string) =>
    store.appendSource({
      id,
      audiences: [scope],
      platform: "slack",
      account: "T1",
      conversation: "D1",
      author: "U1",
      observedAt: Date.now(),
      sourceUrl: "https://example.com/source",
      text: `Original ${id}`,
    });
  for (const id of ["cited", "uncited", "oversized", "race", "retry"])
    append(id);
  let modelCalls = 0;
  let extractionCalls = 0;
  let authorized = true;
  let wrongScope = false;
  let expired = false;
  let reads = 0;
  let pause: Promise<void> | undefined;
  let release = () => {};
  let retry = false;
  let rationale = `HYPOTHESIS https://example.com/private <!channel> & ${"🤔".repeat(1900)}`;
  const quiet = { timeZone: "UTC", startMinute: 0, endMinute: 0 };
  const sent: OutboundMessage[] = [];
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
          sent.push(JSON.parse(JSON.stringify(message)));
          if (retry) {
            retry = false;
            store.deleteSource("retry");
            return {
              status: "rejected",
              code: "fixture",
              retryable: true,
              retryAfterMs: 1,
            };
          }
          return { status: "sent", messageId: `out${sent.length}` };
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
      source: (event, audience) => ({
        id: event.id,
        audiences: [audience],
        platform: "slack",
        account: "T1",
        conversation: "D1",
        author: event.senderId,
        observedAt: event.occurredAt,
        sourceUrl: "https://example.com/message",
        text: event.text,
      }),
      async extract() {
        extractionCalls++;
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
      idleMs: 86400000,
      deepMs: 86400000,
      pollMs: 20,
      timeoutMs: 10000,
      evidenceCurrent: (scope, evidence) =>
        authorized &&
        !wrongScope &&
        !expired &&
        JSON.stringify(
          store.reflectionEvidence(
            scope,
            evidence.map((e) => e.id),
            60000,
          ),
        ) === JSON.stringify(evidence),
      async retrieve(input) {
        reads++;
        await pause;
        const evidence = store.reflectionEvidence(
          input.scope,
          input.evidenceIds,
          60000,
        );
        return {
          authorized,
          evidence: evidence.map((item) => ({
            ...item,
            ...(wrongScope ? { scope: "foreign" } : {}),
            ...(expired ? { expiresAt: 0 } : {}),
          })),
        };
      },
      async decide(input) {
        return {
          answer: "yes",
          rationale,
          evidenceIds: input.evidence.slice(0, 1).map((item) => item.id),
          confidence: 0.6,
        };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const reflection = (
    client as Client<JuneClientRegistry>
  ).reflection.getOrCreate([owner.id]);
  const stage = async (evidenceIds: string[]) => {
    const request = await reflection.enqueue({
      scope,
      evidenceIds,
      kind: "reflection",
      mode: "interaction",
    });
    const internal = JSON.stringify([request.id, 1]);
    await expect
      .poll(
        async () => (await reflection.status()).candidateIds.includes(internal),
        { timeout: 5000 },
      )
      .toBe(true);
    return createHash("sha256").update(internal).digest("hex");
  };
  let sequence = 0;
  const deliver = async (text: string, extra: Partial<MessageEvent> = {}) => {
    sequence++;
    const event: MessageEvent = {
      id: `in${sequence}`,
      type: "message",
      messageId: `ts${sequence}`,
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      direct: true,
      senderId: "U1",
      reflectionReviewEligible: true,
      text,
      ...extra,
    };
    const routed = routeEvent(event, owner, true);
    if (!routed) throw new Error("Missing test scope");
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
        { timeout: 5000 },
      )
      .toBe(done + 1);
    const content = sent.at(-1)?.content;
    return {
      text: content?.type === "text" ? content.text : "",
      snapshot: await actor.snapshot(),
    };
  };

  const id = await stage(["cited", "uncited"]);
  expect(parseReflectionReviewCommand(`!reflection inspect ${id}`)).toEqual({
    action: "inspect",
    id,
  });
  for (const text of [
    `quoted !reflection inspect ${id}`,
    `!reflection inspect ${id.slice(1)}`,
    `!reflection inspect ${id} extra`,
  ])
    expect(parseReflectionReviewCommand(text)).toBeUndefined();
  const inspected = await reflection.inspectCandidate(scope, id);
  expect(inspected?.candidate.decision.rationale).toBe(rationale);
  expect(Buffer.byteLength(JSON.stringify(inspected))).toBeLessThanOrEqual(
    24000,
  );
  const before = await reflection.status();
  const result = await deliver(`!reflection inspect ${id}`);
  expect(result.text).toContain(rationale);
  expect(result.text).toContain('"id":"uncited"');
  expect(result.text).toContain('"cited":false');
  expect(result.text).toContain(
    "generated hypotheses, never independent evidence",
  );
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(25000);
  expect(result.text).not.toContain("Original");
  expect(JSON.stringify(result.snapshot)).not.toContain(rationale);
  expect(JSON.stringify(result.snapshot)).not.toContain('"id":"uncited"');
  // The real transport sends inert text and excludes June's posted report from
  // automatic history, even when Slack returns it on the next ordinary turn.
  let posted: Record<string, unknown> = {};
  const slack = createSlackAdapter({
    signingSecret: "fixture",
    botToken: "fixture",
    teamId: "T1",
    botUserId: "U_JUNE",
    ownerUserIds: ["U1"],
    contextEnabled: true,
    async fetch(url, init) {
      if (String(url).endsWith("chat.postMessage")) {
        posted = JSON.parse(String(init?.body));
        return Response.json({ ok: true, ts: "1.000001" });
      }
      if (String(url).endsWith("conversations.history"))
        return Response.json({
          ok: true,
          messages: [
            { ts: "1.000001", user: "U_JUNE", text: posted.text },
            { ts: "1.000000", user: "U_JUNE", text: "ordinary prior reply" },
          ],
        });
      return Response.json({ ok: true, channel: { id: "D1", is_im: true } });
    },
  });
  expect(
    await slack.send({
      id: "inspection-transport",
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      lastInboundAt: Date.now(),
      content: { type: "text", text: result.text },
    }),
  ).toEqual({ status: "sent", messageId: "1.000001" });
  expect(posted).toMatchObject({
    mrkdwn: false,
    parse: "none",
    link_names: false,
    unfurl_links: false,
    unfurl_media: false,
  });
  expect(posted.text).toContain("&lt;!channel&gt; &amp;");
  expect(posted.text).not.toContain("<!channel>");
  const context = await slack.context?.({
    id: "followup",
    type: "message",
    messageId: "2.000000",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    direct: true,
    senderId: "U1",
    text: "ordinary follow-up",
    metadata: { channelType: "im" },
  });
  expect(context?.map((message) => message.content)).toEqual([
    "ordinary prior reply",
    "ordinary follow-up",
  ]);
  expect(store.source(scope, "in1")).toBeUndefined();
  expect(modelCalls).toBe(0);
  expect(extractionCalls).toBe(0);
  expect(await reflection.status()).toEqual(before);
  expect((await deliver(`!reflection inspect ${id}`)).text).toContain(
    rationale,
  );
  expect(await reflection.inspectCandidate("foreign", id)).toBeNull();
  expect(await reflection.inspectCandidate(scope, "f".repeat(64))).toBeNull();
  authorized = false;
  expect(await reflection.inspectCandidate(scope, id)).toBeNull();
  authorized = true;
  wrongScope = true;
  expect(await reflection.inspectCandidate(scope, id)).toBeNull();
  wrongScope = false;
  expired = true;
  expect(await reflection.inspectCandidate(scope, id)).toBeNull();
  expired = false;
  const now = new Date();
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  quiet.startMinute = (minute + 1439) % 1440;
  quiet.endMinute = (minute + 2) % 1440;
  expect(await reflection.inspectCandidate(scope, id)).not.toBeNull();
  expect(await reflection.candidate(id, scope)).toBeNull();
  quiet.startMinute = quiet.endMinute = 0;
  await reflection.trigger({ id: "hold", type: "idle", liveActive: 1 });
  expect(await reflection.inspectCandidate(scope, id)).not.toBeNull();
  expect(await reflection.candidate(id, scope)).toBeNull();
  await reflection.trigger({ id: "release", type: "idle", liveActive: 0 });
  expect(await reflection.inspectCandidate(scope, id)).not.toBeNull();
  const references = (await reflection.reviewCandidates(scope))?.references;
  expect(references).toEqual([inspected?.reference]);
  expect(await reflection.validateReview(scope, references ?? [])).toBe(true);
  expect(await reflection.validateReview("foreign", references ?? [])).toBe(
    false,
  );
  expect(await reflection.validateReview(scope, [{ id, digest: "bad" }])).toBe(
    false,
  );
  // Every source seen by the generator matters, including its uncited input.
  store.deleteSource("uncited");
  expect(await reflection.validateReview(scope, references ?? [])).toBe(false);
  expect((await reflection.reviewCandidates(scope))?.references).toEqual([]);
  expect((await deliver(`!reflection inspect ${id}`)).text).not.toContain(
    rationale,
  );

  // 9,006 ID characters plus the cited ID and rationale fit the character
  // budget, but their UTF-8 payload alone exceeds 24KB, before JSON overhead.
  const unicodeIds = Array.from(
    { length: 6 },
    (_, i) => `${"é".repeat(1500)}${i}`,
  );
  for (const sourceId of unicodeIds) append(sourceId);
  const multibyte = await stage(unicodeIds);
  expect(await reflection.inspectCandidate(scope, multibyte)).toBeNull();
  rationale = "\u0000".repeat(4000);
  const oversized = await stage(["oversized"]);
  expect(await reflection.candidate(oversized, scope)).not.toBeNull();
  expect(await reflection.inspectCandidate(scope, oversized)).toBeNull();
  rationale = "PRIVATE RACE HYPOTHESIS";
  const raced = await stage(["race"]);
  pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previousReads = reads;
  const pending = reflection.inspectCandidate(scope, raced);
  await expect.poll(() => reads).toBe(previousReads + 1);
  await reflection.occupancy("overlap", true);
  await reflection.occupancy("overlap", false);
  release();
  pause = undefined;
  expect(await pending).not.toBeNull();
  expect(await reflection.inspectCandidate(scope, raced)).not.toBeNull();
  expect(await reflection.candidate(raced, scope)).toBeNull();
  const retained = await reflection.inspectCandidate(scope, raced);
  expect((await reflection.reviewCandidates(scope))?.references).toContainEqual(
    retained?.reference,
  );
  expect(
    await reflection.validateReview(
      scope,
      retained ? [retained.reference] : [],
    ),
  ).toBe(true);

  rationale = "PRIVATE RETRY HYPOTHESIS";
  const retried = await stage(["retry"]);
  retry = true;
  const sentBefore = sent.length;
  await deliver(`!reflection inspect ${retried}`);
  expect(sent.slice(sentBefore)).toHaveLength(1);
  expect(await reflection.inspectCandidate(scope, retried)).toBeNull();
  for (const extra of [
    { senderId: "U2", metadata: { channelType: "im" as const } },
    {
      direct: false,
      address: {
        channel: "slack" as const,
        accountId: "T1",
        conversationId: "C1",
      },
    },
  ]) {
    const sourceId = `private-only-${sequence}`;
    append(sourceId);
    const privateId = await stage([sourceId]);
    expect(await reflection.inspectCandidate(scope, privateId)).not.toBeNull();
    const previousReads = reads;
    expect(
      (await deliver(`!reflection inspect ${privateId}`, extra)).text,
    ).not.toContain("PRIVATE");
    expect(reads).toBe(previousReads);
  }
  // Other admitted scopes use the command path too, but cannot read this hypothesis.
  expect(modelCalls).toBe(0);
  expect(extractionCalls).toBe(0);
  expect(store.proposals(scope)).toEqual([]);
});
