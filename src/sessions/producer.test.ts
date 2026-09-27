import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { slackSource } from "../imports/identity.js";
import { EvidenceStore, type Source } from "../memory/store.js";
import { archiveDependencies, sessionTurnId } from "./archive.js";
import {
  type ArchiveEvidence,
  produceSessionArchiveTurn,
  type SessionArchiveTurnInput,
} from "./producer.js";

const original: Source = slackSource({
  audiences: ["private"],
  workspace: "T1",
  channel: "D1",
  ts: "1.123456",
  threadTs: "1.000000",
  author: "owner",
  workspaceUrl: "https://example.slack.com/",
  text: "Original human text",
});
const evidence: ArchiveEvidence = {
  source: (_audience, id) => (id === original.id ? original : undefined),
  isDeleted: () => false,
  contextAvailable: (_audience, id) => id === "context",
};
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
function input(): SessionArchiveTurnInput {
  const address = {
    channel: "slack" as const,
    accountId: "T1",
    conversationId: "D1",
    threadId: "1.000000",
  };
  return {
    sessionId: "a".repeat(64),
    audience: "private",
    openedAt: 1100,
    eventId: "b".repeat(64),
    sequence: 1,
    receivedAt: 1100,
    retentionExcluded: false,
    inbound: {
      sourceId: original.id,
      event: {
        id: "event",
        type: "message",
        address,
        occurredAt: 1000,
        messageId: "1.123456",
        senderId: "owner",
        direct: true,
        text: original.text,
      },
    },
    deliveries: [
      {
        delivery: {
          message: {
            id: "reply",
            address,
            lastInboundAt: 1000,
            content: { type: "text", text: "Assistant text" },
          },
          phase: "settled",
          attempts: 1,
          result: { status: "unknown", code: "transport_error" },
          outcomeObservedAt: 1200,
        },
        reference: {
          sourceIds: [original.id],
          contextSourceIds: ["context"],
          deletionTracked: true,
          personality: "digest",
        },
      },
    ],
  };
}

it("projects exact immutable original metadata and ordered uncertain receipts deterministically", (t) => {
  const value = input();
  const before = structuredClone(value);
  const output = produceSessionArchiveTurn(value, evidence);
  expect(output).toEqual(produceSessionArchiveTurn(value, evidence));
  expect(value).toEqual(before);
  expect(output.turn.data.entries).toMatchObject([
    {
      role: "user",
      observedAt: 1123,
      sourceId: "slack:T1:D1:1.123456",
      content: { retention: "retained", text: original.text },
    },
    {
      role: "assistant",
      observedAt: 1200,
      delivery: "unknown",
      content: { retention: "retained", text: "Assistant text" },
    },
  ]);
  required(output.turn.data.entries[0]).address.conversationId = "mutated";
  expect(value).toEqual(before);
  for (const status of ["sent", "rejected", "not_sent"] as const) {
    const notification = input();
    delete notification.inbound;
    const receipt = required(notification.deliveries[0]).delivery;
    receipt.result =
      status === "sent"
        ? { status, messageId: "sent-id" }
        : status === "rejected"
          ? { status, retryable: false, code: "denied" }
          : undefined;
    if (status === "not_sent") {
      receipt.phase = "ready";
      receipt.attempts = 0;
    }
    expect(
      produceSessionArchiveTurn(notification, evidence).turn.data.entries,
    ).toMatchObject([{ role: "assistant", delivery: status }]);
  }
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  store.appendSource(original);
  store.appendSource({ ...original, id: "context", text: "Separate context" });
  const archived = produceSessionArchiveTurn(value, evidence);
  expect(store.archiveSessionTurn(archived, 0)).toBe(1);
  expect(store.archiveSessionTurn(archived, 0)).toBe(1);
  expect(store.retrieveSession("private", value.sessionId).turns).toHaveLength(
    1,
  );
  store.deleteSource(original.id);
  expect(store.archiveSessionTurn(archived, 0)).toBe(1);
  expect(store.retrieveSession("private", value.sessionId)).toMatchObject({
    session: { archivedThrough: 1 },
    turns: [],
  });
});

