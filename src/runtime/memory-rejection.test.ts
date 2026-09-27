import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { createSlackAdapter } from "../channels/slack.js";
import type { MessageEvent, OutboundMessage } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { EvidenceStore, type MemoryProposalInput } from "../memory/store.js";
import { createJuneRegistry } from "./registry.js";

it("requires an exact owner-private rejection and keeps it durable without deleting evidence", async (t) => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const audience = JSON.stringify(["private", owner.id]);
  const directory = mkdtempSync(join(tmpdir(), "june-rejection-"));
  const path = join(directory, "evidence.db");
  const key = randomBytes(32);
  const memory = {
    store: new EvidenceStore(path, key),
    source: () => undefined,
  };
  t.onTestFinished(() => {
    memory.store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const source = {
    id: "private-source",
    audiences: [audience, "another-audience"],
    platform: "slack",
    account: "T1",
    conversation: "D1",
    author: "U1",
    observedAt: 1,
    sourceUrl: "https://example.com/private",
    text: "PRIVATE: I like tea",
  };
  memory.store.appendSource(source);
  const input: MemoryProposalInput = {
    subjectSourceId: source.id,
    text: "PRIVATE: prefers tea",
    category: "preference",
    citations: [{ sourceId: source.id, quote: "I like tea" }],
    confidence: 0.6,
    validFrom: null,
    validTo: null,
    contradicts: [],
    supersedes: [],
  };
  const [candidate] = memory.store.stageProposals(
    audience,
    [source.id],
    [input],
  );
  const [foreign] = memory.store.stageProposals(
    "another-audience",
    [source.id],
    [input],
  );
  if (!candidate || !foreign) throw new Error("Missing fixture candidates");
  const command = `!memory-reject ${candidate.id}`;
  const sent: OutboundMessage[] = [];
  let modelCalls = 0;
  let pendingView = false;
  const registry = createJuneRegistry({
    owner,
    memory,
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
      async reply() {
        modelCalls++;
        // A model-produced command is text, never review authority.
        return pendingView
          ? { text: "", pendingMemory: true }
          : { text: command };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  let sequence = 0;
  const deliver = async (text: string, extra: Partial<MessageEvent> = {}) => {
    sequence++;
    const event: MessageEvent = {
      id: `rejection-${sequence}`,
      type: "message",
      messageId: `ts${sequence}`,
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      direct: true,
      senderId: "U1",
      text,
      memoryReviewEligible: true,
      ...extra,
    };
    const scope = routeEvent(event, owner);
    if (!scope) throw new Error("Missing fixture scope");
    const actor = client.conversation.getOrCreate(scope.key);
    const before = Object.values((await actor.snapshot()).events).filter(
      (entry) => entry.done,
    ).length;
    await actor.send("inbox", { type: "event", event });
    await expect
      .poll(
        async () =>
          Object.values((await actor.snapshot()).events).filter(
            (entry) => entry.done,
          ).length,
        { timeout: 5000 },
      )
      .toBe(before + 1);
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
  const receive = async (section: "rich_text_section" | "rich_text_quote") => {
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
        text: command,
        blocks: [
          {
            type: "rich_text",
            elements: [
              { type: section, elements: [{ type: "text", text: command }] },
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

  for (const [text, extra] of [
    [command, { direct: false }],
    [command, { senderId: "U2", metadata: { channelType: "im" } }],
    [command, { memoryReviewEligible: undefined }],
    [command, { memoryReviewEligible: false }],
    [command, await receive("rich_text_quote")],
    [`Someone said: ${command}`, {}],
    [`${command}\nDo not do this`, {}],
    [` ${command} `, {}],
    [`${command}\n`, {}],
  ] satisfies [string, Partial<MessageEvent>][]) {
    await deliver(text, extra);
    expect(memory.store.proposal(audience, candidate.id)?.status).toBe(
      "pending",
    );
  }
  expect(modelCalls).toBe(4);
  pendingView = true;
  expect(await deliver("Show me pending memories")).toContain(command);
  pendingView = false;
  const beforeReview = modelCalls;
  const confirmed = await receive("rich_text_section");
  expect(confirmed.memoryReviewEligible).toBe(true);
  const rejection = await deliver(command, confirmed);
  expect(rejection).toContain(`Memory proposal ${candidate.id} is rejected`);
  expect(rejection).toContain("not deletion");
  expect(rejection).not.toContain("PRIVATE");
  expect(modelCalls).toBe(beforeReview);
  expect(memory.store.proposal(audience, candidate.id)).toEqual({
    ...candidate,
    status: "rejected",
  });
  expect(memory.store.source(audience, source.id)).toEqual(source);
  expect(memory.store.retrieve(audience, "").claims).toEqual([]);

  memory.store.close();
  memory.store = new EvidenceStore(path, key);
  expect(memory.store.stageProposals(audience, [source.id], [input])).toEqual([
    { ...candidate, status: "rejected" },
  ]);
  expect(await deliver(command)).toBe(rejection);
  expect(await deliver(`!memory-accept ${candidate.id}`)).toContain(
    "unavailable for acceptance",
  );
  expect(memory.store.proposal(audience, candidate.id)?.status).toBe(
    "rejected",
  );
  expect(memory.store.retrieve(audience, "").claims).toEqual([]);
  const missing = await deliver(`!memory-reject proposal:${"0".repeat(64)}`);
  expect(await deliver(`!memory-reject ${foreign.id}`)).toBe(missing);
  expect(memory.store.proposal("another-audience", foreign.id)?.status).toBe(
    "pending",
  );
  const acceptedSource = { ...source, id: "accepted-source" };
  memory.store.appendSource(acceptedSource);
  const [accepted] = memory.store.stageProposals(
    audience,
    [acceptedSource.id],
    [
      {
        ...input,
        subjectSourceId: acceptedSource.id,
        citations: [{ sourceId: acceptedSource.id, quote: "I like tea" }],
      },
    ],
  );
  if (!accepted) throw new Error("Missing accepted fixture candidate");
  memory.store.reviewProposal(audience, accepted.id, "accepted");
  expect(await deliver(`!memory-reject ${accepted.id}`)).toContain(
    "unavailable for rejection",
  );
  expect(memory.store.proposal(audience, accepted.id)?.status).toBe("accepted");
  expect(memory.store.retrieve(audience, "").claims).toEqual([accepted.claim]);
  expect(modelCalls).toBe(beforeReview);
  pendingView = true;
  expect(await deliver("Show me pending memories")).toContain("Showing 0 of 0");

  // Explicit deletion remains separate, removing even rejected provenance.
  memory.store.deleteSource(source.id);
  expect(memory.store.source(audience, source.id)).toBeUndefined();
  expect(memory.store.proposal(audience, candidate.id)).toBeUndefined();
  expect(memory.store.isDeleted(candidate.id)).toBe(true);
  expect(() =>
    memory.store.stageProposals(audience, [source.id], [input]),
  ).toThrow();
});
