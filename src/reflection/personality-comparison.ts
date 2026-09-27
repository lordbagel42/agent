import { createHash } from "node:crypto";
import { z } from "zod";
import type { Evidence } from "./domain.js";
import type { Decision } from "./evaluator.js";

const answer = z.enum(["yes", "no", "abstain"]);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceId = z.string().min(1).max(2000);

/** No private text, rationale, confidence or profile values enter a receipt. */
export const personalityComparisonSchema = z
  .strictObject({
    evaluationId: z.string().uuid(),
    candidateId: sourceId,
    expectedVersion: z.number().int().nonnegative(),
    currentDigest: digest,
    candidateDigest: digest,
    heldOutSourceIds: z.array(sourceId).min(1).max(4),
    heldOutDigest: digest,
    evidenceMaxAgeMs: z.number().int().positive().safe(),
    evaluatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    status: z.enum(["complete", "incomplete"]),
    pairs: z
      .array(
        z.strictObject({
          evidenceId: sourceId,
          current: answer,
          candidate: answer,
          outcome: z.enum([
            "candidate",
            "current",
            "both",
            "neither",
            "unknown",
          ]),
        }),
      )
      .min(1)
      .max(4),
  })
  .refine(
    (receipt) =>
      new Set(receipt.heldOutSourceIds).size ===
        receipt.heldOutSourceIds.length &&
      receipt.pairs.length === receipt.heldOutSourceIds.length &&
      receipt.pairs.every(
        (pair, index) =>
          pair.evidenceId === receipt.heldOutSourceIds[index] &&
          pair.outcome ===
            personalityComparisonOutcome(pair.current, pair.candidate),
      ) &&
      receipt.status ===
        (receipt.pairs.some((pair) => pair.outcome === "unknown")
          ? "incomplete"
          : "complete") &&
      receipt.expiresAt > receipt.evaluatedAt &&
      receipt.expiresAt <= receipt.evaluatedAt + 15 * 60 * 1000,
  );

export type PersonalityComparisonReceipt = z.infer<
  typeof personalityComparisonSchema
>;

/** Abstention is missing information, never a negative vote or a tie. */
export function personalityComparisonOutcome(
  current: Decision["answer"],
  candidate: Decision["answer"],
): "candidate" | "current" | "both" | "neither" | "unknown" {
  if (current === "abstain" || candidate === "abstain") return "unknown";
  if (current === "yes") return candidate === "yes" ? "both" : "current";
  return candidate === "yes" ? "candidate" : "neither";
}

/** Exact ordered, projected evidence used by both passes, not just source IDs. */
export function personalityHeldOutDigest(evidence: Evidence[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        evidence.map((entry) => ({
          id: entry.id,
          scope: entry.scope,
          text: entry.text,
          source: entry.source,
          observedAt: entry.observedAt,
          expiresAt: entry.expiresAt,
          ...(entry.correction
            ? {
                correction: {
                  trait: entry.correction.trait,
                  value: entry.correction.value,
                },
              }
            : {}),
        })),
      ),
    )
    .digest("hex");
}
