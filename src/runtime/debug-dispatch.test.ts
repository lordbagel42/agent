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
import type { MessageEvent } from "../core/contracts.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import type { CapabilityContext } from "./capabilities.js";
import { createDebugDispatcher } from "./debug-dispatch.js";
import { runExecutionCapability } from "./execution-capabilities.js";
import {
  currentExecutionCapabilities,
  executionCapabilities,
} from "./execution-context.js";
import { createJuneRegistry, type Dependencies } from "./registry.js";
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
    JSON.stringify({
      id: snapshot.id,
      status: "completed",
      threadId,
      resolved: true,
    }),
    { mode: 0o600 },
  );
  const resumed = createDebugDispatcher({ directory, timeoutMs: 5000 });
  expect(
    await resumed.run(snapshot, new AbortController().signal, onThread),
  ).toMatchObject({ threadId, resolved: true });
  expect(onThread).toHaveBeenCalledExactlyOnceWith(threadId);
  expect((await readdir(directory)).sort()).toEqual([
    `${snapshot.id}.json`,
    `${snapshot.id}.receipt.json`,
  ]);
  expect(await resumed.inspect?.(randomUUID())).toBeUndefined();
});

it("records a late resolution idempotently without changing or relaunching the completed request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "june-debug-resolution-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const id = randomUUID();
  const dispatcher = createDebugDispatcher({ directory, timeoutMs: 20 });
  const request = JSON.stringify({ id, snapshotOnly: false });
  const receipt = JSON.stringify({
    id,
    status: "completed",
    threadId: `T-${randomUUID()}`,
  });
  await writeFile(join(directory, `${id}.json`), request, { mode: 0o600 });
  await writeFile(join(directory, `${id}.receipt.json`), receipt, {
    mode: 0o600,
  });
  expect(await dispatcher.inspect?.(id)).not.toHaveProperty("resolved");
  expect(await dispatcher.resolve?.(id)).toBe(true);
  expect(await dispatcher.resolve?.(id)).toBe(true);
  // A later transport receipt must not erase the independent resolution.
  await writeFile(
    join(directory, `${id}.receipt.json`),
    JSON.stringify({ id, status: "unknown" }),
  );
  const restarted = createDebugDispatcher({ directory, timeoutMs: 20 });
  expect(await restarted.inspect?.(id)).toMatchObject({
    status: "unknown",
    resolved: true,
  });
  expect(await readFile(join(directory, `${id}.json`), "utf8")).toBe(request);
  expect(
    (await stat(join(directory, `${id}.resolution.json`))).mode & 0o777,
  ).toBe(0o600);
  expect(await restarted.resolve?.(randomUUID())).toBe(false);
  const taskId = randomUUID();
  await writeFile(
    join(directory, `${taskId}.task.json`),
    JSON.stringify({ id: taskId }),
  );
  expect(await restarted.resolve?.(taskId)).toBe(false);
  await expect(restarted.resolve?.("../invalid")).rejects.toThrow();
  await expect(restarted.resolve?.(id, () => false)).rejects.toThrow();
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
    JSON.stringify({
      id: snapshot.id,
      status: "completed",
      threadId,
      resolved: true,
    }),
    { mode: 0o600 },
  );
  await publishDebugSnapshot(snapshot, (chunk) => actor.startChunk(chunk));
  expect(await actor.inspect()).toMatchObject({
    status: "completed",
    threadId,
    resolved: true,
  });
  expect(run).toHaveBeenCalledTimes(1);
});

it("grants resolution only as an exclusive owner-private execution action and runs it through June", async (t) => {
  const id = randomUUID();
  const directive = {
    text: "",
    debugShareResolve: { id, confirmedResolved: true as const },
  };
  const granted = {
    agentRole: "execution" as const,
    debugShareResolveAvailable: true,
  };
  expect(replyJsonSchema([], granted).properties).toHaveProperty(
    "debugShareResolve",
  );
  expect(parseReply(JSON.stringify(directive), [], granted)).toEqual(directive);
  for (const capabilities of [
    {},
    { ...granted, debugShareResolveAvailable: false },
    { ...granted, agentRole: "interaction" as const },
    { ...granted, agentRole: "repository" as const },
  ]) {
    expect(replyJsonSchema([], capabilities).properties).not.toHaveProperty(
      "debugShareResolve",
    );
    expect(() =>
      parseReply(JSON.stringify(directive), [], capabilities),
    ).toThrow();
  }
  for (const extra of [
    { text: "Resolved" },
    { javascript: "return 1" },
    { debugShareResolve: { id, confirmedResolved: false } },
  ]) {
    expect(() =>
      parseReply(JSON.stringify({ ...directive, ...extra }), [], {
        ...granted,
        javascriptAvailable: true,
      }),
    ).toThrow();
  }
  const resolve = vi.fn(async () => true);
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const deps: Dependencies = {
    owner,
    channels: {},
    debugShare: {
      resolve,
      run: async () => {
        throw new Error("Must not investigate");
      },
    },
    model: {
      reply: async (request) =>
        request.executionAvailable
          ? {
              text: "",
              execution: [
                {
                  agent: "resolution",
                  action: "run",
                  task: "Record the verified resolution",
                },
              ],
            }
          : { text: "Resolution recorded." },
    },
    execution: {
      model: {
        reply: async (request) =>
          request.debugShareResolveAvailable
            ? directive
            : { text: "Resolution recorded." },
      },
    },
  };
  const event: MessageEvent = {
    id: "resolve",
    type: "message",
    messageId: "1",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    senderId: "U1",
    direct: true,
    metadata: { channelType: "im" },
    text: `The repair is verified; record DEBUGSHARE ${id} as resolved`,
  };
  expect(executionCapabilities(deps, event).debugShareResolveAvailable).toBe(
    true,
  );
  expect(
    currentExecutionCapabilities(deps, event, {}).debugShareResolveAvailable,
  ).toBe(false);
  const { client } = await setupTest(t, createJuneRegistry(deps));
  const context: CapabilityContext = {
    event,
    eventId: event.id,
    scope: { key: ["private", "owner"], private: true },
    audience: "owner",
    origin: "event",
    phase: "reply",
    ownerTurn: true,
    deletionRevision: 0,
    personalityVersion: undefined,
    workspaces: [],
    signal: new AbortController().signal,
    valid: () => true,
    model: deps.model,
    deps,
    ports: {} as CapabilityContext["ports"],
  };
  for (const change of [
    { event: { ...event, senderId: "guest" } },
    {
      event: {
        ...event,
        direct: false,
        metadata: { channelType: "mpim" as const },
      },
    },
    {
      event: {
        ...event,
        direct: false,
        metadata: { channelType: "channel" as const },
      },
    },
    { origin: "wakeup" as const },
    { origin: "execution_result" as const },
    { phase: "synthesis" as const },
    { ownerTurn: false },
    { valid: () => false },
    { signal: AbortSignal.abort() },
    { canStartAction: () => false },
  ]) {
    await expect(
      runExecutionCapability(
        directive,
        { ...granted, system: "", messages: [], workspaces: [] },
        { ...context, ...change },
        deps,
        client as Parameters<typeof runExecutionCapability>[4],
        [],
        async () => {
          throw new Error("Unexpected delivery");
        },
      ),
    ).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
  }
  await client.conversation
    .getOrCreate(["private", owner.id])
    .send("inbox", { type: "event", event });
  await expect
    .poll(() => resolve.mock.calls, { timeout: 15000 })
    .toEqual([[id, expect.any(Function)]]);
});
