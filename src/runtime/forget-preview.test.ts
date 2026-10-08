import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { createJuneRegistry } from "./registry.js";

it("accepts an explicit exact-preview deletion decision without treating a preview as deletion", () => {
  const command = { sourceId: "target", apply: "a".repeat(64) };
  expect(
    parseReply(JSON.stringify({ text: "", forgetPreview: command }), [], {
      forgetPreviewAvailable: true,
    }).forgetPreview,
  ).toEqual(command);
  expect(() =>
    parseReply(
      JSON.stringify({
        text: "",
        forgetPreview: {
          ...command,
          apply: "invented",
        },
      }),
      [],
      { forgetPreviewAvailable: true },
    ),
  ).toThrow();
});

for (const execution of [false, true])
  it(`lets June select scoped forgetting from a guest channel (execution: ${execution})`, async (t) => {
    const owner = {
      id: "owner",
      identities: [
        { channel: "slack" as const, accountId: "T1", senderId: "U1" },
      ],
    };
    const event: MessageEvent = {
      id: "forget-task",
      type: "message",
      messageId: "100.1",
      occurredAt: Date.now(),
      address: {
        channel: "slack",
        accountId: "T1",
        conversationId: "C1",
        threadId: "99.1",
      },
      senderId: "U2",
      direct: false,
      botMentioned: true,
      metadata: { channelType: "channel" },
      text: "Forget the selected memory",
    };
    const scope = routeEvent(event, owner);
    if (!scope) throw new Error("Missing guest scope");
    const audience = JSON.stringify(scope.key);
    const store = new EvidenceStore(":memory:", randomBytes(32));
    t.onTestFinished(() => store.close());
    store.appendSource({
      id: "target",
      audiences: [audience],
      platform: "slack",
      account: "T1",
      conversation: "C1",
      author: "U2",
      observedAt: 1,
      sourceUrl: "https://example.com/source",
      text: "PRIVATE BODY",
    });
    const sent: OutboundMessage[] = [];
    const cleanup = vi.fn(async (_audience: string, id: string) => {
      expect(_audience).toBe(audience);
      expect(store.isDeleted(id)).toBe(true);
      await client.conversation.getOrCreate(scope.key).forget(id);
    });
    const fingerprint = store.previewForget(audience, "target", {
      includeArchives: true,
    })?.fingerprint;
    if (!fingerprint) throw new Error("Missing preview");
    let apply = "0".repeat(64);
    const model = {
      async reply(request: ModelRequest): Promise<CompanionReply> {
        if (!request.forgetPreviewAvailable) return { text: "" };
        return { text: "", forgetPreview: { sourceId: "target", apply } };
      },
    };
    const registry = createJuneRegistry({
      owner,
      memory: { store, source: () => undefined, forget: cleanup },
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, threads: true, reactions: true },
          async receive() {
            return { response: new Response(), events: [] };
          },
          async send(message) {
            sent.push(JSON.parse(JSON.stringify(message)));
            return { status: "sent", messageId: `out${sent.length}` };
          },
        },
      },
      model: execution
        ? {
            async reply(request): Promise<CompanionReply> {
              return request.executionAvailable
                ? {
                    text: "",
                    execution: [
                      {
                        agent: "forgetter",
                        action: "run",
                        task: "Forget the selected source using its exact preview",
                      },
                    ],
                  }
                : { text: "" };
            },
          }
        : model,
      ...(execution
        ? { execution: { model }, sessions: { idleMs: 60_000 } }
        : {}),
    });
    // Crash after the selection save but before notification publication. The
    // same saved body that onWake republishes must already have an ingress ID.
    let interrupted = false;
    const config = registry.config.use.conversation.config;
    if (!("createVars" in config) || !config.createVars)
      throw new Error("Missing vars");
    const createVars = config.createVars;
    config.createVars = async (c, input) => {
      const vars = await createVars(c, input);
      return {
        ...vars,
        persist: async () => {
          await vars.persist();
          if (
            !interrupted &&
            Object.values(c.state.forgetConfirmations ?? {}).some(
              (entry) => entry.runtimeSelected,
            )
          ) {
            interrupted = true;
            throw new Error("Fixture crash before queue publication");
          }
        },
      };
    };
    const { client } = await setupTest(t, registry);
    const june = client.conversation.getOrCreate(scope.key);
    await june.receive(event);
    await expect
      .poll(
        async () =>
          Object.values((await june.snapshot()).events).some((e) => e.done),
        { timeout: 15000 },
      )
      .toBe(true);
    expect(store.isDeleted("target")).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    apply = fingerprint;
    await june.receive({
      ...event,
      id: "apply-task",
      messageId: "100.2",
      occurredAt: Date.now(),
    });
    await expect.poll(() => interrupted, { timeout: 15000 }).toBe(true);
    const saved = await june.snapshot();
    const pending = Object.entries(saved.pendingNotifications ?? {}).find(
      ([, input]) => input.type === "forget_request",
    );
    expect(pending).toBeDefined();
    if (!pending) throw new Error("Missing durable forgetting publication");
    expect(saved.ingress?.receipts[pending[0]]).toBeDefined();
    expect(store.isDeleted("target")).toBe(false);
    await june.send("inbox", pending[1]);
    await expect
      .poll(
        () =>
          sent.some(
            (message) =>
              message.content.type === "text" &&
              message.content.text.includes("host cleanup completed"),
          ),
        { timeout: 20000 },
      )
      .toBe(true);
    expect(store.isDeleted("target")).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sent)).not.toContain("PRIVATE BODY");
    expect(
      sent.every((message) => message.address.conversationId === "C1"),
    ).toBe(true);
    const snapshot = await june.snapshot();
    const token = Object.entries(snapshot.forgetConfirmations ?? {}).find(
      ([, entry]) => entry.runtimeSelected,
    )?.[0];
    expect(token).toBeTruthy();
    await june.send("inbox", {
      type: "forget_request",
      source: event,
      token: token as string,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cleanup).toHaveBeenCalledTimes(1);
  }, 40000);

