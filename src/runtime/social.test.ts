import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Client } from "rivetkit/client";
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
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { createLifecycle } from "./lifecycle.js";
import { createPriorityAdmission } from "./priority.js";
import type { ReflectionCandidate } from "./reflection.js";
import { createJuneRegistry, type JuneClientRegistry } from "./registry.js";
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

function fixture(
  t: { onTestFinished(fn: () => void): void },
  deletionRevision?: () => number,
) {
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
    deletionRevision,
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

it("stages one private candidate-bound preview without granting or sending, and rechecks deletion", async (t) => {
  const { social, sent, options } = fixture(t);
  const candidate: ReflectionCandidate & { evidenceIds: string[] } = {
    id: "private-source-candidate",
    requestId: "private-request",
    evidenceIds: ["source-a", "uncited-source-b"],
    scope: JSON.stringify(["private", owner.id]),
    attempt: 1,
    epoch: 3,
    mode: "idle",
    kind: "interruption-candidate",
    hypothesisOnly: false,
    createdAt: Date.now(),
    publication: { version: 1, expiresAt: Date.now() + 60000 },
    decision: {
      answer: "yes",
      rationale: "Private hypothesis",
      evidenceIds: ["source-a"],
    },
  };
  const input = {
    candidateId: createHash("sha256").update(candidate.id).digest("hex"),
    userId: "UGUEST",
    text: "Exact <@UOTHER> & message",
  };
  for (const event of [
    guest,
    { ...raygen, direct: false },
    {
      ...raygen,
      address: { ...raygen.address, accountId: "TOTHER" },
    },
  ])
    expect(social.stageInterruption(event, input, candidate, true)).toContain(
      "private conversation",
    );
  for (const invalid of [
    null,
    { ...candidate, scope: "public" },
    { ...candidate, hypothesisOnly: true },
    { ...candidate, id: "other" },
    { ...candidate, kind: "proposal" as const },
  ])
    expect(social.stageInterruption(raygen, input, invalid, true)).toContain(
      "unavailable",
    );
  expect(social.view(raygen)).toBe("[]");
  expect(
    await social.propose(raygen, { kind: "interruption_proposal", ...input }),
  ).toContain("private reflection gate");
  expect(social.view(raygen)).toBe("[]");
  social.rejectInterruption("different-scope", input.candidateId);
  const preview = social.stageInterruption(raygen, input, candidate, true);
  expect(preview).toContain('"Exact <@UOTHER> & message"');
  expect(preview).not.toContain(candidate.decision.rationale);
  expect(preview).not.toContain(candidate.id);
  const id = preview.match(/proposal ([a-f0-9]{24})/)?.[1];
  expect(id).toBeDefined();
  expect(JSON.parse(social.view(raygen))).toMatchObject([
    {
      status: "pending",
      action: { kind: "outreach", userId: input.userId, text: input.text },
      reflection: {
        candidateId: input.candidateId,
        epoch: 3,
        evidenceIds: ["source-a", "uncited-source-b"],
        publication: candidate.publication,
      },
    },
  ]);
  expect(social.view(guest)).toBe("[]");
  expect(await social.decide({ ...raygen, text: `!allow ${id}` })).toContain(
    "unapproved",
  );
  expect(social.permits(guest, "deep")).toBe(false);
  const rejected = { ...candidate, id: "rejected-before-staging" };
  const rejectedInput = {
    ...input,
    candidateId: createHash("sha256").update(rejected.id).digest("hex"),
  };
  social.rejectInterruption(candidate.scope, rejectedInput.candidateId);
  let revision = 0;
  const reopened = new SocialPermissions({
    ...options,
    deletionRevision: () => revision,
  });
  try {
    expect(
      reopened.stageInterruption(raygen, rejectedInput, rejected, true),
    ).toContain("rejected");
    expect(
      reopened.stageInterruption(
        { ...raygen, id: "another-turn" },
        { ...input, userId: "UCHANGED", text: "Changed" },
        candidate,
        true,
      ),
    ).toBe(preview);
    expect(
      reopened.stageInterruption(raygen, input, null, false),
    ).not.toContain(input.text);
    expect(
      reopened.stageInterruption(raygen, input, candidate, false),
    ).toContain("not currently send-eligible");
    revision++;
    expect(
      await reopened.decide({ ...raygen, text: `!allow ${id}` }),
    ).toContain("revoked");
    expect(reopened.view(raygen)).not.toContain(input.text);
    expect(
      reopened.stageInterruption(raygen, input, candidate, true),
    ).toContain("no longer pending");
  } finally {
    reopened.close();
  }
  expect(sent).toEqual([]);
});

it("stages strict commands and inert model drafts without reauthorizing stale candidates", async (t) => {
  const store = new EvidenceStore(":memory:", Buffer.alloc(32, 1));
  t.onTestFinished(() => store.close());
  const { social, sent, slack, options } = fixture(t, () =>
    store.deletionRevision(),
  );
  let modelCalls = 0;
  let modelAlias = "";
  let modelText = "Model's inert draft";
  let forgetAtStaging = false;
  let deleted = false;
  let rejections = 0;
  let holdRead: Promise<void> | undefined;
  let reading = false;
  const observedAt = Date.now();
  const quiet = { timeZone: "UTC", startMinute: 0, endMinute: 0 };
  const registry = createJuneRegistry({
    owner,
    social,
    channels: { slack },
    memory: { store, source: () => undefined },
    wakeups: { sources: ["slack"], pollMs: 20 },
    model: {
      async reply(request) {
        modelCalls++;
        expect(request.socialAvailable).toBe(true);
        expect(request.system).toContain("interruption_proposal");
        return parseReply(
          JSON.stringify({
            text: "",
            social: {
              kind: "interruption_proposal",
              candidateId: modelAlias,
              userId: "UOTHER",
              text: modelText,
            },
          }),
          [],
          request,
        );
      },
    },
    reflection: {
      ownerId: owner.id,
      policy: {
        totalCapacity: 2,
        liveReserve: 1,
        cooldownMs: 1,
        maxAttempts: 1,
        maxNoNewEvidence: 1,
        evidenceMaxAgeMs: 600000,
        quiet,
      },
      idleMs: 100,
      deepMs: 200,
      pollMs: 20,
      timeoutMs: 10000,
      rejectProposals() {
        rejections++;
        return undefined;
      },
      evidenceCurrent(scope, evidence) {
        return (
          scope === JSON.stringify(["private", owner.id]) &&
          !evidence.some((e) => deleted && e.id === "uncited-source-b")
        );
      },
      async retrieve({ scope, evidenceIds }) {
        if (holdRead) {
          reading = true;
          await holdRead;
        }
        return {
          authorized: !(deleted && evidenceIds.includes("uncited-source-b")),
          evidence: evidenceIds.map((id) => ({
            id,
            scope,
            text: "Private original evidence",
            source: "episode" as const,
            observedAt,
            expiresAt: observedAt + 600000,
          })),
        };
      },
      async decide() {
        return {
          answer: "yes",
          rationale: "Private hypothesis",
          evidenceIds: ["source-a"],
        };
      },
    },
  });
  const actorConfig = registry.config.use.reflection?.config;
  if (!actorConfig?.actions) throw new Error("Missing reflection actions");
  const stage = actorConfig.actions.stageInterruption;
  actorConfig.actions.stageInterruption = (c, ...args) => {
    if (forgetAtStaging) {
      forgetAtStaging = false;
      store.deleteSource("unrelated-inference-context");
    }
    return stage(c, ...args);
  };
  const { client } = await setupTest(t, registry);
  const reflection = (
    client as Client<JuneClientRegistry>
  ).reflection.getOrCreate([owner.id]);
  const scope = ["private", owner.id];
  await reflection.enqueue({
    scope: JSON.stringify(scope),
    evidenceIds: ["source-a", "uncited-source-b"],
    kind: "curiosity",
    mode: "interaction",
  });
  await expect
    .poll(async () => (await reflection.status()).candidateIds.length)
    .toBe(1);
  const before = await reflection.status();
  const rawId = before.candidateIds[0];
  if (!rawId) throw new Error("Missing fixture candidate");
  const alias = createHash("sha256").update(rawId).digest("hex");
  await expect
    .poll(() => reflection.candidate(alias, JSON.stringify(scope)))
    .not.toBeNull();
  const wakeups = (client as Client<JuneClientRegistry>).wakeups.getOrCreate([
    owner.id,
  ]);
  await wakeups.manage(
    {
      action: "create",
      name: "matching command",
      instruction: "Must not infer from private staging commands",
      once: false,
      trigger: {
        kind: "event",
        source: "slack",
        type: "message",
        filters: [
          {
            path: "text",
            value: `!reflection propose ${alias} UGUEST Frozen preview`,
          },
        ],
      },
    },
    raygen,
    "staging-watch",
  );
  const conversation = client.conversation.getOrCreate(scope);
  await conversation.send("inbox", {
    type: "event",
    event: {
      ...raygen,
      reflectionReviewEligible: true,
      text: `!reflection propose ${alias} UGUEST Frozen preview`,
    },
  });
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]?.address).toEqual(raygen.address);
  expect(sent[0]?.content).toMatchObject({
    type: "text",
    text: expect.stringContaining('"Frozen preview"'),
  });
  expect(await reflection.status()).toMatchObject({
    epoch: before.epoch,
    candidateIds: [rawId],
  });
  expect(JSON.parse(social.view(raygen))).toMatchObject([
    {
      status: "pending",
      reflection: {
        candidateId: alias,
        evidenceIds: ["source-a", "uncited-source-b"],
      },
    },
  ]);
  deleted = true;
  await conversation.send("inbox", {
    type: "event",
    event: {
      ...raygen,
      id: "deleted-proposal",
      messageId: "124.002",
      reflectionReviewEligible: true,
      text: `!reflection propose ${alias} UOTHER Changed message`,
    },
  });
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]?.address).toEqual(raygen.address);
  expect(sent[1]?.content).toMatchObject({
    type: "text",
    text: expect.stringContaining("unavailable"),
  });
  expect(JSON.stringify(sent[1])).not.toContain("Frozen preview");
  expect(JSON.stringify(sent)).not.toContain("Private hypothesis");
  expect(modelCalls).toBe(0);
  expect(Object.keys((await wakeups.snapshot()).runs)).toEqual([]);
  expect(social.grants(guest)).toEqual([]);

  await reflection.occupancy("next-candidate", true);
  await reflection.occupancy("next-candidate", false);
  await reflection.enqueue({
    scope: JSON.stringify(scope),
    evidenceIds: ["source-a", "uncited-source-c"],
    kind: "curiosity",
    mode: "interaction",
  });
  await expect
    .poll(async () => (await reflection.status()).candidateIds.length)
    .toBe(2);
  const retained = await reflection.status();
  const modelRawId = retained.candidateIds.find((id) => id !== rawId);
  if (!modelRawId) throw new Error("Missing model candidate");
  modelAlias = createHash("sha256").update(modelRawId).digest("hex");
  await expect
    .poll(() => reflection.candidate(modelAlias, JSON.stringify(scope)))
    .not.toBeNull();
  await conversation.send("inbox", {
    type: "event",
    event: {
      ...raygen,
      id: "model-stage",
      messageId: "124.003",
      text: "Stage that interruption privately.",
    },
  });
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2]?.content).toMatchObject({
    text: expect.stringContaining("not currently send-eligible"),
  });
  const rows = JSON.parse(social.view(raygen));
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({
    status: "pending",
    action: { userId: "UOTHER", text: "Model's inert draft" },
    reflection: {
      candidateId: modelAlias,
      epoch: retained.epoch,
      evidenceIds: ["source-a", "uncited-source-c"],
      publication: { version: 1, expiresAt: observedAt + 600000 },
    },
  });
  expect((await reflection.status()).epoch).toBeGreaterThan(retained.epoch);
  expect(
    await reflection.candidate(modelAlias, JSON.stringify(scope)),
  ).toBeNull();
  expect(
    await social.decide({ ...raygen, text: `!allow ${rows[1].id}` }),
  ).toContain("unapproved");
  await conversation.send("inbox", {
    type: "event",
    event: {
      ...raygen,
      id: "stale-host-stage",
      messageId: "124.004",
      reflectionReviewEligible: true,
      text: `!reflection propose ${modelAlias} UOTHER Must not restamp`,
    },
  });
  await expect.poll(() => sent.length).toBe(4);
  expect(sent[3]?.content).toMatchObject({
    text: expect.stringContaining("unavailable"),
  });
  expect(modelCalls).toBe(1);

  const input = { candidateId: modelAlias, userId: "UOTHER", text: "Changed" };
  await reflection.occupancy("live-staging-gate", true);
  expect(await reflection.stageInterruption(raygen, input, 0, true)).toContain(
    "unavailable",
  );
  await reflection.occupancy("live-staging-gate", false);
  const minute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  quiet.startMinute = (minute + 1439) % 1440;
  quiet.endMinute = (minute + 2) % 1440;
  expect(await reflection.stageInterruption(raygen, input, 0, true)).toContain(
    "unavailable",
  );
  quiet.startMinute = quiet.endMinute = 0;

  await reflection.enqueue({
    scope: JSON.stringify(scope),
    evidenceIds: ["source-a", "race-source"],
    kind: "curiosity",
    mode: "interaction",
  });
  await expect
    .poll(async () => (await reflection.status()).candidateIds.length)
    .toBe(3);
  const raceRawId = (await reflection.status()).candidateIds.find(
    (id) => id !== rawId && id !== modelRawId,
  );
  if (!raceRawId) throw new Error("Missing race candidate");
  await expect.poll(() => reflection.candidate(raceRawId)).not.toBeNull();
  let releaseRead = () => {};
  holdRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  t.onTestFinished(() => releaseRead());
  const racing = reflection.stageInterruption(
    raygen,
    {
      ...input,
      candidateId: createHash("sha256").update(raceRawId).digest("hex"),
    },
    0,
    true,
  );
  await expect.poll(() => reading).toBe(true);
  await reflection.occupancy("preempt-stage", true);
  await reflection.occupancy("preempt-stage", false);
  releaseRead();
  holdRead = undefined;
  expect(await racing).toContain("unavailable");
  expect(JSON.parse(social.view(raygen))).toHaveLength(2);
  expect(
    await reflection.rejectCandidate(JSON.stringify(scope), modelAlias),
  ).toBe(true);
  expect(
    await reflection.rejectCandidate(JSON.stringify(scope), modelAlias),
  ).toBe(true);
  expect(rejections).toBe(2);
  expect(
    JSON.parse(social.view(raygen)).find(
      (row: { id: string }) => row.id === rows[1].id,
    ).status,
  ).toBe("revoked");
  expect(await reflection.stageInterruption(raygen, input, 0, true)).toContain(
    "unavailable",
  );
  // Forget context used by the draft after the conversation's final pre-RPC
  // check, but before the actor starts. The candidate's originals remain valid.
  modelAlias = createHash("sha256").update(raceRawId).digest("hex");
  modelText = "Draft derived from forgotten context";
  forgetAtStaging = true;
  await conversation.send("inbox", {
    type: "event",
    event: {
      ...raygen,
      id: "stale-context-stage",
      messageId: "124.005",
      text: "Stage another draft privately.",
    },
  });
  await expect
    .poll(async () =>
      Object.values((await conversation.snapshot()).events).some(
        ({ event, done }) => event.id === "stale-context-stage" && done,
      ),
    )
    .toBe(true);
  expect(modelCalls).toBe(2);
  expect(store.deletionRevision()).toBeGreaterThan(0);
  const reopened = new SocialPermissions(options);
  try {
    expect(JSON.parse(reopened.view(raygen))).toHaveLength(2);
    expect(reopened.view(raygen)).not.toContain(modelText);
  } finally {
    reopened.close();
  }
  expect(sent).toHaveLength(4);
  expect(
    sent.every((message) => message.address.conversationId === "DOWNER"),
  ).toBe(true);
  expect(social.grants(guest)).toEqual([]);
  const snapshot = await conversation.snapshot();
  expect(JSON.stringify(snapshot)).not.toContain("Model's inert draft");
  expect(JSON.stringify(snapshot.deliveries)).not.toContain("Frozen preview");
});

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

