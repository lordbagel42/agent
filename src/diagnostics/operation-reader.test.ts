import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { parseConfig } from "../config.js";
import type { CompanionReply } from "../core/contracts.js";
import { parseReply } from "../models/provider.js";
import { executionKey } from "../runtime/execution.js";
import { createInspectionReader } from "../runtime/inspection.js";
import { createJuneRegistry } from "../runtime/registry.js";
import {
  createOperationReader,
  operationInspectionPage,
} from "./operation-reader.js";
import { type OperationIndex, operationEventSchema } from "./operations.js";

afterEach(() => vi.unstubAllGlobals());
const token = "private-reader-credential".padEnd(48, "x");
const event = {
  id: "event:1",
  operationId: "amp-task:17",
  source: "amp-task" as const,
  sequence: 0,
  observedAt: 1000,
  occurredAt: null,
  status: "unknown" as const,
  failure: true,
};
const summary = {
  latest: event,
  firstObservedAt: 1000,
  lastObservedAt: 1000,
  eventCount: 1,
  failure: event,
  failureKey: "amp-task:unknown:unknown",
  matchingFailures: 1,
};
const result: OperationIndex = {
  items: [summary],
  total: 1,
  nextOffset: null,
  controller: null,
};

it("reads a separate metadata-only endpoint and preserves private query pagination", async () => {
  const fetcher = vi.fn(async () => Response.json(result));
  vi.stubGlobal("fetch", fetcher);
  const read = createOperationReader({
    origin: "https://debug.example.test",
    token,
  });
  expect(
    await read({
      sources: ["amp-task", "coding"],
      failuresOnly: true,
      offset: 3,
      limit: 2,
    }),
  ).toEqual(result);
  const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
  expect(String(url)).toBe(
    "https://debug.example.test/api/operations-read?q=&offset=3&limit=2&sources=amp-task%2Ccoding&failuresOnly=true",
  );
  expect(options.redirect).toBe("error");
  expect(options.headers).toEqual({
    authorization: `Bearer ${token}`,
    accept: "application/json",
  });
  expect(options.signal).toBeDefined();
  fetcher.mockImplementation(async () =>
    Response.json({ ...result, privateBody: "DO NOT RETURN" }),
  );
  await expect(read({})).rejects.toThrow("Operations archive unavailable");
  fetcher.mockImplementation(async () => {
    throw new Error(`PRIVATE ${token}`);
  });
  await expect(read({})).rejects.toThrow(/^Operations archive unavailable$/);
});

