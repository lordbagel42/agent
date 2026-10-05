import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { createDebugDispatcher } from "./debug-dispatch.js";
import { createJuneRegistry } from "./registry.js";
import {
  type DebugSnapshot,
  publishDebugSnapshot,
} from "./session-controls.js";

it("retains one private immutable request across interrupted observers and reads late receipts without relaunching", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "june-debug-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const snapshot: DebugSnapshot = {
    id: randomUUID(),
    sessionId: "session",
    capturedAt: new Date().toISOString(),
    revision: "a".repeat(40),
    scope: ["private"],
    reason: "wrong answer",
    data: "private 🌻 evidence".repeat(70_000),
    exclusions: [],
  };
  const dispatcher = createDebugDispatcher({ directory, timeoutMs: 5000 });
  const stopped = new AbortController();
  const onThread = vi.fn(async () => {});
  const run = dispatcher
    .run(snapshot, stopped.signal, onThread)
    .catch(() => "interrupted");
  await expect
    .poll(() => dispatcher.inspect?.(snapshot.id))
    .toEqual({ status: "queued" });
  const request = join(directory, `${snapshot.id}.json`);
  expect((await stat(request)).mode & 0o777).toBe(0o600);
  stopped.abort();
  expect(await run).toBe("interrupted");
  expect(JSON.parse(await readFile(request, "utf8"))).toEqual(snapshot);
  await expect(
    dispatcher.run(
      { ...snapshot, reason: "changed" },
      new AbortController().signal,
      onThread,
    ),
  ).rejects.toThrow("conflict");
  const threadId = `T-${randomUUID()}`;
  await writeFile(
    join(directory, `${snapshot.id}.receipt.json`),
    JSON.stringify({ id: snapshot.id, status: "completed", threadId }),
    { mode: 0o600 },
  );
  const resumed = createDebugDispatcher({ directory, timeoutMs: 5000 });
  expect(
    await resumed.run(snapshot, new AbortController().signal, onThread),
  ).toMatchObject({ threadId });
  expect(onThread).toHaveBeenCalledExactlyOnceWith(threadId);
  expect((await readdir(directory)).sort()).toEqual([
    `${snapshot.id}.json`,
    `${snapshot.id}.receipt.json`,
  ]);
  expect(await resumed.inspect?.(randomUUID())).toBeUndefined();
});

it("exposes late independent receipts through actor inspection after observation timed out", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "june-debug-actor-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const dispatcher = createDebugDispatcher({ directory, timeoutMs: 20 });
  const run = vi.fn(dispatcher.run);
  const { client } = await setupTest(
    t,
    createJuneRegistry({
      owner: { id: "owner", identities: [] },
      channels: {},
      model: {
        async reply() {
          return { text: "unused" };
        },
      },
      debugShare: { ...dispatcher, run },
    }),
  );
  const snapshot: DebugSnapshot = {
    id: randomUUID(),
    sessionId: "session",
    capturedAt: new Date().toISOString(),
    revision: "a".repeat(40),
    scope: ["private"],
    reason: "fixture",
    data: {},
    exclusions: [],
  };
  const actor = client.debugShare.getOrCreate([snapshot.id]);
  await publishDebugSnapshot(snapshot, (chunk) => actor.startChunk(chunk));
  await expect.poll(() => run.mock.settledResults[0]?.type).toBe("rejected");
  expect((await actor.inspect()).status).toBe("queued");
  await writeFile(
    join(directory, `${snapshot.id}.receipt.json`),
    JSON.stringify({
      id: snapshot.id,
      status: "queued",
      retryAt: Date.now() + 30_000,
    }),
    { mode: 0o600 },
  );
  expect((await actor.inspect()).status).toBe("queued");
  const threadId = `T-${randomUUID()}`;
  await writeFile(
    join(directory, `${snapshot.id}.receipt.json`),
    JSON.stringify({ id: snapshot.id, status: "completed", threadId }),
    { mode: 0o600 },
  );
  await publishDebugSnapshot(snapshot, (chunk) => actor.startChunk(chunk));
  expect(await actor.inspect()).toMatchObject({
    status: "completed",
    threadId,
  });
  expect(run).toHaveBeenCalledTimes(1);
});
