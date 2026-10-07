import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { DebugSnapshot } from "../runtime/session-controls.js";
import { createIssueGitHub } from "./github-issues.js";
import { IssueTracker } from "./issue-tracker.js";
import { createDebugSite } from "./server.js";
import { DiagnosticStore, MAX_SNAPSHOT_BYTES } from "./store.js";

const origin = "https://debug.example.test";
const viewerToken = "viewer-fixture-".padEnd(48, "v");
const ingestToken = "ingest-fixture-".padEnd(48, "i");
const snapshot: DebugSnapshot = {
  id: "e782a1c4-9d2f-4ace-a1c0-5f3e9d7b1142",
  sessionId: "private-session",
  capturedAt: "2026-10-04T16:42:00.000Z",
  revision: "example-revision",
  scope: ["private", "owner"],
  reason: "Delayed reply <script>alert(1)</script>",
  snapshotOnly: true,
  data: { history: [{ role: "user", content: "synthetic private evidence" }] },
  exclusions: ["Raw service logs are not collected."],
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "june-debug-http-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "archive.sqlite");
  const store = new DiagnosticStore(file);
  cleanup.push(() => store.close());
  writeFileSync(
    join(directory, "index.html"),
    "<!doctype html><title>June Debug</title><div id=app></div>",
  );
  const options = {
    origin,
    viewerToken,
    ingestToken,
    store,
    assets: directory,
  };
  const app = createDebugSite(options);
  const request = (path: string, init?: RequestInit) =>
    app.request(`${origin}${path}`, init);
  const upload = (value = snapshot, token = ingestToken, id = value.id) =>
    request(`/api/ingest/${id}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(value),
    });
  return { store, options, file, request, upload };
}

it("reports deployment receipts separately from site readiness without exposing archive data", async () => {
  const { options, upload } = fixture();
  await upload();
  const receipt = {
    version: 1 as const,
    controllerRevision: "1".repeat(40),
    phase: "failed" as const,
    checkedAt: 1,
    targetRevision: "2".repeat(40),
    activeRevision: "3".repeat(40),
    reason: "preflight_failed" as const,
  };
  const withStatus = createDebugSite({
    ...options,
    revision: "4".repeat(40),
    deployment: async () => receipt,
  });
  const response = await withStatus.request(`${origin}/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ready: true,
    revision: "4".repeat(40),
    deployment: receipt,
  });
  const missing = createDebugSite({ ...options, deployment: async () => null });
  expect(await (await missing.request(`${origin}/health`)).json()).toEqual({
    ready: true,
    revision: "development",
    deployment: null,
  });
});

