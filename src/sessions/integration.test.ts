import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Client } from "rivetkit/client";
import { expect, it, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  ChannelAdapter,
  CompanionReply,
  MessageEvent,
  ModelInvocation,
  ModelRequest,
  OutboundMessage,
  SendResult,
} from "../core/contracts.js";
import { slackSource } from "../imports/identity.js";
import { EvidenceStore } from "../memory/store.js";
import { conversationInputId } from "../runtime/inbox.js";
import {
  createInspectionReader,
  type OutstandingOperationSnapshot,
} from "../runtime/inspection.js";
import {
  createJuneRegistry,
  type JuneClientRegistry,
} from "../runtime/registry.js";
import { SocialPermissions } from "../runtime/social.js";
import { sessionActorKey } from "./state.js";

it.for([false, true])(
  "handles event decisions in activities and holds unknown effects (%s)",
  async (unknown, t) => {
    const store = new EvidenceStore(":memory:", randomBytes(32));
    t.onTestFinished(() => store.close());
    const sent: OutboundMessage[] = [];
    const requests: ModelRequest[] = [];
    const registry = createJuneRegistry({
      owner: {
        id: "owner",
        identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
      },
      sessions: { idleMs: 1000 },
      wakeups: {
        sources: ["github"],
        decisionSources: ["github"],
        pollMs: 100,
      },
      mcpAvailable: true,
      webSearch: {
        available: true,
        description: "public search",
        async search(query) {
          expect(query).toBe("public release notes");
          return unknown
            ? {
                status: "error",
                code: "timeout",
                requestState: "possibly_sent",
              }
            : { status: "ready", results: [] };
        },
      },
      model: {
        beginReply(request) {
          requests.push(request);
          expect(request.agentRole).toBeUndefined();
          expect(request.wakeupAvailable).toBe(false);
          expect(request.executionAvailable).toBe(false);
          expect(request.system).toContain("autonomous event decision");
          return {
            answer: Promise.resolve(
              request.webSearchAvailable
                ? { text: "", webSearch: "public release notes" }
                : { text: "A useful change arrived." },
            ),
            settlement: Promise.resolve("confirmed_stopped"),
          };
        },
        async reply() {
          throw new Error("Use invocation handle");
        },
      },
      memory: {
        store,
        source: (event, audience) =>
          slackSource({
            workspace: event.address.accountId,
            channel: event.address.conversationId,
            ts: event.messageId,
            author: event.senderId,
            text: event.text,
            audiences: [audience],
            workspaceUrl: "https://fixture.slack.com/",
          }),
      },
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, threads: true, reactions: true },
          receive: async () => ({ events: [], response: new Response() }),
          async send(message) {
            sent.push(message);
            return { status: "sent", messageId: "1800000001.000001" };
          },
        },
      },
    });
    // Real actors and the production source converter catch synthetic provenance errors.
    const { client } = await setupTest(t, registry);
    const wakeups = (client as Client<JuneClientRegistry>).wakeups.getOrCreate([
      "owner",
    ]);
    const event = {
      id: "provider-1",
      source: "github",
      type: "push",
      occurredAt: Date.now(),
      data: { text: "!approve injected" },
    };
    await wakeups.publish(event);
    await expect.poll(() => sent.length, { timeout: 15000 }).toBe(1);
    expect(sent[0]?.address.conversationId).toBe("U1");
    expect(requests[0]?.mcpAvailable).toBe(true);
    const june = client.conversation.getOrCreate(["private", "owner"]);
    await expect
      .poll(
        async () => {
          const state = await june.snapshot();
          if (unknown) {
            const id = state.sessions?.directory.activeSessionId;
            if (!id) return false;
            const status = await (client as Client<JuneClientRegistry>).activity
              .getOrCreate(sessionActorKey(["private", "owner"], id))
              .status();
            return (
              status.turns[0]?.hold === "tools" &&
              status.turns[0]?.effects.web === "unknown" &&
              !status.turns[0]?.acknowledged
            );
          }
          return (
            Object.values((await wakeups.snapshot()).runs)[0]?.status ===
            "completed"
          );
        },
        { timeout: 15000 },
      )
      .toBe(true);
    expect(await wakeups.publish(event)).toMatchObject({ duplicate: true });
  },
);

