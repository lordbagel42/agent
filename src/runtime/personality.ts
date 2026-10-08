import { createHash } from "node:crypto";
import { actor } from "rivetkit";
import { z } from "zod";
import type { MessageEvent, Owner } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import type { CuratedPersonalityStore } from "../memory/curated.js";
import type {
  GlobalProposalInput,
  ReflectionProposalBinding,
} from "../reflection/global-proposal.js";
import { CHARTER } from "../reflection/personality.js";
import { personalityProfileDigest } from "./personality-evaluation-preview.js";

// A closed vocabulary is intentional: private evidence, arbitrary instructions,
// names and explanations cannot become public through this profile.
export const globalStyleSchema = z.strictObject({
  tone: z.enum(["warm", "dry", "playful", "direct"]),
  verbosity: z.enum(["concise", "balanced", "expansive"]),
  humor: z.enum(["subtle", "playful", "none"]),
  curiosity: z.enum(["occasional", "eager", "reserved"]),
});
export const personalityPreviewSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  style: globalStyleSchema,
  apply: z.boolean().optional(),
});
export type PersonalityPreview = z.infer<typeof personalityPreviewSchema>;
type Style = z.infer<typeof globalStyleSchema>;
const traitProvenanceSchema = z.strictObject({
  kind: z.enum(["default", "owner-publication", "rollback"]),
  originVersion: z.number().int().nonnegative(),
  appliedVersion: z.number().int().nonnegative(),
  restoredFromVersion: z.number().int().nonnegative().optional(),
});
const provenanceSchema = z.strictObject({
  tone: traitProvenanceSchema,
  verbosity: traitProvenanceSchema,
  humor: traitProvenanceSchema,
  curiosity: traitProvenanceSchema,
});
type TraitProvenance = z.infer<typeof traitProvenanceSchema>;
type Provenance = z.infer<typeof provenanceSchema>;
export interface GlobalPersonality {
  version: number;
  style: Style;
  /** Absent on snapshots captured before provenance was introduced. */
  provenance?: Provenance;
}
export const defaultGlobalPersonality: GlobalPersonality = {
  version: 0,
  style: {
    tone: "warm",
    verbosity: "balanced",
    humor: "subtle",
    curiosity: "occasional",
  },
};

export const personalityHelp = `My personality is one global voice, not a separate persona per channel. Read it with !personality. June may choose a bounded public-safe style with personalityPreview:{expectedVersion:VERSION,style:{tone,verbosity,humor,curiosity},apply:true} from any admitted conversation; human per-action approval is not required. Omitting apply or setting apply:false is read-only. Only explicitly changed traits lose prior evidence grounding; unchanged traits retain it. Use !personality pending for up to five pending draft summaries in this source scope with exact proposalId/expectedVersion and safe provenance fingerprints. Pending inspection is read-only, not publication or evidence recall; drafts never apply automatically. Use !personality history for up to five newest revisions, then its next command (!personality history BEFORE_VERSION) for older revisions, excluding that saved version. Explanations are shown only in their original source scope. New edits do not shift older pages. Fresh plain-text commands (not quotes, code blocks or historical text) also work from admitted conversations. Publish a change with !personality revise {"expectedVersion":VERSION,"changes":{"tone":"dry"},"explanation":"Why this fits","publish":true}. Changes may include tone (warm/dry/playful/direct), verbosity (concise/balanced/expansive), humor (subtle/playful/none), curiosity (occasional/eager/reserved). Reset just one named trait with !personality reset {"expectedVersion":VERSION,"trait":"humor","explanation":"Restore default humor","publish":true}. Defaults are tone=warm, verbosity=balanced, humor=subtle, curiosity=occasional. Reset preserves other traits and appends a revision without clearing history. The separate grounded-draft path still requires a complete, unexpired host comparison matching the candidate, effective current profile and evidence: personalityEvaluate:{candidateId,heldOutSourceIds,mode:"compare"}, then !personality approve {"proposalId":"ID","expectedVersion":VERSION,"evaluationId":"RECEIPT_UUID","candidateDigest":"SHA256_FROM_COMPARISON","publish":true}. Evaluation and explicit grounded publication work in the draft's original host-routed source scope, including admitted guest and shared conversations; the model cannot choose or substitute an audience. Select 1–4 fresh interactions from that same scope, excluding the draft's supporting evidence and sources. An ID from owner-private or another scope grants no access. Evidence, terminal decisions and the effective profile are revalidated during evaluation and before publication; an unavailable or stale comparison requires a fresh review, never automatic rebasing or acceptance. These checks do not restrict direct public-safe style application. Comparison judgments are advisory, not a required winning score. Each grounded field retains its exact original evidence scope through unrelated edits and rollback, and returns to its default if that evidence expires or is forgotten. Restore a saved version with !personality rollback {"expectedVersion":VERSION,"targetVersion":0,"explanation":"Why restore it","publish":true}. Reject a staged suggestion in its source scope with !personality reject {"proposalId":"ID"}; rejection is permanent for that ID and does not change my global voice. Revisions affect new turns in every conversation; already-started turns keep their snapshot. No private evidence or rationale is published. The legacy provenance label owner-publication denotes explicit style publication, not proof of human approval. These actions cannot change honesty, privacy, permissions or tools.`;

