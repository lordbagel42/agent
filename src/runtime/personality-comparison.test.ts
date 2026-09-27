import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CuratedPersonalityStore } from "../memory/curated.js";
import { EvidenceStore } from "../memory/store.js";
import type {
  DecisionFunction,
  DecisionInput,
} from "../reflection/evaluator.js";
import { personalityComparisonSchema } from "../reflection/personality-comparison.js";
import { defaultGlobalPersonality } from "./personality.js";
import { createPersonalityComparison } from "./personality-comparison.js";
import { createPersonalityPreview } from "./personality-evaluation-preview.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "june-comparison-"));
  const store = new EvidenceStore(join(root, "evidence.db"), randomBytes(32));
  const scope = JSON.stringify(["private", "owner"]);
  const at = 1000;
  const profile = { ...structuredClone(defaultGlobalPersonality), version: 3 };
  for (const [index, id] of [
    "support",
    "one",
    "two",
    "three",
    "four",
  ].entries()) {
    store.appendSource({
      id,
      audiences: [scope],
      platform: "slack",
      account: "workspace",
      conversation: "dm",
      author: "owner",
      sourceUrl: `https://example.com/${id}`,
      observedAt: 100 + index,
      text: `private interaction ${id}`,
    });
  }
  const proposals = new CuratedPersonalityStore(
    join(root, "curated"),
    randomBytes(32),
    store,
    { initialize: true },
  );
  const proposal = proposals.stageGlobalProposal(
    scope,
    {
      expectedVersion: 3,
      changes: { tone: "dry" },
      evidenceIds: ["support"],
      explanation: "Private rationale",
      confidence: 0.8,
    },
    at,
  );
  const request = {
    candidateId: proposal.id,
    heldOutSourceIds: ["one", "two", "three", "four"],
  };
  const decision = { rejected: false };
  const preview = (decide: DecisionFunction) =>
    createPersonalityPreview({
      ownerId: "owner",
      store,
      async readCandidate(id) {
        const pending = proposals.pendingGlobalProposal(scope, id, at);
        return !decision.rejected &&
          pending &&
          pending.expectedVersion === profile.version
          ? { profile, proposal: pending }
          : null;
      },
      decide,
      evidenceMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
      now: () => at,
    });
  const compare = (decide: DecisionFunction) =>
    createPersonalityComparison({
      preview: preview(decide),
      proposals,
      now: () => at,
    });
  return {
    scope,
    at,
    profile,
    decision,
    store,
    proposals,
    request,
    preview,
    compare,
    close() {
      proposals.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it("preserves asymmetric and unknown outcomes without promotion or private text in a trusted, expiring receipt", async () => {
  const f = fixture();
  try {
    const contexts: DecisionInput[] = [];
    const compare = f.compare(async (input) => {
      contexts.push(structuredClone(input));
      const candidate = input.prompt.includes('"tone":"dry"');
      const id = input.evidence[0]?.id ?? "";
      const answer =
        id === "one"
          ? candidate
            ? "yes"
            : "no"
          : id === "two"
            ? candidate
              ? "no"
              : "yes"
            : id === "three"
              ? "yes"
              : candidate
                ? "no"
                : "abstain";
      if (input.evidence[0]) input.evidence[0].text = "provider mutation";
      return {
        answer,
        evidenceIds: [id],
        rationale: "private model rationale",
        confidence: 1,
      };
    });
    const result = await compare(f.request);
    expect(result.status).toBe("comparison");
    if (result.status !== "comparison") throw new Error("Missing comparison");
    const receipt = result.receipt;
    expect(receipt.status).toBe("incomplete");
    expect(receipt.pairs).toEqual([
      {
        evidenceId: "one",
        current: "no",
        candidate: "yes",
        outcome: "candidate",
      },
      {
        evidenceId: "two",
        current: "yes",
        candidate: "no",
        outcome: "current",
      },
      {
        evidenceId: "three",
        current: "yes",
        candidate: "yes",
        outcome: "both",
      },
      {
        evidenceId: "four",
        current: "abstain",
        candidate: "no",
        outcome: "unknown",
      },
    ]);
    expect(contexts).toHaveLength(8);
    for (let i = 0; i < 4; i++) {
      expect(contexts[i]?.evidence).toEqual(contexts[i + 4]?.evidence);
      expect(contexts[i]?.now).toBe(contexts[i + 4]?.now);
      expect(contexts[i]?.prior).toBeUndefined();
      expect(contexts[i + 4]?.prior).toBeUndefined();
    }
    expect(f.profile).toEqual({ ...defaultGlobalPersonality, version: 3 });
    expect(receipt.currentDigest).toBe(
      "f60b49c4a1c169f7072078285b49174bf421f0743a5e57c9e7a92673183af329",
    );
    expect(receipt.candidateDigest).toBe(
      "ec7b54617ca6903d5cabf38d56fa412da5c4c98e987726c82a833038d95cfddf",
    );
    expect(JSON.stringify(receipt)).not.toMatch(
      /private|rationale|confidence|provider mutation/,
    );
    expect(
      f.proposals.readEvaluation("public", receipt.evaluationId, f.at),
    ).toBeUndefined();
    expect(
      f.proposals.readEvaluation(
        f.scope,
        receipt.evaluationId,
        receipt.expiresAt - 1,
      ),
    ).toEqual(receipt);
    expect(
      f.proposals.readEvaluation(
        f.scope,
        receipt.evaluationId,
        receipt.expiresAt,
      ),
    ).toBeUndefined();
    expect(
      personalityComparisonSchema.safeParse({ ...receipt, status: "complete" })
        .success,
    ).toBe(false);
    const neither = await f.compare(async () => ({
      answer: "no",
      evidenceIds: ["two"],
      rationale: "not suitable",
    }))({ ...f.request, heldOutSourceIds: ["two"] });
    expect(neither.status).toBe("comparison");
    if (neither.status !== "comparison") throw new Error("Missing comparison");
    expect(neither.receipt.status).toBe("complete");
    expect(neither.receipt.pairs).toEqual([
      { evidenceId: "two", current: "no", candidate: "no", outcome: "neither" },
    ]);
    f.store.deleteSource("one");
    expect(
      f.proposals.readEvaluation(f.scope, receipt.evaluationId, f.at),
    ).toBeUndefined();
    expect(
      f.proposals.readEvaluation(f.scope, neither.receipt.evaluationId, f.at),
    ).toEqual(neither.receipt);
    f.store.deleteSource("support");
    expect(
      f.proposals.readEvaluation(f.scope, neither.receipt.evaluationId, f.at),
    ).toBeUndefined();
  } finally {
    f.close();
  }
});

it("revalidates the profile, decision ledger and sources after inference before writing a receipt", async () => {
  for (const invalidate of [
    "profile",
    "style",
    "source",
    "rejected",
  ] as const) {
    const f = fixture();
    try {
      const record = vi.spyOn(f.proposals, "recordEvaluation");
      let calls = 0;
      const compare = f.compare(async (input) => {
        if (++calls === 1) {
          if (invalidate === "profile") f.profile.version++;
          else if (invalidate === "style") f.profile.style.tone = "direct";
          else if (invalidate === "rejected") f.decision.rejected = true;
          else f.store.deleteSource("one");
        }
        return {
          answer: "yes",
          evidenceIds: [input.evidence[0]?.id ?? ""],
          rationale: "unsupported promotion",
        };
      });
      expect(await compare(f.request)).toEqual({ status: "unavailable" });
      expect(calls).toBe(1);
      expect(record).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  }
});

it("does not persist a receipt when cancellation arrives during final currentness revalidation", async () => {
  const f = fixture();
  try {
    const record = vi.spyOn(f.proposals, "recordEvaluation");
    const controller = new AbortController();
    const preview = f.preview(async (input) => ({
      answer: "yes",
      evidenceIds: [input.evidence[0]?.id ?? ""],
      rationale: "suitable",
    }));
    const compare = createPersonalityComparison({
      preview: {
        ...preview,
        async isCurrent() {
          controller.abort();
          return true;
        },
      },
      proposals: f.proposals,
      now: () => f.at,
    });
    expect(await compare(f.request, controller.signal)).toEqual({
      status: "unavailable",
    });
    expect(record).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
