import { createHmac, randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { createSlackAdapter } from "../channels/slack.js";
import type {
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { slackSource, slackSourceId } from "../imports/index.js";
import { EvidenceStore, extractMemory } from "../memory/store.js";
import { createJuneRegistry } from "./registry.js";

it("accepts exact scoped confirmations, never model text, cross-scope or stale authority", async (t) => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const audience = JSON.stringify(["private", owner.id]);
  const foreign = JSON.stringify(["private", "someone-else"]);
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const stage = async (
    scope: string,
    id: string,
    text: string,
    sibling?: string,
  ) => {
    store.appendSource({
      id,
      audiences: [scope],
      platform: "slack",
      account: "T1",
      conversation: "D1",
      author: "U1",
      observedAt: 1,
      sourceUrl: "https://example.com/evidence",
      text: sibling ? `${text}; ${sibling}` : text,
    });
    const [proposal] = await extractMemory(store, scope, [id], async () =>
      (sibling ? [text, sibling] : [text]).map((text) => ({
        subjectSourceId: id,
        text,
        category: "preference",
        citations: [{ sourceId: id, quote: text }],
        confidence: 0.6,
        validFrom: null,
        validTo: null,
        contradicts: [],
        supersedes: [],
      })),
    );
    if (!proposal) throw new Error("Missing fixture proposal");
    return proposal;
  };
  const selected = await stage(
    audience,
    "selected",
    "PRIVATE prefers tea",
    "PRIVATE likes herons",
  );
  const other = store
    .proposals(audience)
    .find((proposal) => proposal.id !== selected.id);
  if (!other) throw new Error("Missing sibling proposal from same extraction");
  const rejected = await stage(audience, "rejected", "PRIVATE rejected claim");
  const deleted = await stage(audience, "deleted", "PRIVATE deleted claim");
  const unauthorized = await stage(foreign, "foreign", "FOREIGN claim");
  store.reviewProposal(audience, rejected.id, "rejected");
  const review = vi.spyOn(store, "reviewProposal");
  const command = `!memory-accept ${selected.id}`;
  const requests: ModelRequest[] = [];
  const sent: OutboundMessage[] = [];
  let listPending = false;
  const registry = createJuneRegistry({
    owner,
    memory: {
      store,
      source: (event, scope) =>
        slackSource({
          workspace: event.address.accountId,
          channel: event.address.conversationId,
          ts: event.messageId,
          author: event.senderId,
          text: event.text,
          workspaceUrl: "https://fixture.slack.com/",
          audiences: [scope],
        }),
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          return { status: "sent", messageId: `out${sent.length}` };
        },
      },
    },
    model: {
      async reply(request) {
        requests.push(request);
        if (listPending) return { text: "", pendingMemory: true };
        // Even exact confirmation syntax emitted by a model is only reply text.
        return { text: command };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  let sequence = 0;
  let lastEvent: MessageEvent | undefined;
  const deliver = async (extra: Partial<MessageEvent> = {}, worker = false) => {
    sequence++;
    const event: MessageEvent = {
      type: "message",
      id: `in${sequence}`,
      messageId: `1800000000.${String(sequence).padStart(6, "0")}`,
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      direct: true,
      senderId: "U1",
      text: command,
      memoryReviewEligible: true,
      ...extra,
    };
    lastEvent = event;
    const scope = routeEvent(event, owner);
    if (!scope) throw new Error("Missing fixture scope");
    const actor = client.conversation.getOrCreate(scope.key);
    const done = () =>
      actor
        .snapshot()
        .then(
          (state) => Object.values(state.events).filter((e) => e.done).length,
        );
    const previous = await done();
    await actor.send(
      "inbox",
      worker
        ? {
            type: "job_result",
            jobId: `job${sequence}`,
            attempt: 1,
            source: event,
            text: command,
          }
        : { type: "event", event },
    );
    await expect.poll(done, { timeout: 5000 }).toBe(previous + 1);
    const content = sent.at(-1)?.content;
    return content?.type === "text" ? content.text : "";
  };
  const ingress = createSlackAdapter({
    teamId: "T1",
    botUserId: "UBOT",
    ownerUserIds: ["U1"],
    signingSecret: "fixture-secret",
    botToken: "fixture-token",
    async fetch() {
      throw new Error("No live Slack calls");
    },
  });
  const receive = async (
    sectionType: "rich_text_section" | "rich_text_quote",
    text = command,
  ) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: `signed${++sequence}`,
      event_time: Number(timestamp),
      event: {
        type: "message",
        user: "U1",
        channel: "D1",
        channel_type: "im",
        ts: `1800000001.${String(sequence).padStart(6, "0")}`,
        text,
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: sectionType,
                elements: [{ type: "text", text }],
              },
            ],
          },
        ],
      },
    });
    const result = await ingress.receive(
      new Request("https://example.com/webhooks/slack", {
        method: "POST",
        body,
        headers: {
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": `v0=${createHmac("sha256", "fixture-secret").update(`v0:${timestamp}:${body}`).digest("hex")}`,
        },
      }),
    );
    expect(result.response.status).toBe(200);
    const event = result.events[0];
    if (event?.type !== "message")
      throw new Error("Missing signed fixture event");
    return event;
  };

  expect(store.retrieve(audience, "").claims).toEqual([]);
  // Admitted public and guest turns cannot accept the owner's scoped proposal.
  expect(
    await deliver({
      direct: false,
      address: { channel: "slack", accountId: "T1", conversationId: "C1" },
      metadata: { channelType: "channel" },
    }),
  ).toContain("unavailable for acceptance");
  expect(
    await deliver({ senderId: "U2", metadata: { channelType: "im" } }),
  ).toContain("unavailable for acceptance");
  expect(review).toHaveBeenCalledTimes(2);
  expect(review.mock.calls.map(([scope]) => scope)).not.toContain(audience);
  expect(store.proposal(audience, selected.id)?.status).toBe("pending");
  review.mockClear();
  for (const memoryReviewEligible of [false, undefined])
    expect(await deliver({ memoryReviewEligible })).toContain(
      "new plain-text Slack message",
    );
  const quoted = await receive("rich_text_quote");
  expect(quoted.memoryReviewEligible).toBe(false);
  expect(await deliver(quoted)).toContain("new plain-text Slack message");
  expect(requests).toHaveLength(0);
  expect(review).not.toHaveBeenCalled();
  expect(JSON.stringify(sent)).not.toContain("PRIVATE");
  for (const text of [
    `> ${command}`,
    `${command}\n!memory-accept ${other.id}`,
    command.slice(0, -1),
    "yes, accept that memory",
  ])
    await deliver({ text });
  for (const text of [` ${command}`, `${command} `, `${command}\n`])
    await deliver(await receive("rich_text_section", text));
  await deliver({}, true);
  expect(requests).toHaveLength(8);
  expect(requests[0]?.system).toContain("!memory-accept proposal:");
  expect(review).not.toHaveBeenCalled();
  expect(store.proposal(audience, selected.id)?.status).toBe("pending");

  listPending = true;
  const listing = await deliver({ text: "Which memory claims await review?" });
  listPending = false;
  expect(listing).toContain(`"acceptCommand":"${command}"`);
  expect(listing).toContain(`"proposalId":"${other.id}"`);
  expect(review).not.toHaveBeenCalled();
  expect(store.proposal(audience, selected.id)?.status).toBe("pending");
  const confirmed = await receive("rich_text_section");
  expect(confirmed.memoryReviewEligible).toBe(true);
  expect(await deliver(confirmed)).toContain(`${selected.id} is accepted`);
  expect(requests).toHaveLength(9);
  expect(review).toHaveBeenLastCalledWith(audience, selected.id, "accepted");
  expect(store.retrieve(audience, "").claims.map((claim) => claim.id)).toEqual([
    selected.id,
  ]);
  expect(store.proposal(audience, other.id)?.status).toBe("pending");
  const confirmation = store.source(
    audience,
    slackSourceId("T1", "D1", confirmed.messageId),
  );
  expect(confirmation).toBeDefined();
  expect(confirmation?.correction).toBeUndefined();
  expect(store.retrieve(foreign, "").claims).toEqual([]);
  const beforeReplay = sent.length;
  if (!lastEvent) throw new Error("Missing fixture event");
  await client.conversation.getOrCreate(["private", owner.id]).send("inbox", {
    type: "event",
    event: lastEvent,
  });
  // A following message is a queue barrier for the duplicate, and an explicit retry.
  expect(await deliver()).toContain(`${selected.id} is accepted`);
  expect(sent).toHaveLength(beforeReplay + 1);
  expect(review).toHaveBeenCalledTimes(2);
  expect(store.retrieve(audience, "").claims.map((claim) => claim.id)).toEqual([
    selected.id,
  ]);

  store.deleteSource("deleted");
  for (const id of [
    unauthorized.id,
    rejected.id,
    deleted.id,
    `proposal:${"0".repeat(64)}`,
  ]) {
    expect(await deliver({ text: `!memory-accept ${id}` })).toContain(
      "unavailable for acceptance",
    );
  }
  expect(store.proposal(foreign, unauthorized.id)?.status).toBe("pending");
  expect(store.proposal(audience, rejected.id)?.status).toBe("rejected");
  expect(store.proposal(audience, deleted.id)).toBeUndefined();
  expect(store.proposal(audience, other.id)?.status).toBe("pending");
  expect(store.retrieve(audience, "").claims.map((claim) => claim.id)).toEqual([
    selected.id,
  ]);
  expect(requests).toHaveLength(9);
  for (const extra of [
    { senderId: "U2", metadata: { channelType: "im" as const } },
    {
      direct: false,
      address: {
        channel: "slack" as const,
        accountId: "T1",
        conversationId: "C1",
      },
      metadata: { channelType: "channel" as const },
    },
  ]) {
    if (!lastEvent) throw new Error("Missing fixture event");
    const routed = routeEvent(
      {
        ...lastEvent,
        direct: true,
        senderId: "U1",
        address: { channel: "slack", accountId: "T1", conversationId: "D1" },
        ...extra,
      },
      owner,
    );
    if (!routed) throw new Error("Missing scoped fixture route");
    const scope = JSON.stringify(routed.key);
    const proposal = await stage(
      scope,
      `scoped-${sequence}`,
      "Scoped preference",
    );
    expect(
      await deliver({ ...extra, text: `!memory-accept ${proposal.id}` }),
    ).toContain(`${proposal.id} is accepted`);
    expect(review).toHaveBeenLastCalledWith(scope, proposal.id, "accepted");
    expect(store.retrieve(scope, "").claims.map((claim) => claim.id)).toEqual([
      proposal.id,
    ]);
    expect(store.proposal(audience, proposal.id)).toBeUndefined();
  }
  expect(requests).toHaveLength(9);
});
