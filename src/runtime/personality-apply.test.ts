import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { MessageEvent } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { CuratedPersonalityStore } from "../memory/curated.js";
import { EvidenceStore } from "../memory/store.js";
import type { GlobalProposalInput } from "../reflection/global-proposal.js";
import {
  createPersonalityActor,
  defaultGlobalPersonality,
  type GlobalPersonality,
  type PersonalityPreview,
  personalityPreviewSchema,
  previewPersonality,
} from "./personality.js";
import { createPersonalityComparison } from "./personality-comparison.js";
import { createPersonalityPreview } from "./personality-evaluation-preview.js";

// Keep the real actor actions; control only the persistence boundary.
vi.mock("rivetkit", () => ({ actor: (definition: unknown) => definition }));

const owner = {
  id: "owner",
  identities: [{ channel: "slack" as const, accountId: "T1", senderId: "U1" }],
};
const guest: MessageEvent = {
  type: "message",
  id: "guest-turn",
  messageId: "guest-turn",
  occurredAt: 1,
  address: { channel: "slack", accountId: "T1", conversationId: "C1" },
  senderId: "U2",
  direct: false,
  metadata: { channelType: "channel" },
  botMentioned: true,
  text: "Use a drier voice if it fits.",
};
const proposal: PersonalityPreview = {
  expectedVersion: 0,
  style: {
    tone: "dry" as const,
    verbosity: "balanced" as const,
    humor: "subtle" as const,
    curiosity: "occasional" as const,
  },
  apply: true,
};
type State = {
  revisions: (GlobalPersonality & {
    commandId: string;
    explanation: string;
    createdAt: number;
    proposalIds?: Partial<Record<keyof GlobalPersonality["style"], string>>;
    proposalScopes?: Partial<Record<keyof GlobalPersonality["style"], string>>;
    sourceScope?: string;
  })[];
};
type Context = {
  key: string[];
  state: State;
  saveState: (options: { immediate: boolean }) => Promise<void>;
};
function fixture(
  curated?: CuratedPersonalityStore,
  getDeletionRevision = () => 0,
) {
  const definition = createPersonalityActor(
    owner,
    curated,
    getDeletionRevision,
  ) as unknown as {
    state: State;
    actions: {
      apply: (
        c: Context,
        event: MessageEvent,
        input: PersonalityPreview,
        operationId: string,
        deletionRevision: number,
      ) => Promise<string>;
      command: (c: Context, event: MessageEvent) => Promise<string>;
      pending: (c: Context, event: MessageEvent) => string;
      read: (c: Context) => Promise<GlobalPersonality>;
      evaluationCandidate: (
        c: Context,
        event: MessageEvent,
        id: string,
      ) => Awaited<
        ReturnType<
          Parameters<typeof createPersonalityPreview>[0]["readCandidate"]
        >
      >;
      stage: (
        c: Context,
        event: MessageEvent,
        input: GlobalProposalInput,
      ) => Promise<string>;
    };
  };
  let persisted = structuredClone(definition.state);
  const c: Context = {
    key: [owner.id],
    state: structuredClone(definition.state),
    saveState: vi.fn(async () => {
      persisted = structuredClone(c.state);
    }),
  };
  return {
    c,
    persisted: () => persisted,
    command: (event: MessageEvent) => definition.actions.command(c, event),
    pending: (event: MessageEvent) => definition.actions.pending(c, event),
    read: () => definition.actions.read(c),
    readCandidate: async (event: MessageEvent, id: string) =>
      definition.actions.evaluationCandidate(c, event, id),
    stage: (event: MessageEvent, input: GlobalProposalInput) =>
      definition.actions.stage(c, event, input),
    apply: (
      input = proposal,
      operationId = "operation",
      event = guest,
      deletionRevision = 0,
    ) =>
      definition.actions.apply(c, event, input, operationId, deletionRevision),
  };
}

