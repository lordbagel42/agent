import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type {
  ChannelAdapter,
  ChannelAudience,
  MessageEvent,
  Owner,
} from "../core/contracts.js";
import { ConversationContinuity, type PrivacyFilter } from "./continuity.js";

const owner: Owner = {
  id: "owner",
  identities: [
    { channel: "slack", accountId: "T1", senderId: "U1" },
    { channel: "whatsapp", accountId: "W1", senderId: "P1" },
  ],
};
const event: MessageEvent = {
  type: "message",
  id: "one",
  messageId: "1.1",
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  occurredAt: 1000,
  senderId: "U1",
  direct: true,
  text: "The public project is called Orchard.",
};
const group: MessageEvent = {
  ...event,
  id: "two",
  messageId: "2.1",
  direct: false,
  address: { ...event.address, conversationId: "C1" },
  text: "What's the project?",
};

it("excludes DEBUG commands and receipts from cross-surface continuity", async (t) => {
  const store = new ConversationContinuity({
    file: ":memory:",
    key: randomBytes(32),
    owner,
    idleMs: 100000,
    revision: () => 0,
    filter: vi.fn<PrivacyFilter>(),
  });
  t.onTestFinished(() => store.close());
  store.receive(event);
  const destination: MessageEvent = {
    ...event,
    senderId: "P1",
    address: { channel: "whatsapp", accountId: "W1", conversationId: "P1" },
  };
  const before = await store.project(destination, { kind: "owner" });
  const debug = { ...event, id: "debug", messageId: "3.1", text: "DEBUG slow" };
  store.receive(debug);
  store.remember(
    event,
    [{ role: "assistant", content: "DEBUG diagnostic-id", source: debug }],
    before.epoch,
  );
  const after = await store.project(destination, { kind: "owner" });
  expect(after.text).toContain("Orchard");
  expect(after.text).not.toContain("DEBUG");
});