export function isPersonalityCommand(text: string): boolean {
  return /^!personality(?:\s|$)/.test(text.trim());
}

/** The only global projection. Validate and select fields, never serialize a
 * revision or private curation record into the prompt. */
export function publicPersonality(profile: GlobalPersonality) {
  const style = globalStyleSchema.parse(profile.style);
  const version = z.number().int().nonnegative().parse(profile.version);
  return {
    version,
    style,
    selfDescription: `I'm ${CHARTER.identity} (she/her), the same companion across conversations. My tone is ${style.tone}, my replies are ${style.verbosity}, my humor is ${style.humor}, and my curiosity is ${style.curiosity}.`,
    ...(profile.provenance === undefined
      ? {}
      : { provenance: provenanceSchema.parse(profile.provenance) }),
  };
}

/** Pure public-safe diff, even if apply is set. Only the actor's apply action
 * can publish; this helper never appends a revision or saves state. */
export function previewPersonality(
  profile: GlobalPersonality,
  value: PersonalityPreview,
): string {
  const current = publicPersonality(profile);
  const proposal = personalityPreviewSchema.parse(value);
  if (proposal.expectedVersion !== current.version)
    return `Personality changed: current version is ${current.version}. Read !personality and preview your change again. Nothing has been saved.`;
  const changed = Object.entries(proposal.style).filter(
    ([key, value]) => current.style[key as keyof Style] !== value,
  );
  if (!changed.length)
    return `No style changes from global personality v${current.version}. Nothing has been saved.`;
  return [
    `Public-safe personality preview against v${current.version}. Nothing has been saved.`,
    ...changed.map(
      ([key, value]) =>
        `${key}: ${current.style[key as keyof Style]} → ${value}`,
    ),
    `Proposed voice: ${publicPersonality({ version: current.version, style: proposal.style }).selfDescription}`,
    `June can choose personalityPreview with apply:true, expectedVersion:${current.version} and this style to apply it to new turns in every conversation. No human command or owner-private conversation is required.`,
    "Permissions and tools will not change. A newer revision requires a fresh version check.",
  ].join("\n");
}

interface StoredPersonality extends GlobalPersonality {
  /** Private, per-field provenance; never part of publicPersonality. */
  proposalIds?: Partial<Record<keyof Style, string>>;
  /** Original grounding audience, not the scope of a later edit or rollback.
   * Legacy IDs without this field resolve ONLY in their historical private scope. */
  proposalScopes?: Partial<Record<keyof Style, string>>;
}
interface Revision extends StoredPersonality {
  commandId: string;
  explanation: string;
  /** Legacy revisions without a source scope originated in owner-private chat. */
  sourceScope?: string;
  createdAt: number;
  restoredFrom?: number;
}
interface State {
  revisions: Revision[];
  proposalDecisions?: Record<
    string,
    ({ status: "accepted"; revision: number } | { status: "rejected" }) & {
      sourceScope?: string;
    }
  >;
}

