import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDebugSite } from "./server.js";
import { DiagnosticStore } from "./store.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "june-operations-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "archive.sqlite");
  const store = new DiagnosticStore(file);
  cleanups.push(() => store.close());
  return { directory, file, store };
}
const failed = {
  id: "recovery:17:1",
  operationId: "recovery:17",
  source: "recovery" as const,
  sequence: 1,
  observedAt: 2000,
  occurredAt: 1500,
  status: "pending" as const,
  failure: true,
  reason: "health_failed",
  phase: "readiness",
};

it("keeps immutable history and selects latest by sequence, not upload order or wall clock", () => {
  const { file, store } = fixture();
  const settled = {
    ...failed,
    id: "recovery:17:2",
    sequence: 2,
    observedAt: 1900,
    occurredAt: 1800,
    status: "reconciled" as const,
    failure: false,
  };
  expect(store.putOperation(settled)).toBe("created");
  expect(store.putOperation(failed)).toBe("created");
  expect(store.putOperation({ ...failed })).toBe("exists");
  expect(() => store.putOperation({ ...failed, status: "failed" })).toThrow();
  expect(() => store.putOperation({ ...failed, id: "other-id" })).toThrow();
  store.close();
  const reopened = new DiagnosticStore(file);
  cleanups.push(() => reopened.close());
  const detail = reopened.operation("recovery:17");
  expect(detail?.operation.latest.status).toBe("reconciled");
  expect(detail?.operation.failure?.reason).toBe("health_failed");
  expect(detail?.events.map((event) => event.id)).toEqual([
    "recovery:17:2",
    "recovery:17:1",
  ]);
  expect(detail?.totalEvents).toBe(2);
});

it("counts distinct matching operations across resolved history, without merging different phases", () => {
  const { store } = fixture();
  store.putOperation(failed);
  store.putOperation({ ...failed, id: "repeat", sequence: 2 });
  store.putOperation({
    ...failed,
    id: "later",
    operationId: "recovery:23",
    observedAt: 5000,
  });
  store.putOperation({
    ...failed,
    id: "different",
    operationId: "recovery:24",
    phase: "rollback",
  });
  store.putOperation({
    ...failed,
    id: "settled",
    sequence: 3,
    status: "reconciled",
    failure: false,
  });
  const detail = store.operation("recovery:17");
  expect(detail?.operation.matchingFailures).toBe(2);
  expect(detail?.related.map((entry) => entry.latest.operationId)).toEqual([
    "recovery:23",
  ]);
  expect(store.operations({ query: "health_failed", limit: 1 }).total).toBe(3);
  expect(store.operations({ query: "' OR 1=1 --" }).total).toBe(0);
  expect(() =>
    store.putOperation({ ...failed, prompt: "private sentinel" }),
  ).toThrow();
});

it("filters historical failures and source groups before counting and pagination", () => {
  const { store } = fixture();
  const observations = [
    ["coding", "older", true, 100],
    ["amp-task", "later", true, 200],
    ["debugshare", "healthy", false, 300],
    ["deployment", "newest", true, 400],
  ] as const;
  for (const [source, name, failure, observedAt] of observations) {
    store.putOperation({
      ...failed,
      id: name,
      operationId: `${source}:${name}`,
      source,
      failure,
      observedAt,
    });
    store.putOperation({
      ...failed,
      id: `${name}-settled`,
      operationId: `${source}:${name}`,
      source,
      failure: false,
      observedAt: observedAt + 10,
      sequence: 2,
      status: "completed",
    });
  }
  const options = {
    sources: ["amp-task", "debugshare", "coding"] as const,
    failuresOnly: true,
    limit: 1,
  };
  const first = store.operations({ ...options, sources: [...options.sources] });
  expect(first.total).toBe(2);
  expect(first.items.map((item) => item.latest.operationId)).toEqual([
    "amp-task:later",
  ]);
  expect(first.items[0]?.latest.status).toBe("completed");
  expect(first.nextOffset).toBe(1);
  const second = store.operations({
    ...options,
    sources: [...options.sources],
    offset: 1,
  });
  expect(second.items.map((item) => item.latest.operationId)).toEqual([
    "coding:older",
  ]);
  expect(second.nextOffset).toBeNull();
  expect(
    store.operations({ sources: ["coding"], source: "deployment" }).total,
  ).toBe(0);
  expect(
    store.operations({
      sources: ["coding", "coding"],
      source: "coding",
      failureKey: "coding:readiness:health_failed",
    }).total,
  ).toBe(1);
  expect(
    store.operations({ sources: [...options.sources], failuresOnly: false })
      .total,
  ).toBe(3);
});

it("separates metadata reader, ingest and viewer authority, bounds input and protects independent reads", async () => {
  const { directory, store } = fixture();
  writeFileSync(join(directory, "index.html"), "<div id=app></div>");
  const origin = "https://debug.example.test";
  const ingestToken = "ingest-test-".padEnd(48, "i");
  const viewerToken = "viewer-test-".padEnd(48, "v");
  const operationsToken = "operations-test-".padEnd(48, "o");
  const app = createDebugSite({
    origin,
    ingestToken,
    viewerToken,
    operationsToken,
    store,
    assets: directory,
  });
  const request = (path: string, token?: string, body?: unknown) =>
    app.request(`${origin}${path}`, {
      method: body ? "PUT" : "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  expect(
    (
      await request(
        "/api/ingest/operations/recovery:17:1",
        operationsToken,
        failed,
      )
    ).status,
  ).toBe(401);
  expect(
    (await request("/api/ingest/operations/recovery:17:1", ingestToken, failed))
      .status,
  ).toBe(201);
  expect(
    (await request("/api/ingest/operations/recovery:17:1", ingestToken, failed))
      .status,
  ).toBe(200);
  expect(
    (
      await request("/api/ingest/operations/recovery:17:1", ingestToken, {
        ...failed,
        prompt: "secret",
      })
    ).status,
  ).toBe(400);
  for (const path of ["/api/operations", "/api/snapshots", "/api/passkeys"])
    expect((await request(path, operationsToken)).status).toBe(401);
  expect((await request("/api/operations-read", ingestToken)).status).toBe(401);
  expect((await request("/api/operations-read", operationsToken)).status).toBe(
    200,
  );
  expect(
    (await request("/api/operations-read/recovery:17", operationsToken)).status,
  ).toBe(200);
  const result = await request("/api/operations/recovery:17", viewerToken);
  expect(result.status).toBe(200);
  expect((await result.json()).operation.latest.id).toBe("recovery:17:1");
  expect(result.headers.get("cache-control")).toContain("no-store");
  expect((await request("/api/operations?offset=-1", viewerToken)).status).toBe(
    400,
  );
  for (const invalid of [
    "failuresOnly=garbage",
    "failuresOnly=1",
    "sources=coding,invalid",
    "sources=",
  ])
    expect(
      (await request(`/api/operations?${invalid}`, viewerToken)).status,
    ).toBe(400);
  expect(
    (
      await request(
        "/api/operations-read?sources=coding,recovery&failuresOnly=true",
        operationsToken,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await (
        await request("/api/operations?failuresOnly=false", viewerToken)
      ).json()
    ).total,
  ).toBe(1);
  expect((await request("/operations")).status).toBe(200);
});