it("rejects a queued style decision after forgetting but preserves recorded receipts", async () => {
  let revision = 0;
  const { apply, c, persisted } = fixture(undefined, () => revision);
  const queued = Promise.withResolvers<void>();
  const pending = queued.promise.then(() => apply(proposal, "stale", guest, 0));
  revision++;
  queued.resolve();
  expect(await pending).toContain("context changed");
  expect(c.state.revisions).toHaveLength(0);
  expect(persisted().revisions).toHaveLength(0);
  expect(await apply(proposal, "fresh", guest, 1)).toContain(
    "Saved global personality revision 1",
  );
  revision++;
  expect(await apply(proposal, "fresh", guest, 1)).toContain("already saved");
  expect(c.state.revisions).toHaveLength(1);
});

it("publishes bounded model-selected style from an admitted guest channel", async () => {
  const { c, apply, persisted } = fixture();
  const receipt = await apply(proposal, "PRIVATE operation id");
  expect(receipt).toContain("Saved global personality revision 1");
  expect(receipt).not.toContain("PRIVATE");
  expect(receipt.length).toBeLessThan(2000);
  expect(c.state.revisions).toHaveLength(1);
  expect(persisted().revisions).toMatchObject([
    { version: 1, style: proposal.style },
  ]);
});

it.each([undefined, false])(
  "keeps apply:%s genuinely read-only and offers June a direct apply choice",
  async (applyFlag) => {
    const { c, persisted, apply } = fixture();
    const input = {
      expectedVersion: proposal.expectedVersion,
      style: proposal.style,
      ...(applyFlag === undefined ? {} : { apply: applyFlag }),
    };
    expect(personalityPreviewSchema.safeParse(input).success).toBe(true);
    const before = structuredClone(c.state);
    const text = previewPersonality(defaultGlobalPersonality, input);
    expect(text).toContain("tone: warm → dry");
    expect(text).toContain("apply:true");
    expect(text).not.toContain("!personality revise");
    expect(await apply(input)).toBe(text);
    expect(c.state).toEqual(before);
    expect(persisted()).toEqual(before);
    expect(c.saveState).not.toHaveBeenCalled();
  },
);

it("compares expectedVersion at the write boundary before either concurrent save completes", async () => {
  const { c, apply } = fixture();
  const save = Promise.withResolvers<void>();
  vi.mocked(c.saveState).mockImplementation(() => save.promise);
  const first = apply();
  const stale = await apply(
    { ...proposal, style: { ...proposal.style, humor: "none" } },
    "competing-operation",
  );
  expect(stale).toContain("current version is 1");
  expect(stale).toContain("nothing was overwritten");
  expect(c.state.revisions).toHaveLength(1);
  expect(c.state.revisions[0]?.style).toEqual(proposal.style);
  save.resolve();
  expect(await first).toContain("Saved global personality revision 1");
});

it("deduplicates stable operations across retries and reloads before checking a stale version", async () => {
  const { c, persisted, apply } = fixture();
  await apply();
  c.state = structuredClone(persisted());
  const retry = await apply(proposal, "operation", {
    ...guest,
    id: "retried-turn",
    messageId: "retried-turn",
  });
  expect(retry).toContain("already saved");
  expect(persisted().revisions).toHaveLength(1);
  expect(c.state.revisions).toHaveLength(1);
});

it("never acknowledges a failed save and persists a retry without a second revision", async () => {
  const { c, persisted, apply } = fixture();
  vi.mocked(c.saveState).mockRejectedValueOnce(new Error("PRIVATE failure"));
  await expect(apply()).rejects.toThrow("could not be confirmed");
  expect(persisted().revisions).toHaveLength(0);
  expect(c.state.revisions).toHaveLength(1);
  vi.mocked(c.saveState).mockRejectedValueOnce(new Error("PRIVATE retry"));
  await expect(apply()).rejects.toThrow("could not be confirmed");
  expect(persisted().revisions).toHaveLength(0);
  expect(await apply()).toContain("already saved");
  expect(persisted().revisions).toHaveLength(1);
});