/** Derive only the four effective traits' lineage, including pre-upgrade state.
 * Private reasons, command IDs and evidence never participate in this read. */
function currentPersonality(
  revisions: readonly Revision[],
  project: (profile: StoredPersonality) => GlobalPersonality,
) {
  const initial: TraitProvenance = {
    kind: "default",
    originVersion: 0,
    appliedVersion: 0,
  };
  let provenance: Provenance = {
    tone: initial,
    verbosity: initial,
    humor: initial,
    curiosity: initial,
  };
  const byVersion = new Map([[0, provenance]]);
  let head: StoredPersonality = defaultGlobalPersonality;
  for (const revision of revisions) {
    const restored =
      revision.restoredFrom === undefined
        ? undefined
        : byVersion.get(revision.restoredFrom);
    if (revision.restoredFrom !== undefined && !restored)
      throw new Error("Missing personality rollback version");
    const next = { ...provenance };
    for (const trait of globalStyleSchema.keyof().options) {
      if (restored) {
        next[trait] = {
          kind: "rollback",
          originVersion: restored[trait].originVersion,
          appliedVersion: revision.version,
          restoredFromVersion: revision.restoredFrom,
        };
      } else if (
        revision.style[trait] !== head.style[trait] ||
        revision.proposalIds?.[trait] !== head.proposalIds?.[trait] ||
        revision.proposalScopes?.[trait] !== head.proposalScopes?.[trait]
      ) {
        next[trait] = {
          kind: "owner-publication",
          originVersion: revision.version,
          appliedVersion: revision.version,
        };
      }
    }
    provenance = next;
    byVersion.set(revision.version, provenance);
    head = revision;
  }
  return publicPersonality(project({ ...head, provenance }));
}

const commandFields = {
  expectedVersion: personalityPreviewSchema.shape.expectedVersion,
  explanation: z.string().trim().min(1).max(240),
  publish: z.literal(true),
};
const reviseSchema = z.strictObject({
  ...commandFields,
  changes: globalStyleSchema.partial().refine((v) => Object.keys(v).length > 0),
});
const rollbackSchema = z.strictObject({
  ...commandFields,
  targetVersion: z.number().int().nonnegative(),
});
const resetSchema = z.strictObject({
  ...commandFields,
  trait: globalStyleSchema.keyof(),
});
const rejectSchema = z.strictObject({
  proposalId: z.string().regex(/^personality:[a-f0-9]{64}$/),
});
const approveSchema = z.strictObject({
  proposalId: z.string().regex(/^personality:[a-f0-9]{64}$/),
  expectedVersion: z.number().int().nonnegative().safe(),
  evaluationId: z.uuid(),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  publish: z.literal(true),
});

/** One actor per owner, shared by ALL surfaces. Its actions are host-only APIs;
 * only authenticated ingress may supply events. Never expose the engine. */
