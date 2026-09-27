import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { expect, it, vi } from "vitest";
import { freeEnginePort, stopTestEngine } from "../../tests/rivet.js";
import { createLifecycle, type Lifecycle } from "./lifecycle.js";
import {
  createReflectionActor,
  type ReflectionRuntimeState,
} from "./reflection.js";

it("rechecks audience/deletion and holds deduplicated work across cancellation and overlapping live turns", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "june-reflection-"));
  const previousStorage = process.env.RIVETKIT_STORAGE_PATH;
  process.env.RIVETKIT_STORAGE_PATH = directory;
  const port = await freeEnginePort();
  let authorized = true;
  let deleted = false;
  let calls = 0;
  let release = () => {};
  let providerSignal: AbortSignal | undefined;
  let beforeSave: (() => Promise<void>) | undefined;
  let releaseSave = () => {};
  let beforeRetrieve: (() => Promise<void>) | undefined;
  let releaseRetrieve = () => {};
  const lifecycle: Lifecycle = createLifecycle(async () => handle.isSettled());
  const enter = vi.spyOn(lifecycle, "enter");
  const registry = setup({
    use: {
      reflection: createReflectionActor(
        {
          ownerId: "owner",
          policy: {
            totalCapacity: 2,
            liveReserve: 1,
            cooldownMs: 1,
            maxAttempts: 1,
            maxNoNewEvidence: 1,
            evidenceMaxAgeMs: 60000,
            quiet: { timeZone: "UTC", startMinute: 0, endMinute: 0 },
          },
          idleMs: 100,
          deepMs: 200,
          pollMs: 20,
          timeoutMs: 10000,
          async retrieve({ scope, evidenceIds }) {
            await beforeRetrieve?.();
            return {
              authorized,
              evidence: evidenceIds.map((id) => ({
                id,
                scope: id === "wrong-scope" ? "private" : scope,
                text: "Private fixture",
                source: "episode" as const,
                observedAt: Date.now(),
                expiresAt: Date.now() + 60000,
                invalidated: deleted,
              })),
            };
          },
          async decide(input, signal) {
            calls++;
            providerSignal = signal;
            if (input.simulateResponses) expect(input.question).toBe("novelty");
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return {
              answer: "yes",
              rationale: "Fixture",
              evidenceIds: input.evidence.map((e) => e.id),
              ...(input.simulateResponses
                ? {
                    alternativeResponses: [
                      "Hypothetical: ask one clarifying question.",
                    ],
                  }
                : {}),
            };
          },
        },
        lifecycle,
      ),
    },
    startEngine: true,
    startServices: false,
    enginePort: port,
    engineHost: "127.0.0.1",
    namespace: "default",
    token: "default",
    envoy: { poolName: "default" },
  });
  const actorConfig = registry.config.use.reflection.config;
  if (
    !("createVars" in actorConfig) ||
    !actorConfig.createVars ||
    !("state" in actorConfig) ||
    !actorConfig.actions
  )
    throw new Error("Expected reflection actor configuration");
  const createVars = actorConfig.createVars;
  actorConfig.createVars = async (c, input) => {
    const vars = await createVars(c, input);
    return {
      ...vars,
      persist: async () => {
        await beforeSave?.();
        await vars.persist();
      },
    };
  };
  t.onTestFinished(async () => {
    beforeSave = undefined;
    releaseSave();
    beforeRetrieve = undefined;
    releaseRetrieve();
    lifecycle.resume();
    release();
    await registry.shutdown();
    await stopTestEngine(directory, port);
    await rm(directory, { recursive: true, force: true });
    if (previousStorage === undefined) delete process.env.RIVETKIT_STORAGE_PATH;
    else process.env.RIVETKIT_STORAGE_PATH = previousStorage;
  });
  const { client } = await setupTest(t, registry);
  const handle = client.reflection.getOrCreate(["owner"]);
  // Durable markers must independently block drain, even with no local worker
  // or running request left in memory. The check must never reconcile them.
  const settled = actorConfig.actions.isSettled;
  const context = {
    state: structuredClone(actorConfig.state),
    vars: { active: new Map<string, AbortController>(), async persist() {} },
  } as Parameters<typeof settled>[0];
  for (const phase of ["started", "uncertain"] as const) {
    context.state.invocations.old = phase;
    expect(settled(context)).toBe(false);
    expect(context.state.invocations.old).toBe(phase);
  }
  context.state.invocations.old = "settled";
  expect(settled(context)).toBe(true);
  const input = {
    scope: "public",
    kind: "reflection" as const,
    mode: "idle" as const,
  };
  const wrong = await handle.enqueue({
    ...input,
    evidenceIds: ["wrong-scope"],
  });
  await expect
    .poll(
      async () =>
        (await handle.status()).reflection.requests.find(
          (r) => r.id === wrong.id,
        )?.status,
    )
    .toBe("cancelled");
  expect(calls).toBe(0);
  await handle.trigger({ id: "live", type: "interaction", liveActive: 1 });
  const denied = await handle.enqueue({ ...input, evidenceIds: ["denied"] });
  authorized = false;
  await handle.trigger({ id: "idle", type: "idle", liveActive: 0 });
  await expect
    .poll(
      async () =>
        (await handle.status()).reflection.requests.find(
          (r) => r.id === denied.id,
        )?.status,
    )
    .toBe("cancelled");
  expect(calls).toBe(0);
  authorized = true;
  const late = await handle.enqueue({ ...input, evidenceIds: ["late-delete"] });
  await expect.poll(() => calls).toBe(1);
  expect(
    (await handle.enqueue({ ...input, evidenceIds: ["late-delete"] })).accepted,
  ).toBe(false);
  deleted = true;
  release();
  await expect
    .poll(
      async () =>
        (await handle.status()).reflection.requests.find(
          (r) => r.id === late.id,
        )?.status,
    )
    .toBe("stopped");
  expect((await handle.status()).candidateIds).toEqual([]);
  expect(
    (await handle.status()).decisionOutcomes?.[JSON.stringify([late.id, 1])],
  ).toBeUndefined();
  deleted = false;
  const cancelled = await handle.enqueue({
    ...input,
    mode: "deep",
    evidenceIds: ["cancel"],
  });
  await expect.poll(() => calls).toBe(2);
  await handle.cancel(cancelled.id);
  expect(
    (await handle.status()).reflection.requests.find(
      (r) => r.id === cancelled.id,
    )?.status,
  ).toBe("cancelling");
  expect(providerSignal?.aborted).toBe(true);
  expect(await handle.isSettled()).toBe(false);
  context.state.reflection = (await handle.status()).reflection;
  const heldRequest = context.state.reflection.requests.find(
    (r) => r.id === cancelled.id,
  );
  if (!heldRequest) throw new Error("Missing held request");
  for (const status of ["running", "cancelling"] as const) {
    heldRequest.status = status;
    expect(settled(context)).toBe(false);
    expect(heldRequest.status).toBe(status);
  }
  expect(lifecycle.active).toBe(1);
  expect(await lifecycle.drain(20)).toBe(false);
  expect(lifecycle.active).toBe(1);
  expect(lifecycle.ready).toBe(true);
  const saveStarted = Promise.withResolvers<void>();
  const saveFinished = Promise.withResolvers<void>();
  releaseSave = saveFinished.resolve;
  beforeSave = async () => {
    beforeSave = undefined;
    saveStarted.resolve();
    await saveFinished.promise;
  };
  let drained = false;
  const draining = lifecycle.drain().then((result) => {
    drained = result;
    return result;
  });
  release();
  await saveStarted.promise;
  // The raw provider has returned but its settlement is not durable yet.
  expect(lifecycle.active).toBe(1);
  expect(drained).toBe(false);
  const admittedBefore = enter.mock.calls.length;
  releaseSave();
  expect(await draining).toBe(true);
  expect(lifecycle.active).toBe(0);
  expect(lifecycle.ready).toBe(false);
  await expect
    .poll(
      async () =>
        (await handle.status()).reflection.requests.find(
          (r) => r.id === cancelled.id,
        )?.status,
    )
    .toBe("cancelled");
  expect((await handle.status()).candidateIds).toEqual([]);
  expect(calls).toBe(2);
  const queued = await handle.enqueue({
    ...input,
    kind: "curiosity",
    mode: "deep",
    evidenceIds: ["read-after-delete"],
  });
  await expect
    .poll(() => enter.mock.calls.length)
    .toBeGreaterThan(admittedBefore);
  expect(calls).toBe(2);
  expect(
    (await handle.status()).reflection.requests.find((r) => r.id === queued.id)
      ?.status,
  ).toBe("pending");
  lifecycle.resume();
  await expect.poll(() => calls).toBe(3);
  release();
  await expect
    .poll(async () => (await handle.status()).candidateIds.length, {
      timeout: 5000,
    })
    .toBe(1);
  const candidateId = (await handle.status()).candidateIds[0];
  if (!candidateId) throw new Error("Missing fixture candidate");
  expect(await handle.candidate(candidateId)).toMatchObject({
    mode: "deep",
    kind: "proposal",
    hypothesisOnly: true,
    decision: {
      answer: "yes",
      evidenceIds: ["read-after-delete"],
      alternativeResponses: ["Hypothetical: ask one clarifying question."],
    },
  });
  const simulationStatus = await handle.status();
  expect(
    simulationStatus.reflection.scopes.find((s) => s.scope === input.scope)
      ?.noNewEvidence,
  ).toBe(1);
  expect(JSON.stringify(simulationStatus)).not.toContain("Hypothetical: ask");
  expect(simulationStatus.decisionOutcomes).toMatchObject({
    [JSON.stringify([queued.id, 1])]: "yes",
  });
  // Switching kinds cannot spend a second attempt over the same evidence set.
  expect(
    (await handle.enqueue({ ...input, evidenceIds: ["read-after-delete"] }))
      .accepted,
  ).toBe(false);
  deleted = true;
  expect(await handle.candidate(candidateId)).toBeNull();
  deleted = false;
  for (const invalidate of [false, true]) {
    const retrievalStarted = Promise.withResolvers<void>();
    const retrievalFinished = Promise.withResolvers<void>();
    releaseRetrieve = retrievalFinished.resolve;
    beforeRetrieve = async () => {
      beforeRetrieve = undefined;
      retrievalStarted.resolve();
      await retrievalFinished.promise;
    };
    const reading = handle.candidate(candidateId);
    await retrievalStarted.promise;
    if (invalidate) await handle.cancel(queued.id);
    else
      expect(
        (await handle.enqueue({ ...input, evidenceIds: ["read-after-delete"] }))
          .accepted,
      ).toBe(false);
    releaseRetrieve();
    // Unrelated root replacement preserves the invocation; cancellation does not.
    if (invalidate) expect(await reading).toBeNull();
    else expect(await reading).toMatchObject({ decision: { answer: "yes" } });
  }

  const epoch = (await handle.status()).epoch;
  await Promise.all([
    handle.occupancy("turn-a", true),
    handle.occupancy("turn-b", true),
    handle.occupancy("turn-a", true),
  ]);
  const overlapping = await handle.status();
  expect(overlapping).toMatchObject({
    liveActive: 2,
    epoch: epoch + 2,
    candidateIds: [],
  });
  expect(overlapping.activeTurnIds.sort()).toEqual(["turn-a", "turn-b"]);
  expect(await handle.isSettled()).toBe(false);
  expect(await lifecycle.drain()).toBe(false);
  expect((await handle.status()).activeTurnIds.sort()).toEqual([
    "turn-a",
    "turn-b",
  ]);
  await handle.trigger({ id: "legacy-hold", type: "idle", liveActive: 1 });
  expect((await handle.status()).liveActive).toBe(3);
  await handle.occupancy("finished-before-start", false);
  await handle.occupancy("finished-before-start", true);
  await Promise.all([
    handle.occupancy("turn-a", false),
    handle.occupancy("turn-a", false),
  ]);
  await handle.occupancy("turn-a", true);
  expect(await handle.status()).toMatchObject({
    liveActive: 2,
    epoch: epoch + 2,
    activeTurnIds: ["turn-b"],
  });
  await handle.trigger({ id: "legacy-release", type: "idle", liveActive: 0 });
  expect((await handle.status()).liveActive).toBe(1);
  const blocked = await handle.enqueue({
    ...input,
    mode: "interaction",
    evidenceIds: ["occupancy-blocked"],
  });
  await setTimeout(100);
  expect(calls).toBe(3);
  await handle.occupancy("turn-b", false);
  await expect.poll(() => calls).toBe(4);
  await handle.occupancy("turn-c", true);
  expect(providerSignal?.aborted).toBe(true);
  await handle.occupancy("turn-c", false);
  const invocation = JSON.stringify([blocked.id, 1]);
  const held = await handle.status();
  expect(
    held.reflection.requests.find((r) => r.id === blocked.id),
  ).toMatchObject({ status: "running", attempts: 1 });
  expect(held.invocations[invocation]).toBe("started");
  release();
  // The real-engine flush and status RPC share this deadline with settlement;
  // the default 1s poll limit is not a provider-settlement contract.
  await expect
    .poll(
      async () => {
        const status = await handle.status();
        return {
          request: status.reflection.requests.find((r) => r.id === blocked.id),
          invocation: status.invocations[invocation],
        };
      },
      { timeout: 5000 },
    )
    .toMatchObject({
      request: { status: "stopped", attempts: 1 },
      invocation: "settled",
    });
  expect(await handle.status()).toMatchObject({
    liveActive: 0,
    epoch: epoch + 3,
    activeTurnIds: [],
    candidateIds: [],
  });
  expect(
    (await handle.enqueue({ ...input, evidenceIds: ["occupancy-blocked"] }))
      .accepted,
  ).toBe(false);
  expect(calls).toBe(4);
  expect(
    (await handle.status()).decisionOutcomes?.[invocation],
  ).toBeUndefined();

  // Settlement must allow sustained fresh work, not just one more provider call.
  // Nested state-proxy layers previously stalled persistence/status by this point.
  for (let index = 0; index < 4; index++) {
    const freshInput = { ...input, evidenceIds: [`after-preemption-${index}`] };
    const fresh = await handle.enqueue(freshInput);
    expect(fresh.accepted).toBe(true);
    await expect.poll(() => calls).toBe(5 + index);
    release();
    await expect
      .poll(async () => {
        const status = await handle.status();
        return {
          request: status.reflection.requests.find((r) => r.id === fresh.id)
            ?.status,
          invocation: status.invocations[JSON.stringify([fresh.id, 1])],
        };
      })
      .toEqual({ request: "stopped", invocation: "settled" });
    expect((await handle.enqueue(freshInput)).accepted).toBe(false);
  }
  expect(calls).toBe(8);
});

