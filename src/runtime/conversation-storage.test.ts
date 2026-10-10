import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import {
  beginSessionMigration,
  inspectLegacyDrain,
} from "../sessions/migration.js";
import {
  commandSnapshot,
  compactConversation,
  conversationSnapshot,
  deliveryRecord,
  editDelivery,
  editEvent,
  editHistory,
  editLegacyTurn,
  eventRecord,
  readDeliveries,
  readEvents,
  readHistory,
  readModelInvocations,
} from "./conversation-storage.js";
import { deliver } from "./delivery.js";
import { conversationInputId } from "./inbox.js";
import { outstandingOperationMetadata } from "./inspection.js";
import { type ConversationState, createJuneRegistry } from "./registry.js";
import {
  captureDebug,
  publishSessionCommand,
  resetConversation,
  type SessionCommandReceipt,
} from "./session-controls.js";

test("compressed history preserves order, provenance and edits through restart and clear", () => {
  const state: ConversationState = {
    history: Array.from({ length: 240 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 ? "assistant" : "user",
      content: `${index}: résumé 😀 ${"historical content ".repeat(20)}`,
      sourceId: `source-${index}`,
    })),
    events: {},
    deliveries: {},
    jobs: {},
    lastInbound: {},
  };
  const original = structuredClone(state.history);
  compactConversation(state);
  expect(state.history).toEqual([]);
  expect(readHistory(JSON.parse(JSON.stringify(state)))).toEqual(original);
  const edited = editHistory(state)[7];
  if (!edited) throw new Error("Missing history entry");
  edited.sourceId = "corrected-source";
  state.history.push({ id: "new", role: "user", content: "new message" });
  compactConversation(state);
  expect(readHistory(state)[7]?.sourceId).toBe("corrected-source");
  expect(readHistory(state).at(-1)?.id).toBe("new");
  state.pendingInputs = {
    "message-7": {
      id: "message-7",
      type: "message",
      messageId: "7",
      occurredAt: 1,
      address: { channel: "slack", accountId: "team", conversationId: "dm" },
      senderId: "owner",
      direct: true,
      text: "test",
    },
  };
  expect(captureDebug(state, ["private", "owner"], "").data).toMatchObject({
    history: [{ ...original[7], sourceId: "corrected-source" }],
  });
  resetConversation(state, 10);
  expect(readHistory(state)).toEqual([]);
});

test("compressed model markers keep replay and migration fences after demotion and clear", () => {
  const state: ConversationState = {
    history: [],
    events: {},
    deliveries: {},
    jobs: {},
    lastInbound: {},
    modelInvocations: Object.fromEntries(
      Array.from({ length: 800 }, (_, index) => [
        JSON.stringify([
          "private",
          `event-${index}-${"x".repeat(90)}`,
          "reply",
        ]),
        "settled" as const,
      ]),
    ),
  };
  const expected = structuredClone(state.modelInvocations ?? {});
  const key = Object.keys(expected)[17] as string;
  if (!state.modelInvocations) throw new Error("Missing fixture markers");
  state.modelInvocations.pending = "started";
  expected.pending = "started";
  compactConversation(state);
  expect(state.modelInvocationsArchive).toBeDefined();
  expect(state.modelInvocations).toEqual({ pending: "started" });
  expect(readModelInvocations(state)).toEqual(expected);
  expect(
    inspectLegacyDrain(state, ["private", "owner"]).counts
      .modelSettlementUnproven,
  ).toBe(801);
  state.modelInvocations[key] = "uncertain";
  expected[key] = "uncertain";
  compactConversation(state);
  const reopened: ConversationState = JSON.parse(JSON.stringify(state));
  resetConversation(reopened, 10);
  expect(conversationSnapshot(reopened).modelInvocations).toEqual(expected);
  expect(outstandingOperationMetadata(reopened).counts.model).toEqual({
    started: 1,
    uncertain: 1,
  });
  expect(
    inspectLegacyDrain(reopened, ["private", "owner"]).counts
      .modelSettlementUnproven,
  ).toBe(801);
});

