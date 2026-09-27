import { describe, expect, it } from "vitest";
import {
  acknowledgeSessionArchive,
  initialSessionDirectory,
  nextSessionInput,
  receiveSessionInput,
  type SessionDirectory,
  sealIdleSession,
  sessionActorKey,
  settleSessionInput,
} from "./state.js";

const a = "a".repeat(64);
const b = "b".repeat(64);
const c = "c".repeat(64);
const d = "d".repeat(64);
const e = "e".repeat(64);

function dispatch(state: SessionDirectory) {
  const result = nextSessionInput(state);
  if (result.kind !== "dispatch")
    throw new Error(`Expected dispatch, got ${result.kind}`);
  return result.receipt;
}

describe("session assignment safety", () => {
  it("keeps replayed events in their original session across restart and rotation", () => {
    let state = initialSessionDirectory(["private", "owner"], 1000);
    receiveSessionInput(state, a, "message", 1000);
    receiveSessionInput(state, a, "message", 1700);
    expect(state.pending).toEqual([a]);
    const first = dispatch(state);
    expect(first).toMatchObject({ id: a, receivedAt: 1000, sequence: 1 });

    receiveSessionInput(state, b, "message", 2000);
    state = JSON.parse(JSON.stringify(state));
    expect(dispatch(state)).toEqual(first);
    const beforeRejection = JSON.stringify(state);
    expect(() => settleSessionInput(state, a, "wrong-session")).toThrow();
    expect(JSON.stringify(state)).toBe(beforeRejection);
    expect(sealIdleSession(state, 9000)).toBe(false);

    settleSessionInput(state, a, first.sessionId);
    expect(nextSessionInput(state)).toEqual({
      kind: "archive",
      sessionId: first.sessionId,
      through: 1,
    });
    expect(() =>
      acknowledgeSessionArchive(state, first.sessionId, 2),
    ).toThrow();
    acknowledgeSessionArchive(state, first.sessionId, 1);
    const second = dispatch(state);
    expect(second).toMatchObject({ id: b, receivedAt: 2000, sequence: 1 });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(state.sessions[first.sessionId]?.status).toBe("sealed");

    const beforeReplay = JSON.stringify(state);
    receiveSessionInput(state, a, "message", 10000);
    settleSessionInput(state, a, first.sessionId);
    expect(JSON.stringify(state)).toBe(beforeReplay);
    expect(dispatch(state)).toEqual(second);
    expect(state.scopeKey).toEqual(["private", "owner"]);
    const firstKey = sessionActorKey(state.scopeKey, first.sessionId);
    const secondKey = sessionActorKey(state.scopeKey, second.sessionId);
    expect(firstKey[0]).toBe(secondKey[0]);
    expect(firstKey).not.toEqual(secondKey);
    expect(firstKey.every((segment) => /^[a-f0-9]{64}$/.test(segment))).toBe(
      true,
    );
  });

  it("does not let a stale idle wake split already-received conversation turns", () => {
    const state = initialSessionDirectory(["private", "owner"]);
    receiveSessionInput(state, a, "message", 100);
    receiveSessionInput(state, b, "message", 10_800_099);
    receiveSessionInput(state, c, "message", 21_600_099);
    const first = dispatch(state);
    settleSessionInput(state, a, first.sessionId);
    acknowledgeSessionArchive(state, first.sessionId, 1);

    // Processing is late, but B arrived one millisecond before the boundary.
    expect(sealIdleSession(state, 100_000_000)).toBe(false);
    expect(dispatch(state)).toMatchObject({
      id: b,
      sessionId: first.sessionId,
      sequence: 2,
    });
    settleSessionInput(state, b, first.sessionId);
    expect(sealIdleSession(state, 100_000_000)).toBe(false);
    acknowledgeSessionArchive(state, first.sessionId, 2);
    acknowledgeSessionArchive(state, first.sessionId, 1);
    expect(state.sessions[first.sessionId]?.archivedThrough).toBe(2);
    expect(sealIdleSession(state, 100_000_000)).toBe(true);
    const next = dispatch(state);
    expect(next.id).toBe(c);
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(next.sequence).toBe(1);
  });

  it("does not let notifications or clock rollback refresh human inactivity", () => {
    const state = initialSessionDirectory(["private", "owner"], 1000);
    receiveSessionInput(state, a, "message", 2000);
    const first = dispatch(state);
    settleSessionInput(state, a, first.sessionId);
    acknowledgeSessionArchive(state, first.sessionId, 1);

    receiveSessionInput(state, b, "notification", 2800);
    expect(dispatch(state)).toMatchObject({
      sessionId: first.sessionId,
      sequence: 2,
    });
    settleSessionInput(state, b, first.sessionId);
    acknowledgeSessionArchive(state, first.sessionId, 2);
    expect(state.sessions[first.sessionId]?.lastHumanAt).toBe(2000);
    receiveSessionInput(state, c, "message", 3000);
    const second = dispatch(state);
    expect(second.sessionId).not.toBe(first.sessionId);
    settleSessionInput(state, c, second.sessionId);
    acknowledgeSessionArchive(state, second.sessionId, 1);

    receiveSessionInput(state, d, "message", 1500);
    expect(dispatch(state)).toMatchObject({
      receivedAt: 3000,
      sessionId: second.sessionId,
      sequence: 2,
    });
    settleSessionInput(state, d, second.sessionId);
    acknowledgeSessionArchive(state, second.sessionId, 2);
    expect(sealIdleSession(state, 3999)).toBe(false);
    expect(sealIdleSession(state, 4000)).toBe(true);
    receiveSessionInput(state, e, "message", 4001);
    expect(dispatch(state).sessionId).not.toBe(second.sessionId);
  });

  it("requires archived settlement for notification-only retirement and rejects conflicting receipts", () => {
    const state = initialSessionDirectory(["private", "owner"], 1000);
    receiveSessionInput(state, a, "notification", 1000);
    const first = dispatch(state);
    expect(sealIdleSession(state, 9000)).toBe(false);
    settleSessionInput(state, a, first.sessionId);
    expect(sealIdleSession(state, 9000)).toBe(false);
    acknowledgeSessionArchive(state, first.sessionId, 1);

    // A queued notification must not hide the eligible human behind it.
    receiveSessionInput(state, b, "notification", 1100);
    receiveSessionInput(state, c, "message", 1200);
    expect(sealIdleSession(state, 9000)).toBe(false);
    expect(dispatch(state)).toMatchObject({
      id: b,
      sessionId: first.sessionId,
    });
    settleSessionInput(state, b, first.sessionId);
    acknowledgeSessionArchive(state, first.sessionId, 2);
    expect(state.sessions[first.sessionId]?.lastHumanAt).toBeUndefined();
    expect(dispatch(state)).toMatchObject({
      id: c,
      sessionId: first.sessionId,
    });
    settleSessionInput(state, c, first.sessionId);
    acknowledgeSessionArchive(state, first.sessionId, 3);
    expect(sealIdleSession(state, 2200)).toBe(true);

    receiveSessionInput(state, d, "notification", 2300);
    const second = dispatch(state);
    settleSessionInput(state, d, second.sessionId);
    acknowledgeSessionArchive(state, second.sessionId, 1);
    expect(sealIdleSession(state, 2300)).toBe(true);
    expect(nextSessionInput(state)).toEqual({ kind: "idle" });

    const before = JSON.stringify(state);
    expect(() => receiveSessionInput(state, a, "message", 9900)).toThrow();
    expect(() =>
      receiveSessionInput(state, "__proto__", "message", 9900),
    ).toThrow();
    expect(() =>
      receiveSessionInput(state, d, "message", Number.NaN),
    ).toThrow();
    expect(() => settleSessionInput(state, e, second.sessionId)).toThrow();
    expect(() =>
      acknowledgeSessionArchive(state, first.sessionId, -1),
    ).toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });
});
