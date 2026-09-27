import { execFileSync } from "node:child_process";
import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { GlobalPersonalityProposal } from "../reflection/global-proposal.js";
import type { PersonalityProposal } from "../reflection/personality.js";
import { CuratedPersonalityStore } from "./curated.js";
import { EvidenceStore, type Source } from "./store.js";

it("isolates personality scopes, rejects forged corrections, and never resurrects forgotten traits through historical reads or rollback", () => {
  const root = mkdtempSync(join(tmpdir(), "june-curated-"));
  const evidence = new EvidenceStore(
    join(root, "evidence.db"),
    randomBytes(32),
  );
  const key = randomBytes(32);
  let curated: CuratedPersonalityStore | undefined;
  try {
    const source: Source = {
      id: "secret-source",
      audiences: ["private"],
      platform: "slack",
      account: "workspace",
      conversation: "dm",
      author: "owner",
      sourceUrl: "https://example.com/message",
      observedAt: 100,
      text: "please use a confidential lavender tone",
      correction: { trait: "tone", value: "confidential lavender" },
    };
    evidence.appendSource(source);
    evidence.appendSource({
      ...source,
      id: "channel",
      audiences: ["public"],
      correction: undefined,
    });
    curated = new CuratedPersonalityStore(
      join(root, "curated"),
      key,
      evidence,
      { initialize: true },
    );
    const proposal: PersonalityProposal = {
      id: "private-revision",
      scope: "private",
      trait: "tone",
      value: "confidential lavender",
      basis: "owner-correction",
      evidenceIds: [source.id],
      explanation: "secret explanation",
      confidence: 1,
    };
    const first = curated.ownerRevise(
      proposal,
      evidence.reflectionEvidence("private", [source.id], 1000),
      200,
      1000,
    );
    const channelProposal: PersonalityProposal = {
      ...proposal,
      id: "channel-revision",
      scope: "public",
      value: "neutral",
      basis: "inferred",
      evidenceIds: ["channel"],
    };
    const channelEvidence = evidence.reflectionEvidence(
      "public",
      ["channel"],
      1000,
    );
    expect(() =>
      curated?.ownerRevise(
        { ...channelProposal, basis: "owner-correction" },
        channelEvidence.map((e) => ({
          ...e,
          source: "owner-correction",
          correction: { trait: "tone", value: "neutral" },
        })),
        200,
        1000,
      ),
    ).toThrow();
    curated.ownerRevise(channelProposal, channelEvidence, 200, 1000);
    expect(curated.effectiveTraits("private")).toEqual({
      tone: "confidential lavender",
    });
    expect(curated.effectiveTraits("public")).toEqual({ tone: "neutral" });
    expect(curated.effectiveTraits("unknown")).toEqual({});
    // Model a pre-policy ledger whose already-curated source opted out. Keep
    // the real encrypted curated revision and its provenance validation.
    const search = evidence.search.bind(evidence);
    const legacyLedger = vi
      .spyOn(evidence, "search")
      .mockImplementation((scope, query) => {
        const result = search(scope, query);
        return {
          ...result,
          sources: result.sources.map((entry) =>
            entry.id === source.id
              ? { ...entry, text: `## ${entry.text}` }
              : entry,
          ),
        };
      });
    expect(curated.effectiveTraits("private")).toEqual({});
    expect(curated.effectiveTraits("public")).toEqual({ tone: "neutral" });
    legacyLedger.mockRestore();
    curated.close();
    curated = new CuratedPersonalityStore(join(root, "curated"), key, evidence);
    evidence.deleteSource(source.id);
    expect(curated.effectiveTraits("private", first)).toEqual({});
    expect(curated.effectiveTraits("private")).toEqual({});
    curated.ownerRollback(
      "rollback",
      "channel-revision",
      "undo public tone",
      300,
    );
    expect(curated.effectiveTraits("private")).toEqual({});
    expect(curated.effectiveTraits("public")).toEqual({});
    expect(curated.ownerHistory().revisions.at(-1)?.reverts).toBe(
      "channel-revision",
    );

    // Inspect decoded Git objects, not merely compressed files: compression is
    // not confidentiality. Only opaque hashes and fixed metadata may enter Git.
    const gitDir = join(root, "curated", "metadata.git");
    const objects = execFileSync(
      "git",
      [
        "--git-dir",
        gitDir,
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname)",
      ],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");
    const contents = objects
      .map((oid) =>
        execFileSync("git", ["--git-dir", gitDir, "cat-file", "-p", oid], {
          encoding: "utf8",
        }),
      )
      .join("\n");
    for (const secret of [
      "confidential lavender",
      "secret explanation",
      "secret-source",
      "private-revision",
      "channel-revision",
    ])
      expect(contents).not.toContain(secret);
    for (const name of readdirSync(join(root, "curated", "snapshots")))
      expect(
        readFileSync(join(root, "curated", "snapshots", name)).toString(
          "latin1",
        ),
      ).not.toContain("confidential lavender");
  } finally {
    curated?.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps global suggestions private, immutable and bound to original live sources", () => {
  const root = mkdtempSync(join(tmpdir(), "june-suggestions-"));
  const evidence = new EvidenceStore(":memory:", randomBytes(32));
  const key = randomBytes(32);
  let curated = new CuratedPersonalityStore(
    join(root, "curated"),
    key,
    evidence,
    {
      initialize: true,
    },
  );
  try {
    for (const [id, audiences, observedAt] of [
      ["original", ["private"], 100],
      ["unrelated", ["private"], 200],
      ["other-audience", ["channel"], 100],
    ] as const)
      evidence.appendSource({
        id,
        audiences: [...audiences],
        platform: "slack",
        account: "T1",
        conversation: "D1",
        author: "owner",
        observedAt,
        sourceUrl: "https://example.com/source",
        text: "Private preference for drier humor",
      });
    const input = {
      expectedVersion: 3,
      changes: { tone: "dry" },
      evidenceIds: ["original"],
      explanation: "Private rationale",
      confidence: 0.7,
    };
    const proposal = curated.stageGlobalProposal("private", input, 300);
    expect(proposal).toMatchObject({
      ...input,
      sourceIds: ["original"],
      createdAt: 300,
      expiresAt: 604800100,
    });
    const commit = curated.ownerHistory().commit;
    expect(curated.stageGlobalProposal("private", input, 400)).toEqual(
      proposal,
    );
    expect(curated.ownerHistory()).toEqual({ commit, revisions: [] });
    expect(curated.effectiveTraits("private")).toEqual({});
    expect(curated.effectiveTraits("channel")).toEqual({});
    expect(
      curated.pendingGlobalProposal("channel", proposal.id, 400),
    ).toBeUndefined();
    proposal.changes.tone = "warm";
    expect(
      curated.pendingGlobalProposal("private", proposal.id, 400)?.changes,
    ).toEqual({ tone: "dry" });
    for (const invalid of [
      { ...input, evidenceIds: ["other-audience"] },
      { ...input, changes: { tone: "Private identifying detail" } },
      { ...input, changes: {} },
      { ...input, evidenceIds: ["original", "original"] },
    ])
      expect(() =>
        curated.stageGlobalProposal("private", invalid, 400),
      ).toThrow();
    expect(
      curated.pendingGlobalProposal("private", proposal.id, 604800099),
    ).toBeDefined();
    expect(
      curated.pendingGlobalProposal("private", proposal.id, 604800100),
    ).toBeUndefined();
    const next = curated.stageGlobalProposal(
      "private",
      { ...input, expectedVersion: 4, evidenceIds: ["unrelated"] },
      400,
    );
    expect(
      curated
        .pendingGlobalProposals("private", 1, 400, [next.id])
        .map((p) => p.id),
    ).toEqual([proposal.id]);
    curated.close();
    curated = new CuratedPersonalityStore(join(root, "curated"), key, evidence);
    evidence.deleteSource("original");
    expect(
      curated.pendingGlobalProposal("private", proposal.id, 400),
    ).toBeUndefined();
    expect(
      curated.pendingGlobalProposals("private", 10, 400).map((p) => p.id),
    ).toEqual([next.id]);
    expect(() => curated.stageGlobalProposal("private", input, 400)).toThrow();
  } finally {
    curated.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("removes forgotten suggestion payloads durably on reads, reopen and staging without erasing unrelated suggestions", () => {
  const root = mkdtempSync(join(tmpdir(), "june-suggestion-forget-"));
  const path = join(root, "curated");
  const evidence = new EvidenceStore(":memory:", randomBytes(32));
  const key = randomBytes(32);
  let curated = new CuratedPersonalityStore(path, key, evidence, {
    initialize: true,
  });
  // Read the actual encrypted HEAD, not a filtered model projection: merely
  // hiding a forgotten record while retaining its copied prose must fail.
  const activePayload = () => {
    const { revision } = JSON.parse(
      execFileSync(
        "git",
        [
          "--git-dir",
          join(path, "metadata.git"),
          "show",
          "curated:record.json",
        ],
        { encoding: "utf8" },
      ),
    ) as { revision: string };
    const bytes = readFileSync(join(path, "snapshots", revision));
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(0, 12),
    );
    decipher.setAAD(
      Buffer.from(`${readFileSync(join(path, "STORE"), "utf8")}${revision}`),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString("utf8"),
    ) as { globalProposals: GlobalPersonalityProposal[] };
  };
  try {
    for (const id of ["original", "unrelated", "other-scope", "fresh"])
      evidence.appendSource({
        id,
        audiences: [id === "other-scope" ? "other" : "private"],
        platform: "slack",
        account: "T1",
        conversation: "D1",
        author: "U1",
        observedAt: 100,
        sourceUrl: "https://example.invalid/source",
        text: "Private source detail",
      });
    const input = {
      expectedVersion: 0,
      changes: { tone: "dry" },
      evidenceIds: ["original"],
      explanation: "PRIVATE copied source detail",
      confidence: 0.8,
    };
    const direct = curated.stageGlobalProposal("private", input, 300);
    curated.stageGlobalProposal(
      "private",
      {
        ...input,
        evidenceIds: ["original", "unrelated"],
      },
      300,
    );
    const keep = curated.stageGlobalProposal(
      "private",
      {
        ...input,
        evidenceIds: ["unrelated"],
        explanation: "Independent suggestion",
      },
      300,
    );
    const other = curated.stageGlobalProposal(
      "other",
      {
        ...input,
        evidenceIds: ["other-scope"],
        explanation: "Other scope suggestion",
      },
      300,
    );
    expect(JSON.stringify(activePayload())).toContain(input.explanation);
    evidence.deleteSource("original");
    expect(
      curated.pendingGlobalProposal("private", direct.id, 400),
    ).toBeUndefined();
    expect(activePayload().globalProposals).toEqual([keep, other]);
    expect(JSON.stringify(activePayload())).not.toContain(input.explanation);
    const head = curated.ownerHistory().commit;
    curated.forgetGlobalProposals();
    expect(curated.pendingGlobalProposals("private", 10, 400)).toEqual([keep]);
    expect(curated.ownerHistory().commit).toBe(head);
    expect(() => curated.stageGlobalProposal("private", input, 400)).toThrow();

    // A crash after the ledger tombstone but before the host callback is safe.
    evidence.deleteSource("other-scope");
    curated.close();
    curated = new CuratedPersonalityStore(path, key, evidence);
    expect(activePayload().globalProposals).toEqual([keep]);
    evidence.deleteSource("unrelated");
    const fresh = curated.stageGlobalProposal(
      "private",
      {
        ...input,
        evidenceIds: ["fresh"],
        explanation: "Fresh suggestion",
      },
      400,
    );
    expect(activePayload().globalProposals).toEqual([fresh]);
  } finally {
    curated.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});