it("recovers approved outreach after restart only when delivery is known not to have happened", async (t) => {
  const { social, sent, options } = fixture(t);
  const db = new DatabaseSync(options.file);
  t.onTestFinished(() => db.close());
  for (const boundary of ["before_send", "after_send"] as const) {
    const pending = await social.propose(
      { ...raygen, id: boundary },
      { kind: "outreach", userId: "UGUEST", text: boundary },
    );
    const id = pending.match(/[a-f0-9]{24}/)?.[0];
    if (!id) throw new Error("missing proposal id");
    const approval = { ...raygen, text: `!allow ${id}` };
    // Fail the actual durable write, either before dispatch or after Slack
    // accepted it. The latter must leave an uncertain, non-retryable send.
    db.exec(`CREATE TRIGGER crash BEFORE INSERT ON social_deliveries
      WHEN NEW.id = '${id}:outreach' AND json_extract(NEW.value, '$.phase') = '${boundary === "before_send" ? "sending" : "settled"}'
      BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;`);
    const before = sent.length;
    await expect(social.decide(approval)).rejects.toThrow("simulated crash");
    expect(sent.length - before).toBe(boundary === "before_send" ? 0 : 1);
    const approved = JSON.parse(
      String(
        db.prepare("SELECT value FROM social_proposals WHERE id = ?").get(id)
          ?.value,
      ),
    );
    expect(approved.status).toBe("approved");
    db.exec("DROP TRIGGER crash");
    const reopened = new SocialPermissions({
      ...options,
      now: () => options.now() + 1000,
    });
    try {
      const expected = boundary === "before_send" ? "sent" : "unknown";
      expect(await reopened.decide(approval)).toContain(`delivery ${expected}`);
      expect(await reopened.decide(approval)).toContain(`delivery ${expected}`);
      expect(sent.length - before).toBe(1);
      expect(sent.at(-1)?.content).toEqual({ type: "text", text: boundary });
      expect(
        JSON.parse(
          String(
            db
              .prepare("SELECT value FROM social_proposals WHERE id = ?")
              .get(id)?.value,
          ),
        ).expires,
      ).toBe(approved.expires);
    } finally {
      reopened.close();
    }
  }
});

