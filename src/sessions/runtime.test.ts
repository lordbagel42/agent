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
import { createLifecycle, type Lifecycle } from "../runtime/lifecycle.js";
import { createJuneRegistry } from "../runtime/registry.js";
import type { SessionArchiveInput } from "./archive.js";
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

async function fixture(t: TestContext, lifecycle?: Lifecycle) {
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
          messagingAvailable: true,
        },
      };
    }),
    apply: vi.fn(async (_input, reply) => ({
      text: reply.text,
      messages: reply.messages,
      sendMessages: reply.sendMessages,
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
        lifecycle,
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

it("tracks an activity surface without a typing ping until the real turn settles", async (t) => {
  const lifecycle = createLifecycle();
  const f = await fixture(t, lifecycle);
  const answer = Promise.withResolvers<CompanionReply>();
  f.model.beginReply.mockReturnValue({
    answer: answer.promise,
    settlement: Promise.resolve("confirmed_stopped"),
  });
  const conversation = {
    address: {
      channel: "slack" as const,
      accountId: "T1",
      conversationId: "D1",
      threadId: "1700000000.000001",
    },
    senderId: "U1",
    direct: true,
  };
  const input = { ...assignment(), conversation };
  const activity = f.activity(input);
  await activity.receive(input);
  await expect.poll(() => f.model.beginReply.mock.calls.length).toBe(1);
  expect(lifecycle.conversations).toEqual([conversation]);
  answer.resolve({ text: "settled" });
  await expect.poll(() => lifecycle.active).toBe(0);
  expect(lifecycle.conversations).toEqual([]);
  expect(f.send).toHaveBeenCalledTimes(1);
});

it.for(["acknowledged", "cleared"] as const)(
  "does not announce participation while checking a %s assignment",
  async (status, t) => {
    const lifecycle = createLifecycle();
    const f = await fixture(t, lifecycle);
    const checking = Promise.withResolvers<void>();
    const result = Promise.withResolvers<typeof status>();
    vi.mocked(f.catalog.assignmentStatus)
      .mockResolvedValueOnce("active") // Receive admission precedes queued work.
      .mockImplementation(async () => {
        checking.resolve();
        return result.promise;
      });
    const input = {
      ...assignment(),
      conversation: {
        address: {
          channel: "slack" as const,
          accountId: "T1",
          conversationId: "CSTALE",
          threadId: "1700000000.000009",
        },
        senderId: "U1",
        direct: false,
      },
    };
    await f.activity(input).receive(input);
    await checking.promise;
    const targets = lifecycle.conversations;
    const draining = lifecycle.drain();
    expect(lifecycle.active).toBe(1);
    result.resolve(status);
    expect(await draining).toBe(true);
    expect(targets).toEqual([]);
    expect(lifecycle.conversations).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
  },
);

it("delivers independently addressed activity replies once and archives receipts without their bodies", async (t) => {
  const f = await fixture(t);
  f.model.beginReply.mockReturnValue({
    answer: Promise.resolve({
      text: "",
      sendMessages: [
        { conversationId: "owner", threadId: null, text: "DM detail" },
        {
          conversationId: "COTHER",
          threadId: "456.789",
          text: "Channel update",
        },
      ],
    }),
    settlement: Promise.resolve("confirmed_stopped"),
  });
  const first = assignment();
  const activity = f.activity(first);
  await activity.receive(first);
  await vi.waitFor(async () =>
    expect((await activity.status()).acknowledgedThrough).toBe(1),
  );
  expect(f.send.mock.calls.map(([message]) => message.address)).toEqual([
    { channel: "slack", accountId: "T1", conversationId: "U1" },
    {
      channel: "slack",
      accountId: "T1",
      conversationId: "COTHER",
      threadId: "456.789",
    },
  ]);
  const archive = f.store.retrieveSession(audience, first.sessionId);
  expect(JSON.stringify(archive)).not.toContain("DM detail");
  expect(
    archive.turns[0]?.data?.entries
      .filter((entry) => entry.role === "assistant")
      .map((entry) => entry.content),
  ).toEqual([
    { retention: "omitted", reason: "retention_excluded" },
    { retention: "omitted", reason: "retention_excluded" },
  ]);
  await activity.receive(first);
  expect(f.send).toHaveBeenCalledTimes(2);
});

it("keeps volatile-derived speech in active history but out of the searchable archive", async (t) => {
  const f = await fixture(t);
  const prepare = vi.mocked(f.catalog.prepare).getMockImplementation();
  if (!prepare) throw new Error("Missing preparation fixture");
  vi.mocked(f.catalog.prepare).mockImplementation(async (input, history) => {
    const result = await prepare(input, history);
    if (!("control" in result)) {
      result.reference.sourceIds = [
        ...new Set([
          ...result.reference.sourceIds,
          ...history.flatMap((entry) => entry.reference.sourceIds),
        ]),
      ];
      result.reference.contextSourceIds?.push(
        "volatile-context:continuity:test",
      );
    }
    return result;
  });
  const first = assignment();
  const activity = f.activity(first);
  await activity.receive(first);
  await vi.waitFor(async () =>
    expect((await activity.status()).acknowledgedThrough).toBe(1),
  );
  expect(
    f.store.retrieveSession(audience, first.sessionId).turns[0]?.data
      ?.entries[1]?.content,
  ).toEqual({ retention: "omitted", reason: "retention_excluded" });
  await activity.receive({
    ...first,
    eventId: "c".repeat(64),
    sequence: 2,
    receivedAt: first.receivedAt + 1,
  });
  await vi.waitFor(async () =>
    expect((await activity.status()).acknowledgedThrough).toBe(2),
  );
  expect(
    f.model.beginReply.mock.calls[1]?.[0].messages.some(
      (entry) =>
        entry.role === "assistant" && entry.content === "June's answer",
    ),
  ).toBe(true);
});

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
    expect((await f.activity(second).status()).turns[0]?.acknowledged).toBe(
      true,
    ),
  );
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.catalog.acknowledge).toHaveBeenCalledExactlyOnceWith(second, {
    inference: "confirmed_stopped",
    deliveries: [],
    archivedThrough: 1,
  });
  const archived = f.store.retrieveSession(audience, second.sessionId);
  expect(archived.turns[0]?.data).toEqual({
    sourceIds: [],
    contextSourceIds: [],
    entries: [],
  });
  expect(JSON.stringify(archived)).not.toContain(
    "Must not be sent or archived",
  );
});

