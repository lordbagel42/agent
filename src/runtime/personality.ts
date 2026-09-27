import { createHash } from "node:crypto";
import { actor } from "rivetkit";
import { z } from "zod";
import type { MessageEvent, Owner } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { isOwner } from "../core/social.js";
import type { CuratedPersonalityStore } from "../memory/curated.js";
import type { GlobalProposalInput } from "../reflection/global-proposal.js";
import { CHARTER } from "../reflection/personality.js";

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

export const personalityHelp = `My personality is one global voice, not a separate persona per channel. Read it with !personality. In an owner-private DM, use !personality pending for up to five unreviewed suggestion summaries with exact proposalId/expectedVersion and safe provenance fingerprints. Pending inspection is read-only, not approval or evidence recall. Use !personality history for up to five newest revisions, then its next command (!personality history BEFORE_VERSION) for older revisions, excluding that saved version. New edits do not shift older pages. Publish a change with !personality revise {"expectedVersion":VERSION,"changes":{"tone":"dry"},"explanation":"Why this fits","publish":true}. Changes may include tone (warm/dry/playful/direct), verbosity (concise/balanced/expansive), humor (subtle/playful/none), curiosity (occasional/eager/reserved). Reset just one named trait with !personality reset {"expectedVersion":VERSION,"trait":"humor","explanation":"Restore default humor","publish":true}. Defaults are tone=warm, verbosity=balanced, humor=subtle, curiosity=occasional. Reset preserves other traits and appends a revision without clearing history; propose this command, not a whole-profile rollback, when the owner asks to reset one trait. Approve an exact staged suggestion for all conversations with !personality approve {"proposalId":"ID","expectedVersion":VERSION,"publish":true}; its staged version and evidence must still be current. Approval publishes only style, never its private evidence or rationale. Grounded fields return to defaults if their evidence expires or is forgotten, including on rollback. Restore a saved version with !personality rollback {"expectedVersion":VERSION,"targetVersion":0,"explanation":"Why restore it","publish":true}. Reject a staged suggestion with !personality reject {"proposalId":"ID"}; rejection is permanent for that ID and does not change my global voice. Revisions affect every conversation; explanations stay private. These commands cannot change honesty, privacy, permissions or tools.`;

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

/** Pure diff of public-safe fields. The host must deliver it only to the owner
 * privately. Never append a revision or call the publishing path from preview. */
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
    `Owner-private personality preview against v${current.version}. Nothing has been saved.`,
    ...changed.map(
      ([key, value]) =>
        `${key}: ${current.style[key as keyof Style]} → ${value}`,
    ),
    `Proposed voice: ${publicPersonality({ version: current.version, style: proposal.style }).selfDescription}`,
    "To apply this style to new turns in every conversation, send this exact plain-text command in your private DM (not as a quote or code block):",
    `!personality revise ${JSON.stringify({ expectedVersion: current.version, changes: Object.fromEntries(changed), explanation: "Owner-approved personality preview", publish: true })}`,
    "Permissions and tools will not change. A newer revision requires a fresh review.",
  ].join("\n");
}

interface StoredPersonality extends GlobalPersonality {
  /** Private, per-field provenance; never part of publicPersonality. */
  proposalIds?: Partial<Record<keyof Style, string>>;
}
interface Revision extends StoredPersonality {
  commandId: string;
  explanation: string;
  createdAt: number;
  restoredFrom?: number;
}
interface State {
  revisions: Revision[];
  proposalDecisions?: Record<
    string,
    { status: "accepted"; revision: number } | { status: "rejected" }
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
        revision.proposalIds?.[trait] !== head.proposalIds?.[trait]
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
  publish: z.literal(true),
});

/** One actor per owner, shared by ALL surfaces. Its actions are host-only APIs;
 * only authenticated ingress may supply events. Never expose the engine. */
