import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
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