it("does not retain mismatched originals or missing, foreign, deleted or incomplete output provenance", () => {
  // Same author/text/thread and millisecond, but a distinct original message.
  const otherMessage = input();
  required(otherMessage.inbound).event.messageId = "1.123999";
  required(otherMessage.inbound).event.occurredAt = 1123;
  expect(
    produceSessionArchiveTurn(otherMessage, evidence).turn.data.entries[0]
      ?.content.retention,
  ).toBe("omitted");
  for (const change of [
    { text: "different" },
    { author: "other" },
    { platform: "whatsapp" },
    { account: "other" },
    { conversation: "D2/1.000000" },
    { observedAt: 999 },
    { text: "## opt out" },
    { audiences: ["foreign"] },
  ]) {
    const output = produceSessionArchiveTurn(input(), {
      ...evidence,
      source: () => ({ ...original, ...change }),
    });
    expect(output.turn.data.entries[0]?.content.retention).toBe("omitted");
  }
  for (const mode of [
    "missing",
    "foreign",
    "deleted",
    "context",
    "legacy",
    "absent-context",
  ] as const) {
    const value = input();
    delete value.inbound;
    const reference = required(required(value.deliveries[0]).reference);
    if (mode === "legacy") delete reference.deletionTracked;
    if (mode === "absent-context") delete reference.contextSourceIds;
    const output = produceSessionArchiveTurn(value, {
      ...evidence,
      source: () =>
        mode === "missing"
          ? undefined
          : {
              ...original,
              audiences: mode === "foreign" ? ["foreign"] : ["private"],
            },
      isDeleted: () => mode === "deleted",
      contextAvailable: () => mode !== "context",
    });
    expect(output.turn.data).toMatchObject({
      incomplete: true,
      sourceIds: [],
      contextSourceIds: [],
      entries: [{ content: { retention: "omitted" } }],
    });
    expect(JSON.stringify(output)).not.toContain("Assistant text");
  }
});

it("excludes control/volatile payloads and dependencies, and never invents legacy times", () => {
  const value = input();
  value.retentionExcluded = true;
  const output = produceSessionArchiveTurn(value, {
    source: () => {
      throw new Error("Excluded turns must not consult evidence");
    },
    isDeleted: () => {
      throw new Error("Excluded turns must not consult evidence");
    },
    contextAvailable: () => {
      throw new Error("Excluded turns must not consult evidence");
    },
  });
  expect(
    archiveDependencies({
      id: sessionTurnId(value.sessionId, value.eventId),
      ...output.turn,
    }),
  ).toEqual([]);
  expect(
    output.turn.data.entries.every(
      (entry) => entry.content.retention === "omitted",
    ),
  ).toBe(true);
  delete value.inbound;
  value.retentionExcluded = false;
  const delivery = required(value.deliveries[0]).delivery;
  delivery.ephemeral = true;
  expect(produceSessionArchiveTurn(value, evidence).turn.data).toMatchObject({
    sourceIds: [],
    contextSourceIds: [],
    entries: [{ content: { reason: "retention_excluded" } }],
  });
  delete delivery.outcomeObservedAt;
  expect(produceSessionArchiveTurn(value, evidence).turn.data).toEqual({
    sourceIds: [],
    contextSourceIds: [],
    entries: [],
    incomplete: true,
  });
  const historical = input();
  required(historical.inbound).event.messageId = "missing-original-time";
  required(historical.deliveries[0]).delivery.phase = "sending";
  expect(produceSessionArchiveTurn(historical, evidence).turn.data).toEqual({
    sourceIds: [],
    contextSourceIds: [],
    entries: [],
    incomplete: true,
  });
});