export function createPersonalityActor(
  owner: Owner,
  curated?: CuratedPersonalityStore,
  getDeletionRevision: () => number = () => 0,
) {
  const privateScope = JSON.stringify(["private", owner.id]);
  const effective = (profile: StoredPersonality): GlobalPersonality => {
    const style = globalStyleSchema.parse(profile.style);
    const provenance =
      profile.provenance && provenanceSchema.parse(profile.provenance);
    const grounding = globalStyleSchema.keyof().options.flatMap((trait) => {
      const id = profile.proposalIds?.[trait];
      if (!id) return [];
      const scope = profile.proposalScopes?.[trait] ?? privateScope;
      return [{ trait, id, scope, key: JSON.stringify([scope, id]) }];
    });
    const expirations = new Map<string, number>();
    for (const { id, scope, key } of grounding) {
      if (expirations.has(key)) continue;
      let expiresAt = 0;
      try {
        expiresAt = curated?.publishedGlobalProposalExpiry(scope, id) ?? 0;
      } catch {
        // Unavailable evidence cannot sustain a published grounded trait.
      }
      expirations.set(key, expiresAt);
    }
    // One expiry boundary after all synchronous ledger reads, including fields
    // supported by the same proposal. Never resurrect an older grounded value.
    const now = Date.now();
    for (const { trait, key } of grounding) {
      if ((expirations.get(key) ?? 0) <= now) {
        Object.assign(style, {
          [trait]: defaultGlobalPersonality.style[trait],
        });
        if (provenance)
          provenance[trait] = {
            kind: "default",
            originVersion: 0,
            appliedVersion: 0,
          };
      }
    }
    return {
      version: profile.version,
      style,
      ...(provenance ? { provenance } : {}),
    };
  };
  const inspectPending = (state: State, scope: string): string => {
    if (!curated)
      return "Pending personality suggestions are unavailable: curated memory is disabled. Nothing changed.";
    try {
      const now = Date.now();
      const head = state.revisions.at(-1) ?? defaultGlobalPersonality;
      const proposals = curated.pendingGlobalProposals(
        scope,
        6,
        now,
        Object.keys(state.proposalDecisions ?? {}),
      );
      // Select public-safe values only. Raw IDs, evidence and rationale may
      // contain private text; never copy them into command receipts/history.
      const rows = proposals.slice(-5).map((proposal) => ({
        proposalId: proposal.id,
        expectedVersion: proposal.expectedVersion,
        changes: proposal.changes,
        reviewState:
          proposal.expectedVersion === head.version
            ? "pending draft; not applied"
            : "stale target; fresh suggestion required",
        sourceCount: proposal.sourceIds.length,
        sourceRefs: proposal.sourceIds
          .slice(0, 3)
          .map(
            (id) => `sha256:${createHash("sha256").update(id).digest("hex")}`,
          ),
      }));
      return `Source-scoped pending personality snapshot at ${new Date(now).toISOString()}. Current global version: ${head.version}. Showing ${rows.length} latest suggestions (limit 5). ${proposals.length > 5 ? "Additional pending suggestions are omitted." : rows.length ? "" : "No currently valid pending suggestions."}\n${JSON.stringify(rows)}\nSupport was revalidated for this read; decided, expired and invalidated suggestions are excluded. Nothing was approved or applied. A matching version does not publish a draft. Review uses the exact proposalId and expectedVersion; stale targets must not be rebased automatically. sourceRefs are SHA-256 of original UTF-8 source IDs (up to 3 per suggestion), not recall IDs or evidence text. Raw rationale, source IDs, URLs and bodies remain private in encrypted storage; this snapshot is not current truth on later turns. Evaluate and explicitly approve a grounded draft only in this same host-routed source scope; guest and shared scopes never borrow owner-private evidence.`;
    } catch {
      return "Pending personality inspection is unavailable; no review state can be inferred. Nothing changed.";
    }
  };
  return actor({
    state: { revisions: [] } as State,
    actions: {
      pending: (c, event: MessageEvent): string => {
        if (c.key.length !== 1 || c.key[0] !== owner.id)
          throw new Error("Wrong personality owner");
        const scope = routeEvent(event, owner);
        if (!scope) return "Pending personality inspection is unavailable.";
        return inspectPending(c.state, JSON.stringify(scope.key));
      },
      read: async (c) => {
        if (c.key.length !== 1 || c.key[0] !== owner.id)
          throw new Error("Wrong personality owner");
        await c.saveState({ immediate: true });
        return currentPersonality(c.state.revisions, effective);
      },
      /** Host supplies an admitted event and stable operation identity, never
       * model-authored scope. Guard + append stay synchronous across RPC races. */
      apply: async (
        c,
        event: MessageEvent,
        input: PersonalityPreview,
        operationId: string,
        deletionRevision: number,
      ): Promise<string> => {
        if (c.key.length !== 1 || c.key[0] !== owner.id)
          throw new Error("Wrong personality owner");
        const scope = routeEvent(event, owner);
        if (!scope) return "Personality application is unavailable.";
        const parsed = personalityPreviewSchema.safeParse(input);
        if (!parsed.success)
          return "Invalid personality preview. Nothing changed.";
        const value = parsed.data;
        if (value.apply !== true)
          return previewPersonality(
            currentPersonality(c.state.revisions, effective),
            value,
          );
        if (!z.string().trim().min(1).max(256).safeParse(operationId).success)
          return "Invalid personality operation identity. Nothing changed.";
        const sourceScope = JSON.stringify(scope.key);
        const commandId = createHash("sha256")
          .update(JSON.stringify(["apply", sourceScope, operationId]))
          .digest("hex");
        const confirmSave = async () => {
          try {
            await c.saveState({ immediate: true });
          } catch {
            throw new Error(
              "Personality application could not be confirmed. Retry with the same operation identity, not a new action.",
            );
          }
        };
        const previous = c.state.revisions.find(
          (r) => r.commandId === commandId,
        );
        if (previous) {
          await confirmSave();
          return `Personality revision ${previous.version} was already saved; no duplicate change was made.`;
        }
        if (deletionRevision !== getDeletionRevision())
          return "Personality application context changed; nothing was saved. Review the current context before choosing a new style.";
        const head: StoredPersonality =
          c.state.revisions.at(-1) ?? defaultGlobalPersonality;
        if (value.expectedVersion !== head.version)
          return `Personality changed: current version is ${head.version}. Read the current profile and choose again; nothing was overwritten.`;
        const current = effective(head);
        // A full profile may have been read before evidence expired, without a
        // version change. Copying a stored grounded value is not an explicit
        // edit: preserve its lineage rather than laundering it into an
        // independent publication. Only new values detach their grounding.
        const changed = globalStyleSchema
          .keyof()
          .options.filter(
            (trait) =>
              value.style[trait] !== current.style[trait] &&
              (!head.proposalIds?.[trait] ||
                value.style[trait] !== head.style[trait]),
          );
        if (!changed.length)
          return `No style changes from global personality v${head.version}. Unchanged grounded traits still follow evidence expiry. Nothing has been saved.`;
        if (head.version >= Number.MAX_SAFE_INTEGER)
          return "Personality revision limit reached. Nothing changed.";
        const proposalIds = { ...head.proposalIds };
        const proposalScopes = { ...head.proposalScopes };
        const style = { ...current.style };
        for (const trait of changed) {
          delete proposalIds[trait];
          delete proposalScopes[trait];
          Object.assign(style, { [trait]: value.style[trait] });
        }
        const version = head.version + 1;
        c.state.revisions.push({
          version,
          style,
          proposalIds,
          proposalScopes,
          commandId,
          sourceScope,
          explanation: "June selected a bounded public-safe style.",
          createdAt: Date.now(),
        });
        const result = currentPersonality(c.state.revisions, effective);
        // A failed flush must reject, not claim publication. The retained
        // operation ID lets a retry flush the same revision without appending.
        await confirmSave();
        return `Saved global personality revision ${version}. New turns in every conversation use this style; already-started turns keep their snapshot. ${JSON.stringify(publicPersonality(effective({ ...result, proposalIds, proposalScopes })))} No private evidence or rationale was published; permissions and tools are unchanged.`;
      },
      /** Explicit draft only; never automatically publishes a pending proposal. */
      stage: async (
        c,
        event: MessageEvent,
        input: GlobalProposalInput,
        reflection?: ReflectionProposalBinding,
        callerDeletionRevision?: number,
      ): Promise<string> => {
        if (c.key.length !== 1 || c.key[0] !== owner.id)
          throw new Error("Wrong personality owner");
        const scope = routeEvent(event, owner);
        if (!curated || !scope)
          return "Personality suggestion not staged. An admitted conversation and curated memory are required; nothing was applied.";
        if (reflection && callerDeletionRevision === undefined)
          return "Personality suggestion not staged. Current caller validity is required; nothing was applied.";
        const head = c.state.revisions.at(-1) ?? defaultGlobalPersonality;
        if (input?.expectedVersion !== head.version)
          return `Personality suggestion not staged: current version is ${head.version}. Review the current profile before suggesting again; nothing was applied.`;
        // No await between head check, current ledger validation and encrypted
        // CAS write. The optional binding comes from fresh host admission, never
        // model output. No profile fields or revisions are changed here.
        const proposal = curated.stageGlobalProposal(
          JSON.stringify(scope.key),
          input,
          Date.now(),
          reflection,
          callerDeletionRevision,
        );
        const decision = c.state.proposalDecisions?.[proposal.id];
        if (decision) {
          await c.saveState({ immediate: true });
          return `That personality suggestion was already ${decision.status}; it was not staged again and nothing was applied.`;
        }
        return `Staged private personality suggestion ${proposal.id} for global version ${proposal.expectedVersion} in this source scope. Nothing was applied; this is an explicit draft, not an automatic publication. Evaluate and explicitly approve this grounded draft in the same host-routed source scope. June can independently choose a public-safe style with personalityPreview and apply:true against the current version.`;
      },
      /** Private host-only projection, never part of read() or a public prompt.
       * Authenticated ingress binds candidate lookup to its original audience.
       * Keep head, decision and payload reads synchronous; this does not mutate state. */
      evaluationCandidate: (c, event: MessageEvent, id: string) => {
        if (c.key.length !== 1 || c.key[0] !== owner.id)
          throw new Error("Wrong personality owner");
        const scope = routeEvent(event, owner);
        if (
          !scope ||
          !z.string().min(1).max(256).safeParse(id).success ||
          Object.hasOwn(c.state.proposalDecisions ?? {}, id)
        )
          return null;
        const head = c.state.revisions.at(-1) ?? defaultGlobalPersonality;
        const proposal = curated?.pendingGlobalProposal(
          JSON.stringify(scope.key),
          id,
        );
        if (!proposal || proposal.expectedVersion !== head.version) return null;
        return {
          profile: currentPersonality(c.state.revisions, effective),
          proposal: {
            id: proposal.id,
            scope: proposal.scope,
            expectedVersion: proposal.expectedVersion,
            changes: proposal.changes,
            evidenceIds: proposal.evidenceIds,
            sourceIds: proposal.sourceIds,
          },
        };
      },
      command: async (c, event: MessageEvent): Promise<string> => {
        if (c.key.length !== 1 || c.key[0] !== owner.id)
          throw new Error("Wrong personality owner");
        const scope = routeEvent(event, owner);
        if (!scope || !isPersonalityCommand(event.text))
          return "Personality command unavailable.";
        const sourceScope = JSON.stringify(scope.key);
        const head: StoredPersonality =
          c.state.revisions.at(-1) ?? defaultGlobalPersonality;
        const input = event.text.trim().slice("!personality".length).trim();
        if (!input || input === "show") {
          await c.saveState({ immediate: true });
          const result = JSON.stringify(
            currentPersonality(c.state.revisions, effective),
          );
          return `${result}\n\n${personalityHelp}`;
        }
        if (
          event.address.channel === "slack" &&
          event.personalityCommandEligible !== true
        )
          return "Personality commands require fresh, plain-text ingress (not a quote, code block or historical text).";
        if (input === "pending") return inspectPending(c.state, sourceScope);
        if (input.length > 2000) return "Personality command is too long.";
        if (/^history(?:\s|$)/.test(input)) {
          await c.saveState({ immediate: true });
          const currentVersion = c.state.revisions.at(-1)?.version ?? 0;
          const match = input.match(/^history(?:\s+([1-9]\d*))?$/);
          const before = match?.[1] ? Number(match[1]) : undefined;
          const end =
            before === undefined
              ? c.state.revisions.length
              : c.state.revisions.findIndex((r) => r.version === before);
          if (
            !match ||
            end < 0 ||
            (before !== undefined && !Number.isSafeInteger(before))
          )
            return "Invalid personality history cursor. Use !personality history or its next command with a saved positive revision number.";
          // The exclusive boundary is a saved revision ID, never a moving offset.
          const page = c.state.revisions
            .slice(Math.max(0, end - 5), end)
            .reverse();
          const history = page.map(
            (r) =>
              `v${r.version} (${new Date(r.createdAt).toISOString()})${r.restoredFrom !== undefined ? ` restored from v${r.restoredFrom}` : ""}: ${JSON.stringify(effective(r).style)}\nWhy: ${(r.sourceScope ?? privateScope) === sourceScope ? r.explanation : "Explanation withheld outside its source scope."}`,
          );
          const oldest = page.at(-1);
          const next =
            end > 5 && oldest
              ? `Next: !personality history ${oldest.version}`
              : "End of personality history.";
          return `Personality revisions, newest first (up to 5; explanations are source-scoped; version 0 is the initial style):\n${history.join("\n\n") || "No earlier revisions."}\nCurrent version: ${currentVersion}. Rollback appends a revision, never erases history.\n${next}`;
        }
        const match = input.match(
          /^(revise|rollback|reset|reject|approve)\s+([\s\S]+)$/,
        );
        if (!match) return personalityHelp;
        let value: unknown;
        try {
          value = JSON.parse(match[2] ?? "");
        } catch {
          return `Invalid personality JSON.\n${personalityHelp}`;
        }
        if (match[1] === "reject") {
          const parsed = rejectSchema.safeParse(value);
          if (!parsed.success) return "Invalid personality rejection.";
          const { proposalId } = parsed.data;
          const decision = c.state.proposalDecisions?.[proposalId];
          if (
            decision &&
            (decision.sourceScope ?? privateScope) !== sourceScope
          )
            return "No current pending personality suggestion has that ID. Nothing changed.";
          if (decision?.status === "accepted")
            return "That personality suggestion was already accepted. Nothing changed.";
          if (!decision) {
            try {
              if (!curated?.pendingGlobalProposal(sourceScope, proposalId))
                return "No current pending personality suggestion has that ID. Nothing changed.";
            } catch {
              return "Personality suggestions are unavailable. Nothing changed.";
            }
          }
          // Lookup and decision are synchronous, sharing approval's terminal
          // ledger. Reassign and flush even on retry, including after a failed
          // save or forgotten evidence. Never append a personality revision.
          c.state.proposalDecisions = {
            ...c.state.proposalDecisions,
            [proposalId]: { status: "rejected", sourceScope },
          };
          await c.saveState({ immediate: true });
          return `Rejected personality suggestion ${proposalId}. Global personality is unchanged.`;
        }
        const commandId = createHash("sha256")
          .update(
            JSON.stringify([
              event.address.channel,
              event.address.accountId,
              event.id,
            ]),
          )
          .digest("hex");
        const previous = c.state.revisions.find(
          (r) => r.commandId === commandId,
        );
        if (previous) {
          await c.saveState({ immediate: true });
          return `Personality revision ${previous.version} was already saved; no duplicate change was made.`;
        }
        if (match[1] === "approve") {
          const approval = approveSchema.safeParse(value);
          if (!approval.success)
            return "Invalid personality approval. Nothing changed.";
          const { proposalId, expectedVersion, evaluationId, candidateDigest } =
            approval.data;
          const decision = c.state.proposalDecisions?.[proposalId];
          if (
            decision &&
            (decision.sourceScope ?? privateScope) !== sourceScope
          )
            return "That personality suggestion is unavailable in this source scope. Nothing changed.";
          if (decision?.status === "accepted") {
            await c.saveState({ immediate: true });
            return `Personality revision ${decision.revision} was already saved; no duplicate change was made.`;
          }
          if (decision?.status === "rejected")
            return "That personality suggestion was rejected. Nothing changed.";
          const proposal = curated?.pendingGlobalProposal(
            sourceScope,
            proposalId,
          );
          if (!proposal || proposal.expiresAt <= Date.now())
            return "That personality suggestion is unavailable or its evidence is no longer valid. Nothing changed.";
          if (
            expectedVersion !== head.version ||
            proposal.expectedVersion !== head.version
          )
            return `Personality changed: current version is ${head.version}. Request a new suggestion; nothing was overwritten.`;
          const evaluation = curated?.readEvaluation(sourceScope, evaluationId);
          const current = currentPersonality(c.state.revisions, effective);
          const version = head.version + 1;
          const style = globalStyleSchema.parse({
            ...current.style,
            ...proposal.changes,
          });
          // A caller-provided digest is confirmation, not proof of evaluation.
          // Forgetting can change effective style without advancing the version.
          if (
            evaluation?.status !== "complete" ||
            evaluation.candidateId !== proposalId ||
            evaluation.expectedVersion !== expectedVersion ||
            evaluation.currentDigest !== personalityProfileDigest(current) ||
            evaluation.candidateDigest !== candidateDigest ||
            evaluation.candidateDigest !==
              personalityProfileDigest({ version, style })
          )
            return "Personality evaluation is unavailable or no longer matches this candidate and current profile. Request a new comparison and review it; nothing changed.";
          const proposalIds = { ...head.proposalIds };
          const proposalScopes = { ...head.proposalScopes };
          for (const trait of Object.keys(
            proposal.changes,
          ) as (keyof Style)[]) {
            proposalIds[trait] = proposalId;
            proposalScopes[trait] = sourceScope;
          }
          // Evidence, evaluation, head guard and terminal decision share one
          // synchronous turn. Recheck expiry after all synchronous store reads.
          if (Math.min(proposal.expiresAt, evaluation.expiresAt) <= Date.now())
            return "Personality suggestion or evaluation expired. Request a new comparison; nothing changed.";
          c.state.revisions.push({
            version,
            style,
            proposalIds,
            proposalScopes,
            commandId,
            explanation: "Approved staged personality suggestion.",
            sourceScope,
            createdAt: Date.now(),
          });
          c.state.proposalDecisions ??= {};
          c.state.proposalDecisions[proposalId] = {
            status: "accepted",
            revision: version,
            sourceScope,
          };
          const result = currentPersonality(c.state.revisions, effective);
          await c.saveState({ immediate: true });
          return `Saved global personality revision ${version} for all conversations. ${JSON.stringify(publicPersonality(effective({ ...result, proposalIds, proposalScopes })))} Private evidence and rationale were not published; permissions and tools are unchanged.`;
        }
        const revise =
          match[1] === "revise" ? reviseSchema.safeParse(value) : undefined;
        const rollback =
          match[1] === "rollback" ? rollbackSchema.safeParse(value) : undefined;
        const reset =
          match[1] === "reset" ? resetSchema.safeParse(value) : undefined;
        const command = revise?.success
          ? revise.data
          : rollback?.success
            ? rollback.data
            : reset?.success
              ? reset.data
              : undefined;
        if (!command)
          return `Invalid personality revision.\n${personalityHelp}`;
        if (command.expectedVersion !== head.version)
          return `Personality changed: current version is ${head.version}. Read !personality and review your change again; nothing was overwritten.`;
        const restored: StoredPersonality | undefined = rollback?.success
          ? rollback.data.targetVersion === 0
            ? defaultGlobalPersonality
            : c.state.revisions.find(
                (r) => r.version === rollback.data.targetVersion,
              )
          : undefined;
        if (rollback?.success && !restored)
          return "That personality version does not exist. Nothing changed.";
        const style = globalStyleSchema.parse(
          revise?.success
            ? { ...effective(head).style, ...revise.data.changes }
            : reset?.success
              ? {
                  ...effective(head).style,
                  [reset.data.trait]:
                    defaultGlobalPersonality.style[reset.data.trait],
                }
              : restored && effective(restored).style,
        );
        const proposalIds = { ...(restored ?? head).proposalIds };
        const proposalScopes = { ...(restored ?? head).proposalScopes };
        if (revise?.success)
          for (const trait of Object.keys(
            revise.data.changes,
          ) as (keyof Style)[]) {
            delete proposalIds[trait];
            delete proposalScopes[trait];
          }
        if (reset?.success) {
          delete proposalIds[reset.data.trait];
          delete proposalScopes[reset.data.trait];
        }
        // Guard + append are synchronous: concurrent actions cannot both pass
        // the same version. Flush before acknowledging, including duplicate calls.
        const version = head.version + 1;
        c.state.revisions.push({
          version,
          style,
          proposalIds,
          proposalScopes,
          commandId,
          explanation: command.explanation,
          sourceScope,
          createdAt: Date.now(),
          ...(restored ? { restoredFrom: restored.version } : {}),
        });
        const result = currentPersonality(c.state.revisions, effective);
        await c.saveState({ immediate: true });
        return `Saved global personality revision ${version}. New turns in every conversation use this style; already-started turns keep their snapshot. ${JSON.stringify(publicPersonality(effective({ ...result, proposalIds, proposalScopes })))} Explanations remain source-scoped; permissions and tools are unchanged.`;
      },
    },
  });
}
