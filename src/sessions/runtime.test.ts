import { randomBytes } from "node:crypto";
import { setup } from "rivetkit";
import { expect, it, type TestContext, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelInvocation,
  ModelRequest,
  OutboundMessage,
  SendResult,
} from "../core/contracts.js";
import { slackSource } from "../imports/identity.js";
import { EvidenceStore } from "../memory/store.js";
import { createJuneRegistry } from "../runtime/registry.js";
import {
  type ActivityAssignment,
  type ActivityCatalog,
  createActivityActor,
} from "./runtime.js";
import { sessionActorKey } from "./state.js";

const owner = {
  id: "owner",
  identities: [{ channel: "slack" as const, accountId: "T1", senderId: "U1" }],
};
const scopeKey = ["private", owner.id];
const audience = JSON.stringify(scopeKey);
const assignment = (id = "a", session = "b"): ActivityAssignment => ({
  scopeKey,
  sessionId: session.repeat(64),
  eventId: id.repeat(64),
  sequence: 1,
  openedAt: 1800000001000,
  receivedAt: 1800000001000,
  kind: "message",
});

async function fixture(t: TestContext) {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const source = (id: string): MessageEvent => ({
    id,
    type: "message",
    messageId: `1800000000.${id[0] === "a" ? "000001" : "000002"}`,
    occurredAt: 1800000000000,
    address: {
      channel: "slack",
      accountId: "T1",
      conversationId: "D1",
      threadId: "1700000000.000001",
    },
    direct: true,
    metadata: { channelType: "im" },
    senderId: "U1",
    text: id[0] === "a" ? "FIRST PRIVATE TURN" : "SECOND PRIVATE TURN",
  });
  const model = {
    beginReply: vi.fn(
      (_request: ModelRequest): ModelInvocation => ({
        answer: Promise.resolve({ text: "June's answer" }),
        settlement: Promise.resolve("confirmed_stopped"),
      }),
    ),
    reply: async (): Promise<CompanionReply> => {
      throw new Error("Handle required");
    },
  };
  const send = vi.fn(
    async (_message: OutboundMessage): Promise<SendResult> => ({
      status: "sent",
      messageId: "1800000002.000001",
    }),
  );
  const catalog: ActivityCatalog = {
    assignmentStatus: vi.fn(async () => "active" as const),
    prepare: vi.fn<ActivityCatalog["prepare"]>(async (input, history) => {
      const event = source(input.eventId);
      const original = slackSource({
        audiences: [audience],
        workspace: "T1",
        channel: "D1",
        ts: event.messageId,
        threadTs: event.address.threadId,
        author: "U1",
        workspaceUrl: "https://example.slack.com/",
        text: event.text,
      });
      store.appendSource(original);
      return {
        source: event,
        sourceId: original.id,
        replyAddress: event.address,
        reference: {
          sourceIds: [original.id],
          contextSourceIds: [],
          deletionTracked: true,
          personality: "test",
        },
        deletionRevision: store.deletionRevision(),
        retentionExcluded: false,
        request: {
          agentRole: "interaction",
          system: "Test interaction; no tools",
          messages: [...history, { role: "user", content: event.text }],
          workspaces: [],
          searchAvailable: false,
          turnTakingAvailable: true,
        },
      };
    }),
    apply: vi.fn(async (_input, reply) => ({
      text: reply.text,
      messages: reply.messages,
    })),
    acknowledge: vi.fn(async () => {}),
  };
  const base = createJuneRegistry({ owner, channels: {}, model });
  const registry = setup({
    ...base.config,
    use: {
      ...base.config.use,
      activity: createActivityActor({
        owner,
        model,
        channel: { send },
        catalog: () => catalog,
        memory: {
          store,
          evidence: {
            source: (scope, id) => store.source(scope, id),
            isDeleted: (id) => store.isDeleted(id),
            contextAvailable: (scope, id) => !!store.source(scope, id),
          },
          current: (scope, reference) =>
            reference.deletionTracked === true &&
            reference.sourceIds.every((id) => !!store.source(scope, id)) &&
            (reference.contextSourceIds ?? []).every(
              (id) => !store.isDeleted(id),
            ),
        },
      }),
    },
  });
  const { client } = await setupTest(t, registry);
  return {
    store,
    model,
    send,
    catalog,
    activity: (input: ActivityAssignment) =>
      client.activity.getOrCreate(sessionActorKey(scopeKey, input.sessionId)),
  };
}