it("bounds private curiosity provenance and withholds revoked inputs and hypotheses", async () => {
  const scope = JSON.stringify(["private", "owner"]);
  let authorized = true;
  let invalidated = false;
  const reads: string[] = [];
  const definition = createReflectionActor({
    ownerId: "owner",
    policy: {
      totalCapacity: 2,
      liveReserve: 1,
      cooldownMs: 1,
      maxAttempts: 1,
      maxNoNewEvidence: 1,
      evidenceMaxAgeMs: 60000,
      quiet: { timeZone: "UTC", startMinute: 0, endMinute: 0 },
    },
    idleMs: 1,
    deepMs: 1,
    pollMs: 1000,
    timeoutMs: 1000,
    async retrieve(input) {
      reads.push(input.scope);
      return {
        authorized,
        evidence: input.evidenceIds.map((id, index) => ({
          id,
          scope: input.scope,
          text: "SECRET SOURCE TEXT",
          source: index === 0 ? ("episode" as const) : ("dream" as const),
          observedAt: Date.now(),
          expiresAt: Date.now() + 60000,
          invalidated,
        })),
      };
    },
    async decide() {
      throw new Error("Inspection must not call the provider");
    },
  });
  const inspect = definition.config.actions?.curiosityProgress;
  if (!inspect) throw new Error("Missing curiosity inspection action");
  const state: ReflectionRuntimeState = {
    reflection: { version: 1, requests: [], scopes: [] },
    modes: {},
    invocations: {},
    candidates: {},
    liveActive: 0,
    lastInteractionAt: 0,
    epoch: 0,
    interruptionEpoch: -1,
    triggerIds: [],
  };
  state.reflection.requests = Array.from({ length: 13 }, (_, index) => ({
    id: `SECRET REQUEST ${index}`,
    scope: index === 12 ? "SECRET OTHER SCOPE" : scope,
    evidenceIds: ["SECRET EPISODE", "SECRET DREAM 1", "SECRET DREAM 2"],
    kind: "curiosity",
    createdAt: index,
    attempts: index < 10 ? 1 : 0,
    status: index < 10 ? "stopped" : "pending",
  }));
  state.invocations = Object.fromEntries(
    state.reflection.requests
      .slice(0, 10)
      .map((request, index) => [
        JSON.stringify([request.id, 1]),
        index === 9 ? "uncertain" : "settled",
      ]),
  );
  state.decisionOutcomes = {
    [JSON.stringify(["SECRET REQUEST 7", 1])]: "no",
  };
  const context = { key: ["owner"], state } as Parameters<typeof inspect>[0];
  const result = await inspect(context, scope);
  expect(result.truncated).toBe(true);
  expect(result.rows).toHaveLength(10);
  expect(reads).toEqual(Array(10).fill(scope));
  expect(result.rows.map((row) => row.progress)).toEqual([
    "pending",
    "pending",
    "unknown",
    "settled",
    "settled",
    "settled",
    "settled",
    "settled",
    "settled",
    "settled",
  ]);
  expect(result.rows[0]?.currentInputs).toEqual({
    episodes: 1,
    ownerCorrections: 0,
    dreamHypotheses: 2,
  });
  expect(result.rows[3]?.recordedOutcome).toBe("not-recorded");
  expect(result.rows[4]?.recordedOutcome).toBe("no");
  expect(result.rows.every((row) => /^[a-f0-9]{64}$/.test(row.reference))).toBe(
    true,
  );
  expect(JSON.stringify(result)).not.toContain("SECRET");
  const snapshot = structuredClone(state);
  for (const revoke of [
    () => {
      invalidated = true;
    },
    () => {
      invalidated = false;
      authorized = false;
    },
  ]) {
    revoke();
    const redacted = await inspect(context, scope);
    expect(
      redacted.rows.every(
        (row) =>
          row.currentInputs === null && row.recordedOutcome === "withheld",
      ),
    ).toBe(true);
  }
  expect(state).toEqual(snapshot);
  const count = reads.length;
  await expect(inspect(context, "public")).rejects.toThrow(
    "Wrong reflection audience",
  );
  await expect(inspect({ ...context, key: ["other"] }, scope)).rejects.toThrow(
    "Wrong reflection audience",
  );
  expect(reads).toHaveLength(count);
});
