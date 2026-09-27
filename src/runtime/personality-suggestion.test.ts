import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { CuratedPersonalityStore } from "../memory/curated.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { createJuneRegistry, type JuneClientRegistry } from "./registry.js";

it("stages through June without publishing and rejects public, guest, stale and forgotten suggestions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "june-suggestion-runtime-"));
  const store = new EvidenceStore(":memory:", randomBytes(32));
  const personality = new CuratedPersonalityStore(
    join(root, "curated"),
    randomBytes(32),
    store,
    { initialize: true },
  );
  t.onTestFinished(() => {
    personality.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const scope = JSON.stringify(["private", owner.id]);
  store.appendSource({
    id: "original-private-source",
    audiences: [scope],
    platform: "slack",
    account: "T1",
    conversation: "D1",
    author: "U1",
    observedAt: Date.now(),
    sourceUrl: "https://example.com/private",
    text: "Private preference: suggest a drier tone",
  });
  const suggestion: NonNullable<CompanionReply["personalitySuggestion"]> = {
    expectedVersion: 0,
    changes: { tone: "dry" },
    evidenceIds: ["original-private-source"],
    explanation: "SECRET rationale",
    confidence: 0.8,
  };
  let action: CompanionReply = {
    text: "",
    personalitySuggestion: suggestion,
  };
  let forgetDuringReply = false;
  const sent: OutboundMessage[] = [];
  const requests: ModelRequest[] = [];
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
          return { status: "sent", messageId: `out${sent.length}` };
        },
      },
    },
    memory: { store, personality, source: () => undefined },
    model: {
      async reply(request) {
        requests.push(request);
        expect(
          Object.hasOwn(
            replyJsonSchema([], request).properties,
            "personalitySuggestion",
          ),
        ).toBe(request.personalitySuggestionAvailable);
        if (forgetDuringReply) store.deleteSource("original-private-source");
        return action; // Host must enforce the boundary even for custom providers.
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const profile = (
    client as Client<JuneClientRegistry>
  ).personality.getOrCreate([owner.id]);
  const initial = await profile.read();
  let sequence = 0;
  async function deliver(extra: Partial<MessageEvent> = {}) {
    const event: MessageEvent = {
      id: `in${++sequence}`,
      messageId: `ts${sequence}`,
      type: "message",
      text: "Suggest a drier tone",
      senderId: "U1",
      occurredAt: Date.now(),
      direct: true,
      metadata: { channelType: "im" },
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      ...extra,
    };
    const route = routeEvent(event, owner, true);
    if (!route) throw new Error("Fixture is not routable");
    const conversation = client.conversation.getOrCreate(route.key);
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
    return sent.at(-1)?.content;
  }
  expect(await deliver()).toMatchObject({
    type: "text",
    text: expect.stringContaining("Staged private personality suggestion"),
  });
  const [staged] = personality.pendingGlobalProposals(scope);
  expect(staged).toMatchObject({
    expectedVersion: 0,
    changes: { tone: "dry" },
    sourceIds: ["original-private-source"],
  });
  expect(await profile.read()).toEqual(initial);
  await deliver();
  expect(personality.pendingGlobalProposals(scope)).toHaveLength(1);
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
    { senderId: "U2" },
  ]) {
    await deliver(extra);
    expect(requests.at(-1)?.personalitySuggestionAvailable).toBe(false);
    expect(personality.pendingGlobalProposals(scope)).toHaveLength(1);
  }
  action = {
    ...action,
    personalitySuggestion: {
      ...suggestion,
      expectedVersion: 9,
    },
  };
  expect(await deliver()).toMatchObject({
    type: "text",
    text: expect.stringContaining("not staged"),
  });
  expect(personality.pendingGlobalProposals(scope)).toHaveLength(1);
  action = {
    ...action,
    personalitySuggestion: suggestion,
  };
  forgetDuringReply = true;
  await deliver();
  expect(personality.pendingGlobalProposals(scope)).toEqual([]);
  expect(await profile.read()).toEqual(initial);
  expect(JSON.stringify(sent)).not.toContain("SECRET");
  expect(() => parseReply(JSON.stringify(action), [])).toThrow();
  expect(() =>
    parseReply(JSON.stringify({ ...action, inspection: "memory" }), [], {
      personalitySuggestionAvailable: true,
      inspectionAvailable: true,
    }),
  ).toThrow();
});