it("rejects non-vocabulary input, missing operation identity and unadmitted events without mutation", async () => {
  const { c, apply } = fixture();
  for (const input of [
    { ...proposal, style: { ...proposal.style, tone: "PRIVATE instructions" } },
    { ...proposal, style: { ...proposal.style, permissions: "all" } },
    { ...proposal, explanation: "PRIVATE explanation" },
    { ...proposal, apply: "true" },
    { ...proposal, expectedVersion: -1 },
  ]) {
    expect(personalityPreviewSchema.safeParse(input).success).toBe(false);
    const receipt = await apply(input as typeof proposal);
    expect(receipt).toContain("Invalid");
    expect(receipt).not.toContain("PRIVATE");
  }
  expect(await apply(proposal, "")).toContain("operation");
  expect(
    await apply(proposal, "unadmitted", { ...guest, botMentioned: false }),
  ).toContain("unavailable");
  expect(c.state.revisions).toHaveLength(0);
  expect(c.saveState).not.toHaveBeenCalled();
});

it("accepts fresh guest commands but confines revision explanations to their source scopes", async () => {
  const { c, command } = fixture();
  const privateEvent: MessageEvent = {
    ...guest,
    senderId: "U1",
    direct: true,
    metadata: { channelType: "im" },
    address: { ...guest.address, conversationId: "D1" },
    personalityCommandEligible: true,
  };
  await command({
    ...privateEvent,
    id: "private-revision",
    text: '!personality revise {"expectedVersion":0,"changes":{"tone":"playful"},"explanation":"PRIVATE explanation","publish":true}',
  });
  const edit = {
    ...guest,
    text: '!personality revise {"expectedVersion":1,"changes":{"humor":"none"},"explanation":"CHANNEL explanation","publish":true}',
  };
  expect(await command(edit)).not.toContain("Saved global");
  const receipt = await command({ ...edit, personalityCommandEligible: true });
  expect(receipt).toContain("Saved global personality revision 2");
  const history = {
    text: "!personality history",
    personalityCommandEligible: true,
  };
  const channelHistory = await command({ ...guest, ...history });
  expect(channelHistory).toContain("CHANNEL explanation");
  expect(channelHistory).not.toContain("PRIVATE explanation");
  const privateHistory = await command({ ...privateEvent, ...history });
  expect(privateHistory).toContain("PRIVATE explanation");
  expect(privateHistory).not.toContain("CHANNEL explanation");
  expect(await command({ ...guest, ...history, senderId: "U3" })).not.toContain(
    "CHANNEL explanation",
  );
  expect(c.state.revisions).toHaveLength(2);
});

it("stages and inspects inert guest drafts in their actual source scope without owner-scope substitution", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "june-personality-scopes-"));
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
  const scope = JSON.stringify(routeEvent(guest, owner)?.key);
  store.appendSource({
    id: "PRIVATE source",
    audiences: [scope],
    observedAt: Date.now(),
    platform: "slack",
    account: "T1",
    conversation: "C1",
    author: "U2",
    sourceUrl: "https://private.invalid/",
    text: "PRIVATE evidence body",
  });
  const input: GlobalProposalInput = {
    expectedVersion: 0,
    changes: { tone: "dry" },
    evidenceIds: ["PRIVATE source"],
    explanation: "PRIVATE rationale",
    confidence: 0.8,
  };
  const { c, stage, pending, command } = fixture(curated);
  expect(await stage(guest, input)).toContain("Nothing was applied");
  const [draft] = curated.pendingGlobalProposals(scope);
  expect(draft).toBeDefined();
  if (!draft) throw new Error("Missing scoped draft");
  expect(
    curated.pendingGlobalProposals(JSON.stringify(["private", owner.id])),
  ).toEqual([]);
  expect(pending(guest)).toContain(draft.id);
  expect(pending(guest)).not.toContain("PRIVATE");
  expect(pending({ ...guest, senderId: "U3" })).not.toContain(draft.id);
  expect(
    await command({
      ...guest,
      personalityCommandEligible: true,
      text: `!personality approve ${JSON.stringify({ proposalId: draft.id, expectedVersion: 0, evaluationId: randomUUID(), candidateDigest: "0".repeat(64), publish: true })}`,
    }),
  ).toContain("Personality evaluation is unavailable");
  const rejected = await command({
    ...guest,
    personalityCommandEligible: true,
    text: `!personality reject ${JSON.stringify({ proposalId: draft.id })}`,
  });
  expect(rejected).toContain("Rejected personality suggestion");
  expect(pending(guest)).not.toContain(draft.id);
  expect(c.state.revisions).toHaveLength(0);
});

