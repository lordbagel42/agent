import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type { MessageEvent, OutboundMessage } from "../core/contracts.js";
import { CuratedPersonalityStore } from "../memory/curated.js";
import { EvidenceStore } from "../memory/store.js";
import {
  GLOBAL_PROPOSAL_MAX_AGE_MS,
  type ReflectionProposalBinding,
} from "../reflection/global-proposal.js";
import { createJuneRegistry } from "./registry.js";

it("approves only the exact live suggestion at its staged head through owner-private June ingress", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "june-personality-approval-"));
  const evidence = new EvidenceStore(":memory:", randomBytes(32));
  const curated = new CuratedPersonalityStore(
    join(root, "curated"),
    randomBytes(32),
    evidence,
    { initialize: true },
  );
  t.onTestFinished(() => {
    curated.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  });
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const scope = JSON.stringify(["private", owner.id]);
  const event: MessageEvent = {
    type: "message",
    id: "approve",
    messageId: "123.456",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    senderId: "U1",
    direct: true,
    metadata: { channelType: "im" },
    personalityCommandEligible: true,
    text: "!personality",
  };
  const sent: OutboundMessage[] = [];
  const registry = createJuneRegistry({
    owner,
    memory: { store: evidence, personality: curated, source: () => undefined },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          return { status: "sent", messageId: "out" };
        },
      },
    },
    model: {
      async reply() {
        return { text: "" };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const profile = client.personality.getOrCreate([owner.id]);
  const stage = (
    id: string,
    expectedVersion: number,
    age = 0,
    audience = scope,
    reflection?: ReflectionProposalBinding,
  ) => {
    const now = Date.now() - age;
    evidence.appendSource({
      id,
      audiences: [audience],
      platform: "slack",
      account: "T1",
      conversation: "D1",
      author: "U1",
      sourceUrl: "https://example.com/message",
      observedAt: now,
      text: "PRIVATE original evidence",
    });
    return curated.stageGlobalProposal(
      audience,
      {
        expectedVersion,
        changes: { tone: "dry", verbosity: "concise" },
        evidenceIds: [id],
        explanation: "PRIVATE staged rationale",
        confidence: 0.8,
      },
      now,
      reflection,
    );
  };
  const command = (proposalId: string, expectedVersion: number) =>
    `!personality approve ${JSON.stringify({ proposalId, expectedVersion, publish: true })}`;
  const candidateId = "a".repeat(64);
  const valid = stage("fresh", 0, 0, scope, {
    candidateId,
    sourceIds: ["fresh"],
    expiresAt: Date.now() + 1_000_000,
  });
  const oldHead = stage("old-head", 0);
  const rejected = stage("reject-me", 0);
  expect(
    await profile.command({
      ...event,
      text: `!personality reject ${JSON.stringify({ proposalId: rejected.id })}`,
    }),
  ).toContain("Rejected personality suggestion");
  expect(
    await profile.stage(event, {
      expectedVersion: 0,
      changes: rejected.changes,
      evidenceIds: rejected.evidenceIds,
      explanation: rejected.explanation,
      confidence: rejected.confidence,
    }),
  ).toContain("already rejected");
  evidence.deleteSource("reject-me");
  expect(
    await profile.command({ ...event, text: command(rejected.id, 0) }),
  ).toContain("was rejected");
  for (const source of [
    { ...event, senderId: "U2" },
    { ...event, direct: false, metadata: { channelType: "channel" as const } },
    { ...event, metadata: undefined },
    { ...event, personalityCommandEligible: undefined },
    { ...event, address: { ...event.address, accountId: "other" } },
  ]) {
    expect(
      await profile.command({ ...source, text: command(valid.id, 0) }),
    ).not.toContain("Saved global");
  }
  for (const extra of [{ changes: { tone: "playful" } }, { publish: false }]) {
    expect(
      await profile.command({
        ...event,
        text: `!personality approve ${JSON.stringify({ proposalId: valid.id, expectedVersion: 0, publish: true, ...extra })}`,
      }),
    ).toContain("Invalid personality approval");
  }
  const expired = stage("expired", 0, GLOBAL_PROPOSAL_MAX_AGE_MS);
  const forgotten = stage("forgotten", 0);
  evidence.deleteSource("forgotten");
  const unrelated = stage("other-audience", 0, 0, "other-private-scope");
  for (const proposal of [expired, forgotten, unrelated]) {
    expect(
      await profile.command({ ...event, text: command(proposal.id, 0) }),
    ).toContain("unavailable");
  }
  expect((await profile.read()).version).toBe(0);
  // A submitted head different from the proposal's cannot consume it.
  expect(
    await profile.command({ ...event, text: command(valid.id, 1) }),
  ).toMatch(/^Personality changed:/);
  const june = client.conversation.getOrCreate(["private", owner.id]);
  await june.send("inbox", {
    type: "event",
    event: { ...event, text: command(valid.id, 0) },
  });
  await expect
    .poll(
      async () =>
        Object.values((await june.snapshot()).events).some(
          (record) => record.event.id === event.id && record.done,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  expect(sent.at(-1)?.content).toMatchObject({
    text: expect.stringContaining("Saved global personality revision 1"),
  });
  expect(await profile.read()).toMatchObject({
    version: 1,
    style: {
      tone: "dry",
      verbosity: "concise",
      humor: "subtle",
      curiosity: "occasional",
    },
  });
  // Rejection revokes pending incorporation, not an earlier owner publication.
  curated.rejectReflectionProposals(scope, candidateId);
  expect(curated.pendingGlobalProposal(scope, valid.id)).toBeUndefined();
  expect(await profile.read()).toMatchObject({
    version: 1,
    style: { tone: "dry", verbosity: "concise" },
  });
  expect(
    await profile.command({
      ...event,
      id: "reject-accepted",
      text: `!personality reject ${JSON.stringify({ proposalId: valid.id })}`,
    }),
  ).toContain("already accepted");
  expect(
    await profile.command({
      ...event,
      id: "approve-rejected-again",
      text: command(rejected.id, 1),
    }),
  ).toContain("was rejected");
  // Neither private rationale nor evidence is copied to the revision journal.
  expect(
    await profile.command({ ...event, text: "!personality history" }),
  ).not.toContain("PRIVATE");
  expect(JSON.stringify(await profile.read())).not.toContain("PRIVATE");
  expect(JSON.stringify(await profile.read())).not.toContain(valid.id);
  await profile.command({
    ...event,
    id: "manual",
    text: '!personality revise {"expectedVersion":1,"changes":{"tone":"playful"},"explanation":"Owner-authored voice","publish":true}',
  });
  evidence.deleteSource("fresh");
  // An explicit owner-authored field survives; inherited grounded fields do not.
  expect(await profile.read()).toMatchObject({
    version: 2,
    style: { tone: "playful", verbosity: "balanced" },
    provenance: {
      tone: { kind: "owner-publication", originVersion: 2, appliedVersion: 2 },
      verbosity: { kind: "default", originVersion: 0, appliedVersion: 0 },
    },
  });
  expect(
    await profile.command({ ...event, text: "!personality history" }),
  ).not.toMatch(/"tone":"dry"|"verbosity":"concise"/);
  await profile.command({
    ...event,
    id: "manual-after-forget",
    text: '!personality revise {"expectedVersion":2,"changes":{"humor":"none"},"explanation":"Less humor","publish":true}',
  });
  expect(await profile.read()).toMatchObject({
    version: 3,
    style: { tone: "playful", verbosity: "balanced", humor: "none" },
  });
  await profile.command({
    ...event,
    id: "rollback",
    text: '!personality rollback {"expectedVersion":3,"targetVersion":1,"explanation":"Restore prior voice","publish":true}',
  });
  expect(await profile.read()).toMatchObject({
    version: 4,
    style: { tone: "warm", verbosity: "balanced" },
    provenance: {
      tone: { kind: "default", originVersion: 0, appliedVersion: 0 },
      verbosity: { kind: "default", originVersion: 0, appliedVersion: 0 },
      humor: {
        kind: "rollback",
        originVersion: 0,
        appliedVersion: 4,
        restoredFromVersion: 1,
      },
    },
  });
  expect(
    await profile.command({
      ...event,
      id: "retry",
      text: command(valid.id, 0),
    }),
  ).toContain("already saved");
  expect((await profile.read()).version).toBe(4);

  // Changing the submitted head cannot rebase a suggestion staged on v0.
  expect(
    await profile.command({
      ...event,
      id: "old-head",
      text: command(oldHead.id, 4),
    }),
  ).toMatch(/^Personality changed:/);
  expect((await profile.read()).version).toBe(4);
  const competing = [stage("candidate-a", 4), stage("candidate-b", 4)];
  const results = await Promise.all(
    competing.map((proposal, index) =>
      profile.command({
        ...event,
        id: `race-${index}`,
        text: command(proposal.id, 4),
      }),
    ),
  );
  expect(
    results.filter((result) => result.startsWith("Saved global")),
  ).toHaveLength(1);
  expect(
    results.filter((result) => result.startsWith("Personality changed:")),
  ).toHaveLength(1);
  expect((await profile.read()).version).toBe(5);
  evidence.deleteSource("candidate-a");
  evidence.deleteSource("candidate-b");
  expect((await profile.read()).style.tone).toBe("warm");
  // The enum matches stored v5, but this is new, independent owner authority.
  const sameValue = await profile.command({
    ...event,
    id: "manual-same-value",
    text: '!personality revise {"expectedVersion":5,"changes":{"tone":"dry"},"explanation":"Owner-authored dry tone","publish":true}',
  });
  expect(sameValue).toContain(
    '"tone":{"kind":"owner-publication","originVersion":6,"appliedVersion":6}',
  );
  expect(await profile.read()).toMatchObject({
    version: 6,
    style: { tone: "dry", verbosity: "balanced" },
    provenance: {
      tone: { kind: "owner-publication", originVersion: 6, appliedVersion: 6 },
    },
  });
  await profile.command({
    ...event,
    id: "rollback-same-value",
    text: '!personality rollback {"expectedVersion":6,"targetVersion":6,"explanation":"Keep owner-authored tone","publish":true}',
  });
  expect(await profile.read()).toMatchObject({
    version: 7,
    style: { tone: "dry", verbosity: "balanced" },
    provenance: {
      tone: {
        kind: "rollback",
        originVersion: 6,
        appliedVersion: 7,
        restoredFromVersion: 6,
      },
    },
  });
  await profile.command({
    ...event,
    id: "reset-revoked-trait",
    text: '!personality reset {"expectedVersion":7,"trait":"verbosity","explanation":"Keep default verbosity","publish":true}',
  });
  expect(await profile.read()).toMatchObject({
    version: 8,
    style: { tone: "dry", verbosity: "balanced" },
    provenance: {
      tone: { kind: "rollback", originVersion: 6, appliedVersion: 7 },
      verbosity: {
        kind: "owner-publication",
        originVersion: 8,
        appliedVersion: 8,
      },
    },
  });
});
