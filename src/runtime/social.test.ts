import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  ChannelAdapter,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
  Owner,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { RAYGEN_SLACK_ID, type SocialAction } from "../core/social.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { createLifecycle } from "./lifecycle.js";
import { createPriorityAdmission } from "./priority.js";
import { createJuneRegistry } from "./registry.js";
import { SocialPermissions } from "./social.js";

const owner: Owner = {
  id: "raygen",
  identities: [
    { channel: "slack", accountId: "T1", senderId: RAYGEN_SLACK_ID },
  ],
};
const guest: MessageEvent = {
  id: "guest1",
  type: "message",
  occurredAt: Date.now(),
  messageId: "123.456",
  senderId: "UGUEST",
  direct: false,
  botMentioned: true,
  text: "<@UBOT> help?",
  metadata: { channelType: "channel" },
  address: { channel: "slack", accountId: "T1", conversationId: "C1" },
};
const raygen: MessageEvent = {
  ...guest,
  id: "owner1",
  senderId: RAYGEN_SLACK_ID,
  direct: true,
  address: { ...guest.address, conversationId: "DOWNER" },
  metadata: { channelType: "im" },
  text: "Please ask me first.",
};
const access: SocialAction = {
  kind: "request_access",
  userId: "UGUEST",
  conversationId: "C1",
  topic: "public project research",
  sharedContext: "",
  tools: ["webSearch"],
  via: "thread",
};

function fixture(t: { onTestFinished(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "june-social-"));
  const sent: OutboundMessage[] = [];
  const typing: { active: boolean; thread?: string }[] = [];
  const slack: ChannelAdapter = {
    channel: "slack",
    capabilities: { text: true, threads: true, reactions: true },
    async receive() {
      return { response: new Response(), events: [] };
    },
    async send(message) {
      sent.push(JSON.parse(JSON.stringify(message)));
      return { status: "sent", messageId: `out${sent.length}` };
    },
    async setTyping(event, active) {
      typing.push({ active, thread: event.address.threadId });
    },
  };
  let now = Date.now();
  const options = {
    file: join(root, "permissions.sqlite"),
    owner,
    teamId: "T1",
    botUserId: "UBOT",
    slack,
    now: () => now,
  };
  const social = new SocialPermissions(options);
  t.onTestFinished(() => {
    social.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    social,
    sent,
    slack,
    typing,
    options,
    expire: () => {
      now += 31 * 86_400_000;
    },
  };
}

it("lets the owner post directly to chosen Slack destinations once, but rejects guests", async (t) => {
  const { social, sent, options, slack } = fixture(t);
  const action = parseReply(
    JSON.stringify({
      text: "",
      social: {
        kind: "post",
        conversationId: "CDEST",
        threadId: "777.123",
        text: "Hello there.",
      },
    }),
    [],
    { socialAvailable: true },
  ).social;
  if (action?.kind !== "post") throw new Error("missing post action");
  expect(await social.propose(guest, action)).toContain("Only Raygen");
  expect(sent).toEqual([]);
  expect(await social.propose(raygen, action)).toContain("sent");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.address).toEqual({
    channel: "slack",
    accountId: "T1",
    conversationId: "CDEST",
    threadId: "777.123",
  });
  expect(sent[0]?.content).toEqual({ type: "text", text: "Hello there." });
  await social.propose(raygen, action);
  expect(sent).toHaveLength(1);
  slack.send = async (message) => {
    sent.push(message);
    return { status: "unknown", code: "timeout" };
  };
  const uncertain = { ...raygen, id: "uncertain-post" };
  expect(await social.propose(uncertain, action)).toContain("unknown");
  const reopened = new SocialPermissions(options);
  try {
    expect(
      await reopened.propose(uncertain, {
        ...action,
        conversationId: "CDIFFERENT",
        text: "Changed replay payload",
      }),
    ).toContain("unknown");
    expect(sent).toHaveLength(2);
  } finally {
    reopened.close();
  }
});

