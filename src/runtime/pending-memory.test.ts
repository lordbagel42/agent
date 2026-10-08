import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
import { expect, it, onTestFinished } from "vitest";
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
import type { CapabilityContext } from "./capabilities.js";
import { runExecutionCapability } from "./execution-capabilities.js";
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
  expect(view.claimIds).toEqual(proposals.slice(3, 8).map((p) => p.claim.id));
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

it("dispatches scoped June pending views with provenance, denying cross-scope, mixed, synthesis and disabled access", async (t) => {
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
          expect(request.system).toContain(
            "pendingMemory:true lists bounded pending hypotheses in the authenticated audience",
          );
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
  expect(
    Object.values((await june.snapshot()).memoryContexts ?? {}).flatMap(
      (reference) => reference.contextSourceIds ?? [],
    ),
  ).toContain(proposal?.claim.id);
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
    expect(requests.at(-1)?.pendingMemoryAvailable).toBe(true);
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

it("validates exact pending-memory decisions in both schemas and keeps them exclusive", () => {
  const capabilities = { pendingMemoryAvailable: true };
  const schema = replyJsonSchema([], capabilities);
  const validate = new Ajv({ allowUnionTypes: true }).compile(schema);
  const id = `proposal:${"a".repeat(64)}`;
  const decisions = [true, { action: "accept", id }, { action: "reject", id }];
  for (const pendingMemory of decisions) {
    const reply = { text: "", pendingMemory };
    expect(validate({ coding: null, reaction: null, ...reply })).toBe(true);
    expect(parseReply(JSON.stringify(reply), [], capabilities)).toEqual(reply);
    expect(() => parseReply(JSON.stringify(reply), [])).toThrow();
    for (const extra of [
      { text: "Already done" },
      { reaction: "thumbsup" },
      { recall: "hypothesis" },
      { inspection: "memory" },
      { messages: ["Already done"] },
    ])
      expect(() =>
        parseReply(JSON.stringify({ ...reply, ...extra }), [], {
          ...capabilities,
          recallAvailable: true,
          inspectionAvailable: true,
          turnTakingAvailable: true,
        }),
      ).toThrow();
  }
  for (const pendingMemory of [
    false,
    {},
    { action: "list", id },
    { action: "accepted", id },
    { action: "accept" },
    { action: "accept", id: "a".repeat(64) },
    { action: "accept", id: `proposal:${"a".repeat(63)}` },
    { action: "accept", id: `proposal:${"g".repeat(64)}` },
    { action: "accept", id: `${id}\n` },
    { action: "accept", id, audience },
    { action: "reject", id, text: "replacement claim" },
  ]) {
    const reply = { text: "", pendingMemory };
    expect(validate({ coding: null, reaction: null, ...reply })).toBe(false);
    expect(() => parseReply(JSON.stringify(reply), [], capabilities)).toThrow();
  }
  const noAction = {
    text: "",
    coding: null,
    reaction: null,
    pendingMemory: null,
  };
  expect(validate(noAction)).toBe(true);
  expect(parseReply(JSON.stringify(noAction), [], capabilities)).toEqual({
    text: "",
  });
  expect(replyJsonSchema([]).properties).not.toHaveProperty("pendingMemory");
});

function pendingDecisionFixture(
  senderId = "U2",
  channelType: "im" | "channel" = "channel",
) {
  const directory = mkdtempSync(join(tmpdir(), "june-pending-decisions-"));
  const path = join(directory, "memory.db");
  const key = randomBytes(32);
  let store = new EvidenceStore(path, key);
  onTestFinished(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const event: MessageEvent = {
    type: "message",
    id: "review-task",
    messageId: "1.000001",
    occurredAt: Date.now(),
    senderId,
    direct: channelType === "im",
    botMentioned: true,
    text: "Review the pending hypotheses for this task",
    address: {
      channel: "slack",
      accountId: "T1",
      conversationId: channelType === "im" ? "D2" : "C1",
    },
    metadata: { channelType },
  };
  const deps: Dependencies = {
    owner: {
      id: "owner",
      identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
    },
    channels: {},
    model: {
      async reply() {
        throw new Error("Pending decisions do not invoke a nested model");
      },
    },
    memory: { store, source: () => undefined },
  };
  const scope = routeEvent(event, deps.owner);
  if (!scope) throw new Error("Missing task scope");
  const taskAudience = JSON.stringify(scope.key);
  const bound: { sourceIds: string[]; claimIds: string[] }[] = [];
  const unused = (): never => {
    throw new Error("Unexpected unrelated capability");
  };
  const context: CapabilityContext = {
    event,
    scope,
    audience: taskAudience,
    eventId: event.id,
    origin: "event",
    phase: "reply",
    ownerTurn: senderId === "U1",
    deletionRevision: 0,
    personalityVersion: undefined,
    workspaces: [],
    signal: new AbortController().signal,
    valid: () => true,
    model: deps.model,
    deps,
    ports: {
      beginJevObservation: unused,
      personality: { stage: unused, read: unused, pending: unused },
      coding: {
        ids: unused,
        visible: unused,
        job: unused,
        hasProvenance: unused,
        bindReport: unused,
      },
      evidence: {
        sourceIds: () => [],
        async bindRecall() {
          throw new Error("Unexpected recall binding");
        },
        async bindPending(sourceIds, claimIds) {
          bound.push({ sourceIds, claimIds });
        },
      },
      inspectInference: unused,
      deliverRivet: unused,
      waitForTypingCleanup: unused,
      send: unused,
    },
  };
  const scopedSource = {
    ...source,
    id: "scoped-evidence",
    audiences: [taskAudience],
  };
  const uncitedSource = { ...scopedSource, id: "uncited-context" };
  store.appendSource(scopedSource);
  store.appendSource(uncitedSource);
  store.appendSource(source);
  const [proposal, untouched] = store.stageProposals(
    taskAudience,
    [scopedSource.id, uncitedSource.id],
    ["Scoped hypothesis", "Another pending hypothesis"].map((text) => ({
      ...input,
      text,
      subjectSourceId: scopedSource.id,
      citations: [{ sourceId: scopedSource.id, quote: scopedSource.text }],
    })),
  );
  const [ownerProposal] = store.stageProposals(audience, [source.id], [input]);
  if (!proposal || !untouched || !ownerProposal)
    throw new Error("Missing proposal fixture");
  const request: ModelRequest = {
    system: "Review pending memory",
    messages: [],
    workspaces: [],
    agentRole: "execution",
    pendingMemoryAvailable: true,
  };
  return {
    store,
    proposal,
    untouched,
    ownerProposal,
    scopedSource,
    uncitedSource,
    context,
    request,
    bound,
    reopen() {
      store.close();
      store = new EvidenceStore(path, key);
      deps.memory = { store, source: () => undefined };
      return store;
    },
    run(reply: CompanionReply) {
      return runExecutionCapability(
        reply,
        request,
        context,
        deps,
        {} as Parameters<typeof runExecutionCapability>[4],
        [],
        async () => {
          throw new Error("Pending decisions do not require private delivery");
        },
      );
    },
  };
}

it.each([
  ["guest DM", "U2", "im"],
  ["guest channel", "U2", "channel"],
  ["owner channel", "U1", "channel"],
] as const)(
  "%s can choose its own exact pending ID, never an owner-private proposal",
  async (_name, senderId, channelType) => {
    const fixture = pendingDecisionFixture(senderId, channelType);
    const { proposal, untouched, ownerProposal, context, bound, run } = fixture;
    const store = fixture.reopen();
    const before = store.proposals(context.audience);
    const view = await run({ text: "", pendingMemory: true });
    expect(view.terminal).toBe(false);
    const rows = view.text
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    expect(rows.map((row) => row.proposalId)).toEqual([
      proposal.id,
      untouched.id,
    ]);
    expect(view.text).not.toContain(ownerProposal.id);
    expect(view.text).not.toContain(source.text);
    expect(bound).toEqual([
      {
        sourceIds: [fixture.scopedSource.id],
        claimIds: [proposal.claim.id, untouched.claim.id],
      },
    ]);
    expect(store.proposals(context.audience)).toEqual(before);
    expect(store.search(context.audience, "").claims).toEqual([]);

    for (const action of ["accept", "reject"] as const) {
      const denied = await run({
        text: "",
        pendingMemory: { action, id: ownerProposal.id },
      });
      expect(denied.terminal).toBe(true);
      expect(denied.text).not.toContain(input.text);
      expect(store.proposal(audience, ownerProposal.id)?.status).toBe(
        "pending",
      );
    }
    for (const [index, action, status] of [
      [0, "accept", "accepted"],
      [1, "reject", "rejected"],
    ] as const) {
      const id = rows[index]?.proposalId;
      const decision = await run({ text: "", pendingMemory: { action, id } });
      expect(decision.terminal).toBe(true);
      expect(decision.text).toContain(id);
      expect(store.proposal(context.audience, id)?.status).toBe(status);
    }
    expect(store.search(context.audience, "").claims).toEqual([proposal.claim]);
    expect(store.search(audience, "").claims).toEqual([]);
  },
);

it.each([
  ["accept", "accepted", "reject", 1],
  ["reject", "rejected", "accept", 0],
] as const)(
  "%s persists a terminal decision across repeat actions and restart",
  async (action, status, opposite, retained) => {
    const { store, proposal, untouched, context, run, reopen, scopedSource } =
      pendingDecisionFixture();
    const command = { text: "", pendingMemory: { action, id: proposal.id } };
    const first = await run(command);
    expect(first.terminal).toBe(true);
    expect(store.proposal(context.audience, proposal.id)?.status).toBe(status);
    const reopened = reopen();
    expect(await run(command)).toEqual(first);
    const conflicting = await run({
      text: "",
      pendingMemory: { action: opposite, id: proposal.id },
    });
    expect(conflicting.terminal).toBe(true);
    expect(conflicting.text).toMatch(/unavailable|not confirmed/);
    expect(reopened.proposal(context.audience, proposal.id)?.status).toBe(
      status,
    );
    expect(reopened.proposal(context.audience, untouched.id)?.status).toBe(
      "pending",
    );
    expect(reopened.search(context.audience, "").claims).toHaveLength(retained);
    expect(reopened.source(context.audience, scopedSource.id)).toEqual(
      scopedSource,
    );
    const view = await run({ text: "", pendingMemory: true });
    expect(view.terminal).toBe(false);
    expect(view.text).not.toContain(proposal.id);
    expect(view.text).toContain(untouched.id);
  },
);

it.each(["accept", "reject"] as const)(
  "rechecks action admission immediately before a synchronous %s decision",
  async (action) => {
    const { store, proposal, context, run } = pendingDecisionFixture();
    let checks = 0;
    context.canStartAction = () => ++checks === 1;
    const result = await run({
      text: "",
      pendingMemory: { action, id: proposal.id },
    });
    expect(checks).toBe(2);
    expect(result.terminal).toBe(true);
    expect(store.proposal(context.audience, proposal.id)?.status).toBe(
      "pending",
    );
    expect(store.search(context.audience, "").claims).toEqual([]);
  },
);

it("does not accept a listed proposal after an uncited extraction input is deleted", async () => {
  const { store, proposal, context, run, uncitedSource, scopedSource } =
    pendingDecisionFixture();
  expect((await run({ text: "", pendingMemory: true })).text).toContain(
    proposal.id,
  );
  let checks = 0;
  context.canStartAction = () => {
    if (++checks === 2) store.deleteSource(uncitedSource.id);
    return true;
  };
  const result = await run({
    text: "",
    pendingMemory: { action: "accept", id: proposal.id },
  });
  expect(result.terminal).toBe(true);
  expect(result.text).toMatch(/unavailable|not confirmed/);
  expect(store.proposal(context.audience, proposal.id)).toBeUndefined();
  expect(store.search(context.audience, "").claims).toEqual([]);
  expect(store.source(context.audience, scopedSource.id)).toEqual(scopedSource);
});

it("revalidates disabled, mixed and audience-forged decisions before any mutation", async () => {
  const { store, proposal, context, request, run } = pendingDecisionFixture();
  const command = {
    text: "",
    pendingMemory: { action: "accept" as const, id: proposal.id },
  };
  request.pendingMemoryAvailable = false;
  await run(command);
  request.pendingMemoryAvailable = true;
  for (const reply of [
    { ...command, text: "Already done" },
    { ...command, reaction: "thumbsup" },
    { ...command, pendingMemory: { ...command.pendingMemory, audience } },
  ])
    await run(reply);
  expect(store.proposal(context.audience, proposal.id)?.status).toBe("pending");
  expect(store.search(context.audience, "").claims).toEqual([]);
});
