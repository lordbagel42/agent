import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "rivetkit/client";
import { expect, it, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { CuratedPersonalityStore } from "../memory/curated.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { GLOBAL_PROPOSAL_MAX_AGE_MS } from "../reflection/global-proposal.js";
import { createPersonalityComparison } from "./personality-comparison.js";
import { createPersonalityPreview } from "./personality-evaluation-preview.js";
import { createJuneRegistry, type JuneClientRegistry } from "./registry.js";

it("inspects pending suggestions through June without disclosing private support or granting other audiences a read", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "june-pending-"));
  const store = new EvidenceStore(":memory:", randomBytes(32));
  const curated = new CuratedPersonalityStore(
    join(root, "curated"),
    randomBytes(32),
    store,
    { initialize: true },
  );
  t.onTestFinished(() => {
    curated.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const scope = JSON.stringify(["private", owner.id]);
  const now = Date.now();
  const sources = [
    "SECRET <!channel> https://private.invalid/",
    "second",
    "third",
    "fourth",
  ];
  const append = (id: string, audience = scope, observedAt = now) =>
    store.appendSource({
      id,
      audiences: [audience],
      observedAt,
      platform: "slack",
      account: "T1",
      conversation: "D1",
      author: "U1",
      sourceUrl: "https://private.invalid/SECRET",
      text: "SECRET evidence body",
    });
  for (const id of sources) append(id);
  const input = {
    expectedVersion: 0,
    changes: { tone: "dry" as const, humor: "none" as const },
    evidenceIds: sources,
    explanation: "SECRET rationale",
    confidence: 0.73,
  };
  const proposal = curated.stageGlobalProposal(scope, input, now);
  append("foreign", "foreign");
  const foreign = curated.stageGlobalProposal(
    "foreign",
    { ...input, evidenceIds: ["foreign"] },
    now,
  );
  append("expired", scope, now - GLOBAL_PROPOSAL_MAX_AGE_MS - 1);
  const expired = curated.stageGlobalProposal(
    scope,
    { ...input, evidenceIds: ["expired"] },
    now - GLOBAL_PROPOSAL_MAX_AGE_MS - 1,
  );
  const read = vi.spyOn(curated, "pendingGlobalProposals");
  const sent: OutboundMessage[] = [];
  const requests: ModelRequest[] = [];
  const registry = createJuneRegistry({
    owner,
    memory: { store, personality: curated, source: () => undefined },
    inspection: async () => {
      throw new Error("Personality reads must use the actor decision ledger");
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
        if (request.inspectionAvailable) {
          expect(request.system).toContain('inspection:"personality"');
          expect(JSON.stringify(replyJsonSchema([], request))).toContain(
            '"personality"',
          );
        }
        return { text: "", inspection: "personality" };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const profile = (
    client as Client<JuneClientRegistry>
  ).personality.getOrCreate([owner.id]);
  const initial = await profile.read();
  const base: MessageEvent = {
    id: "base",
    messageId: "base",
    type: "message",
    senderId: "U1",
    occurredAt: now,
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    direct: true,
    metadata: { channelType: "im" },
    personalityCommandEligible: true,
    text: "!personality pending",
  };
  let sequence = 0;
  const deliver = async (extra: Partial<MessageEvent> = {}) => {
    const event = {
      ...base,
      ...extra,
      id: `in${++sequence}`,
      messageId: `ts${sequence}`,
    };
    const route = routeEvent(event, owner);
    if (!route) throw new Error("Fixture not routable");
    const conversation = client.conversation.getOrCreate(route.key);
    const before = sent.length;
    await conversation.send("inbox", { type: "event", event });
    await expect
      .poll(
        async () =>
          Object.values((await conversation.snapshot()).events).find(
            (e) => e.event.id === event.id,
          )?.done,
        { timeout: 10000 },
      )
      .toBe(true);
    expect(sent.length).toBe(before + 1);
    const content = sent.at(-1)?.content;
    if (content?.type !== "text") throw new Error("Missing text reply");
    return content.text;
  };
  const command = await deliver();
  const rows = JSON.parse(command.split("\n")[1] ?? "");
  expect(rows).toEqual([
    {
      proposalId: proposal.id,
      expectedVersion: 0,
      changes: { tone: "dry", humor: "none" },
      reviewState: "pending owner review; not applied",
      sourceCount: 4,
      sourceRefs: sources
        .toSorted()
        .slice(0, 3)
        .map((id) => `sha256:${createHash("sha256").update(id).digest("hex")}`),
    },
  ]);
  expect(command).not.toContain(foreign.id);
  expect(command).not.toContain(expired.id);
  expect(requests).toHaveLength(0);
  expect(
    await deliver({ text: "Inspect your pending personality suggestions" }),
  ).toContain(proposal.id);
  expect(requests).toHaveLength(1);
  expect(read).toHaveBeenLastCalledWith(scope, 6, expect.any(Number), []);
  expect(await profile.read()).toEqual(initial);
  for (const extra of [
    { senderId: "U2" },
    {
      direct: false,
      metadata: { channelType: "channel" as const },
      address: { ...base.address, conversationId: "C1" },
    },
    { metadata: undefined },
    { metadata: { channelType: "mpim" as const } },
  ]) {
    const calls = read.mock.calls.length;
    expect(await deliver(extra)).not.toContain(proposal.id);
    expect(
      await deliver({ ...extra, text: "Inspect pending suggestions" }),
    ).not.toContain(proposal.id);
    expect(read).toHaveBeenCalledTimes(calls);
    if (extra.senderId === "U2" || extra.direct === false)
      expect(JSON.stringify(requests.at(-1))).not.toContain("SECRET");
  }
  const beforeUnmarked = read.mock.calls.length;
  expect(await deliver({ personalityCommandEligible: false })).not.toContain(
    proposal.id,
  );
  expect(read).toHaveBeenCalledTimes(beforeUnmarked);
  expect(
    await profile.pending({
      ...base,
      address: { ...base.address, accountId: "T-other" },
    }),
  ).not.toContain(proposal.id);
  expect(await deliver({ text: "!personality", senderId: "U2" })).not.toContain(
    proposal.id,
  );

  await profile.command({
    ...base,
    id: "revision",
    text: '!personality revise {"expectedVersion":0,"changes":{"verbosity":"concise"},"explanation":"Explicit fixture edit","publish":true}',
  });
  expect(await deliver()).toContain('"expectedVersion":0');
  expect(await deliver()).toContain("stale target; fresh suggestion required");
  expect(
    curated.pendingGlobalProposal(scope, proposal.id)?.expectedVersion,
  ).toBe(0);
  const unrelated = curated.stageGlobalProposal(scope, {
    ...input,
    expectedVersion: 1,
    evidenceIds: ["fourth"],
  });
  store.deleteSource(sources[0] ?? "");
  const afterForgetting = await deliver();
  expect(afterForgetting).not.toContain(proposal.id);
  expect(afterForgetting).toContain(unrelated.id);
  store.deleteSource("fourth");
  expect(await deliver()).toContain("No currently valid pending suggestions");
  expect(await profile.read()).toMatchObject({ version: 1 });

  append("fresh");
  const pending = Array.from({ length: 7 }, (_, i) =>
    curated.stageGlobalProposal(scope, {
      ...input,
      expectedVersion: 1,
      evidenceIds: ["second", "third", "fresh"],
      explanation: `SECRET ${i}`,
    }),
  );
  const bounded = await deliver();
  expect(JSON.parse(bounded.split("\n")[1] ?? "")).toHaveLength(5);
  expect(bounded).toContain("Additional pending suggestions are omitted");
  expect(bounded.length).toBeLessThan(4000);
  const encryptedHead = curated.ownerHistory().commit;
  const beforeRejection = await profile.read();
  // Three newest decisions would crowd out valid rows if filtered after limit.
  const rejectedIds = pending.slice(-3).map((p) => p.id);
  for (const proposalId of rejectedIds)
    expect(
      await deliver({
        text: `!personality reject ${JSON.stringify({ proposalId })}`,
      }),
    ).toContain(`Rejected personality suggestion ${proposalId}`);
  for (const text of [
    "!personality pending",
    "Inspect pending personality suggestions",
  ]) {
    const remaining = await deliver({ text });
    expect(
      JSON.parse(remaining.split("\n")[1] ?? "").map(
        (row: { proposalId: string }) => row.proposalId,
      ),
    ).toEqual(pending.slice(0, 4).map((p) => p.id));
    expect(remaining).not.toContain("Additional pending suggestions");
  }
  expect(read).toHaveBeenLastCalledWith(
    scope,
    6,
    expect.any(Number),
    rejectedIds,
  );
  expect(await profile.read()).toEqual(beforeRejection);
  expect(curated.ownerHistory().commit).toBe(encryptedHead);
  read.mockImplementationOnce(() => {
    throw new Error("SECRET error path");
  });
  expect(await deliver()).toContain("no review state can be inferred");
  expect(JSON.stringify(sent)).not.toContain("SECRET");
  expect(JSON.stringify(sent)).not.toContain("private.invalid");
  expect(await profile.read()).toMatchObject({ version: 1 });
  expect(() =>
    parseReply('{"text":"","inspection":"personality"}', []),
  ).toThrow();
  expect(() =>
    parseReply('{"text":"","inspection":"personality","recall":"secret"}', [], {
      inspectionAvailable: true,
      recallAvailable: true,
    }),
  ).toThrow();
  const approved = pending[0];
  if (!approved) throw new Error("Missing approval fixture");
  append("held-out");
  const compared = await createPersonalityComparison({
    proposals: curated,
    preview: createPersonalityPreview({
      ownerId: owner.id,
      store,
      readCandidate: (id) => profile.evaluationCandidate(id),
      evidenceMaxAgeMs: GLOBAL_PROPOSAL_MAX_AGE_MS,
      decide: async (input) => ({
        answer: "yes",
        evidenceIds: input.evidence.map((e) => e.id),
        rationale: "Suitable",
      }),
    }),
  })({ candidateId: approved.id, heldOutSourceIds: ["held-out"] });
  if (compared.status !== "comparison")
    throw new Error("Missing comparison fixture");
  const { evaluationId, candidateDigest } = compared.receipt;
  const evaluatedHead = curated.ownerHistory().commit;
  expect(
    await deliver({
      text: `!personality approve ${JSON.stringify({ proposalId: approved.id, expectedVersion: 1, evaluationId, candidateDigest, publish: true })}`,
    }),
  ).toContain("Saved global personality revision 2");
  const afterApproval = await deliver();
  expect(
    JSON.parse(afterApproval.split("\n")[1] ?? "").map(
      (row: { proposalId: string }) => row.proposalId,
    ),
  ).toEqual(pending.slice(1, 4).map((p) => p.id));
  expect(JSON.stringify(await profile.read())).not.toContain(approved.id);
  expect(curated.ownerHistory().commit).toBe(evaluatedHead);
});
