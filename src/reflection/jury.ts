import { z } from "zod";
import type { EvidenceStore } from "../memory/store.js";
import {
  abstain,
  type DecisionExecutor,
  type DecisionFunction,
  type JuryProviders,
  type JuryResult,
  runJury,
  validDecisionContext,
} from "./evaluator.js";

export const juryRequestSchema = z.strictObject({
  question: z.enum([
    "relevance",
    "novelty",
    "uncertainty",
    "interruption-cost",
  ]),
  prompt: z.string().trim().min(1).max(2000),
  evidenceIds: z.array(z.string().min(1).max(512)).min(1).max(20),
});
export type JuryRequest = z.infer<typeof juryRequestSchema>;

/** Owner scope and providers are fixed by the host, never request arguments. */
export function createJuryTool(options: {
  store: EvidenceStore;
  scope: string;
  executor: DecisionExecutor;
  providers: JuryProviders;
  evidenceMaxAgeMs: number;
}) {
  return async (
    value: JuryRequest,
    signal: AbortSignal,
  ): Promise<JuryResult | null> => {
    const parsed = juryRequestSchema.safeParse(value);
    if (!parsed.success || signal.aborted) return null;
    const request = parsed.data;
    if (new Set(request.evidenceIds).size !== request.evidenceIds.length)
      return null;
    // The free-form question may depend on other turn context, not only the
    // selected evidence. Match the host's conservative forgetting boundary.
    const deletionRevision = options.store.deletionRevision();
    const retrieve = () => {
      if (
        signal.aborted ||
        options.store.deletionRevision() !== deletionRevision
      )
        return null;
      const evidence = options.store.reflectionEvidence(
        options.scope,
        request.evidenceIds,
        options.evidenceMaxAgeMs,
      );
      const input = {
        scope: options.scope,
        question: request.question,
        prompt: request.prompt,
        now: Date.now(),
        evidenceMaxAgeMs: options.evidenceMaxAgeMs,
        evidence,
      };
      return evidence.length === request.evidenceIds.length &&
        request.evidenceIds.every((id) =>
          evidence.some((item) => item.id === id),
        ) &&
        validDecisionContext(input)
        ? input
        : null;
    };
    // Executor timeouts return early, but the durable host must await actual
    // provider settlement before releasing its live-occupancy claim.
    const pending: Promise<unknown>[] = [];
    try {
      const input = retrieve();
      if (!input) return null;
      const guard =
        (decide: DecisionFunction): DecisionFunction =>
        async (context, callSignal) => {
          if (callSignal.aborted || !retrieve())
            return abstain("stale-or-invalid-evidence");
          const work = decide(context, callSignal);
          pending.push(work);
          return work;
        };
      const result = await runJury(
        input,
        options.executor,
        {
          jurors: options.providers.jurors.map(({ id, decide }) => ({
            id,
            decide: guard(decide),
          })),
          critic: guard(options.providers.critic),
          synthesize: guard(options.providers.synthesize),
        },
        signal,
      );
      await Promise.allSettled(pending);
      return retrieve() ? result : null;
    } catch {
      return null;
    } finally {
      await Promise.allSettled(pending);
    }
  };
}

/** Advisory text only. The full transient result remains available to the host. */
export function formatJuryResult(result: JuryResult): string {
  return `Jury advisory synthesis: ${result.synthesis.answer}.\n${result.synthesis.rationale.slice(0, 2000)}\nThis is a model proposal, not verified evidence, unanimous agreement, permission, or approval. No memory, personality, coding, messaging, or deployment action was authorized.`;
}