it("runs June's outreach proposal and repeated owner approval through Rivet", async (t) => {
  const { social, slack, sent } = fixture(t);
  let calls = 0;
  const registry = createJuneRegistry({
    owner,
    social,
    channels: { slack },
    model: {
      async reply(request) {
        calls++;
        expect(request.socialAvailable).toBe(true);
        return parseReply(
          JSON.stringify({
            text: "",
            social: {
              kind: "outreach",
              userId: "UGUEST",
              text: "Frozen hello.",
            },
          }),
          [],
          request,
        );
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const actor = client.conversation.getOrCreate(["private", owner.id]);
  await actor.send("inbox", { type: "event", event: raygen });
  await expect.poll(() => sent.length).toBe(2);
  const notice = sent[0]?.content;
  const id =
    notice?.type === "text"
      ? notice.text.match(/[a-f0-9]{24}/)?.[0]
      : undefined;
  expect(id).toBeDefined();
  expect(
    sent.every((message) => message.address.conversationId !== "UGUEST"),
  ).toBe(true);
  for (const attempt of [1, 2]) {
    await actor.send("inbox", {
      type: "event",
      event: {
        ...raygen,
        id: `approval-${attempt}`,
        messageId: `124.${attempt}`,
        text: `!allow ${id}`,
      },
    });
    await expect
      .poll(
        () =>
          sent.filter(
            (message) =>
              message.content.type === "text" &&
              message.content.text.includes("Approved outreach: delivery sent"),
          ).length,
      )
      .toBe(attempt);
  }
  expect(calls).toBe(1);
  const delivered = sent.filter(
    (message) => message.address.conversationId === "UGUEST",
  );
  expect(delivered).toHaveLength(1);
  expect(delivered[0]?.content).toEqual({
    type: "text",
    text: "Frozen hello.",
  });
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

it("bounds background waiters without spending the owner reserve or releasing aborted active work", async () => {
  const admission = createPriorityAdmission();
  const active = new AbortController();
  const release = await admission.enter("background", active.signal);
  const queued = new AbortController();
  const order: string[] = [];
  const waiters = Array.from({ length: 32 }, () =>
    admission.enter("background", queued.signal).then(
      (done) => {
        order.push("background");
        return done;
      },
      () => undefined,
    ),
  );
  expect(await admission.enter("background", queued.signal)).toBeUndefined();
  const owner = await admission.enter(true, new AbortController().signal);
  const nextOwner = admission
    .enter(true, new AbortController().signal)
    .then((done) => {
      order.push("owner");
      return done;
    });
  active.abort();
  await Promise.resolve();
  expect(order).toEqual([]);
  release?.();
  release?.();
  const owner2 = await nextOwner;
  expect(order).toEqual(["owner"]);
  owner2?.();
  const first = await waiters[0];
  expect(order).toEqual(["owner", "background"]);
  queued.abort();
  await Promise.all(waiters);
  first?.();
  owner?.();
  const next = await admission.enter(
    "background",
    new AbortController().signal,
  );
  expect(next).toBeTypeOf("function");
  next?.();
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
