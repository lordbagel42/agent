import { expect, it } from "vitest";
import {
  createReflectionActor,
  type ReflectionCandidate,
} from "./reflection.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

async function fixture() {
  const now = Date.now();
  const scope = JSON.stringify(["private", "owner"]);
  const config = createReflectionActor({
    ownerId: "owner",
    idleMs: 100,
    deepMs: 200,
    pollMs: 100,
    timeoutMs: 1000,
    policy: {
      totalCapacity: 2,
      liveReserve: 1,
      cooldownMs: 1,
      maxAttempts: 1,
      maxNoNewEvidence: 1,
      evidenceMaxAgeMs: 60000,
      quiet: { timeZone: "UTC", startMinute: 0, endMinute: 0 },
    },
    async retrieve({ scope, evidenceIds }) {
      return {
        authorized: true,
        evidence: evidenceIds.map((id) => ({
          id,
          scope,
          source: "episode" as const,
          text: "private fixture",
          observedAt: now - 1000,
          expiresAt: now + 30000,
        })),
      };
    },
    async decide() {
      throw new Error("No generation in action fixture");
    },
  }).config;
  if (
    !("state" in config) ||
    !("createVars" in config) ||
    !config.createVars ||
    !config.actions
  )
    throw new Error("Expected reflection actor");
  const c = {
    key: ["owner"],
    state: structuredClone(config.state),
    async saveState() {},
    queue: { async send() {} },
  } as unknown as Parameters<typeof config.actions.occupancy>[0];
  c.vars = await config.createVars(c, undefined);
  c.state.epoch = 7;
  // An old actor has no format version; migration must establish publication.
  Reflect.deleteProperty(c.state, "candidateFormatVersion");
  const add = (
    name: string,
    phase: "settled" | "started" | "uncertain" = "settled",
  ) => {
    const requestId = JSON.stringify([scope, [name]]);
    const id = JSON.stringify([requestId, 1]);
    c.state.reflection.requests.push({
      id: requestId,
      scope,
      evidenceIds: [name],
      kind: "reflection",
      createdAt: now - 1000,
      attempts: 1,
      status: "stopped",
    });
    const candidate: ReflectionCandidate = {
      id,
      requestId,
      scope,
      attempt: 1,
      mode: "interaction",
      kind: "proposal",
      hypothesisOnly: false,
      decision: { answer: "yes", rationale: name, evidenceIds: [name] },
      createdAt: now,
      epoch: 7,
      publication: { version: 1, expiresAt: now + 20000 },
    };
    c.state.candidates[id] = candidate;
    c.state.invocations[id] = phase;
    return id;
  };
  return { c, actions: config.actions, add, now };
}

it("preserves published bodies across interactions without rearming effects or releasing uncertain work", async () => {
  const { c, actions, add } = await fixture();
  const id = add("published");
  c.state.invocations.unknown = "uncertain";
  const controller = new AbortController();
  c.vars.active.set("unfinished", controller);
  await actions.occupancy(c, "owner-turn", true);
  expect(c.state.candidates[id]?.decision.rationale).toBe("published");
  expect(c.state.candidates[id]?.epoch).toBe(7);
  expect(c.state.epoch).toBe(8);
  expect(controller.signal.aborted).toBe(true);
  expect(c.state.invocations.unknown).toBe("uncertain");
  await actions.occupancy(c, "owner-turn", false);
  expect(await actions.candidate(c, id)).toBeNull();
  await actions.trigger(c, {
    id: "legacy",
    type: "interaction",
    liveActive: 0,
  });
  expect(c.state.candidates[id]?.epoch).toBe(7);
  expect(c.state.epoch).toBe(9);
});

it("migrates only verifiable capped publications and preserves failed/unknown receipts", async () => {
  const { c, actions, add, now } = await fixture();
  const good = add("good");
  const uncapped = add("unknown-original-ttl");
  Reflect.deleteProperty(required(c.state.candidates[uncapped]), "publication");
  const uncertain = add("uncertain", "uncertain");
  add("started", "started");
  const old = add("old-epoch");
  required(c.state.candidates[old]).epoch = 6;
  const cancelled = add("cancelled");
  required(
    c.state.reflection.requests.find(
      (r) => r.id === c.state.candidates[cancelled]?.requestId,
    ),
  ).status = "cancelled";
  const malformed = add("malformed");
  required(c.state.candidates[malformed]).decision.evidenceIds = ["invented"];
  const mismatch = add("mismatch");
  required(c.state.candidates[mismatch]).attempt = 2;
  const hypothesis = add("wrong-hypothesis");
  required(c.state.candidates[hypothesis]).hypothesisOnly = true;
  const badKey = add("wrong-map-key");
  required(c.state.candidates[badKey]).id = good;
  Reflect.set(c.state.candidates, "null-record", null);
  Reflect.set(c.state.candidates, "string-record", "invalid");
  Reflect.set(c.state.candidates, "empty-record", {});
  await actions.occupancy(c, "migration-turn", true);
  expect(Object.keys(c.state.candidates)).toEqual([good]);
  expect(c.state.invocations[uncertain]).toBe("uncertain");
  expect(c.state.invocations[uncapped]).toBe("settled");
  expect(c.state.reflection.requests).toHaveLength(10);
  expect(c.state).toHaveProperty("candidateFormatVersion", 1);
  // Current retrieval permits another 30 seconds, but migration cannot extend
  // the recorded 20-second original ceiling.
  expect(c.state.candidates[good]?.publication).toEqual({
    version: 1,
    expiresAt: now + 20000,
  });
});

it("evicts oldest and expired bodies within count/byte bounds without erasing dedupe receipts", async () => {
  const { c, actions, add, now } = await fixture();
  Object.assign(c.state, { candidateFormatVersion: 1 });
  const ids: string[] = [];
  for (let index = 0; index < 52; index++) {
    const id = add(`entry-${index}`);
    ids.push(id);
    Object.assign(required(c.state.candidates[id]), {
      createdAt: now - 1000 + index,
      publication: {
        version: 1,
        expiresAt: index === 2 ? now - 1 : now + 30000,
      },
    });
  }
  await actions.occupancy(c, "bounded", true);
  expect(Object.keys(c.state.candidates)).toEqual(
    ids.slice(1).filter((_, i) => i !== 1),
  );
  expect(c.state.reflection.requests).toHaveLength(52);
  expect(Object.keys(c.state.invocations)).toHaveLength(52);
  for (const candidate of Object.values(c.state.candidates))
    candidate.decision.rationale = "夢".repeat(4000);
  await actions.occupancy(c, "byte-bound", true);
  expect(
    Buffer.byteLength(JSON.stringify(c.state.candidates)),
  ).toBeLessThanOrEqual(256 * 1024);
  expect(Object.keys(c.state.candidates).length).toBeLessThan(50);
  expect(c.state.candidates[required(ids[51])]).toBeDefined();
  expect(c.state.candidates[required(ids[1])]).toBeUndefined();
  expect(c.state.reflection.requests).toHaveLength(52);
});
