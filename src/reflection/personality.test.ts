import { expect, it } from "vitest";
import type { Evidence } from "./domain.js";
import {
  initialPersonality,
  proposeRevision,
  revertPersonality,
  revisePersonality,
} from "./personality.js";

const evidence: [Evidence] = [
  {
    id: "a",
    scope: "dm",
    source: "episode",
    text: "Prefers short replies",
    observedAt: 10,
    expiresAt: 100,
  },
];
const proposal = {
  id: "p1",
  scope: "dm",
  trait: "verbosity" as const,
  value: "concise",
  basis: "inferred" as const,
  evidenceIds: ["a"],
  explanation: "Repeated short replies",
  confidence: 0.7,
};

it("requires supporting current evidence and rejects charter/authority edits and fake owner corrections", () => {
  for (const patch of [
    { trait: "charter" },
    { trait: "permissions" },
    { evidenceIds: [] },
    { basis: "owner-correction" },
    { confidence: 2 },
    { grant: true },
    { trait: ["verbosity"] },
    { basis: ["inferred"] },
  ]) {
    expect(
      proposeRevision({ ...proposal, ...patch }, evidence, 20, 100).ok,
    ).toBe(false);
  }
  expect(proposeRevision(proposal, evidence, 100, 100).ok).toBe(false);
  expect(proposeRevision(proposal, evidence, 20, 100).ok).toBe(true);
});

it("keeps reversible revisions and prioritizes actual owner corrections over inferred style", () => {
  const correction: Evidence = {
    ...evidence[0],
    id: "owner",
    source: "owner-correction",
    correction: { trait: "verbosity", value: "detailed" },
  };
  const original = initialPersonality();
  const first = revisePersonality(original, proposal, evidence, 20, 100);
  const second = revisePersonality(
    first,
    {
      ...proposal,
      id: "p2",
      value: "detailed",
      basis: "owner-correction",
      evidenceIds: ["owner"],
    },
    [correction],
    30,
    100,
  );
  expect(() =>
    revisePersonality(second, { ...proposal, id: "p3" }, evidence, 40, 100),
  ).toThrow(/owner correction/);
  const reverted = revertPersonality(
    second,
    "rollback",
    "p2",
    "Owner requested rollback",
    40,
  );
  expect(reverted.revisions.at(-1)?.traits.verbosity?.value).toBe("concise");
  expect(second.revisions.at(-1)?.traits.verbosity?.value).toBe("detailed");
  expect(original.revisions).toHaveLength(0);
  expect(reverted.charter).toEqual(original.charter);
  expect(reverted.revisions).toHaveLength(3);
  expect(JSON.parse(JSON.stringify(reverted))).toEqual(reverted);
});