test("completed legacy receipts compact without losing lane ownership or coverage fences", () => {
  const ids = Array.from({ length: 1100 }, (_, n) =>
    createHash("sha256").update(`legacy-${n}`).digest("hex"),
  );
  const turns = Object.fromEntries(
    ids.map((id, n) => [
      id,
      n === 1099
        ? {}
        : {
            finished: true as const,
            ...(n === 7 ? { untrackedEffect: true as const } : {}),
          },
    ]),
  );
  const state: ConversationState = {
    history: [],
    events: {},
    deliveries: {},
    jobs: {},
    lastInbound: {},
    legacyAdmissions: [...ids],
    legacyCoverage: { version: 1, scope: '["private","owner"]', turns },
  };
  const expected = structuredClone(state);
  const live = state.legacyCoverage?.turns[ids[1099] as string];
  const before = inspectLegacyDrain(state, ["private", "owner"]);
  compactConversation(state);
  // Leave at least three quarters of Rivet's checkpoint budget for other state.
  expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(128 * 1024);
  expect(state.legacyCoverage?.turns[ids[1099] as string]).toBe(live);
  let reopened: ConversationState = JSON.parse(JSON.stringify(state));
  expect(conversationSnapshot(reopened)).toEqual(expected);
  expect(inspectLegacyDrain(reopened, ["private", "owner"])).toEqual(before);
  expect(before.counts).toMatchObject({
    missingCoverage: 0,
    untrackedTurnEffects: 1,
    unfinishedInputs: 1,
  });
  // Later admissions retain prefix/suffix order; promoted flags survive storage.
  const appended = "post-archive-lane";
  if (!reopened.legacyAdmissions || !reopened.legacyCoverage)
    throw new Error("Missing fixture ledgers");
  reopened.legacyAdmissions.push(appended);
  reopened.legacyCoverage.turns[appended] = { finished: true };
  const promoted = editLegacyTurn(reopened, ids[3] as string);
  if (!promoted) throw new Error("Missing archived coverage");
  promoted.untrackedEffect = true;
  compactConversation(reopened);
  reopened = JSON.parse(JSON.stringify(reopened));
  expect(conversationSnapshot(reopened).legacyAdmissions).toEqual([
    ...ids,
    appended,
  ]);
  expect(
    inspectLegacyDrain(reopened, ["private", "owner"]).counts,
  ).toMatchObject({
    missingCoverage: 0,
    untrackedTurnEffects: 2,
    unfinishedInputs: 1,
  });
  const migration = beginSessionMigration(
    reopened,
    ["private", "owner"],
    "a".repeat(64),
  );
  expect(migration.legacyInputs).toEqual([...ids, appended].sort());
  // A later live overlay cannot erase the archived lane identity or its flags.
  const demoted = editLegacyTurn(reopened, ids[7] as string);
  if (!demoted) throw new Error("Missing fixture coverage");
  delete demoted.finished;
  compactConversation(reopened);
  resetConversation(reopened, 10);
  expect(conversationSnapshot(reopened).legacyAdmissions).toEqual([
    ...ids,
    appended,
  ]);
  expect(
    inspectLegacyDrain(reopened, ["private", "owner"]).counts,
  ).toMatchObject({
    missingCoverage: 0,
    untrackedTurnEffects: 2,
    unfinishedInputs: 2,
  });
  // An old journal without creation coverage must never acquire it by compaction.
  delete reopened.legacyCoverage;
  compactConversation(reopened);
  expect(conversationSnapshot(reopened).legacyCoverage).toBeUndefined();
  expect(
    inspectLegacyDrain(reopened, ["private", "owner"]).counts.missingCoverage,
  ).toBe(1102);
});