it("filters tombstoned activity diagnostics before cleanup but preserves independently proven history", async (t) => {
  const f = await fixture(t);
  const first = assignment();
  const second = assignment("c", "d");
  for (const input of [first, second]) {
    await f.activity(input).receive(input);
    await vi.waitFor(async () =>
      expect((await f.activity(input).status()).turns[0]?.acknowledged).toBe(
        true,
      ),
    );
  }
  f.store.deleteSource("slack:T1:D1:1800000000.000001");
  const removed = await f.activity(first).diagnostic(first.sessionId);
  expect(removed).toMatchObject({ history: [], turns: [] });
  expect(JSON.stringify(removed)).not.toContain("FIRST PRIVATE TURN");
  const kept = await f.activity(second).diagnostic(second.sessionId);
  expect(JSON.stringify(kept)).toContain("SECOND PRIVATE TURN");
  expect(kept?.deletionRevision).toBe(f.store.deletionRevision());
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
    if ("control" in prepared) throw new Error("Expected interaction");
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

const controlArchive = (input: ActivityAssignment): SessionArchiveInput => ({
  audience,
  sessionId: input.sessionId,
  openedAt: input.openedAt,
  turn: {
    eventId: input.eventId,
    sequence: input.sequence,
    receivedAt: input.receivedAt,
    data: {
      sourceIds: [],
      contextSourceIds: [],
      entries: [
        {
          role: "assistant",
          address: {
            channel: "slack",
            accountId: "T1",
            conversationId: "D1",
            threadId: "1700000000.000001",
          },
          observedAt: input.receivedAt + 123,
          delivery: "sent",
          messageId: "1800000001.000123",
          content: { retention: "omitted", reason: "retention_excluded" },
        },
      ],
    },
  },
});

it("repairs excluded control receipts across deletion and lost ACKs without executing or retaining control content", async (t) => {
  const f = await fixture(t);
  const input = assignment();
  const projection = controlArchive(input);
  vi.mocked(f.catalog.prepare).mockResolvedValueOnce({
    control: { input: projection, effects: "confirmed" },
  });
  const write = f.store.archiveSessionTurn.bind(f.store);
  const archive = vi.spyOn(f.store, "archiveSessionTurn");
  let lost = false;
  archive.mockImplementation((value, revision) => {
    const through = write(value, revision);
    if (!lost) {
      lost = true;
      f.store.deleteSource("the-control-deleted-this-source");
      throw new Error("Written before response was lost");
    }
    return through;
  });
  const acknowledged = new Set<string>();
  vi.mocked(f.catalog.assignmentStatus).mockImplementation(async (value) =>
    acknowledged.has(value.eventId) ? "acknowledged" : "active",
  );
  vi.mocked(f.catalog.acknowledge).mockImplementation(async (value) => {
    acknowledged.add(value.eventId);
    if (value.eventId === input.eventId)
      throw new Error("Catalog committed before response was lost");
  });
  await f.activity(input).receive(input);
  await vi.waitFor(
    async () =>
      expect((await f.activity(input).status()).acknowledgedThrough).toBe(1),
    { timeout: 15000 },
  );
  await f.activity(input).receive(input);
  expect(f.catalog.prepare).toHaveBeenCalledTimes(1);
  expect(f.catalog.apply).not.toHaveBeenCalled();
  expect(f.model.beginReply).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(archive).toHaveBeenCalledTimes(2);
  for (const [value] of archive.mock.calls) expect(value).toEqual(projection);
  expect(f.catalog.acknowledge).toHaveBeenCalledExactlyOnceWith(input, {
    control: true,
    archivedThrough: 1,
  });
  expect(
    f.store.retrieveSession(audience, input.sessionId).turns[0]?.data,
  ).toEqual(projection.turn.data);

  const next = { ...input, eventId: "c".repeat(64), sequence: 2 };
  await f.activity(next).receive(next);
  await vi.waitFor(async () =>
    expect((await f.activity(next).status()).acknowledgedThrough).toBe(2),
  );
  expect(f.model.beginReply.mock.calls[0]?.[0].messages).toEqual([
    { role: "user", content: "SECOND PRIVATE TURN" },
  ]);
});

it.for(["effect", "delivery", "retained", "assignment"] as const)(
  "never releases an uncertain or invalid control receipt (%s)",
  async (mode, t) => {
    const f = await fixture(t);
    const input = assignment();
    const projection = controlArchive(input);
    const entry = projection.turn.data.entries[0];
    if (entry?.role !== "assistant") throw new Error("Missing receipt");
    if (mode === "delivery") entry.delivery = "unknown";
    if (mode === "retained")
      entry.content = { retention: "retained", text: "PRIVATE CONTROL OUTPUT" };
    if (mode === "assignment") projection.turn.eventId = "f".repeat(64);
    vi.mocked(f.catalog.prepare).mockResolvedValue({
      control: {
        input: projection,
        effects: mode === "effect" ? "unknown" : "confirmed",
      },
    });
    await f.activity(input).receive(input);
    const invalid = mode === "retained" || mode === "assignment";
    await vi.waitFor(async () =>
      expect((await f.activity(input).status()).turns[0]?.hold).toBe(
        invalid ? "provenance" : "control",
      ),
    );
    expect(
      f.store.retrieveSession(audience, input.sessionId).turns,
    ).toHaveLength(invalid ? 0 : 1);
    expect(f.catalog.acknowledge).not.toHaveBeenCalled();
    expect(f.catalog.apply).not.toHaveBeenCalled();
    expect(f.model.beginReply).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    await expect(
      f
        .activity(input)
        .receive({ ...input, eventId: "c".repeat(64), sequence: 2 }),
    ).rejects.toThrow();
  },
);

it("accepts a successor using the exact committed receipt while its ACK response is delayed", async (t) => {
  const f = await fixture(t);
  const first = assignment();
  const second = {
    ...first,
    eventId: "c".repeat(64),
    sequence: 2,
    receivedAt: first.receivedAt + 1,
  };
  const gate = Promise.withResolvers<void>();
  t.onTestFinished(() => gate.resolve());
  const acknowledged = new Set<string>();
  vi.mocked(f.catalog.assignmentStatus).mockImplementation(async (input) =>
    acknowledged.has(input.eventId) ? "acknowledged" : "active",
  );
  vi.mocked(f.catalog.acknowledge).mockImplementation(async (input) => {
    acknowledged.add(input.eventId);
    if (input.eventId === first.eventId) await gate.promise;
  });
  const prepare = vi.mocked(f.catalog.prepare).getMockImplementation();
  if (!prepare) throw new Error("Missing fixture preparation");
  vi.mocked(f.catalog.prepare).mockImplementation(async (input, history) => {
    const prepared = await prepare(input, history);
    if (!("control" in prepared))
      prepared.reference.sourceIds.push(
        ...history.flatMap((entry) => entry.reference.sourceIds),
      );
    return prepared;
  });
  await f.activity(first).receive(first);
  await vi.waitFor(() => expect(acknowledged.has(first.eventId)).toBe(true));
  await expect(f.activity(second).receive(second)).resolves.toBeUndefined();
  gate.resolve();
  await vi.waitFor(async () =>
    expect((await f.activity(second).status()).acknowledgedThrough).toBe(2),
  );
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.model.beginReply).toHaveBeenCalledTimes(2);
});
