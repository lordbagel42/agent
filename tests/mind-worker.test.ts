import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { MessageEvent, Owner } from "../src/core/contracts.js";
import { Mind } from "../src/mind/service.js";
import { executionKey } from "../src/runtime/execution.js";
import type { ExecutionContext } from "../src/runtime/execution-context.js";
import { createLifecycle } from "../src/runtime/lifecycle.js";
import { createJuneRegistry } from "../src/runtime/registry.js";
import { setupTest } from "./rivet.js";

it("returns Mind status without legacy memory while rejecting untracked evidence", async (t) => {
  const owner: Owner = {
    id: "raygen",
    identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
  };
  const directory = await mkdtemp(join(tmpdir(), "june-mind-worker-"));
  const mind = new Mind(
    { directory, reflectIdleMs: 600_000, timezone: "UTC", dreamHour: 3 },
    owner,
    {
      reply: async () => {
        throw new Error("Unexpected background inference");
      },
    },
    () => true,
  );
  await mind.start();
  t.onTestFinished(async () => {
    await mind.close();
    await rm(directory, { recursive: true, force: true });
  });
  const lifecycle = createLifecycle();
  const registry = createJuneRegistry({
    owner,
    mind,
    lifecycle,
    channels: {},
    model: { reply: async () => ({ text: "" }) },
    execution: {
      model: {
        async reply(request) {
          const observation = request.messages.find((message) =>
            message.content.includes("Mind observation ("),
          );
          return observation
            ? {
                text:
                  observation.content
                    .slice(observation.content.indexOf("{"))
                    .split("\n")[0]
                    ?.trim() ?? "",
              }
            : {
                text: "",
                mind: { action: "status" as const, path: "", query: "" },
              };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const scope = ["private", owner.id];
  const context: ExecutionContext = {
    version: 1,
    scopeKey: scope,
    audience: JSON.stringify(scope),
    conversationKey: scope,
    originEventId: "a".repeat(64),
    deletionRevision: 0,
    sourceIds: [],
    contextSourceIds: [],
    personality: createHash("sha256").update("{}").digest("hex"),
    capabilities: { mindAvailable: true },
  };
  const source: MessageEvent = {
    id: "status",
    messageId: "status",
    type: "message",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    senderId: "U1",
    direct: true,
    metadata: { channelType: "im" },
    text: "Check your Mind status",
  };
  const worker = client.execution.getOrCreate(executionKey(scope, "mind"));
  const input = {
    id: `${context.originEventId}:mind`,
    context,
    source,
    task: source.text,
    workspaces: [],
    web: false,
    evidenceIds: [] as string[],
    deletionTracked: true as const,
  };
  expect(await worker.submit(input)).toBe(true);
  await expect
    .poll(async () => (await worker.summary()).status, { timeout: 15_000 })
    .toBe("completed");
  await expect.poll(() => lifecycle.active, { timeout: 15_000 }).toBe(0);
  expect(
    JSON.parse((await worker.result(input.id))?.report ?? "null"),
  ).toMatchObject({
    blocked: null,
    remote: null,
    selfImprovement: false,
    commits: 2,
  });

  const untracked = client.execution.getOrCreate(
    executionKey(scope, "untracked"),
  );
  await untracked.submit({
    ...input,
    id: `${"b".repeat(64)}:untracked`,
    evidenceIds: ["missing-retained-evidence"],
  });
  expect((await untracked.summary()).status).toBe("revoked");
  expect((await untracked.summary()).report).toBe("");
  await expect.poll(() => lifecycle.active, { timeout: 15_000 }).toBe(0);
});