export function createPersonalityActor(
  owner: Owner,
  curated?: CuratedPersonalityStore,
) {
  const privateScope = JSON.stringify(["private", owner.id]);
  const effective = (profile: StoredPersonality): GlobalPersonality => {
    const style = globalStyleSchema.parse(profile.style);
    const provenance =
      profile.provenance && provenanceSchema.parse(profile.provenance);
    const expirations = new Map<string, number>();
    for (const id of new Set(Object.values(profile.proposalIds ?? {}))) {
      let expiresAt = 0;
      try {
        expiresAt =
          curated?.pendingGlobalProposal(privateScope, id)?.expiresAt ?? 0;
      } catch {
        // Unavailable evidence cannot sustain a published grounded trait.
      }
      expirations.set(id, expiresAt);
    }
    // One expiry boundary after all synchronous ledger reads, including fields
    // supported by the same proposal. Never resurrect an older grounded value.
    const now = Date.now();
    for (const trait of Object.keys(
      profile.proposalIds ?? {},
    ) as (keyof Style)[]) {
      const id = profile.proposalIds?.[trait];
      if ((expirations.get(id ?? "") ?? 0) <= now) {
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
            ? "pending owner review; not applied"
            : "stale target; fresh suggestion required",
        sourceCount: proposal.sourceIds.length,
        sourceRefs: proposal.sourceIds
          .slice(0, 3)
          .map(
            (id) => `sha256:${createHash("sha256").update(id).digest("hex")}`,
          ),
      }));
      return `Owner-private pending personality snapshot at ${new Date(now).toISOString()}. Current global version: ${head.version}. Showing ${rows.length} latest suggestions (limit 5). ${proposals.length > 5 ? "Additional pending suggestions are omitted." : rows.length ? "" : "No currently valid pending suggestions."}\n${JSON.stringify(rows)}\nSupport was revalidated for this read; decided, expired and invalidated suggestions are excluded. Nothing was approved or applied. A matching version is not approval. Review uses the exact proposalId and expectedVersion; stale targets must not be rebased automatically. sourceRefs are SHA-256 of original UTF-8 source IDs (up to 3 per suggestion), not recall IDs or evidence text. Raw rationale, source IDs, URLs and bodies remain private in encrypted storage; this snapshot is not current truth on later turns.`;
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
        if (
          !scope?.private ||
          !isOwner(event, owner) ||
          (event.address.channel === "slack" &&
            event.metadata?.channelType !== "im")
        )
          return "Pending personality inspection requires an owner-private turn.";
        return inspectPending(c.state, JSON.stringify(scope.key));
      },
      read: async (c) => {
        if (c.key.length !== 1 || c.key[0] !== owner.id)
          throw new Error("Wrong personality owner");
        await c.saveState({ immediate: true });
        return currentPersonality(c.state.revisions, effective);
      },
      /** Model-callable through the host, but never owner publication authority. */
      stage: async (
        c,
        event: MessageEvent,
        input: GlobalProposalInput,
      ): Promise<string> => {
        if (c.key.length !== 1 || c.key[0] !== owner.id)
          throw new Error("Wrong personality owner");
        const scope = routeEvent(event, owner);
        if (
          !curated ||
          !scope?.private ||
          !isOwner(event, owner) ||
          (event.address.channel === "slack" &&
            event.metadata?.channelType !== "im")
        )
          return "Personality suggestion not staged. An owner-private turn and curated memory are required; nothing was applied.";
        const head = c.state.revisions.at(-1) ?? defaultGlobalPersonality;
        if (input?.expectedVersion !== head.version)
          return `Personality suggestion not staged: current version is ${head.version}. Review the current profile before suggesting again; nothing was applied.`;
        // No await between head check, current ledger validation and encrypted
        // CAS write. No profile fields or revisions are changed here.
        const proposal = curated.stageGlobalProposal(
          JSON.stringify(scope.key),
          input,
        );
        const decision = c.state.proposalDecisions?.[proposal.id];
        if (decision) {
          await c.saveState({ immediate: true });
          return `That personality suggestion was already ${decision.status}; it was not staged again and nothing was applied.`;
        }
        return `Staged private personality suggestion ${proposal.id} for global version ${proposal.expectedVersion}. Nothing was applied; separate owner review is required.`;
      },
      command: async (c, event: MessageEvent): Promise<string> => {
        if (c.key.length !== 1 || c.key[0] !== owner.id)
          throw new Error("Wrong personality owner");
        const scope = routeEvent(event, owner);
        if (!scope || !isPersonalityCommand(event.text))
          return "Personality command unavailable.";
        const ownerPrivate =
          scope.private &&
          isOwner(event, owner) &&
          (event.address.channel !== "slack" ||
            (event.metadata?.channelType === "im" &&
              event.personalityCommandEligible === true));
        const head: StoredPersonality =
          c.state.revisions.at(-1) ?? defaultGlobalPersonality;
        const input = event.text.trim().slice("!personality".length).trim();
        if (!input || input === "show") {
          await c.saveState({ immediate: true });
          const result = JSON.stringify(
            currentPersonality(c.state.revisions, effective),
          );
          return `${result}\n\n${ownerPrivate ? personalityHelp : "This is my shared public style. Only my owner can revise it in a private DM."}`;
        }
        if (!ownerPrivate)
          return "Only my owner can inspect personality history or publish revisions with a fresh, plain-text command in an owner-private DM (not a quote or code block).";
        if (input === "pending")
          return inspectPending(c.state, JSON.stringify(scope.key));
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
              `v${r.version} (${new Date(r.createdAt).toISOString()})${r.restoredFrom !== undefined ? ` restored from v${r.restoredFrom}` : ""}: ${JSON.stringify(effective(r).style)}\nWhy: ${r.explanation}`,
          );
          const oldest = page.at(-1);
          const next =
            end > 5 && oldest
              ? `Next: !personality history ${oldest.version}`
              : "End of personality history.";
          return `Personality revisions, newest first (up to 5; explanations are owner-private; version 0 is the initial style):\n${history.join("\n\n") || "No earlier revisions."}\nCurrent version: ${currentVersion}. Rollback appends a revision, never erases history.\n${next}`;
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
          if (decision?.status === "accepted")
            return "That personality suggestion was already accepted. Nothing changed.";
          if (!decision) {
            try {
              if (
                !curated?.pendingGlobalProposal(
                  JSON.stringify(scope.key),
                  proposalId,
                )
              )
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
            [proposalId]: { status: "rejected" },
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
          const { proposalId, expectedVersion } = approval.data;
          const decision = c.state.proposalDecisions?.[proposalId];
          if (decision?.status === "accepted") {
            await c.saveState({ immediate: true });
            return `Personality revision ${decision.revision} was already saved; no duplicate change was made.`;
          }
          if (decision?.status === "rejected")
            return "That personality suggestion was rejected. Nothing changed.";
          const proposal = curated?.pendingGlobalProposal(
            privateScope,
            proposalId,
          );
          if (!proposal || proposal.expiresAt <= Date.now())
            return "That personality suggestion is unavailable or its evidence is no longer valid. Nothing changed.";
          if (
            expectedVersion !== head.version ||
            proposal.expectedVersion !== head.version
          )
            return `Personality changed: current version is ${head.version}. Request a new suggestion; nothing was overwritten.`;
          const style = globalStyleSchema.parse({
            ...effective(head).style,
            ...proposal.changes,
          });
          const proposalIds = { ...head.proposalIds };
          for (const trait of Object.keys(proposal.changes) as (keyof Style)[])
            proposalIds[trait] = proposalId;
          // Live evidence, head guard, revision and terminal decision share one
          // synchronous turn. No private rationale is copied into actor state.
          if (proposal.expiresAt <= Date.now())
            return "That personality suggestion is unavailable or its evidence is no longer valid. Nothing changed.";
          const version = head.version + 1;
          c.state.revisions.push({
            version,
            style,
            proposalIds,
            commandId,
            explanation: "Approved staged personality suggestion.",
            createdAt: Date.now(),
          });
          c.state.proposalDecisions ??= {};
          c.state.proposalDecisions[proposalId] = {
            status: "accepted",
            revision: version,
          };
          const result = currentPersonality(c.state.revisions, effective);
          await c.saveState({ immediate: true });
          return `Saved global personality revision ${version} for all conversations. ${JSON.stringify(publicPersonality(effective({ ...result, proposalIds })))} Private evidence and rationale were not published; permissions and tools are unchanged.`;
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
        if (revise?.success)
          for (const trait of Object.keys(
            revise.data.changes,
          ) as (keyof Style)[])
            delete proposalIds[trait];
        if (reset?.success) delete proposalIds[reset.data.trait];
        // Guard + append are synchronous: concurrent actions cannot both pass
        // the same version. Flush before acknowledging, including duplicate calls.
        const version = head.version + 1;
        c.state.revisions.push({
          version,
          style,
          proposalIds,
          commandId,
          explanation: command.explanation,
          createdAt: Date.now(),
          ...(restored ? { restoredFrom: restored.version } : {}),
        });
        const result = currentPersonality(c.state.revisions, effective);
        await c.saveState({ immediate: true });
        return `Saved global personality revision ${version}. New turns in every conversation use this style; already-started turns keep their snapshot. ${JSON.stringify(publicPersonality(effective({ ...result, proposalIds })))} Explanations remain owner-private; permissions and tools are unchanged.`;
      },
    },
  });
}
