import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import {
  DecisionExecutor,
  type DecisionFunction,
} from "../reflection/evaluator.js";
import { createJuryTool } from "../reflection/jury.js";
import { createJuneRegistry } from "./registry.js";

it("mounts one private advisory jury, blocks forged public/synthesis requests and suppresses forgotten results", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  const scope = '["private","owner"]';
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  store.appendSource({
    id: "original",
    audiences: [scope],
    text: "PRIVATE heron observation",
    observedAt: Date.now(),
    platform: "slack",
    account: "T1",
    conversation: "D1",
    author: "U1",
    sourceUrl: "https://example.com/source",
  });
  const sent: OutboundMessage[] = [];
  const requests: ModelRequest[] = [];
  let calls = 0;
  let block = false;
  let search = false;
  let ids = ["original"];
  const pending = Promise.withResolvers<void>();
  t.onTestFinished(() => {
    pending.resolve();
    store.close();
  });
  const decide: DecisionFunction = async () => {
    calls++;
    if (block) await pending.promise;
    return {
      answer: "yes",
      rationale: "PRIVATE jury proposal",
      evidenceIds: ["original"],
    };
  };
  const registry = createJuneRegistry({
    owner,
    memory: { store, source: () => undefined },
    jury: createJuryTool({
      store,
      scope,
      evidenceMaxAgeMs: 60000,
      executor: new DecisionExecutor(2, 1000),
      providers: {
        jurors: [
          { id: "one", decide },
          { id: "two", decide },
        ],
        critic: decide,
        synthesize: decide,
      },
    }),
    webSearch: {
      available: true,
      description: "fixture",
      async search() {
        return { status: "ready", results: [] };
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
        requests.push(request);
        if (search && request.webSearchAvailable)
          return { text: "", webSearch: "heron" };
        const reply = {
          text: "",
          jury: {
            question: "uncertainty" as const,
            prompt: "Is the heron observation uncertain?",
            evidenceIds: ids,
          },
        };
        expect("jury" in replyJsonSchema([], request).properties).toBe(
          request.juryAvailable === true,
        );
        if (request.juryAvailable)
          return parseReply(JSON.stringify(reply), [], request);
        expect(() => parseReply(JSON.stringify(reply), [], request)).toThrow();
        // Custom adapters bypass parseReply; runtime must still reject dispatch.
        return reply;
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const base: MessageEvent = {
    id: "jury",
    type: "message",
    messageId: "1",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    direct: true,
    senderId: "U1",
    text: "Please run a jury on the heron observation",
  };
  const deliver = async (event: MessageEvent) => {
    const route = routeEvent(event, owner);
    if (!route) throw new Error("Invalid fixture");
    const actor = client.conversation.getOrCreate(route.key);
    await actor.send("inbox", {
      type: "event",
      event: { ...event, messageId: event.id },
    });
    await expect
      .poll(
        async () =>
          Object.values((await actor.snapshot()).events).find(
            (record) => record.event.id === event.id,
          )?.done,
      )
      .toBe(true);
    return actor;
  };
  const june = await deliver(base);
  expect(calls).toBe(4);
  expect(JSON.stringify(sent[0]?.content)).toContain("Jury advisory synthesis");
  expect(JSON.stringify(sent[0]?.content)).toContain("not verified evidence");
  expect((await june.snapshot()).jobs).toEqual({});
  await june.send("inbox", { type: "event", event: base });
  ids = ["unseen"];
  await deliver({ ...base, id: "unseen" });
  expect(calls).toBe(4);
  ids = ["original"];
  await deliver({
    ...base,
    id: "public",
    direct: false,
    address: { ...base.address, conversationId: "C1" },
  });
  await deliver({
    ...base,
    id: "guest",
    senderId: "U2",
    metadata: { channelType: "im" },
  });
  search = true;
  await deliver({ ...base, id: "synthesis" });
  search = false;
  expect(calls).toBe(4);
  expect(
    requests.slice(-4).some((request) => request.juryAvailable === false),
  ).toBe(true);
  expect(
    sent
      .slice(1)
      .every((message) => !JSON.stringify(message).includes("PRIVATE")),
  ).toBe(true);
  block = true;
  const deleted = deliver({ ...base, id: "deleted" });
  await expect.poll(() => calls).toBe(6);
  store.deleteSource("original");
  pending.resolve();
  await deleted;
  expect(calls).toBe(6);
  expect(sent).toHaveLength(5);
  expect(JSON.stringify((await june.snapshot()).history)).not.toContain(
    "PRIVATE",
  );
});
