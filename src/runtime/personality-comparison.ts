import type { MessageEvent } from "../core/contracts.js";
import type { CuratedPersonalityStore } from "../memory/curated.js";
import {
  personalityComparisonOutcome,
  personalityHeldOutDigest,
} from "../reflection/personality-comparison.js";
import type {
  createPersonalityPreview,
  PersonalityEvaluateInput,
} from "./personality-evaluation-preview.js";

/** Source-scoped host service. Neither profiles nor raw model output are stored;
 * approval remains a separate authenticated action, never a score threshold. */
export function createPersonalityComparison(deps: {
  preview: Pick<
    ReturnType<typeof createPersonalityPreview>,
    "snapshot" | "isCurrent" | "evaluate"
  >;
  proposals: Pick<CuratedPersonalityStore, "recordEvaluation">;
  now?: () => number;
}) {
  return async (
    source: MessageEvent,
    value: PersonalityEvaluateInput,
    signal?: AbortSignal,
  ) => {
    const unavailable = { status: "unavailable" as const };
    try {
      if (signal?.aborted) return unavailable;
      const snapshot = await deps.preview.snapshot(source, value);
      if (!snapshot || signal?.aborted) return unavailable;
      // Same frozen evidence, clock, rubric and provider; independent copies with
      // no prior answers. Serial calls share preview's settlement-aware limiter.
      const current = await deps.preview.evaluate(snapshot, signal, "current");
      const candidate = await deps.preview.evaluate(
        snapshot,
        signal,
        "candidate",
      );
      if (
        signal?.aborted ||
        !(await deps.preview.isCurrent(snapshot)) ||
        signal?.aborted
      )
        return unavailable;
      const pairs = snapshot.evidence.map(({ id }, index) => {
        const left = current[index];
        const right = candidate[index];
        if (
          !left ||
          !right ||
          left.evidenceId !== id ||
          right.evidenceId !== id
        )
          throw new Error("Incomplete comparison ledger");
        return {
          evidenceId: id,
          current: left.decision.answer,
          candidate: right.decision.answer,
          outcome: personalityComparisonOutcome(
            left.decision.answer,
            right.decision.answer,
          ),
        };
      });
      const evaluatedAt = (deps.now ?? Date.now)();
      const receipt = deps.proposals.recordEvaluation(
        snapshot.scope,
        {
          candidateId: snapshot.candidateId,
          expectedVersion: snapshot.expectedVersion,
          currentDigest: snapshot.currentDigest,
          candidateDigest: snapshot.candidateDigest,
          heldOutSourceIds: snapshot.evidence.map((e) => e.id),
          heldOutDigest: personalityHeldOutDigest(snapshot.evidence),
          evidenceMaxAgeMs: snapshot.evidenceMaxAgeMs,
          evaluatedAt,
          status: pairs.some((pair) => pair.outcome === "unknown")
            ? "incomplete"
            : "complete",
          pairs,
        },
        evaluatedAt,
      );
      return { status: "comparison" as const, receipt };
    } catch {
      // Exception/rationale text can contain evidence or provider secrets.
      return unavailable;
    }
  };
}

export const personalityComparisonLimitations =
  "Advisory suitability judgments on the same 1–4 explicitly selected interactions, not generated replies, measured behavior, or proof of improvement. Held out only from this candidate's supporting sources, not guaranteed unseen by the model. Selection bias, fixed current-first order and one uncalibrated evaluator limit the result. Both/neither mean matching judgments, not equivalent personalities; an abstention makes the pair unknown, never a win. No profile was promoted and no permissions changed. A receipt is not approval.";
