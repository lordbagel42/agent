import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RawAccess } from "rivetkit/db";
import { expect, it } from "vitest";
import { DebugBodies, initializeDebugBodies } from "./debug-bodies.js";
import type { DebugSnapshot } from "./session-controls.js";

it("commits the immutable manifest last and recovers lost ACKs without a new capture", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.onTestFinished(() => sqlite.close());
  let failure: "before" | "after" | undefined = "before";
  const db = {
    execute: async (sql: string, ...args: SQLInputValue[]) => {
      if (
        sql.startsWith("INSERT") &&
        sql.includes("debug_body_manifests") &&
        failure === "before"
      )
        throw new Error("interrupted before manifest");
      const result = sqlite.prepare(sql).all(...args);
      if (
        sql.startsWith("INSERT") &&
        sql.includes("debug_body_manifests") &&
        failure === "after"
      )
        throw new Error("lost manifest acknowledgment");
      return result;
    },
  } as RawAccess;
  await initializeDebugBodies(db);
  const snapshot: DebugSnapshot = {
    id: "original",
    sessionId: "session",
    capturedAt: "2026-10-05T00:00:00Z",
    revision: "fixture",
    scope: ["private", "owner"],
    reason: "original reason",
    snapshotOnly: true,
    data: { text: "a🌻b".repeat(30_000) },
    exclusions: [],
  };
  const bodies = new DebugBodies(db);
  await expect(bodies.put("command", snapshot)).rejects.toThrow(
    "before manifest",
  );
  expect(await bodies.get("command")).toBeUndefined();
  failure = "after";
  await expect(bodies.put("command", snapshot)).rejects.toThrow(
    "lost manifest acknowledgment",
  );
  failure = undefined;
  const reopened = new DebugBodies(db);
  expect(await reopened.get("command")).toEqual(snapshot);
  const ref = await reopened.put("command", snapshot);
  expect(ref.snapshotOnly).toBe(true);
  await expect(
    reopened.put("command", { ...snapshot, id: "replacement" }),
  ).rejects.toThrow("manifest conflict");
  expect(await reopened.get("command")).toEqual(snapshot);
  await expect(reopened.writePart(ref.sha256, 0, "different")).rejects.toThrow(
    "part conflict",
  );
  expect(await reopened.get("command")).toEqual(snapshot);
});