it("carries owner continuity across verified transports, expires by human inactivity, and invalidates on forgetting", async (t) => {
  let now = 1000;
  let revision = 0;
  const directory = mkdtempSync(join(tmpdir(), "june-continuity-"));
  const file = join(directory, "context.sqlite");
  const options = {
    file,
    owner,
    key: randomBytes(32),
    idleMs: 1000,
    now: () => now,
    revision: () => revision,
    filter: vi.fn<PrivacyFilter>(),
  };
  let store = new ConversationContinuity(options);
  t.onTestFinished(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.receive(event);
  expect(readFileSync(file).includes(Buffer.from("Orchard"))).toBe(false);
  store.close();
  store = new ConversationContinuity(options);
  const whatsapp: MessageEvent = {
    ...group,
    direct: true,
    senderId: "P1",
    address: { channel: "whatsapp", accountId: "W1", conversationId: "P1" },
  };
  store.receive(whatsapp);
  const projection = await store.prepare(whatsapp, undefined);
  expect(projection.mode).toBe("owner");
  expect(projection.text).toContain("Orchard");
  expect(
    (await store.prepare({ ...whatsapp, senderId: "stranger" }, undefined))
      .text,
  ).toBe("");
  now = 1999;
  store.receive(event); // retry must not extend activity
  expect(store.current(projection.epoch)).toBe(true);
  now = 2000;
  expect(store.current(projection.epoch)).toBe(false);
  expect(store.valid(projection.dependency)).toBe(true);
  expect((await store.prepare(whatsapp, undefined)).text).not.toContain(
    "Orchard",
  );
  store.receive({ ...event, id: "new", messageId: "3.1" });
  const recent = await store.prepare(whatsapp, undefined);
  revision++;
  expect(store.current(recent.epoch)).toBe(false);
  expect(store.valid(projection.dependency)).toBe(false);
  expect((await store.prepare(whatsapp, undefined)).text).not.toContain(
    "Orchard",
  );
  now = 5000;
  store.receive({ ...event, messageId: "old-queued" }, 2001);
  expect((await store.project(whatsapp, { kind: "owner" })).text).not.toContain(
    "Orchard",
  );
});

it("releases only validated excerpts, fails closed, does not retry a paid filter, and rejects late disclosure", async (t) => {
  const filter = vi.fn<PrivacyFilter>(
    async ({ entries, relationshipMemory }) => {
      expect(relationshipMemory).toContain("No reliable relationship");
      return { excerpts: [{ id: entries[0]?.id, text: "Orchard" }] };
    },
  );
  const store = new ConversationContinuity({
    file: ":memory:",
    key: randomBytes(32),
    owner,
    idleMs: 100000,
    revision: () => 0,
    filter,
  });
  t.onTestFinished(() => store.close());
  store.receive(event);
  expect((await store.project(group, { kind: "unknown" })).text).toBe("");
  expect(filter).not.toHaveBeenCalled();
  const projected = await store.project(group, { kind: "public" });
  expect(projected.text).toContain('"text":"Orchard"');
  expect(projected.text).not.toContain("D1");
  await store.project(group, { kind: "public" });
  expect(filter).toHaveBeenCalledTimes(1);
  filter.mockRejectedValueOnce(new Error("network"));
  const next = { ...group, messageId: "3.1" };
  expect((await store.project(next, { kind: "public" })).text).toBe("");
  await store.project(next, { kind: "public" });
  expect(filter).toHaveBeenCalledTimes(2);
  filter.mockImplementationOnce(async ({ entries }) => ({
    excerpts: [{ id: entries[0]?.id, text: "invented" }],
  }));
  expect(
    (await store.project({ ...group, messageId: "4.1" }, { kind: "public" }))
      .text,
  ).toBe("");
  filter.mockImplementationOnce(async ({ entries }) => {
    store.receive({ ...event, messageId: "5.1", text: "don't share this" });
    return { excerpts: [{ id: entries[0]?.id, text: "Orchard" }] };
  });
  expect(
    (await store.project({ ...group, messageId: "6.1" }, { kind: "public" }))
      .text,
  ).toBe("");
  expect(store.current(projected.epoch)).toBe(false);
  expect(store.valid(projected.dependency)).toBe(false);
  store.receive({ ...event, messageId: "7.1", text: "A new ordinary topic" });
  expect(
    (await store.project({ ...group, messageId: "8.1" }, { kind: "public" }))
      .text,
  ).toBe("");
});

it("does not evict ambiguous paid-call receipts when the filter budget fills", async (t) => {
  const filter = vi
    .fn<PrivacyFilter>()
    .mockRejectedValue(new Error("unknown outcome"));
  const store = new ConversationContinuity({
    file: ":memory:",
    key: randomBytes(32),
    owner,
    idleMs: 100000,
    revision: () => 0,
    filter,
  });
  t.onTestFinished(() => store.close());
  store.receive(event);
  for (let i = 0; i < 102; i++)
    await store.project({ ...group, messageId: `${i}.2` }, { kind: "public" });
  await store.project({ ...group, messageId: "0.2" }, { kind: "public" });
  expect(filter).toHaveBeenCalledTimes(100);
});

it("withholds an old preparation if activity rotates during audience lookup", async (t) => {
  let now = 1000;
  const filter = vi.fn<PrivacyFilter>();
  const store = new ConversationContinuity({
    file: ":memory:",
    key: randomBytes(32),
    owner,
    idleMs: 1000,
    now: () => now,
    revision: () => 0,
    filter,
  });
  t.onTestFinished(() => store.close());
  store.receive(group);
  const waiting = Promise.withResolvers<ChannelAudience>();
  const adapter: ChannelAdapter = {
    channel: "slack",
    capabilities: { text: true, reactions: true, threads: true },
    receive: async () => ({ response: new Response(), events: [] }),
    send: async () => ({ status: "sent", messageId: "unused" }),
    audience: () => waiting.promise,
  };
  const pending = store.prepare(group, adapter);
  now = 2000;
  store.receive(event);
  waiting.resolve({ kind: "public" });
  expect((await pending).text).toBe("");
  expect(filter).not.toHaveBeenCalled();
});
