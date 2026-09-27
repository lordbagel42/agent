import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { MessageEvent, Owner } from "../core/contracts.js";
import { slackSource } from "../imports/identity.js";
import { proposeRevision } from "../reflection/personality.js";
import {
  handleMemoryCorrection,
  MEMORY_CORRECTION_HELP,
} from "./correction.js";
import { EvidenceStore } from "./store.js";

const owner: Owner = {
  id: "owner",
  identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
};
const audience = JSON.stringify(["private", owner.id]);
const event: MessageEvent = {
  type: "message",
  id: "live",
  messageId: "1000.000123",
  occurredAt: 1000000,
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  senderId: "U1",
  direct: true,
  ownerCorrectionEligible: true,
  metadata: { channelType: "im" },
  text: "!memory-correct tone confidential lavender",
};
const source = slackSource({
  workspace: "T1",
  channel: "D1",
  ts: event.messageId,
  author: "U1",
  text: event.text,
  workspaceUrl: "https://fixture.slack.com/",
  audiences: [audience],
});

it("binds durable immutable corrections to original private evidence without promoting imports or resurrecting deletions", () => {
  const directory = mkdtempSync(join(tmpdir(), "june-correction-"));
  const path = join(directory, "evidence.sqlite");
  const key = randomBytes(32);
  let store = new EvidenceStore(path, key);
  try {
    const coverage = {
      platform: "slack",
      account: "T1",
      conversations: ["D1"],
      from: 0,
      to: 2000000,
      audiences: [audience],
    };
    store.beginImport("history", coverage);
    const progress = store.importProgress("history");
    if (!progress) throw new Error("Missing import");
    expect(() =>
      store.persistPage(
        progress,
        {
          sources: [
            { ...source, correction: { trait: "tone", value: "forged" } },
          ],
          nextCursor: null,
        },
        1000001,
      ),
    ).toThrow();
    store.persistPage(
      progress,
      { sources: [source], nextCursor: null },
      1000001,
    );
    const proposal = {
      id: "revision",
      scope: audience,
      trait: "tone" as const,
      value: "confidential lavender",
      basis: "owner-correction" as const,
      evidenceIds: [source.id],
      explanation: "Explicit owner input",
      confidence: 1,
    };
    const evidence = () =>
      store.reflectionEvidence(audience, [source.id], 5000);
    expect(evidence()[0]?.source).toBe("episode");
    expect(proposeRevision(proposal, evidence(), 1000001, 5000).ok).toBe(false);
    store.appendSource(source); // Identical live arrival after import.
    const receipt = handleMemoryCorrection(event, owner, store);
    expect(receipt).toContain(
      `Recorded private owner-correction evidence: ${source.id}`,
    );
    expect(handleMemoryCorrection(event, owner, store)).toBe(receipt);
    expect(store.source(audience, source.id)).toEqual(source);
    store.beginImport("later-history", coverage);
    const later = store.importProgress("later-history");
    if (!later) throw new Error("Missing import");
    store.persistPage(later, { sources: [source], nextCursor: null }, 1000002);
    store.close();
    store = new EvidenceStore(path, key);
    expect(evidence()).toEqual([
      {
        id: "slack:T1:D1:1000.000123",
        scope: audience,
        source: "owner-correction",
        text: event.text,
        observedAt: 1000000,
        expiresAt: 1005000,
        correction: { trait: "tone", value: "confidential lavender" },
      },
    ]);
    expect(proposeRevision(proposal, evidence(), 1000001, 5000).ok).toBe(true);
    for (const patch of [{ trait: "humor" }, { value: "different" }])
      expect(
        proposeRevision({ ...proposal, ...patch }, evidence(), 1000001, 5000)
          .ok,
      ).toBe(false);
    expect(() =>
      store.recordOwnerCorrection(audience, source.id, {
        trait: "tone",
        value: "different",
      }),
    ).toThrow(/immutable/);
    expect(() =>
      store.reflectionEvidence("public", [source.id], 5000),
    ).toThrow();
    expect(store.search(audience, "").sources).toHaveLength(1);
    store.deleteSource(source.id);
    expect(() =>
      store.recordOwnerCorrection(audience, source.id, {
        trait: "tone",
        value: "confidential lavender",
      }),
    ).toThrow();
    expect(() => store.appendSource(source)).toThrow(/Tombstoned/);
    expect(() => evidence()).toThrow();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("rejects guests, wrong accounts, public or ambiguous surfaces, quotes, malformed commands and disabled memory", () => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  try {
    store.appendSource(source);
    for (const change of [
      { senderId: "U2" },
      { address: { ...event.address, accountId: "T2" } },
      { direct: false },
      { metadata: undefined },
      { metadata: { channelType: "mpim" as const } },
      { address: { ...event.address, conversationId: "C1" } },
    ])
      expect(
        handleMemoryCorrection({ ...event, ...change }, owner, store),
      ).toContain("require the configured owner's Slack DM");
    for (const text of [
      `> ${event.text}`,
      `\`${event.text}\``,
      ` ${event.text}`,
      `${event.text}\n`,
      "!memory-correct permissions admin",
      "!memory-correct tone ",
      `!memory-correct tone ${"a".repeat(2001)}`,
      `!memory-correct tone ${"𠮷".repeat(1001)}`,
    ])
      expect(handleMemoryCorrection({ ...event, text }, owner, store)).toBe(
        MEMORY_CORRECTION_HELP,
      );
    expect(handleMemoryCorrection(event, owner)).toContain("unavailable");
    expect(
      handleMemoryCorrection(
        { ...event, ownerCorrectionEligible: undefined },
        owner,
        store,
      ),
    ).toBe(MEMORY_CORRECTION_HELP);
    expect(
      store.reflectionEvidence(audience, [source.id], 5000)[0]?.source,
    ).toBe("episode");
  } finally {
    store.close();
  }
});
