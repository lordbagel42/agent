import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { OperationJournal } from "./operation-journal.js";
import type { OperationEvent, OperationObservation } from "./operations.js";

const origin = "https://operations.example";
const token = "test-write-only-token".padEnd(48, "x");
const observation: OperationObservation = {
  operationId: "coding:fixture:1",
  source: "coding",
  occurredAt: 100,
  status: "dispatching",
  phase: "local_dispatch",
  failure: false,
  attempt: 1,
};
const directories: string[] = [];
const journals: OperationJournal[] = [];
function file() {
  const root = mkdtempSync(join(tmpdir(), "june-operation-journal-"));
  directories.push(root);
  return join(root, "private", "events.sqlite");
}
function open(file: string, destination = origin) {
  const journal = new OperationJournal({ file, origin: destination, token });
  journals.push(journal);
  return journal;
}
function rows(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM operation_journal ORDER BY position")
      .all() as {
      id: string;
      payload: string;
      state: string;
      failures: number;
      retry_at: number;
    }[];
  } finally {
    db.close();
  }
}
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of directories.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("durably assigns immutable identities/sequences offline and resumes only publication with backoff", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const requests: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const event = JSON.parse(String(init.body)) as OperationEvent;
    return requests.length === 1
      ? new Response("private upstream failure", { status: 503 })
      : Response.json({ id: event.id, saved: true }, { status: 201 });
  });
  const path = file();
  let journal = open(path);
  const input = { ...observation };
  journal.record(input);
  input.status = "completed";
  const other = open(path);
  other.record({ ...observation, status: "running" });
  other.record({ ...observation, operationId: "coding:other:1" });
  await other.close();
  expect(requests).toEqual([]);
  const before = rows(path).map((row) => row.payload);
  const events = before.map((payload) => JSON.parse(payload) as OperationEvent);
  expect(events.map((event) => event.sequence)).toEqual([0, 1, 0]);
  expect(events[0]?.status).toBe("dispatching");
  expect(new Set(events.map((event) => event.id)).size).toBe(3);
  for (const event of events)
    expect(event.id).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  await journal.close();

  journal = open(path, `${origin}/`);
  journal.start();
  expect(requests).toEqual([]);
  await vi.advanceTimersByTimeAsync(0);
  expect(requests).toHaveLength(1);
  const retryAt = rows(path)[0]?.retry_at ?? 0;
  expect(retryAt).toBeGreaterThan(Date.now());
  await journal.close();
  journal = open(path);
  journal.start();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(
    requests.filter((request) => request.init.body === before[0]),
  ).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(retryAt - Date.now() + 1_000);
  expect(rows(path).map((row) => row.state)).toEqual([
    "saved",
    "saved",
    "saved",
  ]);
  expect(rows(path).map((row) => row.payload)).toEqual(before);
  expect(
    requests.filter((request) => request.init.body === before[0]),
  ).toHaveLength(2);
  for (const { url, init } of requests) {
    const event = JSON.parse(String(init.body)) as OperationEvent;
    expect(url).toBe(`${origin}/api/ingest/operations/${event.id}`);
    expect(init).toMatchObject({
      method: "PUT",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }
  await journal.close();
  const count = requests.length;
  journal = open(path);
  journal.start();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(requests).toHaveLength(count);
  journal.record(observation);
  expect(JSON.parse(rows(path)[3]?.payload ?? "{}").sequence).toBe(2);
});

it("retains false receipts for retry, but quarantines redirects, conflicts and permanent rejections across restart", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const [response, expected] of [
    [
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://elsewhere.example/private" },
        }),
      "rejected",
    ],
    [() => new Response(null, { status: 409 }), "conflict"],
    [() => new Response("private error", { status: 403 }), "rejected"],
    [() => Response.json({ saved: false }), "pending"],
    [() => Response.json({ id: "wrong", saved: true }), "pending"],
    [() => new Response("x".repeat(4097)), "pending"],
    [() => new Response(null, { status: 429 }), "pending"],
  ] as const) {
    const fetch = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetch);
    const path = file();
    let journal = open(path);
    journal.record(observation);
    journal.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(rows(path)[0]?.state).toBe(expected);
    const payload = rows(path)[0]?.payload;
    await journal.close();
    journal = open(path);
    journal.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetch).toHaveBeenCalledTimes(expected === "pending" ? 2 : 1);
    expect(rows(path)[0]?.payload).toBe(payload);
    await journal.close();
  }
});

it("settles in-flight publication on close and bounds stalled requests without involving record", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const signals: AbortSignal[] = [];
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal;
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("private transport path")),
        { once: true },
      );
    });
  });
  const path = file();
  const journal = open(path);
  journal.start();
  journal.record(observation);
  expect(signals).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(0);
  journal.record({ ...observation, status: "unknown", failure: true });
  expect(rows(path)).toHaveLength(2);
  expect(signals[0]?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(signals[0]?.aborted).toBe(true);
  expect(rows(path)[0]?.state).toBe("pending");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(signals).toHaveLength(2);
  await journal.close();
  expect(signals[1]?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(() => journal.record(observation)).not.toThrow();
});

it("binds the private journal to its destination and rejects unsafe paths or content without disclosure", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const path = file();
  const journal = open(path);
  const sentinel = "SENTINEL-private-goal-report-path";
  journal.record({ ...observation, report: sentinel } as OperationObservation);
  expect(rows(path)).toHaveLength(0);
  journal.record(observation);
  await journal.close();
  expect(() => open(path, "https://other.example")).toThrow(
    "Operation journal unavailable",
  );
  expect(() =>
    open(path, `https://user:${sentinel}@operations.example`),
  ).toThrow("Operation journal unavailable");
  expect(readFileSync(path).includes(Buffer.from(sentinel))).toBe(false);
  expect(readFileSync(path).includes(Buffer.from(token))).toBe(false);
  chmodSync(path, 0o644);
  expect(() => open(path)).toThrow("Operation journal unavailable");
  const root = directories.at(-1) as string;
  mkdirSync(join(root, "target"), { mode: 0o700 });
  symlinkSync(join(root, "target"), join(root, "link"));
  expect(() => open(join(root, "link", "new", "events.sqlite"))).toThrow(
    "Operation journal unavailable",
  );
  expect(existsSync(join(root, "target", "new"))).toBe(false);
  expect(JSON.stringify(warning.mock.calls)).not.toContain(sentinel);
  expect(JSON.stringify(warning.mock.calls)).not.toContain(path);
});