it("evaluates only host-routed guest/shared evidence and preserves each trait's grounding through cross-scope edits and rollback", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "june-grounding-scopes-"));
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
  const shared: MessageEvent = { ...guest, senderId: "U1" };
  const privateEvent: MessageEvent = {
    ...shared,
    direct: true,
    metadata: { channelType: "im" },
    address: { ...shared.address, conversationId: "D1" },
  };
  const audience = (event: MessageEvent) =>
    JSON.stringify(routeEvent(event, owner)?.key);
  for (const [prefix, source] of [
    ["guest", guest],
    ["shared", shared],
    ["owner", privateEvent],
  ] as const) {
    for (const suffix of ["support", "held"]) {
      store.appendSource({
        id: `${prefix}-${suffix}`,
        audiences: [audience(source)],
        observedAt: Date.now(),
        platform: "slack",
        account: source.address.accountId,
        conversation: source.address.conversationId,
        author: source.senderId,
        sourceUrl: "https://private.invalid/",
        text: `PRIVATE ${prefix} ${suffix}`,
      });
    }
  }
  const actor = fixture(curated);
  const seen: { scope: string; ids: string[] }[] = [];
  const preview = createPersonalityPreview({
    owner,
    store,
    readCandidate: actor.readCandidate,
    evidenceMaxAgeMs: 60_000,
    decide: async (input) => {
      seen.push({ scope: input.scope, ids: input.evidence.map((e) => e.id) });
      return {
        answer: "yes",
        evidenceIds: input.evidence.map((e) => e.id),
        rationale: "PRIVATE evaluation",
      };
    },
  });
  const compare = createPersonalityComparison({ preview, proposals: curated });
  let serial = 0;
  const command = (event: MessageEvent, verb: string, input: object) =>
    actor.command({
      ...event,
      id: `command-${++serial}`,
      personalityCommandEligible: true,
      text: `!personality ${verb} ${JSON.stringify(input)}`,
    });
  for (const [expectedVersion, source, prefix, changes] of [
    [0, guest, "guest", { tone: "dry", verbosity: "concise" }],
    [1, shared, "shared", { humor: "none" }],
  ] as const) {
    await actor.stage(source, {
      expectedVersion,
      changes,
      evidenceIds: [`${prefix}-support`],
      explanation: "PRIVATE grounding",
      confidence: 0.8,
    });
    const draft = curated.pendingGlobalProposals(audience(source))[0];
    if (!draft) throw new Error("Missing source-scoped draft");
    // Candidate IDs do not grant access to another audience, including owner DM.
    expect(await actor.readCandidate(privateEvent, draft.id)).toBeNull();
    expect(await actor.readCandidate(source, draft.id)).toMatchObject({
      proposal: { id: draft.id, scope: audience(source) },
    });
    const request = {
      candidateId: draft.id,
      heldOutSourceIds: [`${prefix}-held`],
    };
    expect(await compare(privateEvent, request)).toEqual({
      status: "unavailable",
    });
    expect(
      await compare(source, { ...request, heldOutSourceIds: ["owner-held"] }),
    ).toEqual({ status: "unavailable" });
    expect(
      await compare(source, {
        ...request,
        heldOutSourceIds: [`${prefix}-support`],
      }),
    ).toEqual({ status: "unavailable" });
    expect(
      await preview.preview(source, {
        ...request,
        scope: audience(privateEvent),
      } as typeof request),
    ).toEqual({ status: "unavailable" });
    expect(seen).toHaveLength(expectedVersion * 2);
    const result = await compare(source, request);
    expect(result.status).toBe("comparison");
    if (result.status !== "comparison") throw new Error("Missing comparison");
    expect(seen.slice(-2)).toEqual([
      { scope: audience(source), ids: [`${prefix}-held`] },
      { scope: audience(source), ids: [`${prefix}-held`] },
    ]);
    expect(
      curated.readEvaluation(
        audience(privateEvent),
        result.receipt.evaluationId,
      ),
    ).toBeUndefined();
    expect((await actor.read()).version).toBe(expectedVersion); // Never auto-accept.
    const approval = {
      proposalId: draft.id,
      expectedVersion,
      evaluationId: result.receipt.evaluationId,
      candidateDigest: result.receipt.candidateDigest,
      publish: true,
    };
    expect(await command(privateEvent, "approve", approval)).not.toContain(
      "Saved global",
    );
    expect(await command(source, "approve", approval)).toContain(
      `Saved global personality revision ${expectedVersion + 1}`,
    );
    expect(await actor.readCandidate(source, draft.id)).toBeNull();
    expect(await compare(source, request)).toEqual({ status: "unavailable" });
    expect(await command(source, "approve", approval)).toContain(
      "already saved",
    );
  }
  expect((await actor.read()).style).toEqual({
    tone: "dry",
    verbosity: "concise",
    humor: "none",
    curiosity: "occasional",
  });
  // A new owner-private edit cannot rebind retained guest/channel grounding.
  await actor.apply(
    {
      expectedVersion: 2,
      style: { ...(await actor.read()).style, curiosity: "eager" },
      apply: true,
    },
    "private-edit",
    privateEvent,
  );
  await command(privateEvent, "revise", {
    expectedVersion: 3,
    changes: { tone: "playful" },
    explanation: "Independent style",
    publish: true,
  });
  expect((await actor.read()).style).toEqual({
    tone: "playful",
    verbosity: "concise",
    humor: "none",
    curiosity: "eager",
  });
  store.deleteSource("guest-support");
  expect((await actor.read()).style).toEqual({
    tone: "playful",
    verbosity: "balanced",
    humor: "none",
    curiosity: "eager",
  });
  await command(guest, "rollback", {
    expectedVersion: 4,
    targetVersion: 2,
    explanation: "Restore saved voice",
    publish: true,
  });
  expect((await actor.read()).style).toEqual({
    tone: "warm",
    verbosity: "balanced",
    humor: "none",
    curiosity: "occasional",
  });
  // Reload the persisted revision so the scope must survive serialization.
  actor.c.state = structuredClone(actor.persisted());
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.now() + 8 * 24 * 60 * 60 * 1000);
  try {
    expect((await actor.read()).style).toEqual(defaultGlobalPersonality.style);
  } finally {
    clock.mockRestore();
  }
  expect((await actor.read()).style.humor).toBe("none");
  store.deleteSource("shared-support");
  expect((await actor.read()).style).toEqual(defaultGlobalPersonality.style);
  const publicRead = JSON.stringify(await actor.read());
  expect(publicRead).not.toMatch(
    /PRIVATE|proposalIds|proposalScopes|sourceScope|guest-support|shared-support/,
  );
});

