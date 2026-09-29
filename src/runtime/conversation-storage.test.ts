import { expect, test } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import {
  commandSnapshot,
  compactConversation,
  editHistory,
  readHistory,
} from "./conversation-storage.js";
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

test("legacy oversized history wakes and completes a real workflow without losing context", async (t) => {
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
  Object.assign(config.state, { history });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "owner"]);
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
          (record) => record.done,
        ),
      { timeout: 20000 },
    )
    .toBe(true);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("original-199:");
  expect(readHistory(await june.snapshot()).slice(0, history.length)).toEqual(
    history,
  );
  expect(Buffer.byteLength(JSON.stringify(await june.snapshot()))).toBeLessThan(
    512 * 1024,
  );
});
