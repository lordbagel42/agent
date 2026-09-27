import { expect, it } from "vitest";
import type { Delivery } from "../runtime/delivery.js";
import {
  beginSessionMigration,
  finishSessionMigration,
  inspectLegacyDrain,
  type LegacyDrainState,
  observeLegacyBarrier,
} from "./migration.js";

const scope = ["private", "owner"];
const a = "a".repeat(64);
const b = "b".repeat(64);
const c = "c".repeat(64);
const epoch = "e".repeat(64);
function sentDelivery(): Delivery {
  return {
    get message(): never {
      throw new Error("Drain inspection must not read retained payloads");
    },
    phase: "settled",
    attempts: 1,
    outcomeObservedAt: 321,
    result: { status: "sent", messageId: "message-321" },
  };
}

it("does not turn legacy completion, a barrier or settled markers into effect proof", () => {
  const state: LegacyDrainState = {
    events: { [a]: { done: true } },
    modelInvocations: { "PRIVATE MODEL": "settled" },
    webInvocations: { "PRIVATE WEB": "settled" },
    deliveries: {
      "PRIVATE DELIVERY": sentDelivery(),
    },
  };
  const migration = beginSessionMigration(state, scope, epoch);
  observeLegacyBarrier(state, epoch, migration.barrier);
  migration.archivedInputs.push(a);
  expect(inspectLegacyDrain(state, scope)).toMatchObject({
    ready: false,
    counts: {
      missingCoverage: 2,
      unfinishedInputs: 1,
      modelSettlementUnproven: 1,
      webSettlementUnproven: 1,
      unresolvedDeliveries: 0,
    },
  });
  expect(() => finishSessionMigration(state, scope)).toThrow(
    "not provably drained",
  );
  expect(migration.phase).toBe("draining");
  const report = JSON.stringify(inspectLegacyDrain(state, scope));
  expect(report).not.toContain("PRIVATE");
  expect(report).not.toContain(epoch);
  expect(report).not.toContain(a);

  // Even a genuinely new, apparently empty scope needs creation-only lineage.
  const empty: LegacyDrainState = { events: {}, deliveries: {} };
  const boundary = beginSessionMigration(empty, scope, epoch);
  observeLegacyBarrier(empty, epoch, boundary.barrier);
  expect(inspectLegacyDrain(empty, scope).counts.missingCoverage).toBe(1);
  expect(() => finishSessionMigration(empty, scope)).toThrow();
});

it("requires exact barrier, complete frozen input and archive accounting across replay", () => {
  let state: LegacyDrainState = {
    legacyCoverage: {
      version: 1,
      scope: JSON.stringify(scope),
      turns: { [a]: { finished: true }, [b]: {} },
    },
    events: { [a]: { done: true }, [b]: { done: false } },
    pendingNotifications: { [b]: "PRIVATE pending completion" },
    deliveries: {},
  };
  const initial = beginSessionMigration(state, scope, epoch);
  expect(initial.legacyInputs).toEqual([a, b]);
  expect(() => observeLegacyBarrier(state, epoch, "wrong-token")).toThrow();
  expect(initial.barrierObserved).toBeUndefined();
  observeLegacyBarrier(state, epoch, initial.barrier);
  initial.archivedInputs.push(a);
  state = JSON.parse(JSON.stringify(state));
  const migration = beginSessionMigration(state, scope, c);
  expect(migration.epoch).toBe(epoch);
  expect(migration.legacyInputs).toEqual([a, b]);

  // A recovered publication behind the barrier is not accounted for by FIFO.
  expect(inspectLegacyDrain(state, scope).counts).toMatchObject({
    unfinishedInputs: 1,
    unarchivedInputs: 1,
  });
  expect(() => finishSessionMigration(state, scope)).toThrow();
  if (!state.legacyCoverage) throw new Error("Missing fixture coverage");
  state.legacyCoverage.turns[b] = { finished: true };
  migration.archivedInputs.push(b);
  expect(() => finishSessionMigration(state, scope)).toThrow();
  delete state.pendingNotifications?.[b];
  expect(() => finishSessionMigration(state, scope)).toThrow();
  state.events[b] = { done: true };

  state.deliveries.reply = sentDelivery();
  const delivery = state.deliveries.reply;
  for (const result of [
    { status: "unknown", code: "PRIVATE" },
    { status: "rejected", code: "PRIVATE", retryable: true },
    { status: "sent", messageId: "" },
  ] as const) {
    delivery.result = result;
    expect(inspectLegacyDrain(state, scope).counts.unresolvedDeliveries).toBe(
      1,
    );
    expect(() => finishSessionMigration(state, scope)).toThrow();
  }
  delivery.result = { status: "sent", messageId: "message-321" };
  delivery.phase = "sending";
  expect(() => finishSessionMigration(state, scope)).toThrow();
  delivery.phase = "settled";
  state.legacyCoverage.turns[b] = { finished: true, untrackedEffect: true };
  expect(inspectLegacyDrain(state, scope).counts.untrackedTurnEffects).toBe(1);
  expect(() => finishSessionMigration(state, scope)).toThrow();
  state.legacyCoverage.turns[b] = { finished: true };

  // A previously unseen legacy entry cannot hide outside the frozen inventory.
  state.pendingInputs = { [c]: "PRIVATE late legacy" };
  expect(inspectLegacyDrain(state, scope).counts.unfrozenLegacyInputs).toBe(1);
  expect(() => finishSessionMigration(state, scope)).toThrow();
  // Only separately admitted session traffic is excluded from that inventory.
  state.ingress = { receipts: { [c]: { lane: "session" } } };
  expect(inspectLegacyDrain(state, ["private", "someone-else"]).ready).toBe(
    false,
  );
  expect(inspectLegacyDrain(state, scope).ready).toBe(true);
  finishSessionMigration(state, scope);
  expect(state.migration?.phase).toBe("sessions");
  expect(state.pendingInputs[c]).toBe("PRIVATE late legacy");
  expect(state.events).toEqual({ [a]: { done: true }, [b]: { done: true } });
});
