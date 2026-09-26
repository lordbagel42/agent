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
import { EvidenceStore } from "../memory/store.js";
import { createJuneRegistry, type JuneClientRegistry } from "./registry.js";

it("keeps private memory out of public prompts and suppresses a deleted in-flight reply before any side effect", async (t) => {
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
  const requests: ModelRequest[] = [];
  const sent: OutboundMessage[] = [];
  const extracted: string[][] = [];
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
      async extract(_audience, ids) {
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
        async send(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          return { status: "sent", messageId: "out" };
        },
      },
    },
    model: {
      async reply(request) {
        requests.push(structuredClone(request));
        return requests.length === 3 ? pending.promise : { text: "" };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "owner"]);
  const done = async () =>
    Object.values((await june.snapshot()).events).filter((event) => event.done)
      .length;
  await june.send("inbox", { type: "event", event });
  await expect.poll(done).toBe(1);
  expect(extracted).toEqual([[source(event, scope).id]]);
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
  expect(extracted).toHaveLength(1);
  await june.send("inbox", {
    type: "event",
    event: {
      ...event,
      id: "private-2",
      messageId: event.messageId.replace("000001", "000002"),
      text: "more heron context",
    },
  });
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]?.system).toContain("PRIVATE heron observation");
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
});

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
        seen.push(request.messages[0]?.content ?? "");
        return request.messages[0]?.content === "first"
          ? first.promise
          : second.promise;
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
