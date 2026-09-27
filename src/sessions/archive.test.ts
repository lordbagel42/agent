import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { EvidenceStore, type Source } from "../memory/store.js";
import { type SessionArchiveInput, sessionTurnId } from "./archive.js";

const key = randomBytes(32);
const roots: string[] = [];
const stores: EvidenceStore[] = [];
function open(path?: string) {
  if (!path) {
    const root = mkdtempSync(join(tmpdir(), "june-session-archive-"));
    roots.push(root);
    path = join(root, "evidence.sqlite");
  }
  const store = new EvidenceStore(path, key);
  stores.push(store);
  return { store, path };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const source = (id = "original", audiences = ["private"]): Source => ({
  id,
  audiences,
  platform: "slack",
  account: "workspace",
  conversation: "owner-dm",
  author: "owner",
  observedAt: 90,
  sourceUrl: "https://example.com/original",
  text: "The original human sentence.",
});
function input(original = source(), sequence = 1): SessionArchiveInput {
  const address = {
    channel: "slack" as const,
    accountId: "workspace",
    conversationId: "owner-dm",
  };
  return {
    sessionId: "a".repeat(64),
    audience: "private",
    openedAt: 100,
    turn: {
      eventId: (sequence === 1 ? "b" : "c").repeat(64),
      sequence,
      receivedAt: sequence * 100,
      data: {
        sourceIds: [original.id],
        contextSourceIds: [],
        entries: [
          {
            role: "user",
            address,
            author: original.author,
            messageId: "1.000001",
            observedAt: 90,
            sourceId: original.id,
            content: { retention: "retained", text: original.text },
          },
          {
            role: "assistant",
            address,
            observedAt: 150,
            delivery: "unknown",
            content: {
              retention: "retained",
              text: "June said she would arrange the violet tickets.",
            },
          },
        ],
      },
    },
  };
}

function entry(value: SessionArchiveInput, role: "user" | "assistant") {
  const result = value.turn.data.entries.find((item) => item.role === role);
  if (!result) throw new Error(`Missing fixture ${role} entry`);
  return result;
}

it("keeps immutable archive receipts across reopen without creating corroborating sources", () => {
  const { store, path } = open();
  store.appendSource(source());
  const first = input();
  expect(store.archiveSessionTurn(first, 0)).toBe(1);
  expect(store.archiveSessionTurn(first, 0)).toBe(1);
  store.close();
  const reopened = open(path).store;
  expect(reopened.retrieveSession("private", first.sessionId).turns).toEqual([
    { id: sessionTurnId(first.sessionId, first.turn.eventId), ...first.turn },
  ]);
  const altered = structuredClone(first);
  entry(altered, "assistant").content = {
    retention: "retained",
    text: "A different reply",
  };
  expect(() => reopened.archiveSessionTurn(altered, 0)).toThrow("immutable");
  expect(() =>
    reopened.archiveSessionTurn({ ...first, sessionId: "d".repeat(64) }, 0),
  ).toThrow("conflicting");
  const second = input(source(), 2);
  reopened.deleteSource("unrelated-deletion");
  expect(() => reopened.archiveSessionTurn(second, 0)).toThrow("Stale");
  expect(reopened.archiveSessionTurn(first, 0)).toBe(1);
  expect(reopened.archiveSessionTurn(second, 1)).toBe(2);
  const page = reopened.retrieveSession("private", first.sessionId, {
    maxCharacters: 1200,
  });
  expect(page.turns.map((turn) => turn.sequence)).toEqual([1]);
  expect(page.nextAfter).toBe(1);
  const next = reopened.retrieveSession("private", first.sessionId, {
    maxCharacters: 1200,
    afterSequence: page.nextAfter,
  });
  expect(next.turns.map((turn) => turn.sequence)).toEqual([2]);
  expect(next.nextAfter).toBeUndefined();
  const turnId = sessionTurnId(first.sessionId, first.turn.eventId);
  expect(reopened.independentEvidence(turnId, "private")).toEqual([]);
  expect(reopened.search("private", "violet")).toEqual({
    sources: [],
    claims: [],
  });
  expect(() => reopened.appendSource({ ...source(), id: turnId })).toThrow();
  expect(() =>
    reopened.appendClaim({
      id: "claim",
      audiences: ["private"],
      entity: "owner",
      text: "Claim",
      kind: "evidence",
      dependsOn: [turnId],
      contradicts: [],
      supersedes: [],
    }),
  ).toThrow();
  expect(reopened.searchSessions("private", "violet")).toEqual({
    sessions: [
      {
        id: first.sessionId,
        openedAt: 100,
        lastReceivedAt: 200,
        matchingTurns: 2,
      },
    ],
    omitted: 0,
  });
});

it("filters scope and retention before archive matching and bounds whole transcript turns", () => {
  const { store } = open();
  store.appendSource(source());
  store.appendSource(source("foreign", ["other"]));
  store.appendSource({ ...source("optout"), text: "##never retain this" });
  const first = input();
  const falseOriginal = structuredClone(first);
  entry(falseOriginal, "user").content = {
    retention: "retained",
    text: "Fabricated human words",
  };
  expect(() => store.archiveSessionTurn(falseOriginal, 0)).toThrow(
    "original source",
  );
  const foreign = structuredClone(first);
  foreign.turn.data.contextSourceIds = ["foreign"];
  expect(() => store.archiveSessionTurn(foreign, 0)).toThrow("unauthorized");
  const shared = source("shared-for-proposal", ["private", "other"]);
  store.appendSource(shared);
  const [proposal] = store.stageProposals(
    "other",
    [shared.id],
    [
      {
        subjectSourceId: shared.id,
        text: "A hypothesis belonging to the other audience",
        category: "claim",
        citations: [{ sourceId: shared.id, quote: shared.text }],
        confidence: null,
        validFrom: null,
        validTo: null,
        contradicts: [],
        supersedes: [],
      },
    ],
  );
  if (!proposal) throw new Error("Missing fixture proposal");
  foreign.turn.data.contextSourceIds = [proposal.id];
  expect(() => store.archiveSessionTurn(foreign, 0)).toThrow("unauthorized");
  store.reviewProposal("other", proposal.id, "rejected");
  expect(() => store.archiveSessionTurn(foreign, 0)).toThrow("unauthorized");
  expect(() =>
    store.archiveSessionTurn(
      input({ ...source("optout"), text: "##never retain this" }),
      0,
    ),
  ).toThrow("unauthorized");
  const volatile = structuredClone(first);
  entry(volatile, "assistant").content = {
    retention: "omitted",
    reason: "retention_excluded",
    text: "must not persist",
  } as never;
  expect(() => store.archiveSessionTurn(volatile, 0)).toThrow(
    "Invalid memory input",
  );
  entry(first, "assistant").content = {
    retention: "retained",
    text: "violet ".repeat(2000),
  };
  store.archiveSessionTurn(first, 0);
  const second = input(source(), 2);
  entry(second, "assistant").content = {
    retention: "omitted",
    reason: "retention_excluded",
  };
  store.archiveSessionTurn(second, 0);
  const empty = { session: null, turns: [], omitted: 0 };
  expect(store.retrieveSession("other", first.sessionId)).toEqual(empty);
  expect(store.retrieveSession("private", "f".repeat(64))).toEqual(empty);
  expect(store.searchSessions("other", "violet")).toEqual({
    sessions: [],
    omitted: 0,
  });
  expect(
    store.searchSessions("private", "violet", {
      observedFrom: 100,
      observedTo: 200,
    }).sessions[0]?.matchingTurns,
  ).toBe(1);
  expect(
    store.searchSessions("private", "violet", { observedFrom: 200 }),
  ).toEqual({ sessions: [], omitted: 0 });
  // Match the utterance's timestamp, not the earlier ingress receipt.
  expect(
    store.searchSessions("private", "violet", { observedTo: 125 }),
  ).toEqual({ sessions: [], omitted: 0 });
  const page = store.retrieveSession("private", first.sessionId, {
    limit: 1,
    maxCharacters: 1200,
  });
  expect(page).toEqual({
    session: { id: first.sessionId, openedAt: 100, archivedThrough: 2 },
    turns: [],
    omitted: 2,
    nextAfter: 1,
  });
  expect(JSON.stringify(page).length).toBeLessThanOrEqual(1200);
  expect(
    store.retrieveSession("private", first.sessionId, { afterSequence: 1 })
      .turns[0]?.data?.entries[1]?.content,
  ).toEqual({ retention: "omitted", reason: "retention_excluded" });
});

it("binds forget previews to authorized archive dependants without granting hidden spillover", () => {
  const { store } = open();
  const original = source("shared-source", ["private", "other"]);
  store.appendSource(original);
  const before = store.previewForget("private", original.id);
  const first = input(original);
  store.archiveSessionTurn(first, 0);
  expect(store.previewForget("private", original.id)).toMatchObject({
    archivedTurns: 1,
    confirmable: false,
  });
  const preview = store.previewForget("private", original.id, {
    includeArchives: true,
  });
  expect(preview).toMatchObject({ archivedTurns: 1, confirmable: true });
  expect(preview?.fingerprint).not.toBe(before?.fingerprint);
  store.archiveSessionTurn(
    { ...first, sessionId: "e".repeat(64), audience: "other" },
    0,
  );
  const withHidden = store.previewForget("private", original.id, {
    includeArchives: true,
  });
  expect(withHidden).toEqual({ ...preview, confirmable: false });
  expect(store.retrieveSession("private", first.sessionId).turns).toHaveLength(
    1,
  );
});

it("replays archive tombstones before projection and cannot resurrect forgotten payloads", () => {
  const { store, path } = open();
  store.appendSource(source());
  store.appendSource({ ...source("follow-up"), text: "Continue." });
  const first = input();
  const second = input({ ...source("follow-up"), text: "Continue." }, 2);
  second.turn.data.contextSourceIds = [
    sessionTurnId(first.sessionId, first.turn.eventId),
  ];
  store.archiveSessionTurn(first, 0);
  store.archiveSessionTurn(second, 0);
  expect(
    store.previewForget("private", "original", { includeArchives: true }),
  ).toMatchObject({ archivedTurns: 2, confirmable: true });
  store.close();
  const snapshot = `${path}.snapshot`;
  copyFileSync(path, snapshot);
  const current = open(path).store;
  current.deleteSource("original");
  expect(current.deletionRevision()).toBe(3);
  expect(current.archiveSessionTurn(first, 0)).toBe(2);
  expect(current.retrieveSession("private", first.sessionId)).toEqual({
    session: { id: first.sessionId, openedAt: 100, archivedThrough: 2 },
    turns: [],
    omitted: 0,
  });
  const page = current.exportTombstones({ watermark: 3 });
  expect(page.tombstones).toEqual([
    "original",
    sessionTurnId(first.sessionId, first.turn.eventId),
    sessionTurnId(second.sessionId, second.turn.eventId),
  ]);
  const restored = new EvidenceStore(snapshot, key, {
    restore: { watermark: 3, pages: [page] },
  });
  stores.push(restored);
  expect(restored.restoreStatus()).toMatchObject({
    replayedThrough: 3,
    deletionWatermark: 3,
  });
  expect(restored.searchSessions("private", "violet")).toEqual({
    sessions: [],
    omitted: 0,
  });
  expect(restored.retrieveSession("private", first.sessionId).turns).toEqual(
    [],
  );
  expect(restored.archiveSessionTurn(second, 0)).toBe(2);
  expect(restored.source("private", "follow-up")?.text).toBe("Continue.");
  restored.close();
  expect(
    open(snapshot).store.retrieveSession("private", first.sessionId).turns,
  ).toEqual([]);
});
