import { randomBytes } from "node:crypto";
import type { Client } from "rivetkit/client";
import { expect, it, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { createSlackAdapter } from "../channels/slack.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { EvidenceStore } from "../memory/store.js";
import { conversationInputId } from "./inbox.js";
import { createInspectionReader } from "./inspection.js";
import { createLifecycle } from "./lifecycle.js";
import {
  createJuneRegistry,
  type Dependencies,
  type JuneClientRegistry,
} from "./registry.js";
import {
  captureDebug,
  type DebugSnapshot,
  type DebugSnapshotChunk,
  publishDebugNotifications,
  publishDebugSnapshot,
  publishSessionCommand,
  type SessionCommandReceipt,
  sessionCommand,
} from "./session-controls.js";

const owner = {
  id: "owner",
  identities: [{ channel: "slack" as const, accountId: "T1", senderId: "U1" }],
};
const message = (id: string, text: string): MessageEvent => ({
  id,
  text,
  type: "message",
  messageId: id,
  occurredAt: Date.now(),
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  senderId: "U1",
  direct: true,
  sessionCommandEligible: true,
});

it("returns owner report links at origin while keeping guest links and all diagnostic details private", async (t) => {
  const sent: OutboundMessage[] = [];
  const snapshots: DebugSnapshot[] = [];
  const registry = createJuneRegistry({
    owner,
    model: {
      async reply() {
        throw new Error("DEBUGSHARE must bypass inference");
      },
    },
    debugShare: {
      async run(snapshot) {
        snapshots.push(snapshot);
        return {
          threadId: `T-${snapshot.id}`,
          report: "private investigation findings",
        };
      },
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        receive: async () => ({ events: [], response: new Response() }),
        async send(outbound) {
          sent.push(JSON.parse(JSON.stringify(outbound)));
          // Failure at origin must not suppress forwarding; an uncertain owner
          // receipt must not be resent when the command is replayed below.
          if (outbound.address.conversationId === "D2")
            return {
              status: "rejected",
              code: "not_in_channel",
              retryable: false,
            };
          if (
            outbound.content.type === "text" &&
            outbound.content.text.includes("Reason (untrusted): guest reason")
          )
            return { status: "unknown", code: "timeout" };
          return {
            status: "sent",
            messageId: `ack-${outbound.address.conversationId}-${snapshots.at(-1)?.id}`,
          };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const reports: MessageEvent[] = [
    {
      ...message("public-owner", "DEBUGSHARE sensitive owner reason"),
      direct: false,
      address: {
        channel: "slack",
        accountId: "T1",
        conversationId: "C1",
        threadId: "123.4",
      },
      metadata: { channelType: "channel" },
    },
    {
      ...message("guest-dm", "DEBUGSHARE guest reason xoxb-secret"),
      senderId: "U2",
      address: { channel: "slack", accountId: "T1", conversationId: "D2" },
      metadata: { channelType: "im" },
    },
    {
      ...message("guest-group", "DEBUGSHARE group reason"),
      senderId: "U3",
      direct: false,
      address: { channel: "slack", accountId: "T1", conversationId: "G1" },
      metadata: { channelType: "mpim" },
    },
    {
      ...message("guest-channel", "DEBUGSHARE channel reason"),
      senderId: "U4",
      direct: false,
      address: { channel: "slack", accountId: "T1", conversationId: "C2" },
      metadata: { channelType: "channel" },
    },
    {
      ...message("public-owner-root", "DEBUGSHARE owner root reason"),
      direct: false,
      address: { channel: "slack", accountId: "T1", conversationId: "C3" },
      metadata: { channelType: "channel" },
    },
    {
      ...message("owner-group", "DEBUGSHARE owner group reason"),
      direct: false,
      address: { channel: "slack", accountId: "T1", conversationId: "G2" },
      metadata: { channelType: "mpim" },
    },
  ];
  for (const [index, report] of reports.entries()) {
    const scope = routeEvent(report, owner);
    if (!scope) throw new Error("DEBUGSHARE was not routed");
    expect(scope.private).toBe(false);
    const june = client.conversation.getOrCreate(scope.key);
    await june.receive(report);
    await expect
      .poll(() => snapshots.length, { timeout: 15000 })
      .toBe(index + 1);
    await june.receive(report);
    await june.resumeSessionCommands();
    const snapshot = snapshots[index];
    if (!snapshot) throw new Error("DEBUGSHARE was not captured");
    expect(snapshot.scope).toEqual(scope.key);
    expect(snapshot.reporter).toEqual({
      channel: "slack",
      accountId: "T1",
      senderId: report.senderId,
      isOwner: [0, 4, 5].includes(index),
    });
    expect(snapshot.reason).toBe(
      report.text.slice(11).replace("xoxb-secret", "[redacted]"),
    );
    await expect
      .poll(
        () =>
          sent.filter((out) =>
            JSON.stringify(out.content).includes(`T-${snapshot.id}`),
          ).length,
        { timeout: 15000 },
      )
      .toBe(1);
    const origin = sent.filter(
      (out) => out.address.conversationId === report.address.conversationId,
    );
    const ownerReport = report.senderId === "U1";
    expect(origin).toHaveLength(ownerReport ? 2 : 1);
    expect(origin[0]?.address).toEqual(report.address);
    expect(JSON.stringify(origin)).toContain(snapshot.id);
    expect(JSON.stringify(origin[0])).not.toMatch(
      /reason|ampcode\.com|findings|xoxb-/,
    );
    if (ownerReport) {
      expect(origin[1]?.address).toEqual({
        ...report.address,
        threadId:
          report.address.threadId ??
          `ack-${report.address.conversationId}-${snapshot.id}`,
      });
      expect(origin[1]?.content).toEqual({
        type: "text",
        text: `<@U1> Amp investigation: https://ampcode.com/threads/T-${snapshot.id}`,
      });
    }
    const privateMessages = sent.filter(
      (out) =>
        out.address.conversationId === "U1" &&
        (JSON.stringify(out.content).includes(snapshot.id) ||
          out.address.threadId === `ack-U1-${snapshot.id}`),
    );
    expect(privateMessages).toHaveLength(ownerReport ? 1 : 2);
    expect(privateMessages[0]?.address.threadId).toBeUndefined();
    if (!ownerReport)
      expect(privateMessages[1]?.address.threadId).toBe(
        report.senderId === "U2" ? undefined : `ack-U1-${snapshot.id}`,
      );
    expect(JSON.stringify(privateMessages)).toContain(snapshot.reason);
    expect(JSON.stringify(privateMessages)).toContain(
      ownerReport ? "Reason (owner request):" : "Reason (untrusted):",
    );
    expect(JSON.stringify(privateMessages)).not.toContain("xoxb-secret");
    expect(await june.debugShares()).toEqual([]);
  }
  expect(snapshots).toHaveLength(6);
  const ownerJune = client.conversation.getOrCreate(["private", "owner"]);
  expect((await ownerJune.debugShares()).map((entry) => entry.id)).toEqual(
    snapshots.map((snapshot) => snapshot.id),
  );
}, 60_000);

it.for(["DEBUGSHARE", "DEBUG"])(
  "automatically retries a bounded %s owner copy after Slack's deadline without investigation",
  async (command, t) => {
    const attempts: { at: number; text: string; id: string }[] = [];
    const run = vi.fn(async () => {
      throw new Error("No investigation");
    });
    const inspect = vi.fn(async () => ({
      status: "running" as const,
      threadId: "T-forbidden",
    }));
    const slack = createSlackAdapter({
      signingSecret: "fixture",
      botToken: "fixture",
      teamId: "T1",
      botUserId: "BOT",
      ownerUserIds: ["U1"],
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.channel === "U1") {
          attempts.push({
            at: Date.now(),
            text: body.text,
            id: body.client_msg_id,
          });
          if (attempts.length === 1)
            return new Response("", {
              status: 429,
              headers: { "retry-after": "6" },
            });
        }
        return Response.json({ ok: true, ts: "123.4" });
      },
    });
    const registry = createJuneRegistry({
      owner,
      channels: { slack },
      ...(command === "DEBUG"
        ? { debugShare: { resumeSafe: true, run, inspect } }
        : {}),
      model: {
        async reply() {
          throw new Error("No inference");
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const report: MessageEvent = {
      ...message("long-report", `${command} ${"r".repeat(39950)}`),
      senderId: "U2",
      direct: false,
      address: { channel: "slack", accountId: "T1", conversationId: "C1" },
      metadata: { channelType: "channel" },
    };
    const scope = routeEvent(report, owner);
    if (!scope) throw new Error("Guest report was not routed");
    const june = client.conversation.getOrCreate(scope.key);
    await june.receive(report);
    await expect.poll(() => attempts.length, { timeout: 20000 }).toBe(2);
    expect(attempts[1]?.id).toBe(attempts[0]?.id);
    expect(
      (attempts[1]?.at ?? 0) - (attempts[0]?.at ?? 0),
    ).toBeGreaterThanOrEqual(6000);
    expect(attempts[0]?.text).toContain(
      "[truncated; full reason in private snapshot]",
    );
    expect(attempts[0]?.text.length).toBeLessThan(40000);
    const ownerJune = client.conversation.getOrCreate(["private", "owner"]);
    expect((await ownerJune.debugShares())[0]?.status).toBe(
      command === "DEBUG" ? "saved" : "unavailable",
    );
    await expect
      .poll(
        async () =>
          Object.values((await june.snapshot()).sessionCommands ?? {})[0]
            ?.debugLink?.pollAt,
      )
      .toBeUndefined();
    await june.receive(report);
    await june.resumeSessionCommands();
    expect(attempts).toHaveLength(2);
    expect(run).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    if (command === "DEBUG") {
      expect(attempts[0]?.text).toContain("No Amp investigation was started.");
      expect(JSON.stringify(attempts)).not.toContain("ampcode.com");
      const receipt = Object.values(
        (await june.snapshot()).sessionCommands ?? {},
      )[0];
      expect(receipt?.debugLink).toMatchObject({ ownerOnly: true });
      expect(receipt?.debugLink?.delivery).toBeUndefined();
    }
  },
);

it("keeps the newest ten captures when older publications arrive late or replay", async (t) => {
  const registry = createJuneRegistry({
    owner,
    channels: {},
    model: {
      async reply() {
        return { text: "unused" };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "owner"]);
  const captures = Array.from({ length: 11 }, (_, i) => ({
    id: `capture-${i}`,
    capturedAt: new Date(i * 1000).toISOString(),
  }));
  for (const capture of captures.slice(1)) await june.trackDebugShare(capture);
  const oldest = captures[0];
  if (!oldest) throw new Error("Missing oldest capture fixture");
  await june.trackDebugShare(oldest);
  await june.trackDebugShare(oldest);
  expect((await june.snapshot()).debugShareIndex).toEqual(captures.slice(1));
});

it("keeps serialized command publication alive beyond action and idle deadlines", async (t) => {
  const ack = Promise.withResolvers<void>();
  t.onTestFinished(() => ack.resolve());
  const lifecycle = createLifecycle();
  const sent: OutboundMessage[] = [];
  let asleep = false;
  const registry = createJuneRegistry({
    owner,
    lifecycle,
    model: {
      async reply() {
        return { text: "unused" };
      },
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        receive: async () => ({ events: [], response: new Response() }),
        async send(outbound) {
          sent.push(outbound);
          if (sent.length === 1) await ack.promise;
          return { status: "sent", messageId: "sent" };
        },
      },
    },
  });
  const config = registry.config.use.conversation.config;
  config.options = {
    ...config.options,
    actionTimeout: 2_000,
    sleepTimeout: 500,
  };
  config.onSleep = () => {
    asleep = true;
  };
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "owner"]);
  const first = message("first-command", "CLEARHISTORY");
  let admitted = false;
  const admission = june.receive(first).then(() => {
    admitted = true;
  });
  // Attach rejection handling immediately, including on the buggy implementation.
  void admission.catch(() => {});
  await expect.poll(() => sent.length, { timeout: 15_000 }).toBe(1);
  await expect.poll(() => admitted, { timeout: 1_000 }).toBe(true);
  await june.receive(message("second-command", "CLEARHISTORY"));
  await Promise.all([
    june.resumeSessionCommands(),
    june.resumeSessionCommands(),
  ]);
  // No actor polling/connections to hide ordinary idle sleep during this wait.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(asleep).toBe(false);
  expect(sent).toHaveLength(1);
  expect(lifecycle.ready).toBe(true);
  expect(await lifecycle.drain(20)).toBe(false);
  ack.resolve();
  await admission;
  await expect.poll(() => sent.length, { timeout: 15_000 }).toBe(2);
  await expect.poll(() => lifecycle.active, { timeout: 15_000 }).toBe(0);
  await june.receive(first);
  await june.resumeSessionCommands();
  await expect.poll(() => lifecycle.active, { timeout: 15_000 }).toBe(0);
  expect(new Set(sent.map((entry) => entry.id)).size).toBe(2);
  expect(sent).toHaveLength(2);
  expect(lifecycle.ready).toBe(true);
  expect(await lifecycle.drain()).toBe(true);
  lifecycle.resume();
});

it("resumes large debug transfers after lost acknowledgments without replacing or reinvestigating snapshots", async (t) => {
  const snapshots: DebugSnapshot[] = [];
  const registry = createJuneRegistry({
    owner,
    model: {
      async reply() {
        return { text: "unused" };
      },
    },
    channels: {},
    debugShare: {
      async run(snapshot) {
        snapshots.push(snapshot);
        return { threadId: "T-fixture", report: "checked" };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const snapshot: DebugSnapshot = {
    id: "large-snapshot",
    sessionId: "session",
    capturedAt: "2026-09-28T00:00:00Z",
    revision: "fixture",
    scope: ["private", "owner"],
    reason: "fixture",
    data: { text: '🌻"\\\n'.repeat(140000) },
    exclusions: [],
  };
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(1048576);
  const target = client.debugShare.getOrCreate([snapshot.id]);
  let first: DebugSnapshotChunk | undefined;
  await expect(
    publishDebugSnapshot(snapshot, async (chunk) => {
      first ??= chunk;
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(65536);
      const result = await target.startChunk(chunk);
      if (chunk.index === 2) throw new Error("lost chunk acknowledgment");
      return result;
    }),
  ).rejects.toThrow("lost chunk acknowledgment");
  expect(snapshots).toHaveLength(0);
  if (!first) throw new Error("Missing first chunk");
  for (const invalid of [
    { ...first, id: "different" },
    { ...first, index: 4 },
    { ...first, totalBytes: -1 },
    { ...first, sha256: "0".repeat(64) },
    { ...first, data: "!invalid-base64" },
    { ...first, data: Buffer.alloc(32768, 42).toString("base64") },
  ])
    await expect(target.startChunk(invalid)).rejects.toThrow();
  expect(snapshots).toHaveLength(0);
  const resumed: number[] = [];
  await expect(
    publishDebugSnapshot(snapshot, async (chunk) => {
      resumed.push(chunk.index);
      const result = await target.startChunk(chunk);
      if (result.complete) throw new Error("lost final acknowledgment");
      return result;
    }),
  ).rejects.toThrow("lost final acknowledgment");
  expect(resumed.slice(0, 2)).toEqual([0, 3]);
  await expect.poll(() => snapshots.length, { timeout: 15000 }).toBe(1);
  await Promise.all([
    publishDebugSnapshot(snapshot, (chunk) => target.startChunk(chunk)),
    publishDebugSnapshot(snapshot, (chunk) => target.startChunk(chunk)),
  ]);
  expect(snapshots).toEqual([snapshot]);
  await expect
    .poll(async () => (await target.inspect()).status)
    .toBe("completed");
  await expect(
    target.startChunk({ ...first, sha256: "0".repeat(64) }),
  ).rejects.toThrow();
  expect(snapshots).toHaveLength(1);

  const legacy = { ...snapshot, id: "legacy", data: { text: "small" } };
  const old = client.debugShare.getOrCreate([legacy.id]);
  await old.start(legacy);
  await expect.poll(() => snapshots.length, { timeout: 15000 }).toBe(2);
  await publishDebugSnapshot(legacy, (chunk) => old.startChunk(chunk));
  await old.start(legacy);
  expect(snapshots).toEqual([snapshot, legacy]);
});

it.for([false, true])(
  "resets before a blocked model finishes without leaking old context (activity sessions: %s)",
  async (activities, t) => {
    const store = new EvidenceStore(":memory:", randomBytes(32));
    t.onTestFinished(() => store.close());
    const sent: OutboundMessage[] = [];
    const requests: ModelRequest[] = [];
    let resetAt: number | undefined;
    const blocked = Promise.withResolvers<CompanionReply>();
    t.onTestFinished(() => blocked.resolve({ text: "old answer" }));
    const lifecycle = createLifecycle();
    const registry = createJuneRegistry({
      owner,
      lifecycle,
      ...(activities
        ? {
            sessions: { idleMs: 60000 },
            memory: {
              store,
              source: (event: MessageEvent, audience: string) => ({
                id: event.id,
                audiences: [audience],
                platform: "slack" as const,
                account: "T1",
                conversation: "D1",
                author: "U1",
                observedAt: event.occurredAt,
                sourceUrl: "https://example.com/fixture",
                text: event.text,
              }),
            },
          }
        : {}),
      model: {
        async reply(request) {
          requests.push(request);
          return requests.length === 1
            ? blocked.promise
            : { text: "fresh answer" };
        },
      },
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, threads: true, reactions: true },
          receive: async () => ({ events: [], response: new Response() }),
          context: async () => [
            {
              role: "user",
              content: "old platform context",
              source: {
                ...message("old-platform", ""),
                occurredAt: resetAt === undefined ? 1 : resetAt - 1,
              },
            },
            ...(resetAt === undefined
              ? []
              : [resetAt, resetAt + 1].map((occurredAt, offset) => ({
                  role: "user" as const,
                  content: `fresh platform context ${offset}`,
                  source: {
                    ...message(`new-platform-${offset}`, ""),
                    occurredAt,
                  },
                }))),
          ],
          async send(outbound) {
            sent.push(JSON.parse(JSON.stringify(outbound)));
            return { status: "sent", messageId: "sent" };
          },
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(["private", "owner"]);
    await june.receive(message("old", "old question"));
    await expect.poll(() => requests.length, { timeout: 15000 }).toBe(1);
    const ping = message("ping", "PING");
    await june.receive(ping);
    await june.receive(ping);
    await expect.poll(() => sent.length, { timeout: 15000 }).toBe(2);
    expect(requests).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.content).toEqual({ type: "text", text: "PONG" });
    expect(sent[1]?.content).toMatchObject({
      text: expect.stringContaining("PING timing:"),
    });
    const reset = message("reset", "CLEARHISTORY");
    await june.receive(reset);
    await expect
      .poll(() =>
        sent.some(
          (entry) =>
            entry.content.type === "text" &&
            entry.content.text.includes("new session"),
        ),
      )
      .toBe(true);
    const first = await june.snapshot();
    expect(first.session?.id).toMatch(/^[\da-f-]{36}$/);
    resetAt = first.session?.startedAt;
    expect(resetAt).toBeGreaterThan(0);
    await june.receive(reset);
    expect((await june.snapshot()).session?.id).toBe(first.session?.id);
    blocked.resolve({ text: "old answer" });
    await june.receive(message("fresh", "fresh question"));
    await expect
      .poll(
        () =>
          sent.some(
            (entry) =>
              entry.content.type === "text" &&
              entry.content.text === "fresh answer",
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    expect(
      sent.some(
        (entry) =>
          entry.content.type === "text" && entry.content.text === "old answer",
      ),
    ).toBe(false);
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain(
      "old question",
    );
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain(
      "old platform context",
    );
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
      "fresh platform context 0",
    );
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
      "fresh platform context 1",
    );
    expect(lifecycle.ready).toBe(true);
    if (activities)
      expect(
        store.source(JSON.stringify(["private", "owner"]), "old")?.text,
      ).toBe("old question");
  },
);

it.for([
  { activities: false, command: "DEBUGSHARE" },
  { activities: true, command: "DEBUGSHARE" },
  { activities: false, command: "DEBUG" },
  { activities: true, command: "DEBUG" },
])(
  "transfers $command snapshots once and allows reset during a blocked acknowledgment (activity sessions: $activities)",
  async ({ activities, command }, t) => {
    const store = new EvidenceStore(":memory:", randomBytes(32));
    t.onTestFinished(() => store.close());
    const ack = Promise.withResolvers<void>();
    t.onTestFinished(() => ack.resolve());
    const snapshots: DebugSnapshot[] = [];
    const investigations: DebugSnapshot[] = [];
    const sent: OutboundMessage[] = [];
    const answer = activities
      ? "ordinary answer"
      : `ordinary answer ${'☃"\\\n'.repeat(12000)}`;
    const registry = createJuneRegistry({
      owner,
      runningRevision: "fixture-revision",
      ...(activities
        ? {
            sessions: { idleMs: 60000 },
            memory: {
              store,
              source: (event: MessageEvent, audience: string) => ({
                id: event.id,
                audiences: [audience],
                platform: "slack" as const,
                account: "T1",
                conversation: "D1",
                author: "U1",
                observedAt: event.occurredAt,
                sourceUrl: "https://example.com/fixture",
                text: event.text,
              }),
            },
          }
        : {}),
      debugShare: {
        async run(snapshot, _signal, onThread) {
          investigations.push(snapshot);
          await onThread("T-investigation");
          return { threadId: "T-investigation", report: "Investigated" };
        },
      },
      model: {
        async reply() {
          return { text: answer };
        },
      },
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, threads: true, reactions: true },
          receive: async () => ({ events: [], response: new Response() }),
          async send(outbound) {
            sent.push(JSON.parse(JSON.stringify(outbound)));
            if (
              outbound.content.type === "text" &&
              outbound.content.text.startsWith(command)
            )
              await ack.promise;
            return { status: "sent", messageId: "sent" };
          },
        },
      },
    });
    let snapshotSlept = false;
    const debugConfig = registry.config.use.debugShare.config;
    debugConfig.options = { ...debugConfig.options, sleepTimeout: 100 };
    debugConfig.onSleep = () => {
      snapshotSlept = true;
    };
    debugConfig.onStateChange = (c) => {
      const snapshot = c.state.snapshot;
      if (snapshot && !snapshots.some((saved) => saved.id === snapshot.id))
        snapshots.push(JSON.parse(JSON.stringify(snapshot)));
    };
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(["private", "owner"]);
    await june.receive(message("first", "Why did that happen?"));
    await expect.poll(() => sent.length, { timeout: 15000 }).toBe(1);
    const beforeReset = (await june.snapshot()).session?.id;
    const debug = message("debug", `${command} incorrect answer`);
    const sharing = june.receive(debug);
    await expect.poll(() => snapshots.length, { timeout: 15000 }).toBe(1);
    const captured = JSON.stringify(snapshots[0]);
    expect(captured).toContain("fixture-revision");
    expect(captured).toContain("Why did that happen?");
    expect(captured).toContain("incorrect answer");
    expect(captured).toContain("ordinary answer");
    if (!activities) expect(Buffer.byteLength(captured)).toBeGreaterThan(65536);
    expect(captured).toContain(JSON.stringify(answer).slice(1, -1));
    if (command === "DEBUG") {
      expect(snapshots[0]).toMatchObject({ snapshotOnly: true });
      expect(investigations).toHaveLength(0);
    }
    const resetting = june.receive(message("reset", "CLEARHISTORY"));
    await expect
      .poll(async () => (await june.snapshot()).session?.id, { timeout: 15000 })
      .not.toBe(beforeReset);
    ack.resolve();
    await Promise.all([sharing, resetting]);
    await june.receive(debug);
    expect(snapshots).toHaveLength(1);
    await expect
      .poll(async () => (await june.debugShares())[0]?.status)
      .toBe(command === "DEBUG" ? "saved" : "completed");
    const inspection = createInspectionReader({
      audience: JSON.stringify(["private", "owner"]),
      selections: {},
      debugShares: () => june.debugShares(),
    });
    const status = await inspection(
      "debug-shares",
      message("inspect", "status"),
    );
    if (command === "DEBUG") {
      expect(status).toContain('"status":"saved"');
      expect(status).not.toContain("T-investigation");
      expect(investigations).toHaveLength(0);
      const receipt = Object.values(
        (await june.snapshot()).sessionCommands ?? {},
      ).find((receipt) => receipt.snapshotId === snapshots[0]?.id);
      expect(receipt).toMatchObject({ published: true });
      expect(receipt?.debugLink).toBeUndefined();
      expect(receipt?.delivery.message.content).toMatchObject({
        text: expect.stringContaining("No Amp investigation was started."),
      });
      // Repeated publication and actor wake cannot promote a saved snapshot.
      const snapshot = snapshots[0];
      if (!snapshot) throw new Error("Missing snapshot");
      const target = client.debugShare.getOrCreate([snapshot.id]);
      snapshotSlept = false;
      expect((await target.inspect()).status).toBe("saved");
      await expect.poll(() => snapshotSlept, { timeout: 15000 }).toBe(true);
      await publishDebugSnapshot(snapshot, (chunk) => target.startChunk(chunk));
      expect((await target.inspect()).status).toBe("saved");
      expect(investigations).toHaveLength(0);
      // Rivet sanitizes action errors; a transport-size failure has different text.
      await expect(
        publishDebugSnapshot({ ...snapshot, snapshotOnly: false }, (chunk) =>
          target.startChunk(chunk),
        ),
      ).rejects.toThrow("An internal error occurred");
      expect((await target.inspect()).status).toBe("saved");
      expect(investigations).toHaveLength(0);
    } else {
      expect(status).toContain("T-investigation");
      expect(investigations).toHaveLength(1);
    }
    expect(status).not.toContain("Why did that happen?");
    expect(JSON.stringify(snapshots[0])).toBe(captured);
  },
);

it.for(["sent", "unknown", "retry"] as const)(
  "replies to a late DEBUGSHARE thread receipt with the owner mention and preserves %s delivery",
  async (outcome, t) => {
    const sent: OutboundMessage[] = [];
    const snapshots: DebugSnapshot[] = [];
    let threadId: string | undefined;
    let linkAttempts = 0;
    const attemptedAt: number[] = [];
    let failInspection = outcome === "sent";
    const registry = createJuneRegistry({
      owner,
      model: {
        async reply() {
          throw new Error("No inference for DEBUGSHARE");
        },
      },
      debugShare: {
        resumeSafe: true,
        async run(snapshot) {
          snapshots.push(snapshot);
          throw new Error("Observer timed out while dispatcher was queued");
        },
        async inspect() {
          if (threadId && failInspection) {
            failInspection = false;
            throw new Error("Transient receipt read failure");
          }
          return threadId
            ? { status: "running", threadId }
            : { status: "queued" };
        },
      },
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, threads: true, reactions: true },
          receive: async () => ({ events: [], response: new Response() }),
          async send(outbound) {
            sent.push(JSON.parse(JSON.stringify(outbound)));
            if (
              outbound.content.type === "text" &&
              outbound.content.text.includes("https://ampcode.com/threads/")
            ) {
              linkAttempts++;
              attemptedAt.push(Date.now());
              if (outcome === "unknown")
                return { status: "unknown", code: "timeout" };
              if (outcome === "retry" && linkAttempts === 1)
                return {
                  status: "rejected",
                  code: "rate_limited",
                  retryable: true,
                  retryAfterMs: 6000,
                };
            }
            return { status: "sent", messageId: "sent" };
          },
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(["private", "owner"]);
    const debug = message("debug-link", "DEBUGSHARE private reason");
    if (outcome !== "sent") debug.address.threadId = "123.456";
    await june.receive(debug);
    await expect.poll(() => snapshots.length, { timeout: 15000 }).toBe(1);
    expect(snapshots[0]?.reporter).toEqual({
      channel: "slack",
      accountId: "T1",
      senderId: "U1",
      isOwner: true,
    });
    // Snapshot dispatch precedes index persistence and the asynchronous ack.
    await expect.poll(() => sent.length, { timeout: 15000 }).toBe(1);
    threadId = "T-11111111-2222-3333-4444-555555555555";
    await expect
      .poll(() => linkAttempts, { timeout: 20000 })
      .toBe(outcome === "retry" ? 2 : 1);
    const link = sent.at(-1);
    expect(link?.address).toEqual({
      channel: "slack",
      accountId: "T1",
      conversationId: "D1",
      threadId: outcome === "sent" ? "sent" : "123.456",
    });
    expect(link?.content).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        "https://ampcode.com/threads/T-11111111-2222-3333-4444-555555555555",
      ),
    });
    expect(JSON.stringify(link)).toContain("<@U1>");
    expect(JSON.stringify(link)).not.toContain("private reason");
    expect(JSON.stringify(link?.content)).not.toMatch(
      /DEBUGSHARE|Snapshot|queued/,
    );
    expect(JSON.stringify(link?.content)).not.toContain(snapshots[0]?.id);
    await june.receive(debug);
    await june.resumeSessionCommands();
    const status = await june.debugShares();
    expect(status[0]).toMatchObject({
      threadId,
      notification: { status: outcome === "unknown" ? "unknown" : "sent" },
    });
    expect(snapshots).toHaveLength(1);
    expect(linkAttempts).toBe(outcome === "retry" ? 2 : 1);
    if (outcome === "retry") {
      expect(sent[1]?.id).toBe(sent[2]?.id);
      expect(
        (attemptedAt[1] ?? 0) - (attemptedAt[0] ?? 0),
      ).toBeGreaterThanOrEqual(6000);
    }
  },
);

it("waits for the acknowledgment and owner-copy retry before adding a nonrepeating link", async () => {
  const sent: OutboundMessage[] = [];
  const receipt: SessionCommandReceipt = {
    snapshotId: "fixture-snapshot",
    published: true,
    delivery: {
      phase: "sending",
      attempts: 1,
      message: {
        id: "ack",
        lastInboundAt: 0,
        address: { channel: "slack", accountId: "T1", conversationId: "D1" },
        content: { type: "text", text: "DEBUGSHARE fixture-snapshot" },
      },
    },
    debugLink: { pollAt: 1 },
  };
  const deps: Dependencies = {
    owner,
    model: { reply: async () => ({ text: "unused" }) },
    channels: {
      slack: {
        channel: "slack" as const,
        capabilities: { text: true, threads: true, reactions: true },
        receive: async () => ({ events: [], response: new Response() }),
        send: async (outbound: OutboundMessage) => {
          sent.push(structuredClone(outbound));
          return { status: "sent" as const, messageId: "456.789" };
        },
      },
    },
  };
  const persist = async () => {};
  expect(
    await publishDebugNotifications(receipt, "T-fixture", deps, persist),
  ).toBe(true);
  expect(sent).toEqual([]);
  expect(receipt.delivery.phase).toBe("sending");

  receipt.delivery.phase = "settled";
  // Without a confirmed acknowledgment, retain context without resending it.
  for (const result of [
    { status: "unknown", code: "timeout" },
    { status: "rejected", code: "rate_limited", retryable: true },
  ] as const) {
    receipt.delivery.result = result;
    receipt.debugLink = { pollAt: 1 };
    expect(
      await publishDebugNotifications(receipt, "T-fixture", deps, persist),
    ).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.address.threadId).toBeUndefined();
    expect(JSON.stringify(sent[0]?.content)).toContain("fixture-snapshot");
    expect(receipt.delivery.attempts).toBe(1);
    sent.length = 0;
  }
  const ownerAddress = {
    channel: "slack" as const,
    accountId: "T1",
    conversationId: "U1",
  };
  receipt.debugLink = { pollAt: 1, address: ownerAddress };
  receipt.ownerDelivery = {
    phase: "settled",
    attempts: 1,
    message: {
      ...receipt.delivery.message,
      id: "owner-copy",
      address: ownerAddress,
    },
    result: {
      status: "rejected",
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 60000,
    },
    outcomeObservedAt: Date.now(),
  };
  expect(
    await publishDebugNotifications(receipt, "T-fixture", deps, persist),
  ).toBe(true);
  expect(sent).toEqual([]);
  receipt.ownerDelivery.outcomeObservedAt = 0;
  expect(
    await publishDebugNotifications(receipt, "T-fixture", deps, persist),
  ).toBe(false);
  expect(sent).toHaveLength(2);
  expect(sent[1]?.address).toEqual({ ...ownerAddress, threadId: "456.789" });
  expect(JSON.stringify(sent[1]?.content)).not.toContain("fixture-snapshot");
  // A persisted retry/resume never republishes either successful send.
  await publishDebugNotifications(
    structuredClone(receipt),
    "T-fixture",
    deps,
    persist,
  );
  expect(sent).toHaveLength(2);
  const legacyMessage: OutboundMessage = {
    id: "legacy-link",
    lastInboundAt: 0,
    address: ownerAddress,
    content: {
      type: "text",
      text: "<@U1> DEBUGSHARE fixture-snapshot\nAmp investigation: https://ampcode.com/threads/T-legacy",
    },
  };
  receipt.debugLink = {
    pollAt: 1,
    address: ownerAddress,
    delivery: { phase: "ready", attempts: 0, message: legacyMessage },
  };
  await publishDebugNotifications(receipt, "T-fixture", deps, persist);
  expect(sent.at(-1)).toEqual(legacyMessage);
  expect(sent).toHaveLength(3);

  // A successful private copy must not supply a thread ID in a public channel
  // or permit the link to race the still-pending origin acknowledgment.
  receipt.delivery.message.address.conversationId = "C1";
  receipt.delivery.phase = "sending";
  receipt.debugLink = { pollAt: 1, replyAtOrigin: true };
  expect(
    await publishDebugNotifications(receipt, "T-fixture", deps, persist),
  ).toBe(true);
  expect(sent).toHaveLength(3);
  receipt.delivery.phase = "settled";
  receipt.delivery.result = { status: "unknown", code: "timeout" };
  expect(
    await publishDebugNotifications(receipt, "T-fixture", deps, persist),
  ).toBe(false);
  expect(sent.at(-1)?.address).toEqual({
    channel: "slack",
    accountId: "T1",
    conversationId: "C1",
  });
  expect(sent.at(-1)?.content).toEqual({
    type: "text",
    text: "<@U1> DEBUGSHARE fixture-snapshot\nAmp investigation: https://ampcode.com/threads/T-fixture",
  });
  await publishDebugNotifications(
    structuredClone(receipt),
    "T-fixture",
    deps,
    persist,
  );
  expect(sent).toHaveLength(4);
});

it("owns queued DEBUGSHARE notifications beyond action and idle deadlines", async (t) => {
  const blocked = Promise.withResolvers<void>();
  t.onTestFinished(() => blocked.resolve());
  const lifecycle = createLifecycle();
  const links: OutboundMessage[] = [];
  let ready = false;
  let asleep = false;
  const registry = createJuneRegistry({
    owner,
    lifecycle,
    model: {
      reply: async () => {
        throw new Error("No inference for DEBUGSHARE");
      },
    },
    debugShare: {
      resumeSafe: true,
      run: async () => ({
        threadId: "T-11111111-2222-3333-4444-555555555555",
        report: "fixture",
      }),
      inspect: async () =>
        ready
          ? {
              status: "completed",
              threadId: "T-11111111-2222-3333-4444-555555555555",
            }
          : { status: "queued" },
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        receive: async () => ({ events: [], response: new Response() }),
        async send(outbound) {
          if (
            outbound.content.type === "text" &&
            outbound.content.text.includes("https://ampcode.com/threads/")
          ) {
            links.push(JSON.parse(JSON.stringify(outbound)));
            if (links.length === 1) await blocked.promise;
          }
          return { status: "sent", messageId: "sent" };
        },
      },
    },
  });
  const config = registry.config.use.conversation.config;
  config.options = {
    ...config.options,
    actionTimeout: 2000,
    sleepTimeout: 500,
  };
  config.onSleep = () => {
    asleep = true;
  };
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "owner"]);
  await june.receive(message("first-link", "DEBUGSHARE first"));
  await june.receive(message("second-link", "DEBUGSHARE second"));
  const receipts = Object.entries(
    (await june.snapshot()).sessionCommands ?? {},
  );
  expect(receipts).toHaveLength(2);
  asleep = false;
  ready = true;
  const triggers = [...receipts, ...receipts].map(([id, receipt]) => {
    const at = receipt.debugLink?.pollAt;
    if (at === undefined) throw new Error("Missing notification poll");
    return june.notifyDebugShare(id, at);
  });
  const triggered = Promise.all(triggers);
  void triggered.catch(() => {});
  await expect.poll(() => links.length, { timeout: 15000 }).toBe(1);
  await triggered;
  // Only host-side observations during this wait: RPC polling could mask sleep.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  expect(asleep).toBe(false);
  expect(links).toHaveLength(1);
  expect(lifecycle.ready).toBe(true);
  expect(await lifecycle.drain(20)).toBe(false);
  blocked.resolve();
  await expect.poll(() => links.length, { timeout: 15000 }).toBe(2);
  await expect.poll(() => lifecycle.active, { timeout: 15000 }).toBe(0);
  await expect
    .poll(async () =>
      (await june.debugShares()).map((entry) => entry.notification?.status),
    )
    .toEqual(["sent", "sent"]);
  expect(new Set(links.map((link) => link.id)).size).toBe(2);
  expect(lifecycle.ready).toBe(true);
  expect(await lifecycle.drain()).toBe(true);
  lifecycle.resume();
});

it("withholds a delegated search result that completes after reset", async (t) => {
  const search = Promise.withResolvers<void>();
  t.onTestFinished(() => search.resolve());
  const sent: OutboundMessage[] = [];
  let searching = false;
  let finished = false;
  const registry = createJuneRegistry({
    owner,
    model: {
      async reply() {
        return {
          text: "Searching",
          execution: [
            {
              agent: "lookup",
              action: "run" as const,
              task: "Find the answer",
            },
          ],
        };
      },
    },
    execution: {
      model: {
        async reply(request) {
          if (request.messages.length > 2) {
            finished = true;
            return { text: "Done" };
          }
          return { text: "", search: "the answer" };
        },
      },
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        receive: async () => ({ events: [], response: new Response() }),
        async search() {
          searching = true;
          await search.promise;
          return { status: "ready", text: "late search content" };
        },
        async send(outbound) {
          sent.push(JSON.parse(JSON.stringify(outbound)));
          return { status: "sent", messageId: "sent" };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "owner"]);
  await june.receive(message("search", "Find the answer"));
  await expect.poll(() => searching, { timeout: 15000 }).toBe(true);
  await june.receive(message("reset", "CLEARHISTORY"));
  search.resolve();
  await expect.poll(() => finished, { timeout: 15000 }).toBe(true);
  expect(JSON.stringify(sent)).not.toContain("late search content");
});

it("does not export a legacy decision after ordinary memory ingestion prunes its marker", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const snapshots: unknown[] = [];
  const sent: OutboundMessage[] = [];
  const registry = createJuneRegistry({
    owner,
    wakeups: { sources: ["github"], decisionSources: ["github"], pollMs: 100 },
    memory: {
      store,
      source: (event, audience) => ({
        id: event.id,
        audiences: [audience],
        platform: "slack",
        account: "T1",
        conversation: "D1",
        author: "U1",
        observedAt: event.occurredAt,
        sourceUrl: "https://example.com/fixture",
        text: event.text,
      }),
    },
    model: {
      async reply(request) {
        return {
          text: request.system.includes("autonomous event decision")
            ? "EXCLUDED_DECISION_REPLY"
            : "ordinary answer",
        };
      },
    },
    debugShare: {
      async run(snapshot) {
        snapshots.push(snapshot);
        return { threadId: "T-fixture", report: "checked" };
      },
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        receive: async () => ({ events: [], response: new Response() }),
        async send(outbound) {
          sent.push(outbound);
          return { status: "sent", messageId: "sent" };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  await (client as Client<JuneClientRegistry>).wakeups
    .getOrCreate(["owner"])
    .publish({
      id: "provider-1",
      source: "github",
      type: "push",
      occurredAt: Date.now(),
      data: { text: "EXCLUDED_DECISION_INPUT" },
    });
  await expect
    .poll(() => JSON.stringify(sent), { timeout: 15000 })
    .toContain("EXCLUDED_DECISION_REPLY");
  const june = client.conversation.getOrCreate(["private", "owner"]);
  await june.receive(message("ordinary", "hello"));
  await expect
    .poll(() => JSON.stringify(sent), { timeout: 15000 })
    .toContain("ordinary answer");
  await june.receive(message("debug", "DEBUGSHARE"));
  await expect.poll(() => snapshots.length, { timeout: 15000 }).toBe(1);
  expect(JSON.stringify(snapshots)).not.toContain("EXCLUDED_DECISION_REPLY");
  expect(JSON.stringify(snapshots)).not.toContain("EXCLUDED_DECISION_INPUT");
});

it("excludes compacted pre-upgrade notification replies without new flags", () => {
  const source = message("original", "ordinary question");
  const ordinaryId = conversationInputId({ type: "event", event: source });
  const notificationId = conversationInputId({
    type: "wakeup",
    source,
    wakeup: {
      runId: "old-run",
      jobId: "old-job",
      instruction: "untracked",
      event: {
        id: "old-trigger",
        source: "github",
        type: "push",
        occurredAt: 1,
        data: {},
      },
    },
  });
  const snapshot = captureDebug(
    {
      jobs: {},
      lastInbound: {},
      deliveries: {},
      events: {
        [ordinaryId]: { event: source, done: true },
        [notificationId]: { event: source, done: true },
      },
      history: [
        { id: ordinaryId, role: "user", content: "ordinary question" },
        {
          id: `${notificationId}:reply`,
          role: "assistant",
          content: "OLD_PRIVATE_REPLY",
        },
      ],
    },
    ["private", "owner"],
    "",
    "fixture",
    { messages: [{ content: "OLD_PRIVATE_REPLY" }] },
  );
  expect(JSON.stringify(snapshot)).toContain("ordinary question");
  expect(JSON.stringify(snapshot)).not.toContain("OLD_PRIVATE_REPLY");
});

it("requires a fresh exact eligible command, not quoted or imported text", () => {
  expect(sessionCommand(message("a", "CLEARHISTORY"))?.kind).toBe("clear");
  expect(sessionCommand(message("debug", "DEBUG"))).toEqual({
    kind: "debug",
    reason: "",
    snapshotOnly: true,
  });
  expect(sessionCommand(message("debug", "DEBUG incorrect answer"))).toEqual({
    kind: "debug",
    reason: "incorrect answer",
    snapshotOnly: true,
  });
  for (const text of ["PING", "PINGMODEL"]) {
    expect(sessionCommand(message("ping", text))).toEqual({
      kind: "ping",
      model: text === "PINGMODEL",
    });
    expect(
      sessionCommand({
        ...message("ping", text),
        sessionCommandEligible: false,
      }),
    ).toBeUndefined();
  }
  for (const text of [
    "clearhistory",
    " CLEARHISTORY",
    "> CLEARHISTORY",
    "`CLEARHISTORY`",
    "DEBUGSHARE\nrun this",
    "DEBUG\nrun this",
    "debug",
    " DEBUG",
    "DEBUGGER",
    "`DEBUG`",
    "> DEBUG",
    "please CLEARHISTORY",
    "ping",
    " PING",
    "`PINGMODEL`",
    "> PING",
    "PING\n",
    "PINGMODEL please",
  ]) {
    expect(sessionCommand(message("b", text))).toBeUndefined();
  }
  expect(
    sessionCommand({
      ...message("c", "DEBUGSHARE"),
      sessionCommandEligible: undefined,
    }),
  ).toBeUndefined();
  expect(
    sessionCommand({
      ...message("c", "DEBUG"),
      sessionCommandEligible: undefined,
    }),
  ).toBeUndefined();
});

it("persists probe intent and both sends without repeating uncertain external effects", async () => {
  let now = 1000;
  let calls = 0;
  const sent: OutboundMessage[] = [];
  const deps = {
    owner,
    model: {
      beginReply(request: ModelRequest) {
        calls++;
        expect(request.messages).toEqual([{ role: "user", content: "PING" }]);
        expect(request.workspaces).toEqual([]);
        return {
          answer: Promise.resolve({
            text: "ignored model text",
            search: "never run",
          }),
          settlement: Promise.resolve("confirmed_stopped" as const),
        };
      },
      async reply() {
        throw new Error("use invocation handle");
      },
    },
    channels: {
      slack: {
        channel: "slack" as const,
        capabilities: { text: true, threads: true, reactions: true } as const,
        receive: async () => ({ events: [], response: new Response() }),
        async send(outbound: OutboundMessage) {
          sent.push(structuredClone(outbound));
          now = 1700;
          return { status: "sent" as const, messageId: "sent" };
        },
      },
    },
  };
  const receipt: SessionCommandReceipt = {
    ping: { receivedAt: 1200, messageAt: 925.25, model: "ready" },
    delivery: {
      phase: "ready",
      attempts: 0,
      message: {
        id: "pong",
        address: message("ping", "PINGMODEL").address,
        lastInboundAt: 900,
        content: { type: "text", text: "PONG" },
      },
    },
  };
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const persist = async () => {
      if (calls === 0) expect(receipt.ping?.model).toBe("started");
    };
    const publish = async () => {
      throw new Error("not a debug snapshot");
    };
    const run = () =>
      publishSessionCommand(
        receipt,
        deps,
        persist,
        publish,
        new AbortController().signal,
      );
    await run();
    await run();
    expect(calls).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.content).toEqual({ type: "text", text: "PONG" });
    expect(sent[1]?.content).toMatchObject({
      text: expect.stringContaining("500 ms from verified ingress"),
    });
    expect(sent[1]?.content).toMatchObject({
      text: expect.stringContaining("775 ms from Slack message timestamp"),
    });
    expect(sent[1]?.id).not.toBe(sent[0]?.id);
    // Simulate a crash after provider intent and during the first send.
    receipt.ping = { receivedAt: 1200, model: "started" };
    receipt.delivery.phase = "sending";
    delete receipt.delivery.result;
    await run();
    expect(receipt.ping.model).toBe("unknown");
    expect(receipt.delivery).toMatchObject({ result: { status: "unknown" } });
    expect(calls).toBe(1);
    expect(sent).toHaveLength(2);
  } finally {
    clock.mockRestore();
  }
});

it("admits probes independently, deduplicates pending inference, and holds drain through sends and retirement", async (t) => {
  const answer = Promise.withResolvers<CompanionReply>();
  const retirement = Promise.withResolvers<"confirmed_stopped">();
  const sending = Promise.withResolvers<void>();
  t.onTestFinished(() => {
    answer.resolve({ text: "PONG" });
    retirement.resolve("confirmed_stopped");
    sending.resolve();
  });
  let calls = 0;
  const sent: OutboundMessage[] = [];
  const lifecycle = createLifecycle();
  const registry = createJuneRegistry({
    owner,
    lifecycle,
    model: {
      beginReply() {
        calls++;
        return { answer: answer.promise, settlement: retirement.promise };
      },
      async reply() {
        throw new Error("use invocation handle");
      },
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        receive: async () => ({ events: [], response: new Response() }),
        async send(outbound) {
          sent.push(JSON.parse(JSON.stringify(outbound)));
          if (
            outbound.content.type === "text" &&
            outbound.content.text.startsWith("PINGMODEL timing") &&
            sent.length === 4
          ) {
            await sending.promise;
            return {
              status: "rejected",
              retryable: true,
              code: "rate_limited",
            };
          }
          return { status: "sent", messageId: "sent" };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "owner"]);
  const probe = {
    ...message("probe", "PINGMODEL"),
    messageId: "1800000000.812919",
  };
  await june.receive(probe);
  await expect.poll(() => calls).toBe(1);
  await june.receive(probe);
  await june.receive(message("ping", "PING"));
  await expect.poll(() => sent.length).toBe(2);
  expect(calls).toBe(1);
  expect(sent[0]?.content).toEqual({ type: "text", text: "PONG" });
  expect(
    (await june.snapshot()).sessionCommands?.[
      conversationInputId({ type: "event", event: probe })
    ]?.ping?.messageAt,
  ).toBe(1800000000812.919);
  answer.resolve({ text: "not forwarded" });
  await expect.poll(() => sent.length).toBe(4);
  expect(sent[2]?.content).toEqual({ type: "text", text: "PONG" });
  expect(await lifecycle.drain(20)).toBe(false);
  sending.resolve();
  expect(await lifecycle.drain(20)).toBe(false);
  retirement.resolve("confirmed_stopped");
  await expect.poll(() => lifecycle.active).toBe(0);
  expect(await lifecycle.drain(100)).toBe(true);
  lifecycle.resume();
  await june.receive(probe);
  await expect.poll(() => sent.length).toBe(5);
  expect(calls).toBe(1);
  expect(sent[4]?.id).toBe(sent[3]?.id);
  expect(
    sent.filter(
      (item) => item.content.type === "text" && item.content.text === "PONG",
    ),
  ).toHaveLength(2);
});