test("pending snapshots survive a lost publication acknowledgment and restart", async () => {
  const state: ConversationState = {
    history: [],
    events: {},
    deliveries: {},
    jobs: {},
    lastInbound: {},
  };
  const snapshot = captureDebug(
    state,
    ["private", "owner"],
    "x".repeat(100_000),
  );
  const receipt: SessionCommandReceipt = {
    snapshot,
    delivery: {
      phase: "ready" as const,
      attempts: 0,
      message: {
        id: "receipt",
        address: {
          channel: "slack" as const,
          accountId: "team",
          conversationId: "dm",
        },
        lastInboundAt: 1,
        content: { type: "text" as const, text: "saved" },
      },
    },
  };
  state.sessionCommands = { debug: receipt };
  compactConversation(state);
  expect(JSON.stringify(state).length).toBeLessThan(10_000);
  expect(commandSnapshot(receipt)).toEqual(snapshot);
  const deps = {
    owner: { id: "owner", identities: [] },
    channels: {},
    model: {
      async reply() {
        return { text: "unused" };
      },
    },
  };
  await expect(
    publishSessionCommand(
      receipt,
      deps,
      async () => compactConversation(state),
      async (body) => {
        expect(body).toEqual(snapshot);
        throw new Error("Lost acknowledgment");
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Lost acknowledgment");
  const resumed: SessionCommandReceipt = JSON.parse(JSON.stringify(receipt));
  state.sessionCommands.debug = resumed;
  let publications = 0;
  const publish = async (body: typeof snapshot) => {
    expect(body).toEqual(snapshot);
    publications++;
  };
  await publishSessionCommand(
    resumed,
    deps,
    async () => compactConversation(state),
    publish,
    new AbortController().signal,
  );
  await publishSessionCommand(
    resumed,
    deps,
    async () => compactConversation(state),
    publish,
    new AbortController().signal,
  );
  expect(publications).toBe(1);
  expect(commandSnapshot(resumed)).toBeUndefined();
  expect(state.sessionCommands.debug?.snapshotId).toBe(snapshot.id);
  expect(resumed.delivery.result).toEqual({
    status: "rejected",
    code: "channel_disabled",
    retryable: false,
  });
});

test("legacy oversized state wakes and replays without losing context or repeating a completed turn", async (t) => {
  const requests: string[] = [];
  const registry = createJuneRegistry({
    owner: {
      id: "owner",
      identities: [{ channel: "slack", accountId: "team", senderId: "owner" }],
    },
    channels: {},
    model: {
      async reply(request) {
        requests.push(JSON.stringify(request.messages));
        return { text: "" };
      },
    },
  });
  const config = registry.config.use.conversation.config;
  if (!("state" in config)) throw new Error("Missing conversation state");
  const history = Array.from({ length: 200 }, (_, index) => ({
    id: `legacy-${index}`,
    role: "user" as const,
    content: `original-${index}: ${"lossless historical content ".repeat(130)}`,
  }));
  expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(
    512 * 1024,
  );
  const old = {
    id: "old",
    type: "message" as const,
    messageId: "old-1",
    occurredAt: 1,
    address: {
      channel: "slack" as const,
      accountId: "team",
      conversationId: "dm",
    },
    senderId: "owner",
    direct: true,
    text: "saved inbound ".repeat(50_000),
  };
  const oldId = conversationInputId({ type: "event", event: old });
  Object.assign(config.state, {
    history,
    events: { [oldId]: { event: old, done: true } },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "owner"]);
  // The small duplicate uses the old identity; no oversized queue message.
  await june.send("inbox", {
    type: "event",
    event: { ...old, text: "duplicate" },
  });
  await june.send("inbox", {
    type: "event",
    event: {
      id: "new",
      type: "message",
      messageId: "1",
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "team", conversationId: "dm" },
      senderId: "owner",
      direct: true,
      text: "continue",
    },
  });
  await expect
    .poll(
      async () =>
        Object.values((await june.snapshot()).events).some(
          (record) => record.event.id === "new" && record.done,
        ),
      { timeout: 20000 },
    )
    .toBe(true);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("original-199:");
  expect(readHistory(await june.snapshot()).slice(0, history.length)).toEqual(
    history,
  );
  const snapshot = await june.snapshot();
  expect(snapshot.events[oldId]?.event).toEqual(old);
  compactConversation(snapshot);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(512 * 1024);
});

test("completed ledgers preserve replay, uncertainty, edits and reset boundaries", async () => {
  const state: ConversationState = {
    history: [],
    events: {},
    deliveries: {},
    jobs: {},
    lastInbound: {},
  };
  for (let n = 0; n < 240; n++) {
    const event = {
      id: `source-${n}`,
      type: "message" as const,
      messageId: `${n}.123`,
      occurredAt: n + 1,
      address: {
        channel: "slack" as const,
        accountId: "team",
        conversationId: "dm",
      },
      senderId: "owner",
      direct: true,
      text: `${n}: résumé 😀 ${"retained inbound content ".repeat(70)}`,
    };
    const id = conversationInputId({ type: "event", event });
    state.events[id] = { event, done: n !== 239 };
    state.deliveries[`${id}:text`] = {
      message: {
        id: `${id}:text`,
        address: event.address,
        lastInboundAt: n + 1,
        content: {
          type: "text",
          text: `${n}: ${"retained outbound content ".repeat(50)}`,
        },
      },
      phase: n === 238 ? "sending" : "settled",
      attempts: 1,
      ...(n === 238
        ? {}
        : {
            result:
              n === 7
                ? { status: "unknown" as const, code: "interrupted_send" }
                : { status: "sent" as const, messageId: `sent-${n}` },
          }),
    };
  }
  const ids = Object.keys(state.events);
  const firstId = ids[0];
  const unknownId = `${ids[7]}:text`;
  const sendingId = `${ids[238]}:text`;
  const lastId = ids[239];
  if (!firstId || !lastId) throw new Error("Missing fixture");
  const liveEvent = state.events[lastId];
  const liveDelivery = state.deliveries[sendingId];
  const operations = outstandingOperationMetadata(state);
  const expected = captureDebug(state, ["private", "owner"], "").data;
  expect(Buffer.byteLength(JSON.stringify(state))).toBeGreaterThan(512 * 1024);
  compactConversation(state);
  expect(state.events[lastId]).toBe(liveEvent);
  expect(state.deliveries[sendingId]).toBe(liveDelivery);
  expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(256 * 1024);
  const reloaded: ConversationState = JSON.parse(JSON.stringify(state));
  expect(captureDebug(reloaded, ["private", "owner"], "").data).toEqual(
    expected,
  );
  expect(Object.values(reloaded.events).some((record) => !record.done)).toBe(
    true,
  );
  expect(
    Object.values(reloaded.deliveries).some(
      (delivery) => delivery.phase === "sending",
    ),
  ).toBe(true);
  expect(outstandingOperationMetadata(reloaded)).toEqual(operations);
  const compactBytes = JSON.stringify(reloaded);
  for (const id of ids) {
    expect(eventRecord(reloaded, id)).toBeDefined();
    expect(deliveryRecord(reloaded, `${id}:text`)).toBeDefined();
  }
  expect(JSON.stringify(reloaded)).toBe(compactBytes);
  let sends = 0;
  for (const id of [`${firstId}:text`, unknownId]) {
    const receipt = editDelivery(reloaded, id);
    if (!receipt) throw new Error("Missing receipt");
    const result = structuredClone(receipt.result);
    expect(
      await deliver(
        receipt,
        async () => compactConversation(reloaded),
        async () => {
          sends++;
          throw new Error("Archived effect must not be repeated");
        },
      ),
    ).toEqual(result);
  }
  expect(sends).toBe(0);
  // Forgetting mutates the hot overlay; the next compaction must replace the
  // archived body, not resurrect it on another restart.
  const forgotten = editEvent(reloaded, firstId);
  const sent = editDelivery(reloaded, `${firstId}:text`);
  if (forgotten?.event.type !== "message" || !sent)
    throw new Error("Missing fixture");
  forgotten.event.text = "";
  sent.message.content = { type: "text", text: "" };
  compactConversation(reloaded);
  const restarted = JSON.parse(JSON.stringify(reloaded));
  expect(readEvents(restarted)[firstId]).toMatchObject({ event: { text: "" } });
  expect(readDeliveries(restarted)[`${firstId}:text`]).toMatchObject({
    message: { content: { text: "" } },
  });
  resetConversation(restarted, 1000);
  expect(Object.keys(restarted.clearedInputs)).toHaveLength(240);
  expect(captureDebug(restarted, ["private", "owner"], "").data).toMatchObject({
    events: {},
    deliveries: {},
  });
  expect(outstandingOperationMetadata(restarted)).toEqual(operations);
});
