import { describe, expect, it } from "vitest";
import type { Evidence, Policy } from "./domain.js";
import {
  cancel,
  claim,
  decayDrive,
  enqueue,
  finish,
  initialState,
  isQuiet,
} from "./domain.js";

const now = Date.parse("2026-09-26T12:00:00Z");
const evidence: [Evidence] = [
  {
    id: "a",
    scope: "owner/dm",
    observedAt: now,
    expiresAt: now + 10000,
    source: "episode",
    text: "A question",
  },
];
const policy: Policy = {
  totalCapacity: 3,
  liveReserve: 1,
  cooldownMs: 100,
  maxNoNewEvidence: 2,
  maxAttempts: 3,
  evidenceMaxAgeMs: 10000,
  quiet: { timeZone: "UTC", startMinute: 1320, endMinute: 420 },
};
const request = {
  scope: "owner/dm",
  evidenceIds: ["a"],
  kind: "curiosity" as const,
};

describe("serializable reflection admission", () => {
  it("deduplicates stable scope/evidence sets without mutating input", () => {
    const original = initialState();
    const first = enqueue(
      original,
      { ...request, evidenceIds: ["b", "a", "a"] },
      now,
    );
    const again = enqueue(
      first.state,
      { ...request, evidenceIds: ["a", "b"], kind: "reflection" },
      now,
    );
    expect(again.accepted).toBe(false);
    expect(again.id).toBe(first.id);
    expect(original.requests).toEqual([]);
    expect(
      enqueue(again.state, { ...request, scope: "channel" }, now).accepted,
    ).toBe(true);
    expect(JSON.parse(JSON.stringify(again.state))).toEqual(again.state);
  });

  it("reserves capacity and holds cancellation capacity until work settles", () => {
    let state = initialState();
    const ids: string[] = [];
    for (const scope of ["owner/dm", "two", "three"]) {
      const added = enqueue(state, { ...request, scope }, now);
      state = added.state;
      ids.push(added.id);
    }
    const [firstId, secondId, thirdId] = ids;
    if (!firstId || !secondId || !thirdId)
      throw new Error("Missing fixture IDs");
    const scoped = [
      ...evidence,
      ...["two", "three"].map((scope) => ({ ...evidence[0], scope })),
    ];
    const first = claim(state, firstId, now, policy, scoped, 0);
    const second = claim(first.state, secondId, now, policy, scoped, 0);
    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(1);
    expect(claim(second.state, thirdId, now, policy, scoped, 0).reason).toBe(
      "capacity",
    );
    const cancelled = cancel(second.state, firstId);
    expect(claim(cancelled, thirdId, now, policy, scoped, 0).reason).toBe(
      "capacity",
    );
    const settled = finish(cancelled, firstId, 1, now, [], policy);
    expect(settled.requests[0]?.status).toBe("cancelled");
    expect(claim(settled, thirdId, now, policy, scoped, 2).reason).toBe(
      "capacity",
    );
    expect(claim(settled, thirdId, now, policy, scoped, 0).attempt).toBe(1);
    expect(finish(settled, firstId, 1, now, evidence, policy)).toEqual(settled);
  });

  it("rejects expired, future, forgotten and wrong-scope evidence", () => {
    const added = enqueue(initialState(), request, now);
    for (const patch of [
      { expiresAt: now },
      { observedAt: now + 1 },
      { invalidated: true },
      { scope: "other" },
      { observedAt: now - 10001 },
    ]) {
      expect(
        claim(
          added.state,
          added.id,
          now,
          policy,
          [{ ...evidence[0], ...patch }],
          0,
        ).reason,
      ).toBe("stale-evidence");
    }
  });

  it("applies cooldown, habituates without independent evidence and recovers only on new evidence", () => {
    const added = enqueue(initialState(), request, now);
    const first = claim(added.state, added.id, now, policy, evidence, 0);
    const done = finish(first.state, added.id, 1, now, evidence, policy);
    expect(claim(done, added.id, now + 99, policy, evidence, 0).reason).toBe(
      "cooldown",
    );
    const next = claim(done, added.id, now + 100, policy, evidence, 0);
    expect(next.attempt).toBe(2);
    expect(finish(next.state, added.id, 1, now + 100, [], policy)).toEqual(
      next.state,
    );
    const stopped = finish(
      next.state,
      added.id,
      2,
      now + 100,
      [{ ...evidence[0], id: "dream", source: "dream" }],
      policy,
    );
    expect(
      claim(stopped, added.id, now + 200, policy, evidence, 0).reason,
    ).toBe("stopped");
    const fresh = { ...evidence[0], id: "new" };
    const newRequest = enqueue(
      stopped,
      { ...request, evidenceIds: ["new"] },
      now + 200,
    );
    expect(
      claim(newRequest.state, newRequest.id, now + 200, policy, [fresh], 0)
        .attempt,
    ).toBe(1);
  });

  it("decays stimulation by half-life and clamps backwards time", () => {
    expect(decayDrive({ value: 0.8, updatedAt: 100 }, 1100, 1000)).toEqual({
      value: 0.4,
      updatedAt: 1100,
    });
    expect(decayDrive({ value: 0.8, updatedAt: 100 }, 0, 1000)).toEqual({
      value: 0.8,
      updatedAt: 100,
    });
  });

  it("bounds attempts even with new independent evidence and prevents same-scope overlap", () => {
    const added = enqueue(initialState(), request, now);
    const running = claim(
      added.state,
      added.id,
      now,
      { ...policy, maxAttempts: 1 },
      evidence,
      0,
    );
    expect(
      claim(running.state, added.id, now, policy, evidence, 0).reason,
    ).toBe("active");
    const other = enqueue(
      running.state,
      { ...request, evidenceIds: ["b"] },
      now,
    );
    const fresh = { ...evidence[0], id: "b" };
    expect(claim(other.state, other.id, now, policy, [fresh], 0).reason).toBe(
      "active",
    );
    const done = finish(other.state, added.id, 1, now, [fresh], {
      ...policy,
      maxAttempts: 1,
    });
    expect(done.scopes[0]?.noNewEvidence).toBe(0);
    expect(claim(done, added.id, now + 100, policy, evidence, 0).reason).toBe(
      "stopped",
    );
    expect(
      claim(cancel(other.state, other.id), other.id, now, policy, [fresh], 0)
        .reason,
    ).toBe("stopped");
  });
});

