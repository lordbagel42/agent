import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { createConsoleLoginLinks } from "../console/session.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { pendingMemoryView } from "../memory/pending.js";
import { EvidenceStore, type MemoryProposalInput } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { createInspectionReader } from "./inspection.js";
import { createJuneRegistry, type Dependencies } from "./registry.js";

const audience = '["private","owner"]';
const source = {
  id: "original-evidence",
  audiences: [audience],
  platform: "slack",
  account: "T1",
  conversation: "D1",
  author: "U1",
  observedAt: 1,
  sourceUrl: "https://example.com/private-source",
  text: "PRIVATE ORIGINAL QUOTATION",
};
const input: MemoryProposalInput = {
  subjectSourceId: source.id,
  text: "PRIVATE tentative hypothesis",
  category: "preference",
  citations: [{ sourceId: source.id, quote: source.text }],
  confidence: 0.37,
  validFrom: 11,
  validTo: 29,
  contradicts: [],
  supersedes: [],
};

it("bounds unaccepted claims without leaking other scopes, raw quotes, or active markup", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  store.appendSource(source);
  store.appendSource({ ...source, id: "other", audiences: ["other"] });
  store.stageProposals(
    "other",
    ["other"],
    [
      {
        ...input,
        subjectSourceId: "other",
        citations: [{ sourceId: "other", quote: source.text }],
        text: "OTHER SCOPE",
      },
    ],
  );
  const proposals = store.stageProposals(
    audience,
    [source.id],
    [
      { ...input, text: "accepted" },
      { ...input, text: "rejected" },
      { ...input, text: "x".repeat(4000) },
      ...Array.from({ length: 8 }, (_, i) => ({
        ...input,
        text: `claim ${i} <@U1> <!here> https://example.com/ @everyone`,
      })),
    ],
  );
  for (const [index, status] of (["accepted", "rejected"] as const).entries()) {
    const proposal = proposals[index];
    if (!proposal) throw new Error("Missing proposal");
    store.reviewProposal(audience, proposal.id, status);
  }
  const before = store.proposals(audience);
  const view = pendingMemoryView(store, audience);
  const rows = view.text.split("\n").filter((line) => line.startsWith("{"));
  // Complete accept/reject command IDs leave room for five of these rows.
  expect(rows).toHaveLength(5);
  expect(view.text).toContain("Showing 5 of 9 pending claims; 4 omitted");
  expect(rows.join("\n").length).toBeLessThanOrEqual(3000);
  expect(view.text.length).toBeLessThan(4000);
  expect(rows.map((row) => JSON.parse(row))).toEqual(
    Array.from({ length: 5 }, (_, i) =>
      expect.objectContaining({
        status: "pending",
        rejectCommand: `!memory-reject ${proposals[i + 3]?.id}`,
        text: `claim ${i} <@U1> <!here> https://example.com/ @everyone`,
        confidence: 0.37,
        validFrom: 11,
        validTo: 29,
        sourceIds: [source.id],
      }),
    ),
  );
  for (const forbidden of [
    "OTHER SCOPE",
    source.text,
    source.sourceUrl,
    "<@",
    "<!here>",
    "@everyone",
    "https://",
    '"text":"accepted"',
    '"text":"rejected"',
  ])
    expect(view.text).not.toContain(forbidden);
  expect(view.sourceIds).toEqual([source.id]);
  expect(store.proposals(audience)).toEqual(before);
  const inspection = await createInspectionReader({
    audience,
    memory: { store },
    selections: {},
  })("memory");
  expect(inspection).toContain('"pending":9');
  expect(inspection).not.toContain("claim 0");
  const selectionId = "s".repeat(2048);
  store.beginImport(selectionId, {
    platform: source.platform,
    account: source.account,
    conversations: [source.conversation],
    from: 0,
    to: 2,
    audiences: [audience],
  });
  const progress = store.importProgress(selectionId);
  if (!progress) throw new Error("Missing import fixture");
  store.persistPage(progress, { sources: [source], nextCursor: null }, 1);
  const bounded = pendingMemoryView(store, audience);
  const importedRows = bounded.text
    .split("\n")
    .filter((line) => line.startsWith("{"));
  expect(importedRows).toHaveLength(1);
  expect(importedRows.join("\n").length).toBeLessThanOrEqual(3000);
  expect(
    JSON.parse(importedRows[0] ?? "{}").recordedImports[0].selectionId,
  ).toBe(selectionId);
  expect(bounded.text).toContain("Showing 1 of 9 pending claims; 8 omitted");
  expect(store.proposals(audience)).toEqual(before);
  store.deleteSource(source.id);
  expect(pendingMemoryView(store, audience).text).toContain("Showing 0 of 0");
});

