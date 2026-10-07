import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createIssueGitHub } from "./github-issues.js";
import { IssueCredentials } from "./issue-credentials.js";
import { IssueTracker } from "./issue-tracker.js";
import { createDebugSite } from "./server.js";
import { DiagnosticStore } from "./store.js";

const origin = "https://debug.example.test";
const viewer = "v".repeat(48),
  ingest = "i".repeat(48),
  automation = "a".repeat(48),
  operator = "o".repeat(48),
  refresh = "r".repeat(48),
  operations = "p".repeat(48);
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.useRealTimers();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "june-credential-http-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "index.html"),
    "<!doctype html><title>June Debug</title>",
  );
  const store = new DiagnosticStore(join(root, "archive.sqlite"));
  cleanup.push(() => store.close());
  const credentials = new IssueCredentials();
  const tracker = new IssueTracker({
    store,
    origin,
    creatorId: 91,
    github: createIssueGitHub({ token: () => credentials.get() }),
    credentialStatus: () => credentials.status(),
  });
  const options = {
    origin,
    viewerToken: viewer,
    ingestToken: ingest,
    operationsToken: operations,
    store,
    assets: root,
    issues: { token: automation, operatorToken: operator, tracker },
    issueCredentials: { token: refresh, value: credentials },
  };
  const app = createDebugSite(options);
  const grant = {
    version: 1,
    token: "ghs_private_synthetic",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
  const request = (
    path: string,
    token: string,
    body = grant as unknown,
    method = "POST",
  ) =>
    app.request(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
  return { app, options, credentials, grant, request };
}

it("isolates refresh from every existing credential and exposes only safe inspection status", async () => {
  const f = fixture();
  expect((await f.app.request(`${origin}/health`)).status).toBe(200);
  for (const token of ["", viewer, ingest, automation, operator, operations])
    expect(
      (await f.request("/api/issue-github-token", token, { invalid: true }))
        .status,
    ).toBe(401);
  expect((await f.request("/api/issue-github-token", refresh)).status).toBe(
    204,
  );
  expect(f.credentials.get()).toBe(f.grant.token);
  const status = await (
    await f.request("/api/ingest/issues", ingest, undefined, "GET")
  ).text();
  expect(JSON.parse(status)).toMatchObject({
    credentials: { state: "usable", expiresAt: f.grant.expiresAt },
  });
  expect(status).not.toContain(f.grant.token);
  expect(status).not.toContain(refresh);
  for (const path of [
    "/api/issue-tools",
    "/api/issue-reconciliation/7",
    "/api/ingest/issues",
    "/api/operations-read",
  ])
    expect(
      (
        await f.request(
          path,
          refresh,
          { action: "inspect" },
          path.endsWith("issues") || path.endsWith("read") ? "GET" : "POST",
        )
      ).status,
    ).toBe(401);
  expect(
    (await f.request("/api/issue-github-token", refresh, {}, "GET")).status,
  ).toBe(405);
  expect(() =>
    createDebugSite({
      ...f.options,
      issueCredentials: { token: automation, value: f.credentials },
    }),
  ).toThrow();
});

it("rejects oversized and slow credential deliveries without replacing a usable grant", async () => {
  const f = fixture();
  await f.request("/api/issue-github-token", refresh);
  expect(
    (
      await f.request("/api/issue-github-token", refresh, {
        ...f.grant,
        token: "x".repeat(9000),
      })
    ).status,
  ).toBe(400);
  vi.useFakeTimers();
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
    cancel,
  });
  const response = f.app.request(
    new Request(`${origin}/api/issue-github-token`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${refresh}`,
        "content-type": "application/json",
      },
      body,
      duplex: "half",
    } as RequestInit),
  );
  await vi.advanceTimersByTimeAsync(2001);
  expect((await response).status).toBe(400);
  expect(cancel).toHaveBeenCalledOnce();
  expect(f.credentials.get()).toBe(f.grant.token);
});