it("separates upload and viewer authority and serves an archive after the producer is gone", async () => {
  const { request, upload, store, options, file } = fixture();
  expect((await upload(snapshot, viewerToken)).status).toBe(401);
  expect(
    (
      await request("/api/snapshots", {
        headers: { authorization: viewerToken },
      })
    ).status,
  ).toBe(401);
  expect((await upload()).status).toBe(201);
  expect((await upload()).status).toBe(200);
  expect(
    (
      await request(`/api/snapshots/${snapshot.id}`, {
        headers: { authorization: `Bearer ${ingestToken}` },
      })
    ).status,
  ).toBe(401);
  expect((await request(`/api/snapshots/${snapshot.id}`)).status).toBe(401);
  store.close();
  const reopened = new DiagnosticStore(file);
  cleanup.push(() => reopened.close());
  // A fresh site has only its own database. No June client or running publisher.
  const independent = createDebugSite({ ...options, store: reopened });
  const response = await independent.request(
    `${origin}/api/snapshots/${snapshot.id}`,
    { headers: { authorization: `Bearer ${viewerToken}` } },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(snapshot);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});

it("authenticates without June, rejects cross-origin session writes, expires and revokes cookies", async () => {
  const { request, upload, options } = fixture();
  await upload();
  const login = (requestOrigin = origin, token = viewerToken) =>
    request("/api/session", {
      method: "POST",
      headers: { origin: requestOrigin, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
  expect((await login("https://attacker.test")).status).toBe(403);
  expect((await login(origin, ingestToken)).status).toBe(401);
  const signedIn = await login();
  expect(signedIn.status).toBe(200);
  const setCookie = signedIn.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Strict");
  const cookie = setCookie.split(";")[0] ?? "";
  expect(
    (await request("/api/snapshots", { headers: { cookie } })).status,
  ).toBe(200);
  expect(
    (
      await request("/api/logout", {
        method: "POST",
        headers: { cookie, origin: "https://attacker.test" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/api/logout", {
        method: "POST",
        headers: { cookie, origin },
      })
    ).status,
  ).toBe(200);
  expect(
    (await request("/api/snapshots", { headers: { cookie } })).status,
  ).toBe(401);
  let now = 0;
  const expiring = createDebugSite({ ...options, now: () => now });
  const result = await expiring.request(`${origin}/api/session`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ token: viewerToken }),
  });
  const old = result.headers.get("set-cookie")?.split(";")[0] ?? "";
  now = 8 * 60 * 60 * 1000 + 1;
  expect(
    (
      await expiring.request(`${origin}/api/snapshots`, {
        headers: { cookie: old },
      })
    ).status,
  ).toBe(401);
});

it("rejects malformed/oversized/conflicting uploads and exports exact JSON only to viewers", async () => {
  const { request, upload } = fixture();
  await upload();
  expect((await upload({ ...snapshot, reason: "replacement" })).status).toBe(
    409,
  );
  expect((await upload(snapshot, ingestToken, "bad-id")).status).toBe(400);
  expect(
    (
      await upload(
        snapshot,
        ingestToken,
        "10000000-0000-4000-8000-000000000001",
      )
    ).status,
  ).toBe(400);
  const oversized = await request(`/api/ingest/${snapshot.id}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${ingestToken}`,
      "content-type": "application/json",
      "content-length": String(MAX_SNAPSHOT_BYTES + 1),
    },
    body: "{}",
  });
  expect(oversized.status).toBe(413);
  const headers = { authorization: `Bearer ${viewerToken}` };
  const index = await request("/api/snapshots?q=Delayed", { headers });
  expect(await index.json()).toMatchObject({
    total: 1,
    items: [{ id: snapshot.id }],
  });
  const downloaded = await request(`/api/snapshots/${snapshot.id}/download`, {
    headers,
  });
  expect(downloaded.headers.get("content-disposition")).toContain(
    "attachment;",
  );
  expect(downloaded.headers.get("content-type")).toContain("application/json");
  expect(await downloaded.json()).toEqual(snapshot);
  expect((await request("/api/snapshots?offset=-1", { headers })).status).toBe(
    400,
  );
  expect(
    (
      await request("/api/snapshots/10000000-0000-4000-8000-000000000001", {
        headers,
      })
    ).status,
  ).toBe(404);
});

