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

export const personalityHelp = `My personality is one global voice, not a separate persona per channel. Read it with !personality. In an owner-private DM, use !personality history for up to five newest revisions, then its next command (!personality history BEFORE_VERSION) for older revisions, excluding that saved version. New edits do not shift older pages. Publish a change with !personality revise {"expectedVersion":VERSION,"changes":{"tone":"dry"},"explanation":"Why this fits","publish":true}. Changes may include tone (warm/dry/playful/direct), verbosity (concise/balanced/expansive), humor (subtle/playful/none), curiosity (occasional/eager/reserved). Reset just one named trait with !personality reset {"expectedVersion":VERSION,"trait":"humor","explanation":"Restore default humor","publish":true}. Defaults are tone=warm, verbosity=balanced, humor=subtle, curiosity=occasional. Reset preserves other traits and appends a revision without clearing history; propose this command, not a whole-profile rollback, when the owner asks to reset one trait. Restore a saved version with !personality rollback {"expectedVersion":VERSION,"targetVersion":0,"explanation":"Why restore it","publish":true}. Reject a staged suggestion with !personality reject {"proposalId":"ID"}; rejection is permanent for that ID and does not change my global voice. Revisions affect every conversation; explanations stay private. These commands cannot change honesty, privacy, permissions or tools.`;

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

interface Revision extends GlobalPersonality {
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
function currentPersonality(revisions: readonly Revision[]) {
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
  let head = defaultGlobalPersonality;
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
      } else if (revision.style[trait] !== head.style[trait]) {
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
  return publicPersonality({
    version: head.version,
    style: head.style,
    provenance,
  });
}

const commandFields = {
  expectedVersion: z.number().int().nonnegative(),
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

/** One actor per owner, shared by ALL surfaces. Its actions are host-only APIs;
 * only authenticated ingress may supply events. Never expose the engine. */
export function createPersonalityActor(
  owner: Owner,
  curated?: CuratedPersonalityStore,
) {
  return actor({
    state: { revisions: [] } as State,
    actions: {
      read: async (c) => {
        if (c.key.length !== 1 || c.key[0] !== owner.id)
          throw new Error("Wrong personality owner");
        const result = currentPersonality(c.state.revisions);
        await c.saveState({ immediate: true });
        return result;
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
        const head = c.state.revisions.at(-1) ?? defaultGlobalPersonality;
        const input = event.text.trim().slice("!personality".length).trim();
        if (!input || input === "show") {
          const result = JSON.stringify(currentPersonality(c.state.revisions));
          await c.saveState({ immediate: true });
          return `${result}\n\n${ownerPrivate ? personalityHelp : "This is my shared public style. Only my owner can revise it in a private DM."}`;
        }
        if (!ownerPrivate)
          return "Only my owner can inspect personality history or publish revisions with a fresh, plain-text command in an owner-private DM (not a quote or code block).";
        if (input.length > 2000) return "Personality command is too long.";
        if (/^history(?:\s|$)/.test(input)) {
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
              `v${r.version} (${new Date(r.createdAt).toISOString()})${r.restoredFrom !== undefined ? ` restored from v${r.restoredFrom}` : ""}: ${JSON.stringify(globalStyleSchema.parse(r.style))}\nWhy: ${r.explanation}`,
          );
          const oldest = page.at(-1);
          const next =
            end > 5 && oldest
              ? `Next: !personality history ${oldest.version}`
              : "End of personality history.";
          await c.saveState({ immediate: true });
          return `Personality revisions, newest first (up to 5; explanations are owner-private; version 0 is the initial style):\n${history.join("\n\n") || "No earlier revisions."}\nCurrent version: ${head.version}. Rollback appends a revision, never erases history.\n${next}`;
        }
        const match = input.match(
          /^(revise|rollback|reset|reject)\s+([\s\S]+)$/,
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
        const restored = rollback?.success
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
            ? { ...head.style, ...revise.data.changes }
            : reset?.success
              ? {
                  ...head.style,
                  [reset.data.trait]:
                    defaultGlobalPersonality.style[reset.data.trait],
                }
              : restored?.style,
        );
        // Guard + append are synchronous: concurrent actions cannot both pass
        // the same version. Flush before acknowledging, including duplicate calls.
        const version = head.version + 1;
        c.state.revisions.push({
          version,
          style,
          commandId,
          explanation: command.explanation,
          createdAt: Date.now(),
          ...(restored ? { restoredFrom: restored.version } : {}),
        });
        const result = currentPersonality(c.state.revisions);
        await c.saveState({ immediate: true });
        return `Saved global personality revision ${version}. New turns in every conversation use this style; already-started turns keep their snapshot. ${JSON.stringify(result)} Explanations remain owner-private; permissions and tools are unchanged.`;
      },
    },
  });
}