it("dispatches a private June pending view with provenance, rejecting forged, mixed, synthesis and disabled access", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const uncited = {
    ...source,
    id: "uncited-import-input",
    text: "UNCITED INPUT",
  };
  store.beginImport("private-import", {
    platform: source.platform,
    account: source.account,
    conversations: [source.conversation],
    from: 0,
    to: 2,
    audiences: [audience],
  });
  const progress = store.importProgress("private-import");
  if (!progress) throw new Error("Missing import fixture");
  store.persistPage(
    progress,
    { sources: [source, uncited], nextCursor: null },
    1,
  );
  const dashboardLogin = createConsoleLoginLinks("https://june.example");
  const credential = "https://june.example/fixture_sign_in_token_12";
  const [proposal] = store.stageProposals(
    audience,
    [source.id, uncited.id],
    [
      {
        ...input,
        text: `${input.text} ${credential}`,
      },
    ],
  );
  const requests: ModelRequest[] = [];
  const sent: (OutboundMessage & {
    content: { type: "text"; text: string };
  })[] = [];
  let action: CompanionReply = { text: "", pendingMemory: true };
  let inspections = 0;
  let deleteOnSend = false;
  const deps: Dependencies = {
    owner: {
      id: "owner",
      identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
    },
    memory: { store, source: () => undefined },
    dashboardLogin,
    inspection: async () => {
      inspections++;
      return "metadata";
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          if (message.content.type !== "text")
            throw new Error("Unexpected reaction");
          sent.push({ ...message, content: { ...message.content } });
          if (deleteOnSend) {
            store.deleteSource(uncited.id);
            return {
              status: "rejected",
              code: "rate_limited",
              retryable: true,
            };
          }
          return { status: "sent", messageId: `out-${sent.length}` };
        },
      },
    },
    model: {
      async reply(request) {
        requests.push(structuredClone(request));
        expect("pendingMemory" in replyJsonSchema([], request).properties).toBe(
          request.pendingMemoryAvailable,
        );
        if (request.pendingMemoryAvailable)
          expect(request.system).toContain("set pendingMemory to true");
        return request.usageStage === "synthesis"
          ? { text: "", pendingMemory: true }
          : action;
      },
    },
    webSearch: {
      available: true,
      description: "fixture",
      async search() {
        return { status: "ready", results: [] };
      },
    },
  };
  const { client } = await setupTest(t, createJuneRegistry(deps));
  let n = 0;
  const send = async (patch: Partial<MessageEvent> = {}) => {
    const event: MessageEvent = {
      type: "message",
      id: `request-${++n}`,
      messageId: `1.${n.toString().padStart(6, "0")}`,
      occurredAt: Date.now(),
      senderId: "U1",
      direct: true,
      text: "reviewqueue",
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      ...patch,
    };
    const scope = routeEvent(event, deps.owner);
    if (!scope) throw new Error("Missing scope");
    const june = client.conversation.getOrCreate(scope.key);
    const done = async () =>
      Object.values((await june.snapshot()).events).filter(
        (entry) => entry.done,
      ).length;
    const before = await done();
    await june.send("inbox", { type: "event", event });
    await expect.poll(done, { timeout: 20000 }).toBe(before + 1);
    return june;
  };
  const june = await send();
  expect(sent.at(-1)?.content.text).toContain(input.text);
  expect(sent.at(-1)?.content.text).toContain(proposal?.id);
  expect(sent.at(-1)?.content.text).not.toContain(source.text);
  const row = sent
    .at(-1)
    ?.content.text.split("\n")
    .find((line) => line.startsWith("{"));
  expect(JSON.parse(row ?? "{}").text).toBe(
    `${input.text} [dashboard sign-in credential omitted]`,
  );
  expect(JSON.parse(row ?? "{}").recordedImports).toEqual([
    {
      selectionId: "private-import",
      sourceIds: [source.id],
      extractionIds: [],
    },
  ]);
  expect(sent.at(-1)?.content.text).toContain(
    "Exact page attribution is unavailable",
  );
  expect(requests).toHaveLength(1); // Host result, no synthesis invocation.
  expect(
    Object.values((await june.snapshot()).memoryContexts ?? {}).flatMap(
      (reference) => reference.sourceIds,
    ),
  ).toContain(source.id);
  expect(store.proposals(audience)[0]?.status).toBe("pending");
  for (const patch of [
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
    await send(patch);
    expect(requests.at(-1)?.pendingMemoryAvailable).toBe(false);
    expect(sent.at(-1)?.content.text).not.toContain(input.text);
    expect(sent.at(-1)?.content.text).not.toContain("private-import");
  }
  action = { text: "", pendingMemory: true, inspection: "memory" };
  await send();
  expect(requests.at(-1)?.inspectionAvailable).toBe(true);
  expect(inspections).toBe(0);
  expect(sent.at(-1)?.content.text).not.toContain(input.text);
  action = { text: "", webSearch: "public query" };
  await send();
  expect(requests.at(-1)?.usageStage).toBe("synthesis");
  expect(requests.at(-1)?.pendingMemoryAvailable).toBe(false);
  expect(sent.at(-1)?.content.text).not.toContain(input.text);
  action = { text: "", pendingMemory: true };
  deps.memory = undefined;
  await send();
  expect(requests.at(-1)?.pendingMemoryAvailable).toBe(false);
  expect(sent.at(-1)?.content.text).not.toContain(input.text);
  deps.memory = { store, source: () => undefined };
  await send();
  expect(JSON.stringify((await june.snapshot()).history)).toContain(input.text);
  const sendsBeforeDeletion = sent.length;
  const requestsBeforeDeletion = requests.length;
  deleteOnSend = true;
  await send();
  expect(sent).toHaveLength(sendsBeforeDeletion + 1);
  expect(requests).toHaveLength(requestsBeforeDeletion + 1);
  expect(sent.at(-1)?.content.text).toContain(input.text);
  expect(store.source(audience, source.id)).toEqual(source);
  // Deleting an uncited extraction input must suppress retries and copied
  // history even though the displayed citation source still exists.
  expect(JSON.stringify((await june.snapshot()).history)).not.toContain(
    input.text,
  );
  expect(JSON.stringify((await june.snapshot()).history)).not.toContain(
    "private-import",
  );
  deleteOnSend = false;
  await send();
  expect(sent.at(-1)?.content.text).toContain("Showing 0 of 0");
  expect(sent.at(-1)?.content.text).not.toContain("private-import");
  for (const invalid of [
    { text: "not empty", pendingMemory: true },
    { text: "", pendingMemory: false },
    { text: "", pendingMemory: true, audience: "other" },
  ])
    expect(() =>
      parseReply(JSON.stringify(invalid), [], { pendingMemoryAvailable: true }),
    ).toThrow();
  expect(() => parseReply('{"text":"","pendingMemory":true}', [])).toThrow();
}, 60000);