it("resolves legacy proposal IDs only in their historical private scope, never the later revision's scope", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "june-legacy-grounding-"));
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
  const privateScope = JSON.stringify(["private", owner.id]);
  const guestScope = JSON.stringify(routeEvent(guest, owner)?.key);
  for (const scope of [privateScope, guestScope]) {
    store.appendSource({
      id: scope,
      audiences: [scope],
      observedAt: Date.now(),
      platform: "slack",
      account: "T1",
      conversation: "D1",
      author: "U1",
      sourceUrl: "https://private.invalid/",
      text: "PRIVATE legacy evidence",
    });
  }
  const draft = (scope: string) =>
    curated.stageGlobalProposal(scope, {
      expectedVersion: 0,
      changes: { tone: "dry" },
      evidenceIds: [scope],
      explanation: "PRIVATE legacy",
      confidence: 0.8,
    });
  const privateDraft = draft(privateScope);
  const guestDraft = draft(guestScope);
  const actor = fixture(curated);
  actor.c.state.revisions.push({
    version: 1,
    style: { ...defaultGlobalPersonality.style, tone: "dry", humor: "none" },
    commandId: "legacy",
    explanation: "PRIVATE",
    createdAt: Date.now(),
    sourceScope: guestScope,
    proposalIds: { tone: privateDraft.id, humor: guestDraft.id },
  });
  expect((await actor.read()).style).toEqual({
    ...defaultGlobalPersonality.style,
    tone: "dry",
  });
  store.deleteSource(privateScope);
  expect((await actor.read()).style).toEqual(defaultGlobalPersonality.style);
});
