import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import type { DebugSitePublisher } from "./contracts.js";
import {
  createDebugSitePublisher,
  DebugSitePublishError,
} from "./publisher.js";

const id = "10000000-0000-4000-8000-000000000001";
const snapshot: Parameters<DebugSitePublisher["publish"]>[0] = {
  id,
  sessionId: "fixture-session",
  capturedAt: "2026-10-04T12:00:00.000Z",
  revision: "abc123",
  scope: ["slack:team:private"],
  reason: "fixture reason",
  data: { nested: [{ retained: true, text: "private fixture" }] },
  exclusions: [],
};
const token = "fixture-upload-secret".padEnd(48, "x");
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}

it("uploads the complete snapshot with a write-only token and accepts only saved receipts", async () => {
  const requests: {
    method?: string;
    path?: string;
    authorization?: string;
    contentType?: string;
    body: string;
  }[] = [];
  const origin = await listen(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      body,
    });
    response.writeHead(requests.length === 1 ? 201 : 200, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ id, saved: true }));
  });
  const publisher = createDebugSitePublisher({ origin: `${origin}/`, token });
  await publisher.publish(snapshot);
  await publisher.publish(snapshot);
  expect(requests).toEqual([
    {
      method: "PUT",
      path: `/api/ingest/${id}`,
      authorization: `Bearer ${token}`,
      contentType: "application/json",
      body: JSON.stringify(snapshot),
    },
    {
      method: "PUT",
      path: `/api/ingest/${id}`,
      authorization: `Bearer ${token}`,
      contentType: "application/json",
      body: JSON.stringify(snapshot),
    },
  ]);
  expect(publisher.url(id)).toBe(`${origin}/s/${id}`);
});

it("sends investigation metadata separately without changing immutable snapshot bytes", async () => {
  const observations: unknown[] = [];
  const origin = await listen(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    observations.push([
      request.headers["x-june-investigation-phase"],
      request.headers["x-june-investigation-thread"],
      body,
    ]);
    response.end(JSON.stringify({ id, saved: true }));
  });
  const publisher = createDebugSitePublisher({ origin, token });
  await publisher.publish(snapshot, { phase: "unavailable" });
  await publisher.publish(snapshot, { phase: "returned", threadId: `T-${id}` });
  expect(observations).toEqual([
    ["unavailable", undefined, JSON.stringify(snapshot)],
    ["returned", `T-${id}`, JSON.stringify(snapshot)],
  ]);
});

it("reads issue metadata without viewer credentials and bounds responses", async () => {
  let oversized = false;
  const origin = await listen((request, response) => {
    expect(request.method).toBe("GET");
    expect(request.url).toBe("/api/ingest/issues");
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    response.end(
      oversized
        ? "x".repeat(262145)
        : JSON.stringify({ enabled: true, items: [], total: 0, pending: [] }),
    );
  });
  const publisher = createDebugSitePublisher({ origin, token });
  expect(typeof publisher.inspectIssues).toBe("function");
  expect(await publisher.inspectIssues?.()).toEqual({
    enabled: true,
    items: [],
    total: 0,
    pending: [],
  });
  oversized = true;
  await expect(publisher.inspectIssues?.()).rejects.toThrow(
    "Issue metadata unavailable",
  );
});

it("rejects unsafe origins, credentials and IDs before making requests", () => {
  for (const origin of [
    "http://debug.example",
    "https://user:private@debug.example",
    "https://debug.example/path",
    "https://debug.example/ignored/..",
    "https:debug.example",
    "https://debug.example?token=private",
    "https://debug.example#fragment",
    "ftp://debug.example",
    "not-a-url-private-text",
  ])
    expect(() => createDebugSitePublisher({ origin, token })).toThrow(
      DebugSitePublishError,
    );
  for (const invalidToken of [
    "",
    "x".repeat(31),
    "x".repeat(4097),
    " token ",
    "token\r\nleaked: yes",
  ])
    expect(() =>
      createDebugSitePublisher({
        origin: "https://debug.example",
        token: invalidToken,
      }),
    ).toThrow(DebugSitePublishError);
  const publisher = createDebugSitePublisher({
    origin: "https://DEBUG.example:443/",
    token,
  });
  expect(publisher.url(id)).toBe(`https://debug.example/s/${id}`);
  for (const invalidId of ["../secret", `${id}?leak`, "invalid-private-text"])
    expect(() => publisher.url(invalidId)).toThrow(DebugSitePublishError);
});

it("never follows upload redirects or forwards the credential to another host", async () => {
  let received = 0;
  const destination = await listen((_request, response) => {
    received++;
    response.end(JSON.stringify({ id, saved: true }));
  });
  const origin = await listen((_request, response) => {
    response.writeHead(307, { location: `${destination}/private` });
    response.end("private redirect response");
  });
  const publisher = createDebugSitePublisher({ origin, token });
  await expect(publisher.publish(snapshot)).rejects.toMatchObject({
    name: "DebugSitePublishError",
    retryable: false,
    status: 307,
  });
  expect(received).toBe(0);
});

it("classifies HTTP failures without exposing tokens or response bodies", async () => {
  let status = 503;
  const origin = await listen((_request, response) => {
    response.writeHead(status);
    response.end(`private response ${token}`);
  });
  const publisher = createDebugSitePublisher({ origin, token });
  for (const [code, retryable] of [
    [503, true],
    [429, true],
    [401, false],
    [409, false],
  ] as const) {
    status = code;
    try {
      await publisher.publish(snapshot);
      expect.unreachable("failure was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(DebugSitePublishError);
      expect(error).toMatchObject({ status: code, retryable });
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain("private response");
      expect(error).not.toHaveProperty("cause");
    }
  }
});

it("rejects unconfirmed, mismatched, malformed, oversized and merely accepted responses", async () => {
  let body = "{}";
  let status = 200;
  const origin = await listen((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  const publisher = createDebugSitePublisher({ origin, token });
  for (const receipt of [
    { id, saved: false },
    { id, saved: "true" },
    { id: "20000000-0000-4000-8000-000000000001", saved: true },
    { saved: true },
    { id, saved: true, padding: "x".repeat(5000) },
  ]) {
    body = JSON.stringify(receipt);
    await expect(publisher.publish(snapshot)).rejects.toBeInstanceOf(
      DebugSitePublishError,
    );
  }
  body = "private non-json receipt";
  await expect(publisher.publish(snapshot)).rejects.toBeInstanceOf(
    DebugSitePublishError,
  );
  status = 202;
  body = JSON.stringify({ id, saved: true });
  await expect(publisher.publish(snapshot)).rejects.toBeInstanceOf(
    DebugSitePublishError,
  );
});

it("bounds a stalled upload and makes transport failures retryable", async () => {
  const origin = await listen(() => {});
  const publisher = createDebugSitePublisher({ origin, token });
  const started = Date.now();
  await expect(publisher.publish(snapshot)).rejects.toMatchObject({
    name: "DebugSitePublishError",
    retryable: true,
  });
  expect(Date.now() - started).toBeLessThan(15_000);
}, 20_000);

it("does not transmit an invalid snapshot", async () => {
  let received = 0;
  const origin = await listen((_request, response) => {
    received++;
    response.end();
  });
  await expect(
    createDebugSitePublisher({ origin, token }).publish({
      ...snapshot,
      id: "bad-id",
    }),
  ).rejects.toMatchObject({
    name: "DebugSitePublishError",
    retryable: false,
  });
  expect(received).toBe(0);
});