it("executes June's direct-post tool in one model pass from an owner channel turn", async (t) => {
  const { social, slack, sent } = fixture(t);
  const source = { ...guest, id: "owner-post", senderId: RAYGEN_SLACK_ID };
  let calls = 0;
  const registry = createJuneRegistry({
    owner,
    social,
    channels: { slack },
    model: {
      async reply(request) {
        calls++;
        return parseReply(
          JSON.stringify({
            text: "",
            social: {
              kind: "post",
              conversationId: "UOTHER",
              threadId: null,
              text: "Meet me here.",
            },
          }),
          [],
          request,
        );
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const actor = client.conversation.getOrCreate(["slack", "T1", "C1", ""]);
  await actor.send("inbox", { type: "event", event: source });
  await expect.poll(() => sent.length).toBe(2);
  expect(calls).toBe(1);
  expect(sent[0]?.address).toEqual({
    channel: "slack",
    accountId: "T1",
    conversationId: "UOTHER",
  });
  expect(sent[0]?.content).toEqual({ type: "text", text: "Meet me here." });
  expect(sent[1]?.content).toEqual({
    type: "text",
    text: "Post delivery sent. Slack accepted the message.",
  });
});

it("requires exact owner approval, isolates scope, persists grants, and revokes or expires them", async (t) => {
  const { social, sent, options, expire } = fixture(t);
  const result = await social.propose(guest, access);
  const id = result.match(/[a-f0-9]{24}/)?.[0];
  expect(id).toBeDefined();
  expect(sent[0]?.address).toEqual({
    ...guest.address,
    threadId: guest.messageId,
  });
  expect(social.permits(guest, "webSearch")).toBe(false);
  for (const event of [
    guest,
    { ...raygen, address: { ...raygen.address, accountId: "T2" } },
  ]) {
    expect(await social.decide({ ...event, text: `!allow ${id}` })).toContain(
      "Only Raygen",
    );
  }
  expect(
    social.command({ ...raygen, text: `he said !allow ${id}` }),
  ).toBeNull();
  expect(
    await social.decide({ ...raygen, text: `<@UBOT> !allow ${id}` }),
  ).toContain("Approved access");
  expect(social.permits(guest, "webSearch")).toBe(true);
  expect(social.permits(guest, "deep")).toBe(false);
  expect(social.permits({ ...guest, senderId: "UOTHER" }, "webSearch")).toBe(
    false,
  );
  expect(
    social.permits(
      { ...guest, address: { ...guest.address, conversationId: "C2" } },
      "webSearch",
    ),
  ).toBe(false);
  const reopened = new SocialPermissions(options);
  expect(reopened.permits(guest, "webSearch")).toBe(true);
  reopened.close();
  const fingerprint = social.fingerprint(guest);
  await social.decide({ ...raygen, text: `!revoke ${id}` });
  expect(social.fingerprint(guest)).not.toBe(fingerprint);
  expect(social.permits(guest, "webSearch")).toBe(false);
  expect(await social.decide({ ...raygen, text: `!allow ${id}` })).toContain(
    "already revoked",
  );
  const second = await social.propose(
    { ...raygen, id: "owner2" },
    { ...access, sharedContext: "Only this approved excerpt." },
  );
  const id2 = second.match(/[a-f0-9]{24}/)?.[0];
  expect(sent.at(-1)?.address.conversationId).toBe(RAYGEN_SLACK_ID);
  expect(social.view(guest)).not.toContain("approved excerpt");
  await social.decide({ ...raygen, text: `!allow ${id2}` });
  expect(social.view(guest)).toContain("Only this approved excerpt.");
  expire();
  expect(social.view(guest)).toBe("[]");
});

it("prevents guest sharing/outreach and sends a frozen owner-approved message only once", async (t) => {
  const { social, sent } = fixture(t);
  const outreach: SocialAction = {
    kind: "outreach",
    userId: "UGUEST",
    text: "Approved hello.",
  };
  await social.propose(guest, outreach);
  await social.propose(guest, { ...access, sharedContext: "leaked" });
  await social.propose(guest, { ...access, userId: "UOTHER" });
  expect(sent).toHaveLength(0);
  const pending = await social.propose(raygen, outreach);
  const id = pending.match(/[a-f0-9]{24}/)?.[0];
  await social.propose(raygen, {
    ...outreach,
    text: "Replay must not change this",
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.address.conversationId).toBe(RAYGEN_SLACK_ID);
  await Promise.all([
    social.decide({ ...raygen, text: `!allow ${id}` }),
    social.decide({ ...raygen, text: `!allow ${id}` }),
  ]);
  expect(sent).toHaveLength(2);
  expect(sent[1]?.address.conversationId).toBe("UGUEST");
  expect(sent[1]?.content).toEqual({ type: "text", text: "Approved hello." });
});

it("reserves owner capacity and prioritizes the owner over queued guests without cancelling work", async () => {
  const admission = createPriorityAdmission();
  const signal = new AbortController().signal;
  const firstGuest = await admission.enter(false, signal);
  const order: string[] = [];
  const queuedGuest = admission.enter(false, signal).then((release) => {
    order.push("guest");
    return release;
  });
  const firstOwner = await admission.enter(true, signal);
  const secondOwner = admission.enter(true, signal).then((release) => {
    order.push("owner");
    return release;
  });
  firstGuest?.();
  const secondRelease = await secondOwner;
  expect(order).toEqual(["owner"]);
  secondRelease?.();
  (await queuedGuest)?.();
  firstOwner?.();
  expect(order).toEqual(["owner", "guest"]);
});

it("resumes a journaled guest delivery backoff after that person's admission quota is exhausted", async (t) => {
  const { slack, sent } = fixture(t);
  const lifecycle = createLifecycle();
  let modelCalls = 0;
  let attempts = 0;
  const registry = createJuneRegistry({
    owner,
    lifecycle,
    channels: {
      slack: {
        ...slack,
        async send(message) {
          if (
            message.address.conversationId === "CBACKOFF" &&
            ++attempts === 1
          ) {
            sent.push(JSON.parse(JSON.stringify(message)));
            return {
              status: "rejected",
              code: "rate_limited",
              retryable: true,
              retryAfterMs: 5000,
            };
          }
          return slack.send(message);
        },
      },
    },
    model: {
      async reply() {
        modelCalls++;
        return { text: "one model invocation per admitted turn" };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const first = {
    ...guest,
    address: { ...guest.address, conversationId: "CBACKOFF" },
  };
  const firstActor = client.conversation.getOrCreate(
    routeEvent(first, owner)?.key ?? [],
  );
  await firstActor.send("inbox", { type: "event", event: first });
  await expect.poll(() => attempts, { timeout: 3000 }).toBe(1);
  for (let i = 0; i < 3; i++) {
    const other = {
      ...guest,
      id: `fill${i}`,
      address: { ...guest.address, conversationId: `CFILL${i}` },
    };
    await client.conversation
      .getOrCreate(routeEvent(other, owner)?.key ?? [])
      .send("inbox", { type: "event", event: other });
  }
  await expect.poll(() => modelCalls, { timeout: 4000 }).toBe(4);
  expect(attempts).toBe(1);
  await expect
    .poll(
      async () =>
        Object.values((await firstActor.snapshot()).events).filter(
          (event) => event.done,
        ).length,
      { timeout: 10000 },
    )
    .toBe(1);
  expect(attempts).toBe(2);
  expect(modelCalls).toBe(4);
  const retry = sent.filter(
    (message) => message.address.conversationId === "CBACKOFF",
  );
  expect(retry).toHaveLength(2);
  expect(retry[0]?.id).toBe(retry[1]?.id);
  expect(lifecycle.ready).toBe(true);
});

it("exports provider-compatible social schemas but still validates action limits locally", () => {
  const schema = replyJsonSchema([], { socialAvailable: true });
  const wire = JSON.stringify(schema);
  expect(wire).not.toMatch(/"(?:minLength|maxLength|maxItems|oneOf)":/);
  expect(wire).toContain("maxLength: 3000");
  for (const social of [
    { ...access, topic: "x".repeat(301) },
    { ...access, sharedContext: "x".repeat(3001) },
    { ...access, tools: ["deep", "webSearch", "deep"] },
  ])
    expect(() =>
      parseReply(JSON.stringify({ text: "", social }), [], {
        socialAvailable: true,
      }),
    ).toThrow();
  expect(() =>
    parseReply(JSON.stringify({ text: "", social: access }), []),
  ).toThrow();
});

it("runs June's access-request interface through real Rivet without forcing guest threads", async (t) => {
  const { social, sent, slack, typing } = fixture(t);
  const requests: ModelRequest[] = [];
  const registry = createJuneRegistry({
    owner,
    social,
    channels: { slack },
    webSearch: {
      available: true,
      description: "fake",
      async search() {
        throw new Error("must not run");
      },
    },
    model: {
      async reply(request) {
        requests.push(structuredClone(request));
        expect(request.workspaces).toEqual([]);
        expect(request.searchAvailable).toBe(false);
        expect(request.webSearchAvailable).toBe(requests.length > 1);
        expect(request.socialAvailable).toBe(true);
        expect(replyJsonSchema([], request).properties.social).toBeDefined();
        return requests.length === 1
          ? parseReply(
              JSON.stringify({ text: "", social: access }),
              [],
              request,
            )
          : { text: "We can research that now." };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const scope = routeEvent(guest, owner);
  expect(scope?.private).toBe(false);
  const actor = client.conversation.getOrCreate(scope?.key ?? []);
  await actor.send("inbox", { type: "event", event: guest });
  await expect
    .poll(
      async () =>
        Object.values((await actor.snapshot()).events).every(
          (event) => event.done,
        ),
      { timeout: 5000 },
    )
    .toBe(true);
  await expect.poll(() => sent.length, { timeout: 5000 }).toBe(2);
  const id =
    sent[0]?.content.type === "text"
      ? sent[0].content.text.match(/[a-f0-9]{24}/)?.[0]
      : undefined;
  expect(typing).toContainEqual({ active: true, thread: undefined });
  expect(typing).toContainEqual({ active: false, thread: undefined });
  expect(requests[0]?.system).not.toContain("Owner-private availability:");
  const ownerActor = client.conversation.getOrCreate(["private", owner.id]);
  await ownerActor.send("inbox", {
    type: "event",
    event: { ...raygen, text: `!allow ${id}` },
  });
  await expect
    .poll(() => social.permits(guest, "webSearch"), { timeout: 5000 })
    .toBe(true);
  await actor.send("inbox", {
    type: "event",
    event: { ...guest, id: "guest2", messageId: "123.457" },
  });
  await expect.poll(() => requests.length, { timeout: 5000 }).toBe(2);
  await expect
    .poll(
      () =>
        sent.some(
          (message) =>
            message.content.type === "text" &&
            message.content.text === "We can research that now.",
        ),
      { timeout: 5000 },
    )
    .toBe(true);
  expect(social.view({ ...guest, senderId: "UOTHER" })).toBe("[]");
});
