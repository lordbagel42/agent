import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { expect, it } from "vitest";
import { freeEnginePort, stopTestEngine } from "../../tests/rivet.js";
import { createReflectionActor } from "./reflection.js";

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
  const registry = setup({
    use: {
      reflection: createReflectionActor({
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
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return {
            answer: "yes",
            rationale: "Fixture",
            evidenceIds: input.evidence.map((e) => e.id),
          };
        },
      }),
    },
    startEngine: true,
    startServices: false,
    enginePort: port,
    engineHost: "127.0.0.1",
    namespace: "default",
    token: "default",
    envoy: { poolName: "default" },
  });
  t.onTestFinished(async () => {
    release();
    await registry.shutdown();
    await stopTestEngine(directory, port);
    await rm(directory, { recursive: true, force: true });
    if (previousStorage === undefined) delete process.env.RIVETKIT_STORAGE_PATH;
    else process.env.RIVETKIT_STORAGE_PATH = previousStorage;
  });
  const { client } = await setupTest(t, registry);
  const handle = client.reflection.getOrCreate(["owner"]);
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
  release();
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
  await handle.enqueue({ ...input, evidenceIds: ["read-after-delete"] });
  await expect.poll(() => calls).toBe(3);
  release();
  await expect
    .poll(async () => (await handle.status()).candidateIds.length)
    .toBe(1);
  const candidateId = (await handle.status()).candidateIds[0];
  if (!candidateId) throw new Error("Missing fixture candidate");
  expect(await handle.candidate(candidateId)).toMatchObject({
    decision: { answer: "yes" },
  });
  deleted = true;
  expect(await handle.candidate(candidateId)).toBeNull();

  deleted = false;
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
  expect(
    (await handle.status()).reflection.requests.find((r) => r.id === blocked.id)
      ?.status,
  ).toBe("running");
  release();
  await expect
    .poll(
      async () =>
        (await handle.status()).reflection.requests.find(
          (r) => r.id === blocked.id,
        )?.status,
    )
    .toBe("stopped");
  expect(await handle.status()).toMatchObject({
    liveActive: 0,
    epoch: epoch + 3,
    activeTurnIds: [],
    candidateIds: [],
  });
});