it("gates June's exact-target preview and never leaks or mutates evidence", async (t) => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const audience = JSON.stringify(["private", owner.id]);
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  for (const [id, audiences] of [
    ["target", [audience]],
    ["FOREIGN", ["foreign"]],
    ["gone", [audience]],
    ["\u0001".repeat(500), [audience]],
  ] as const)
    store.appendSource({
      id,
      audiences: [...audiences],
      platform: "slack",
      account: "T1",
      conversation: "D1",
      author: "U1",
      observedAt: 1,
      sourceUrl: "https://example.com/private",
      text: "SECRET BODY",
    });
  store.deleteSource("gone");
  store.appendClaim({
    id: "PRIVATE DERIVATIVE",
    audiences: [audience],
    entity: "owner",
    kind: "dream",
    dependsOn: ["target"],
    contradicts: [],
    supersedes: [],
    text: "SECRET CLAIM",
  });
  const before = store.search(audience, "");
  const revision = store.deletionRevision();
  const previewRead = vi.spyOn(store, "previewForget");
  const deleteSource = vi.spyOn(store, "deleteSource");
  const requests: ModelRequest[] = [];
  const sent: OutboundMessage[] = [];
  let action: CompanionReply = {
    text: "",
    forgetPreview: { sourceId: "target" },
  };
  let phase = "reply";
  const registry = createJuneRegistry({
    owner,
    memory: { store, source: () => undefined },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          return { status: "sent", messageId: `out-${sent.length}` };
        },
      },
    },
    model: {
      async reply(request) {
        requests.push(request);
        expect(
          Object.hasOwn(
            replyJsonSchema([], request).properties,
            "forgetPreview",
          ),
        ).toBe(request.forgetPreviewAvailable);
        if (request.forgetPreviewAvailable)
          expect(request.system).toContain("forgetPreview:{sourceId}");
        if (phase === "deep" && request.escalationAvailable)
          return { text: "", escalate: true };
        if (phase === "synthesis" && request.webSearchAvailable)
          return { text: "", webSearch: "public query" };
        // Deliberately bypass parser to exercise the host's independent checks.
        return action;
      },
    },
    deepModel: {
      async reply(request) {
        requests.push(request);
        return action;
      },
    },
    webSearch: {
      available: true,
      description: "fixture",
      async search() {
        return {
          status: "ready",
          results: [
            {
              title: "public",
              url: "https://example.com",
              snippet: "public data",
            },
          ],
        };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  let sequence = 0;
  const deliver = async (extra: Partial<MessageEvent> = {}) => {
    const id = `in-${sequence++}`;
    const event: MessageEvent = {
      id,
      type: "message",
      messageId: id,
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      direct: true,
      senderId: "U1",
      text: "Preview forgetting that exact source",
      ...extra,
    };
    const scope = routeEvent(event, owner);
    if (!scope) throw new Error("Invalid fixture event");
    const actor = client.conversation.getOrCreate(scope.key);
    await actor.send("inbox", { type: "event", event });
    await expect
      .poll(
        async () =>
          Object.values((await actor.snapshot()).events).find(
            (entry) => entry.event.id === id,
          )?.done,
        {
          timeout: 5000,
        },
      )
      .toBe(true);
    const content = sent.at(-1)?.content;
    return content?.type === "text" ? content.text : "";
  };
  const report = await deliver();
  expect(report).toContain('"sourceId":"target","sources":1,"claims":1');
  expect(report).toContain('"archivedTurns":0');
  expect(report).toContain('"physicalPurge":false');
  expect(report).toContain("Nothing was deleted or confirmed");
  expect(report).toContain("journals, and backups");
  expect(requests).toHaveLength(1);
  expect(previewRead).toHaveBeenCalledExactlyOnceWith(audience, "target", {
    includeArchives: true,
  });
  for (const extra of [
    {
      direct: false,
      address: {
        channel: "slack" as const,
        accountId: "T1",
        conversationId: "C1",
      },
    },
    { senderId: "U2", metadata: { channelType: "im" as const } },
  ]) {
    expect(await deliver(extra)).toContain("is unavailable");
    expect(requests.at(-1)?.forgetPreviewAvailable).toBe(true);
  }
  phase = "synthesis";
  expect(await deliver()).toContain("requires available memory");
  expect(requests.at(-1)?.usageStage).toBe("synthesis");
  expect(requests.at(-1)?.forgetPreviewAvailable).toBe(false);
  expect(previewRead).toHaveBeenCalledTimes(3);
  phase = "deep";
  expect(await deliver()).toBe(report);
  expect(requests.at(-1)?.forgetPreviewAvailable).toBe(true);
  phase = "reply";
  action = {
    text: "",
    forgetPreview: { sourceId: "target" },
    reaction: "eyes",
  };
  expect(await deliver()).toContain("is unavailable");
  expect(previewRead).toHaveBeenCalledTimes(4);
  const unavailable: string[] = [];
  for (const sourceId of [
    "missing",
    "FOREIGN",
    "gone",
    "PRIVATE DERIVATIVE",
    " target",
    "\u0001".repeat(500),
  ]) {
    action = { text: "", forgetPreview: { sourceId } };
    unavailable.push(await deliver());
  }
  expect(new Set(unavailable).size).toBe(1);
  expect(unavailable[0]).toContain("is unavailable");
  for (const secret of [
    "SECRET",
    "FOREIGN",
    "PRIVATE DERIVATIVE",
    "confirmable",
  ])
    expect(JSON.stringify(sent)).not.toContain(secret);
  expect(store.search(audience, "")).toEqual(before);
  expect(store.deletionRevision()).toBe(revision);
  expect(deleteSource).not.toHaveBeenCalled();

  const capabilities = { forgetPreviewAvailable: true };
  expect(
    parseReply(
      '{"text":"","forgetPreview":{"sourceId":"target"}}',
      [],
      capabilities,
    ).forgetPreview,
  ).toEqual({ sourceId: "target" });
  expect(() =>
    parseReply('{"text":"","forgetPreview":{"sourceId":"target"}}', []),
  ).toThrow();
  expect(replyJsonSchema([]).properties).not.toHaveProperty("forgetPreview");
  for (const forgetPreview of [
    { sourceId: "" },
    { sourceId: "x".repeat(2049) },
    { sourceId: "target", audience: "foreign" },
    { sourceId: "target", confirmed: true },
  ])
    expect(() =>
      parseReply(JSON.stringify({ text: "", forgetPreview }), [], capabilities),
    ).toThrow();
});
