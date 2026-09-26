import { type Evidence, freshEvidence } from "./domain.js";

export const CHARTER = Object.freeze({
  identity: "June",
  honesty: true,
  privacy: true,
  authority: "external-owner-policy",
} as const);
export type Trait = "verbosity" | "tone" | "humor" | "interests";
export interface PersonalityProposal {
  id: string;
  scope: string;
  trait: Trait;
  value: string;
  basis: "owner-correction" | "inferred";
  evidenceIds: string[];
  explanation: string;
  confidence: number;
}
export interface TraitValue {
  value: string;
  basis: PersonalityProposal["basis"];
  evidenceIds: string[];
  scope: string;
}
export interface PersonalityRevision {
  id: string;
  parent: string | null;
  createdAt: number;
  traits: Partial<Record<Trait, TraitValue>>;
  scopedTraits?: {
    scope: string;
    traits: Partial<Record<Trait, TraitValue>>;
  }[];
  explanation: string;
  proposal?: PersonalityProposal;
  reverts?: string;
}
export interface PersonalityState {
  charter: typeof CHARTER;
  revisions: PersonalityRevision[];
}
export const initialPersonality = (): PersonalityState => ({
  charter: CHARTER,
  revisions: [],
});

/** Legacy snapshots had one slot per trait; retain their surviving scope only. */
function scopes(
  revision: PersonalityRevision | undefined,
): NonNullable<PersonalityRevision["scopedTraits"]> {
  if (revision?.scopedTraits) return structuredClone(revision.scopedTraits);
  const result: NonNullable<PersonalityRevision["scopedTraits"]> = [];
  for (const [trait, value] of Object.entries(revision?.traits ?? {})) {
    let scoped = result.find((s) => s.scope === value.scope);
    if (!scoped) {
      scoped = { scope: value.scope, traits: {} };
      result.push(scoped);
    }
    scoped.traits[trait as Trait] = structuredClone(value);
  }
  return result;
}

export function personalityTraits(
  state: PersonalityState,
  scope: string,
): Partial<Record<Trait, TraitValue>> {
  return (
    scopes(state.revisions.at(-1)).find((s) => s.scope === scope)?.traits ?? {}
  );
}

export function proposeRevision(
  value: unknown,
  evidence: Evidence[],
  now: number,
  maxAgeMs: number,
): { ok: true; proposal: PersonalityProposal } | { ok: false; reason: string } {
  const bad = () => ({
    ok: false as const,
    reason: "invalid-or-unsupported-proposal",
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
  const p = value as Record<string, unknown>;
  if (
    Object.keys(p).some(
      (key) =>
        ![
          "id",
          "scope",
          "trait",
          "value",
          "basis",
          "evidenceIds",
          "explanation",
          "confidence",
        ].includes(key),
    ) ||
    !["id", "scope", "value", "explanation"].every(
      (key) =>
        typeof p[key] === "string" &&
        (p[key] as string).trim().length > 0 &&
        (p[key] as string).length <= 2000,
    ) ||
    typeof p.trait !== "string" ||
    !["verbosity", "tone", "humor", "interests"].includes(p.trait) ||
    typeof p.basis !== "string" ||
    !["owner-correction", "inferred"].includes(p.basis) ||
    typeof p.confidence !== "number" ||
    !Number.isFinite(p.confidence) ||
    p.confidence < 0 ||
    p.confidence > 1 ||
    !Array.isArray(p.evidenceIds) ||
    !p.evidenceIds.length ||
    p.evidenceIds.length > 100 ||
    new Set(p.evidenceIds).size !== p.evidenceIds.length ||
    !p.evidenceIds.every((id) => typeof id === "string")
  )
    return bad();
  const proposal = value as PersonalityProposal;
  const supporting: Evidence[] = [];
  for (const id of proposal.evidenceIds) {
    const matches = evidence.filter(
      (e) => e.id === id && e.scope === proposal.scope,
    );
    const match = matches[0];
    if (
      matches.length !== 1 ||
      !match ||
      !freshEvidence(match, proposal.scope, now, maxAgeMs) ||
      match.source === "dream"
    )
      return bad();
    supporting.push(match);
  }
  if (
    proposal.basis === "owner-correction" &&
    !supporting.some(
      (e) =>
        e.source === "owner-correction" &&
        e.correction?.trait === proposal.trait &&
        e.correction.value === proposal.value,
    )
  )
    return bad();
  return { ok: true, proposal: structuredClone(proposal) };
}

/** A revision is curated data only. Call from the owner's policy/review path; never an authority change. */
export function revisePersonality(
  state: PersonalityState,
  proposal: PersonalityProposal,
  evidence: Evidence[],
  now: number,
  maxAgeMs: number,
): PersonalityState {
  const validated = proposeRevision(proposal, evidence, now, maxAgeMs);
  if (!validated.ok) throw new Error(validated.reason);
  const p = validated.proposal;
  if (state.revisions.some((r) => r.id === p.id))
    throw new Error("Duplicate revision");
  const head = state.revisions.at(-1);
  const scopedTraits = scopes(head);
  let scoped = scopedTraits.find((s) => s.scope === p.scope);
  if (!scoped) {
    scoped = { scope: p.scope, traits: {} };
    scopedTraits.push(scoped);
  }
  if (
    scoped.traits[p.trait]?.basis === "owner-correction" &&
    p.basis !== "owner-correction"
  )
    throw new Error("Inferred style cannot override an owner correction");
  const traits = scoped.traits;
  traits[p.trait] = {
    value: p.value,
    basis: p.basis,
    evidenceIds: [...p.evidenceIds],
    scope: p.scope,
  };
  return {
    charter: CHARTER,
    revisions: [
      ...state.revisions,
      {
        id: p.id,
        parent: head?.id ?? null,
        createdAt: now,
        traits,
        scopedTraits,
        explanation: p.explanation,
        proposal: p,
      },
    ],
  };
}

/** Append-only rollback of current head; caller must authorize it independently of model confidence. */
export function revertPersonality(
  state: PersonalityState,
  id: string,
  target: string,
  explanation: string,
  now: number,
): PersonalityState {
  const head = state.revisions.at(-1);
  if (
    !head ||
    head.id !== target ||
    !id.trim() ||
    !explanation.trim() ||
    !Number.isFinite(now) ||
    state.revisions.some((r) => r.id === id)
  )
    throw new Error("Invalid rollback");
  const previous = state.revisions.find((r) => r.id === head.parent);
  return {
    charter: CHARTER,
    revisions: [
      ...state.revisions,
      {
        id,
        parent: head.id,
        createdAt: now,
        explanation,
        traits: structuredClone(previous?.traits ?? {}),
        scopedTraits: scopes(previous),
        reverts: target,
      },
    ],
  };
}