describe("owner wall-clock quiet hours", () => {
  it.each([
    ["2026-09-26T21:59:59Z", false],
    ["2026-09-26T22:00:00Z", true],
    ["2026-09-27T06:59:59Z", true],
    ["2026-09-27T07:00:00Z", false],
  ])("cross-midnight boundary %s", (date, expected) => {
    expect(isQuiet(Date.parse(date), policy.quiet)).toBe(expected);
  });
  it("uses both repeated DST hours and skips nonexistent hours", () => {
    const quiet = {
      timeZone: "America/New_York",
      startMinute: 60,
      endMinute: 120,
    };
    expect(isQuiet(Date.parse("2026-11-01T05:30:00Z"), quiet)).toBe(true);
    expect(isQuiet(Date.parse("2026-11-01T06:30:00Z"), quiet)).toBe(true);
    expect(isQuiet(Date.parse("2026-11-01T07:00:00Z"), quiet)).toBe(false);
    expect(isQuiet(Date.parse("2026-03-08T07:00:00Z"), quiet)).toBe(false);
    expect(() => isQuiet(now, { ...quiet, timeZone: "invalid" })).toThrow();
    const added = enqueue(initialState(), request, now);
    expect(
      claim(
        added.state,
        added.id,
        now,
        {
          ...policy,
          quiet: { timeZone: "UTC", startMinute: 720, endMinute: 780 },
        },
        evidence,
        0,
      ).reason,
    ).toBe("quiet-hours");
  });
});