it("returns complete logical pages even with dense related history and changing heartbeats", async (t) => {
  let reads = 0;
  const controller = {
    ...event,
    operationId: "controller:deployment",
    source: "controller" as const,
  };
  const operations = vi.fn(async (query: { operationId?: string }) => {
    reads++;
    if (query.operationId)
      return {
        operation: summary,
        events: [event],
        totalEvents: 1,
        nextOffset: null,
        related: Array(10).fill(summary),
      };
    return {
      ...result,
      controller: { ...controller, observedAt: 1000 + reads },
      items: result.items,
      total: 11,
      nextOffset: 1,
    };
  });
  const read = createInspectionReader({
    audience: "owner",
    selections: {},
    debugOperations: operations,
    debugSiteDeployment: async () =>
      'Independent debug-site health: {"ready":true,"revision":"fixture"}',
  });
  const first = await read({
    target: "debug-operations",
    sources: ["amp-task", "coding"],
    failuresOnly: true,
  });
  const page = JSON.parse(first.split("\n")[1] ?? "");
  expect(page.nextOffset).toBe(1);
  expect(page.items[0].latest.operationId).toBe("amp-task:17");
  expect(first.length).toBeLessThan(12000);
  expect(first).toContain("not proof of the same root cause");
  const detail = JSON.parse(
    (
      await read({ target: "debug-operations", operationId: "amp-task:17" })
    ).split("\n")[1] ?? "",
  );
  expect(detail.related).toBeUndefined();
  expect(detail.relatedQuery).toEqual({
    target: "debug-operations",
    failureKey: "amp-task:unknown:unknown",
    offset: 0,
  });
  expect(detail.events).toEqual([event]);
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const scope = ["private", owner.id];
  let turns = 0;
  const registry = createJuneRegistry({
    owner,
    channels: {},
    inspection: read,
    model: { reply: async () => ({ text: "" }) },
    execution: {
      model: {
        reply: async (request): Promise<CompanionReply> => {
          turns++;
          if (turns === 1)
            return {
              text: "",
              inspection: {
                target: "debug-operations",
                operationId: "amp-task:17",
              },
            };
          const observation = request.messages.at(-1)?.content ?? "";
          expect(observation).not.toContain('"nextTextOffset":');
          if (turns === 2) {
            expect(observation).toContain('"nextOffset":');
            return { text: "", inspection: detail.relatedQuery };
          }
          if (turns === 3) {
            expect(observation).toContain('"total":11');
            return { text: "", inspection: "debug-site-deployment" };
          }
          expect(observation).toContain('"ready":true');
          return {
            text: "Eleven retained matches, not a confirmed common cause.",
          };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const worker = client.execution.getOrCreate(
    executionKey(scope, "operations"),
  );
  const accepted = await worker.submit({
    id: `${"a".repeat(64)}:operations`,
    task: "Inspect retained failures",
    source: {
      id: "source",
      type: "message",
      messageId: "1.000001",
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      senderId: "U1",
      direct: true,
      text: "Inspect retained failures",
    },
    context: {
      version: 1,
      scopeKey: scope,
      audience: JSON.stringify(scope),
      conversationKey: scope,
      originEventId: "source",
      deletionRevision: 0,
      sourceIds: [],
      contextSourceIds: [],
      personality: createHash("sha256").update("{}").digest("hex"),
      capabilities: { inspectionAvailable: true },
    },
    web: false,
    workspaces: [],
    evidenceIds: [],
    deletionTracked: true,
  });
  expect(accepted).toBe(true);
  await expect
    .poll(async () => (await worker.summary()).status, { timeout: 15000 })
    .toBe("completed");
  expect((await worker.summary()).report).toContain("Eleven retained matches");
  expect(turns).toBe(4);
  // Completion precedes the host-owned notification; let it settle before shutdown.
  const june = client.conversation.getOrCreate(scope);
  await expect
    .poll(
      async () =>
        Object.values((await june.snapshot()).events).some(
          (record) => record.event.id === "source" && record.done,
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  expect(
    await createInspectionReader({ audience: "owner", selections: {} })(
      "debug-operations",
    ),
  ).toContain("unavailable");
});

it("paginates maximal controller events without splitting records or skipping truncated rows", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const thread = "T-12345678-1234-4234-8234-123456789abc";
  const dense = operationEventSchema.parse({
    ...event,
    id: "a".repeat(200),
    operationId: `controller:${"b".repeat(189)}`,
    source: "controller",
    sequence: max,
    observedAt: max,
    occurredAt: max,
    phase: "p".repeat(80),
    reason: "r".repeat(80),
    revision: "a".repeat(40),
    threadId: thread,
    snapshotId: thread.slice(2),
    attempt: max,
    retryAt: max,
    relatedOperationId: "c".repeat(200),
    controller: {
      activeRevision: "a".repeat(40),
      observedRevision: "b".repeat(40),
      targetRevision: "c".repeat(40),
      controllerRevision: "d".repeat(40),
      blocked: true,
      operatorHold: true,
      phase: "p".repeat(80),
      recoveryIncident: "d".repeat(200),
      recoveryThreadId: thread,
      recoveryOwner: thread,
      retryAttempts: max,
      retryAt: max,
      queuedRevisions: Array(50).fill("e".repeat(40)),
      omittedQueueCount: max,
    },
  });
  const operation = {
    ...summary,
    latest: dense,
    failure: dense,
    failureKey: "f".repeat(250),
  };
  const events = [
    dense,
    { ...dense, sequence: max - 1 },
    { ...dense, sequence: max - 2 },
  ];
  const page = JSON.parse(
    operationInspectionPage(
      {
        operation,
        events,
        totalEvents: 3,
        nextOffset: null,
        related: Array(10).fill(operation),
      },
      0,
      10,
    ),
  );
  expect(JSON.stringify(page).length).toBeLessThanOrEqual(10000);
  expect(page.events).toEqual([dense]);
  expect(page.nextOffset).toBe(1);
  const next = JSON.parse(
    operationInspectionPage(
      {
        operation,
        events: events.slice(1),
        totalEvents: 3,
        nextOffset: null,
        related: [],
      },
      1,
      10,
    ),
  );
  expect(next.events).toEqual([{ ...dense, sequence: max - 1 }]);
  expect(next.nextOffset).toBe(2);
  const index = JSON.parse(
    operationInspectionPage(
      {
        items: Array(10).fill(operation),
        total: 10,
        nextOffset: null,
        controller: dense,
      },
      0,
      10,
    ),
  );
  expect(JSON.stringify(index).length).toBeLessThanOrEqual(10000);
  expect(index.items[0].latest.controller).toBeUndefined();
  expect(index.controller).toEqual(dense);
  expect(index.nextOffset).toBe(index.items.length);
});

it("exposes typed filters only through authorized inspection schemas", () => {
  const inspection = {
    target: "debug-operations",
    sources: ["debugshare", "coding"],
    failuresOnly: true,
    source: null,
    failureKey: null,
    operationId: null,
    query: null,
    offset: null,
    limit: null,
  };
  const reply = JSON.stringify({ text: "", inspection });
  expect(
    parseReply(reply, [], { inspectionAvailable: true, agentRole: "execution" })
      .inspection,
  ).toMatchObject({ sources: ["debugshare", "coding"], failuresOnly: true });
  expect(() => parseReply(reply, [], { inspectionAvailable: false })).toThrow();
  expect(() =>
    parseReply(reply, [], {
      inspectionAvailable: true,
      agentRole: "interaction",
    }),
  ).toThrow();
  expect(() =>
    parseReply(
      JSON.stringify({
        text: "",
        inspection: { ...inspection, sources: ["arbitrary"] },
      }),
      [],
      { inspectionAvailable: true },
    ),
  ).toThrow();
  const config = parseConfig({
    setupMode: true,
    owner: { id: "owner", identities: [] },
    model: { protocol: "openai", model: "fixture", apiKeyEnv: "FIXTURE_KEY" },
    debugSite: {
      origin: "https://debug.example.test",
      tokenEnv: "INGEST_KEY",
      operationsTokenEnv: "OPERATIONS_KEY",
      operationsDatabase: "/private/operations.sqlite",
    },
  });
  expect(config.debugSite?.operationsTokenEnv).toBe("OPERATIONS_KEY");
});
