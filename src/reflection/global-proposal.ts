import { z } from "zod";
import { globalStyleSchema } from "../runtime/personality.js";

/** A private suggestion, never a publication or owner confirmation. */
export const globalProposalInputSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative().safe(),
  changes: z.preprocess(
    (value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).filter(
              ([key, v]) =>
                v !== null || !Object.hasOwn(globalStyleSchema.shape, key),
            ),
          )
        : value,
    globalStyleSchema
      .partial()
      .refine((changes) => Object.keys(changes).length > 0),
  ),
  evidenceIds: z
    .array(z.string().min(1).max(2048))
    .min(1)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length),
  explanation: z.string().trim().min(1).max(240),
  confidence: z.number().min(0).max(1),
});

/** The host derives evidence and rationale from a revalidated publication. */
export const reflectionPersonalitySuggestionSchema = globalProposalInputSchema
  .pick({ expectedVersion: true, changes: true })
  .extend({ candidateId: z.string().regex(/^[a-f0-9]{64}$/) });
export type ReflectionPersonalitySuggestion = z.infer<
  typeof reflectionPersonalitySuggestionSchema
>;

/** Supplied only by fresh host admission, never by the model directive. */
export interface ReflectionProposalBinding {
  candidateId: string;
  sourceIds: string[];
  expiresAt: number;
}

export type GlobalProposalInput = z.infer<typeof globalProposalInputSchema>;
export interface GlobalPersonalityProposal extends GlobalProposalInput {
  id: string;
  scope: string;
  sourceIds: string[];
  /** Trusted bridge binding, never model-supplied evidence or approval. */
  reflectionCandidateId?: string;
  createdAt: number;
  expiresAt: number;
  /** Staging marker only. The personality actor owns terminal decisions. */
  status: "pending";
}

export const GLOBAL_PROPOSAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