it("delivers an early answer but holds admission until retirement, archive and catalog acknowledgment", async (t) => {
  const f = await fixture(t);
  const retired = Promise.withResolvers<"confirmed_stopped">();
  f.model.beginReply.mockImplementationOnce(() => ({
    answer: Promise.resolve({ text: "EARLY ANSWER" }),
    settlement: retired.promise,
  }));
  const first = assignment();
  const activity = f.activity(first);
  await activity.receive(first);
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  expect(f.catalog.acknowledge).not.toHaveBeenCalled();
  expect(f.store.searchSessions(audience, "").sessions).toEqual([]);
  await activity.receive(first);
  await expect(
    activity.receive({ ...first, eventId: "c".repeat(64), sequence: 2 }),
  ).rejects.toThrow();
  expect(f.model.beginReply).toHaveBeenCalledTimes(1);
  retired.resolve("confirmed_stopped");
  await vi.waitFor(async () =>
    expect((await activity.status()).acknowledgedThrough).toBe(1),
  );
  expect(f.catalog.acknowledge).toHaveBeenCalledTimes(1);
  expect(f.model.beginReply).toHaveBeenCalledTimes(1);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(
    f.store.retrieveSession(audience, first.sessionId).turns[0]?.data?.entries,
  ).toMatchObject([
    { role: "user", content: { text: "FIRST PRIVATE TURN" } },
    { role: "assistant", delivery: "sent", content: { text: "EARLY ANSWER" } },
  ]);

  const next = {
    ...assignment("c", "d"),
    openedAt: first.openedAt + 10_800_000,
    receivedAt: first.receivedAt + 10_800_000,
  };
  await f.activity(next).receive(next);
  await vi.waitFor(async () =>
    expect((await f.activity(next).status()).acknowledgedThrough).toBe(1),
  );
  expect(f.model.beginReply.mock.calls[1]?.[0].messages).toEqual([
    { role: "user", content: "SECOND PRIVATE TURN" },
  ]);
  expect(f.send.mock.calls[1]?.[0].address.threadId).toBe("1700000000.000001");
  expect(f.store.retrieveSession("foreign", first.sessionId).turns).toEqual([]);
});

it("repairs an archive-write/acknowledgment failure without repeating inference or delivery", async (t) => {
  const f = await fixture(t);
  const write = f.store.archiveSessionTurn.bind(f.store);
  let loseAck = true;
  vi.spyOn(f.store, "archiveSessionTurn").mockImplementation(
    (input, revision) => {
      const through = write(input, revision);
      if (loseAck) {
        loseAck = false;
        throw new Error("Archive ACK lost");
      }
      return through;
    },
  );
  const input = assignment();
  const acknowledged = new Set<string>();
  vi.mocked(f.catalog.assignmentStatus).mockImplementation(
    async (assignment) =>
      acknowledged.has(assignment.eventId) ? "acknowledged" : "active",
  );
  vi.mocked(f.catalog.acknowledge).mockImplementation(async (assignment) => {
    acknowledged.add(assignment.eventId);
    throw new Error("Catalog committed but ACK was lost");
  });
  await f.activity(input).receive(input);
  await vi.waitFor(
    async () =>
      expect((await f.activity(input).status()).acknowledgedThrough).toBe(1),
    { timeout: 15000 },
  );
  await f.activity(input).receive(input);
  expect(f.store.retrieveSession(audience, input.sessionId).turns).toHaveLength(
    1,
  );
  expect(f.model.beginReply).toHaveBeenCalledTimes(1);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.catalog.acknowledge).toHaveBeenCalledTimes(1);

  // The deliberately minimal catalog above forgets the first turn's history
  // dependencies. A fresh revision alone must not authorize that new prompt.
  await f.activity(input).receive({
    ...input,
    eventId: "c".repeat(64),
    sequence: 2,
    receivedAt: input.receivedAt + 1,
  });
  await vi.waitFor(async () =>
    expect((await f.activity(input).status()).turns[1]?.hold).toBe(
      "provenance",
    ),
  );
  expect(f.model.beginReply).toHaveBeenCalledTimes(1);
});