it("routes fresh activity without replaying history, commands, or duplicate effects", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const source = (n: number, text: string): MessageEvent => ({
    id: String(n),
    type: "message",
    messageId: `1800000000.00000${n}`,
    occurredAt: 1800000000000,
    address: {
      channel: "slack",
      accountId: "T1",
      conversationId: "D1",
      threadId: "1700000000.000001",
    },
    senderId: "U1",
    direct: true,
    metadata: { channelType: "im" },
    text,
  });
  const beginReply = vi.fn(
    (_request: ModelRequest): ModelInvocation => ({
      answer: Promise.resolve({ text: "June's attributed answer" }),
      settlement: Promise.resolve("confirmed_stopped"),
    }),
  );
  const send = vi.fn(
    async (): Promise<SendResult> => ({
      status: "sent",
      messageId: "1800000001.000001",
    }),
  );
  const context = vi.fn(async () => [
    { role: "user" as const, content: "OLD PLATFORM TRANSCRIPT" },
  ]);
  const registry = createJuneRegistry({
    owner: {
      id: "owner",
      identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
    },
    sessions: { idleMs: 1000 },
    wakeups: { sources: ["slack"], pollMs: 100 },
    model: {
      beginReply,
      reply: async () => {
        throw new Error("Use invocation handle");
      },
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        receive: async () => ({ events: [], response: new Response() }),
        send,
        context,
      },
    },
    memory: {
      store,
      source: (event, audience) =>
        slackSource({
          audiences: [audience],
          workspace: "T1",
          channel: "D1",
          ts: event.messageId,
          threadTs: event.address.threadId,
          author: "U1",
          text: event.text,
          workspaceUrl: "https://example.slack.com/",
        }),
    },
  });
  const { client } = await setupTest(t, registry);
  const scope = ["private", "owner"];
  const june = client.conversation.getOrCreate(scope);
  const first = source(1, "FIRST PRIVATE TURN");
  const firstId = conversationInputId({ type: "event", event: first });
  await june.receive(first);
  await vi.waitFor(
    async () =>
      expect(
        (await june.snapshot()).sessions?.directory.receipts[firstId]?.status,
      ).toBe("settled"),
    { timeout: 15000 },
  );
  const firstState = await june.snapshot();
  const firstSession =
    firstState.sessions?.turns[firstId]?.assignment.sessionId;
  if (!firstSession) throw new Error("Missing first session");
  await june.receive(first);
  expect(beginReply).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
  await vi.waitFor(
    async () =>
      expect(
        (await june.snapshot()).sessions?.directory.sessions[firstSession]
          ?.status,
      ).toBe("sealed"),
    { timeout: 10000 },
  );
  const next = source(2, "NEW PRIVATE TURN");
  await june.receive(next);
  const nextId = conversationInputId({ type: "event", event: next });
  await vi.waitFor(
    async () =>
      expect(
        (await june.snapshot()).sessions?.directory.receipts[nextId]?.status,
      ).toBe("settled"),
    { timeout: 10000 },
  );
  expect(beginReply).toHaveBeenCalledTimes(2);
  const request = beginReply.mock.calls[1]?.[0];
  expect(JSON.stringify(request)).not.toContain("FIRST PRIVATE TURN");
  expect(JSON.stringify(request)).not.toContain("OLD PLATFORM TRANSCRIPT");
  expect(request?.agentRole).toBe("interaction");
  expect(context).not.toHaveBeenCalled();
  const nextState = await june.snapshot();
  expect(nextState.sessions?.turns[nextId]?.assignment.sessionId).not.toBe(
    firstSession,
  );
  expect(nextState.history).toEqual([]);
  const archived = store.retrieveSession(JSON.stringify(scope), firstSession);
  expect(
    archived.turns[0]?.data?.entries.map((entry) => entry.content),
  ).toEqual([
    { retention: "retained", text: "FIRST PRIVATE TURN" },
    { retention: "retained", text: "June's attributed answer" },
  ]);
  const control = {
    ...source(3, "!approve 0123456789ab"),
    codingCommandEligible: true,
  };
  await june.receive(control);
  const controlId = conversationInputId({ type: "event", event: control });
  await vi.waitFor(
    async () =>
      expect(
        (await june.snapshot()).sessions?.directory.receipts[controlId]?.status,
      ).toBe("settled"),
    { timeout: 10000 },
  );
  await june.receive(control);
  expect(beginReply).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledTimes(3);
  const saved = await june.snapshot();
  const receipt = saved.sessions?.turns[controlId]?.control;
  if (!receipt) throw new Error("Missing control receipt");
  expect(receipt.input.turn.data.sourceIds).toEqual([]);
  expect(
    receipt.input.turn.data.entries.every(
      (entry) => entry.content.retention === "omitted",
    ),
  ).toBe(true);
  expect(saved.jobs).toEqual({});
  const wakeups = (client as Client<JuneClientRegistry>).wakeups.getOrCreate([
    "owner",
  ]);
  const workerOnly = "worker-recalled-after-dispatch";
  store.appendSource({
    id: workerOnly,
    audiences: [JSON.stringify(scope)],
    platform: "slack",
    account: "T1",
    conversation: "D1",
    author: "U1",
    observedAt: 1,
    sourceUrl: "https://example.invalid/recalled",
    text: "PRIVATE SCHEDULER ANCESTRY",
  });
  expect(JSON.stringify(saved.memoryContexts)).not.toContain(workerOnly);
  await wakeups.manage(
    {
      action: "create",
      name: "Watch one message",
      instruction: "Report this event",
      once: true,
      trigger: {
        kind: "event",
        source: "slack",
        type: "message",
        filters: [{ path: "text", value: "WATCHED" }],
      },
    },
    first,
    "watch",
    [workerOnly],
    firstId,
  );
  const watched = source(4, "WATCHED");
  await june.receive(watched);
  await june.receive(watched);
  await expect
    .poll(
      async () =>
        Object.values((await wakeups.snapshot()).runs).map((run) => run.status),
      { timeout: 15000 },
    )
    .toEqual(["completed"]);
  expect(beginReply).toHaveBeenCalledTimes(4);
  expect(send).toHaveBeenCalledTimes(5);
  const notified = Object.values(
    (await june.snapshot()).sessions?.turns ?? {},
  ).find((turn) => turn.assignment.kind === "notification");
  if (!notified) throw new Error("Missing wakeup assignment");
  expect(notified.context?.reference.contextSourceIds).toContain(workerOnly);
  const triggerId = "slack:T1:D1:1800000000.000004";
  expect(notified.context?.reference.contextSourceIds).toContain(triggerId);
  const run = Object.values((await wakeups.snapshot()).runs)[0];
  expect(run?.contextSourceIds).toContain(triggerId);
  const archivedNotification = () =>
    store
      .retrieveSession(JSON.stringify(scope), notified.assignment.sessionId)
      .turns.find((turn) => turn.eventId === notified.assignment.eventId);
  expect(archivedNotification()?.data?.entries).toEqual([
    expect.objectContaining({
      role: "assistant",
      content: { retention: "retained", text: "June's attributed answer" },
    }),
  ]);
  store.deleteSource(workerOnly);
  expect(archivedNotification()).toBeUndefined();
  await setTimeout(100);
});

