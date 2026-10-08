import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { createJuneRegistry } from "./registry.js";

it("previews public-safe style through June without publishing or exposing private explanations", async (t) => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const event: MessageEvent = {
    type: "message",
    id: "seed",
    messageId: "seed",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    senderId: "U1",
    direct: true,
    metadata: { channelType: "im" },
    personalityCommandEligible: true,
    text: "Preview a personality change without applying it.",
  };
  const proposal = {
    expectedVersion: 1,
    style: {
      tone: "playful" as const,
      verbosity: "concise" as const,
      humor: "none" as const,
      curiosity: "occasional" as const,
    },
  };
  let action: CompanionReply = { text: "", personalityPreview: proposal };
  let search = false;
  const requests: ModelRequest[] = [];
  const sent: OutboundMessage[] = [];
  const registry = createJuneRegistry({
    owner,
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(outbound) {
          sent.push(JSON.parse(JSON.stringify(outbound)));
          return { status: "sent", messageId: `out${sent.length}` };
        },
      },
    },
    model: {
      async reply(request) {
        requests.push(request);
        expect(
          Object.hasOwn(
            replyJsonSchema([], request).properties,
            "personalityPreview",
          ),
        ).toBe(request.personalityPreviewAvailable);
        if (search && request.webSearchAvailable)
          return { text: "", webSearch: "public query" };
        if (request.personalityPreviewAvailable && !action.reaction)
          return parseReply(JSON.stringify(action), [], request);
        // Custom providers must not bypass host gates or mixed-action checks.
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
            { title: "public", url: "https://example.com", snippet: "public" },
          ],
        };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const profile = client.personality.getOrCreate([owner.id]);
  await profile.command({
    ...event,
    text: '!personality revise {"expectedVersion":0,"changes":{"tone":"dry","verbosity":"concise"},"explanation":"PRIVATE reason","publish":true}',
  });
  const before = await profile.read();
  const history = () =>
    profile.command({ ...event, text: "!personality history" });
  const historyBefore = await history();
  let sequence = 0;
  const deliver = async (extra: Partial<MessageEvent> = {}) => {
    const id = `preview-${++sequence}`;
    const next = { ...event, id, messageId: id, ...extra };
    const key = routeEvent(next, owner)?.key;
    if (!key) throw new Error("Invalid fixture route");
    const june = client.conversation.getOrCreate(key);
    await june.send("inbox", { type: "event", event: next });
    await expect
      .poll(
        async () =>
          Object.values((await june.snapshot()).events).some(
            (record) => record.event.id === id && record.done,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    const content = sent.at(-1)?.content;
    return content?.type === "text" ? content.text : "";
  };
  const preview = await deliver();
  expect(requests).toHaveLength(1);
  expect(preview).toContain("tone: dry → playful");
  expect(preview).toContain("humor: subtle → none");
  expect(preview).not.toContain("verbosity:");
  expect(preview).not.toContain("curiosity:");
  expect(preview).toContain("Nothing has been saved");
  expect(preview).toContain("apply:true");
  expect(preview).not.toContain("!personality revise");
  expect(await profile.read()).toEqual(before);
  expect(await history()).toBe(historyBefore);

  for (const extra of [
    { senderId: "U2", address: { ...event.address, conversationId: "D2" } },
    {
      direct: false,
      metadata: { channelType: "channel" as const },
      address: { ...event.address, conversationId: "C1" },
    },
    { metadata: undefined },
  ]) {
    const scopedPreview = await deliver(extra);
    expect(scopedPreview).toContain("tone: dry → playful");
    expect(scopedPreview).not.toContain("PRIVATE reason");
    expect(requests.at(-1)?.personalityPreviewAvailable).toBe(true);
  }
  search = true;
  expect(await deliver()).not.toContain("tone: dry → playful");
  expect(requests.at(-1)?.usageStage).toBe("synthesis");
  expect(requests.at(-1)?.personalityPreviewAvailable).toBe(false);
  search = false;
  action = { text: "", personalityPreview: proposal, reaction: "eyes" };
  expect(await deliver()).toContain("could not be confirmed");
  action = {
    text: "",
    personalityPreview: { expectedVersion: 1, style: before.style },
  };
  expect(await deliver()).toContain("No style changes");
  expect(await profile.read()).toEqual(before);
  expect(await history()).toBe(historyBefore);
  expect(JSON.stringify(sent)).not.toContain("PRIVATE reason");
  expect(() =>
    parseReply(JSON.stringify({ text: "", personalityPreview: proposal }), []),
  ).toThrow();
  for (const invalid of [
    { ...proposal, publish: true },
    { ...proposal, expectedVersion: -1 },
    { ...proposal, style: { ...proposal.style, tone: "PRIVATE evidence" } },
    { ...proposal, style: { ...proposal.style, authority: "all-tools" } },
  ])
    expect(() =>
      parseReply(
        JSON.stringify({ text: "", personalityPreview: invalid }),
        [],
        { personalityPreviewAvailable: true },
      ),
    ).toThrow();

  // The separate actor action publishes only when June explicitly chooses apply.
  await profile.apply(event, { ...proposal, apply: true }, "model-apply", 0);
  expect(await profile.read()).toMatchObject({
    version: 2,
    style: proposal.style,
  });
  action = { text: "", personalityPreview: proposal };
  const stale = await deliver();
  expect(stale).toContain("current version is 2");
  expect(stale).not.toContain("!personality revise {");
  expect((await profile.read()).version).toBe(2);
});