it("holds unknown inference and suppresses output invalidated while inference is live", async (t) => {
  const f = await fixture(t);
  f.model.beginReply.mockImplementationOnce(() => ({
    answer: Promise.resolve({ text: "Uncertain inference answer" }),
    settlement: Promise.resolve("unknown"),
  }));
  const first = assignment();
  await f.activity(first).receive(first);
  await vi.waitFor(async () =>
    expect((await f.activity(first).status()).turns[0]?.hold).toBe("inference"),
  );
  await f.activity(first).receive(first);
  expect(f.catalog.acknowledge).not.toHaveBeenCalled();
  expect(f.model.beginReply).toHaveBeenCalledTimes(1);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.store.retrieveSession(audience, first.sessionId).turns).toHaveLength(
    1,
  );

  const answer = Promise.withResolvers<CompanionReply>();
  f.model.beginReply.mockImplementationOnce(() => ({
    answer: answer.promise,
    settlement: Promise.resolve("confirmed_stopped"),
  }));
  const second = assignment("c", "d");
  await f.activity(second).receive(second);
  await vi.waitFor(() => expect(f.model.beginReply).toHaveBeenCalledTimes(2));
  f.store.deleteSource("slack:T1:D1:1800000000.000002");
  answer.resolve({ text: "Must not be sent or archived" });
  await vi.waitFor(async () =>
    expect((await f.activity(second).status()).turns[0]?.hold).toBe(
      "provenance",
    ),
  );
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.catalog.acknowledge).not.toHaveBeenCalled();
  expect(f.store.retrieveSession(audience, second.sessionId).turns).toEqual([]);
});

it.for(["unknown", "rejected"] as const)(
  "accounts for a %s multipart prefix without sending its tail",
  async (status, t) => {
    const f = await fixture(t);
    f.send.mockResolvedValue(
      status === "unknown"
        ? { status, code: "lost_response" }
        : { status, code: "denied", retryable: false },
    );
    f.model.beginReply.mockImplementation(() => ({
      answer: Promise.resolve({ text: "", messages: ["PART ONE", "PART TWO"] }),
      settlement: Promise.resolve("confirmed_stopped"),
    }));
    const input = assignment();
    await f.activity(input).receive(input);
    await vi.waitFor(async () =>
      expect((await f.activity(input).status()).turns[0]?.archivedThrough).toBe(
        1,
      ),
    );
    expect(
      f.store
        .retrieveSession(audience, input.sessionId)
        .turns[0]?.data?.entries.slice(1),
    ).toMatchObject([
      { role: "assistant", delivery: status, content: { text: "PART ONE" } },
      {
        role: "assistant",
        delivery: "rejected",
        content: { text: "PART TWO" },
      },
    ]);
    await vi.waitFor(async () =>
      expect((await f.activity(input).status()).turns[0]?.acknowledged).toBe(
        status === "rejected",
      ),
    );
    if (status === "unknown")
      expect(f.catalog.acknowledge).not.toHaveBeenCalled();
    else expect(f.catalog.acknowledge).toHaveBeenCalledTimes(1);
    await f.activity(input).receive(input);
    expect(f.model.beginReply).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
  },
);

it("does not infer when a retained original is missing from the frozen provenance", async (t) => {
  const f = await fixture(t);
  const prepare = vi.mocked(f.catalog.prepare).getMockImplementation();
  if (!prepare) throw new Error("Missing fixture preparation");
  vi.mocked(f.catalog.prepare).mockImplementation(async (...args) => {
    const prepared = await prepare(...args);
    prepared.reference.sourceIds = [];
    return prepared;
  });
  const input = assignment();
  await f.activity(input).receive(input);
  await vi.waitFor(async () =>
    expect((await f.activity(input).status()).turns[0]?.hold).toBe(
      "provenance",
    ),
  );
  expect(f.model.beginReply).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.catalog.acknowledge).not.toHaveBeenCalled();
  f.store.deleteSource("slack:T1:D1:1800000000.000001");
  expect(
    f.store.searchSessions(audience, "FIRST PRIVATE TURN").sessions,
  ).toEqual([]);
});
