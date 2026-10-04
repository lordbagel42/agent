import { expect, it } from "vitest";
import type { DebugSnapshot } from "../runtime/session-controls.js";
import type { DebugSitePublisher } from "./contracts.js";
import { type DebugSiteOutbox, publishDebugSite } from "./outbox.js";
import { DebugSitePublishError } from "./publisher.js";

const snapshot: DebugSnapshot = {
  id: "e782a1c4-9d2f-4ace-a1c0-5f3e9d7b1142",
  sessionId: "one",
  capturedAt: "2026-10-04T16:42:00Z",
  revision: "example",
  scope: ["private", "owner"],
  reason: "Example",
  snapshotOnly: true,
  data: {},
  exclusions: [],
};
const url = `https://debug.example.test/s/${snapshot.id}`;

it("retains a retryable outbox while offline and republishes the same identity after restart", async () => {
  let durable: DebugSiteOutbox = {
    status: "pending",
    url,
    attempts: 0,
    retryAt: 0,
  };
  let state = structuredClone(durable);
  const persist = async () => {
    durable = structuredClone(state);
  };
  const publisher: DebugSitePublisher = {
    url: () => url,
    publish: async () => {
      throw new DebugSitePublishError("transport", true);
    },
  };
  await publishDebugSite(state, snapshot, publisher, persist, 1000);
  expect(state.status).toBe("pending");
  expect(state.attempts).toBe(1);
  expect(state.retryAt).toBe(16000);
  state = structuredClone(durable);
  let received: DebugSnapshot | undefined;
  publisher.publish = async (value) => {
    received = value;
  };
  await publishDebugSite(state, snapshot, publisher, persist, 15999);
  expect(received).toBeUndefined();
  await publishDebugSite(state, snapshot, publisher, persist, 16000);
  expect(received).toEqual(snapshot);
  expect(durable).toMatchObject({
    status: "saved",
    attempts: 2,
    savedAt: 16000,
  });
  expect(durable.retryAt).toBeUndefined();
  publisher.publish = async () => {
    throw new Error("must not repeat saved upload");
  };
  await publishDebugSite(state, snapshot, publisher, persist, 20000);
  expect(state.status).toBe("saved");
});

it("records permanent refusal and never silently sends an old capture to a changed destination", async () => {
  const state: DebugSiteOutbox = {
    status: "pending",
    url,
    attempts: 0,
    retryAt: 0,
  };
  const publisher: DebugSitePublisher = {
    url: () => url,
    publish: async () => {
      throw new DebugSitePublishError("http", false, 409);
    },
  };
  await publishDebugSite(state, snapshot, publisher, async () => {}, 1000);
  expect(state).toMatchObject({ status: "rejected", error: "http" });
  const changed: DebugSiteOutbox = {
    status: "pending",
    url,
    attempts: 0,
    retryAt: 0,
  };
  await publishDebugSite(
    changed,
    snapshot,
    {
      url: () => "https://elsewhere.test",
      publish: async () => {
        throw new Error("must not export");
      },
    },
    async () => {},
    1000,
  );
  expect(changed).toMatchObject({
    status: "rejected",
    error: "destination_changed",
    attempts: 0,
  });
});