it.each(["", "/conversation"])(
  "serves a data-free capture shell at /s/:id%s with a restrictive CSP",
  async (page) => {
    const { request, upload } = fixture();
    await upload();
    const response = await request(`/s/${snapshot.id}${page}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("June Debug");
    expect(html).not.toContain(snapshot.reason);
    expect(html).not.toContain("synthetic private evidence");
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).toContain("frame-ancestors 'none'");
    expect((await request("/assets/secret.sqlite")).status).toBe(404);
    expect((await request("/api/does-not-exist")).status).toBe(404);
    expect((await request(`/s/not-a-uuid${page}`)).status).toBe(404);
    expect((await request(`/s/${snapshot.id}${page}/unknown`)).status).toBe(
      404,
    );
    expect((await request(`/api/snapshots/${snapshot.id}`)).status).toBe(401);
  },
);

it("reports its own revision and requires readable UI assets for readiness", async () => {
  const { options } = fixture();
  const app = createDebugSite({ ...options, revision: "built-revision" });
  expect(await (await app.request(`${origin}/health`)).json()).toEqual({
    ready: true,
    revision: "built-revision",
    deployment: null,
  });
  writeFileSync(
    join(options.assets, "index.html"),
    '<script src="/assets/missing.js"></script>',
  );
  expect((await app.request(`${origin}/health`)).status).toBe(503);
  rmSync(join(options.assets, "index.html"));
  expect((await app.request(`${origin}/health`)).status).toBe(503);
});

it("keeps issue automation separate from viewer/ingest authority and registers captures without a network dependency", async () => {
  const { options, store } = fixture();
  const token = "issue-automation-fixture".padEnd(48, "a");
  const operatorToken = "issue-operator-fixture".padEnd(48, "o");
  const operationsToken = "operations-reader-fixture".padEnd(48, "r");
  const tracker = new IssueTracker({
    store,
    origin,
    creatorId: 91,
    github: createIssueGitHub({
      token: "synthetic",
      fetch: async () => {
        throw new Error("offline");
      },
    }),
  });
  const app = createDebugSite({
    ...options,
    operationsToken,
    issues: { token, operatorToken, tracker },
  });
  for (const reused of [token, operatorToken])
    expect(() =>
      createDebugSite({
        ...options,
        operationsToken: reused,
        issues: { token, operatorToken, tracker },
      }),
    ).toThrow("Invalid debug site configuration");
  const request = (path: string, credential: string, body?: unknown) =>
    app.request(`${origin}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  for (const credential of [viewerToken, ingestToken, operationsToken])
    expect(
      (
        await request("/api/issue-tools", credential, {
          action: "track",
          source: `debug:${snapshot.id}`,
        })
      ).status,
    ).toBe(401);
  expect((await request("/api/snapshots", token)).status).toBe(401);
  expect((await request("/api/issues", token)).status).toBe(401);
  expect((await request("/api/issues", operationsToken)).status).toBe(401);
  expect((await request("/api/operations-read", token)).status).toBe(401);
  expect((await request("/api/operations-read", operationsToken)).status).toBe(
    200,
  );
  for (const credential of [viewerToken, ingestToken, token, operationsToken])
    expect(
      (await request("/api/issue-reconciliation/7", credential, {})).status,
    ).toBe(401);
  expect(
    (await request("/api/issue-reconciliation/7", operatorToken, {})).status,
  ).toBe(409);
  expect(
    (await request("/api/issue-tools", operatorToken, { action: "inspect" }))
      .status,
  ).toBe(401);
  expect(
    (
      await request("/api/issue-sources", token, {
        source: "recovery:71",
        phase: "queued",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request("/api/issue-sources", ingestToken, {
        source: "recovery:71",
        phase: "returned",
      })
    ).status,
  ).toBe(401);
  const uploaded = await app.request(`${origin}/api/ingest/${snapshot.id}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${ingestToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(snapshot),
  });
  expect(uploaded.status).toBe(201);
  const index = await (await request("/api/ingest/issues", ingestToken)).json();
  expect(index).toMatchObject({
    enabled: true,
    pending: [
      { source: `debug:${snapshot.id}`, status: "pending" },
      { source: "recovery:71", status: "pending" },
    ],
  });
  expect(JSON.stringify(index)).not.toContain(snapshot.reason);
  expect(JSON.stringify(index)).not.toContain("synthetic private evidence");
  expect((await request("/api/issues", viewerToken)).status).toBe(200);
  expect((await request("/issues", "")).status).toBe(200);
  const tools = await (
    await request("/mcp/issues", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    })
  ).json();
  expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
    ["issue_track", "issue_inspect", "issue_comment", "issue_complete"],
  );
  const call = await (
    await request("/mcp/issues", token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "issue_inspect",
        arguments: { source: `debug:${snapshot.id}` },
      },
    })
  ).json();
  expect(call.result.structuredContent.result).toMatchObject({
    status: "pending",
    snapshotOnly: true,
  });
  const shared = {
    ...snapshot,
    id: "20000000-0000-4000-8000-000000000001",
    snapshotOnly: false,
  };
  expect(
    (
      await app.request(`${origin}/api/ingest/${shared.id}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${ingestToken}`,
          "content-type": "application/json",
          "x-june-investigation-phase": "unavailable",
        },
        body: JSON.stringify(shared),
      })
    ).status,
  ).toBe(201);
  expect(
    await tracker.run({ action: "inspect", source: `debug:${shared.id}` }),
  ).toMatchObject({ phase: "unavailable" });
  expect(store.get(shared.id)).toEqual(shared);
});
