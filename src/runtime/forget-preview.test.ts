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
          expect(request.system).toContain("set forgetPreview");
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
    expect(await deliver(extra)).toContain("requires an owner-private turn");
    expect(requests.at(-1)?.forgetPreviewAvailable).toBe(false);
  }
  phase = "synthesis";
  expect(await deliver()).toContain("requires an owner-private turn");
  expect(requests.at(-1)?.usageStage).toBe("synthesis");
  expect(requests.at(-1)?.forgetPreviewAvailable).toBe(false);
  expect(previewRead).toHaveBeenCalledTimes(1);
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
  expect(previewRead).toHaveBeenCalledTimes(2);
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
    "fingerprint",
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