it("routes late workers once to current activity, preserves placement, and binds forgetting to the delivered preview", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const scope = ["private", owner.id];
  const audience = JSON.stringify(scope);
  const sent: OutboundMessage[] = [];
  const gate = Promise.withResolvers<void>();
  t.onTestFinished(() => gate.resolve());
  const requests: ModelRequest[] = [];
  let workerStarted = false;
  let cleanupCalls = 0;
  let inspection = "";
  let cleanup: (id: string) => Promise<void>;
  let operations: () => Promise<OutstandingOperationSnapshot>;
  const originalId = "slack:T1:D1:1800000000.000001";
  const registry = createJuneRegistry({
    owner,
    sessions: { idleMs: 5000 },
    inspection: createInspectionReader({
      audience,
      memory: { store },
      selections: {},
      operations: () => operations(),
    }),
    memory: {
      store,
      source: (event, scope) =>
        slackSource({
          audiences: [scope],
          workspace: "T1",
          channel: "D1",
          ts: event.messageId,
          threadTs: event.address.threadId,
          author: "U1",
          text: event.text,
          workspaceUrl: "https://example.slack.com/",
        }),
      forget: async (_audience, id) => {
        cleanupCalls++;
        await cleanup(id);
      },
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        receive: async () => ({ events: [], response: new Response() }),
        send: async (message) => {
          sent.push(JSON.parse(JSON.stringify(message)));
          return {
            status: "sent",
            messageId: `1800000010.00000${sent.length}`,
          };
        },
      },
    },
    execution: {
      model: {
        reply: async (request): Promise<CompanionReply> => {
          const last = request.messages.at(-1)?.content ?? "";
          if (last === "late") {
            workerStarted = true;
            await gate.promise;
            return { text: "LATE WORKER REPORT" };
          }
          if (last === "preview")
            return { text: "", forgetPreview: { sourceId: originalId } };
          if (last === "inspect") return { text: "", inspection: "operations" };
          if (last.includes("!forget-confirm")) return { text: last };
          inspection = last;
          return { text: "Inspected bounded session metadata." };
        },
      },
    },
    model: {
      reply: async () => {
        throw new Error("Handle required");
      },
      beginReply: (request) => {
        requests.push(request);
        const last = request.messages.at(-1)?.content ?? "";
        const reply: CompanionReply = last.includes("Automated completion")
          ? {
              text: last.includes("LATE WORKER REPORT")
                ? "SYNTHESIZED LATE REPORT"
                : "Inspection complete.",
            }
          : last.includes("FRESH ACTIVITY")
            ? { text: "Fresh answer" }
            : {
                text: "Working on it.",
                execution: [
                  {
                    agent: last.includes("preview")
                      ? "preview"
                      : last.includes("inspect")
                        ? "inspect"
                        : "late",
                    action: "run",
                    task: last.includes("preview")
                      ? "preview"
                      : last.includes("inspect")
                        ? "inspect"
                        : "late",
                  },
                ],
              };
        return {
          answer: Promise.resolve(reply),
          settlement: Promise.resolve("confirmed_stopped"),
        };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(scope);
  const source = (
    n: number,
    text: string,
    threadId = "1700000000.000001",
  ): MessageEvent => ({
    type: "message",
    id: String(n),
    messageId: `1800000000.00000${n}`,
    occurredAt: Date.now(),
    text,
    senderId: "U1",
    direct: true,
    address: {
      channel: "slack",
      accountId: "T1",
      conversationId: "D1",
      threadId,
    },
    metadata: { channelType: "im" },
    forgetCommandEligible: true,
  });
  cleanup = (id) => june.forget(id);
  operations = () => june.outstandingOperations();
  const settled = async (event: MessageEvent) => {
    const id = conversationInputId({ type: "event", event });
    await expect
      .poll(
        async () =>
          (await june.snapshot()).sessions?.directory.receipts[id]?.status,
        { timeout: 15000 },
      )
      .toBe("settled");
    return (await june.snapshot()).sessions?.turns[id]?.assignment;
  };
  const first = source(1, "late");
  await june.receive(first);
  const firstAssignment = await settled(first);
  if (!firstAssignment) throw new Error("Missing first assignment");
  await expect.poll(() => workerStarted).toBe(true);
  await expect
    .poll(
      async () =>
        (await june.snapshot()).sessions?.directory.sessions[
          firstAssignment.sessionId
        ]?.status,
      { timeout: 10000 },
    )
    .toBe("sealed");
  const second = source(2, "FRESH ACTIVITY", "1700000000.000099");
  await june.receive(second);
  const secondAssignment = await settled(second);
  expect(secondAssignment?.sessionId).not.toBe(firstAssignment.sessionId);
  gate.resolve();
  await expect
    .poll(
      () =>
        sent.filter(
          (message) =>
            message.content.type === "text" &&
            message.content.text === "SYNTHESIZED LATE REPORT",
        ).length,
      { timeout: 15000 },
    )
    .toBe(1);
  const completed = sent.find(
    (message) =>
      message.content.type === "text" &&
      message.content.text === "SYNTHESIZED LATE REPORT",
  );
  expect(completed?.address).toEqual(first.address);
  await expect
    .poll(async () => (await june.snapshot()).sessions?.directory.inFlight, {
      timeout: 15000,
    })
    .toBeUndefined();
  const saved = await june.snapshot();
  const notification = Object.values(saved.sessions?.turns ?? {}).find(
    (turn) => turn.assignment.kind === "notification",
  );
  expect(notification?.assignment.sessionId).toBe(secondAssignment?.sessionId);
  await june.receive(first);
  expect(
    sent.filter(
      (message) =>
        message.content.type === "text" &&
        message.content.text === "SYNTHESIZED LATE REPORT",
    ),
  ).toHaveLength(1);
  const preview = source(3, "preview");
  await june.receive(preview);
  await settled(preview);
  const previewText = () =>
    sent
      .flatMap((message) =>
        message.content.type === "text" &&
        message.content.text.includes("!forget-confirm")
          ? [message.content.text]
          : [],
      )
      .at(-1);
  await expect
    .poll(previewText, { timeout: 15000 })
    .toContain("!forget-confirm");
  expect(previewText()).toContain("[Archived turns affected:");
  const token = previewText()?.match(/!forget-confirm [a-f0-9]{32}/)?.[0];
  if (!token) throw new Error("Missing delivered token");
  const confirm = source(4, token);
  await june.receive(confirm);
  await settled(confirm);
  expect(store.isDeleted(originalId)).toBe(true);
  expect(cleanupCalls).toBe(1);
  expect(
    store.retrieveSession(audience, firstAssignment.sessionId).turns,
  ).toEqual([]);
  const inspect = source(5, "inspect");
  await june.receive(inspect);
  await settled(inspect);
  await expect
    .poll(() => inspection, { timeout: 15000 })
    .toContain('"sessions"');
  expect(inspection).toContain('"activity"');
  expect(inspection).not.toContain("LATE WORKER REPORT");
  expect(
    requests.filter((request) =>
      JSON.stringify(request).includes("!forget-confirm"),
    ),
  ).toEqual([]);
  await expect
    .poll(async () => (await june.snapshot()).sessions?.directory.inFlight, {
      timeout: 15000,
    })
    .toBeUndefined();
});

it.for(["sent", "unknown"] as const)(
  "does not let a successful command acknowledgment hide %s recipient delivery",
  async (outcome, t) => {
    const directory = await mkdtemp(join(tmpdir(), "june-activity-control-"));
    const store = new EvidenceStore(":memory:", randomBytes(32));
    const owner = {
      id: "owner",
      identities: [
        {
          channel: "slack" as const,
          accountId: "T1",
          senderId: "U1",
        },
      ],
    };
    const send = vi.fn(
      async (message: OutboundMessage): Promise<SendResult> =>
        message.address.conversationId === "U2" && outcome === "unknown"
          ? { status: "unknown", code: "lost_response" }
          : { status: "sent", messageId: "1800000001.000001" },
    );
    const slack: ChannelAdapter = {
      channel: "slack" as const,
      capabilities: { text: true, threads: true, reactions: true },
      receive: async () => ({ events: [], response: new Response() }),
      send,
    };
    const social = new SocialPermissions({
      file: join(directory, "social.db"),
      owner,
      teamId: "T1",
      botUserId: "UBOT",
      slack,
    });
    t.onTestFinished(async () => {
      social.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    });
    const event: MessageEvent = {
      type: "message",
      id: "proposal",
      messageId: "1800000000.000001",
      occurredAt: Date.now(),
      text: "",
      senderId: "U1",
      direct: true,
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    };
    const proposed = await social.propose(event, {
      kind: "outreach",
      userId: "U2",
      text: "Original approved message",
    });
    const id = proposed.match(/[a-f0-9]{24}/)?.[0];
    if (!id) throw new Error("Missing actual proposal");
    const model = vi.fn(async () => ({ text: "Must not infer a command" }));
    const registry = createJuneRegistry({
      owner,
      social,
      sessions: { idleMs: 1000 },
      memory: { store, source: () => undefined },
      channels: { slack },
      model: { reply: model },
    });
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(["private", "owner"]);
    const command = {
      ...event,
      id: "allow",
      messageId: "1800000000.000002",
      text: `!allow ${id}`,
    };
    await june.receive(command);
    const inputId = conversationInputId({ type: "event", event: command });
    await expect
      .poll(
        async () =>
          (await june.snapshot()).sessions?.turns[inputId]?.control?.effects,
        { timeout: 15000 },
      )
      .toBe(outcome === "sent" ? "confirmed" : "unknown");
    await june.receive(command);
    await expect
      .poll(async () => JSON.stringify(await june.outstandingOperations()), {
        timeout: 15000,
      })
      .toContain(outcome === "sent" ? '"inFlight":null' : '"hold":"control"');
    expect(
      send.mock.calls.filter(
        ([message]) => message.address.conversationId === "U2",
      ),
    ).toHaveLength(1);
    expect(model).not.toHaveBeenCalled();
    const state = await june.snapshot();
    expect(state.sessions?.directory.receipts[inputId]?.status).toBe(
      outcome === "sent" ? "settled" : "assigned",
    );
  },
);
