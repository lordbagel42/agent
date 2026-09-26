import { type Evidence, freshEvidence } from "./domain.js";

export interface Decision {
  answer: "yes" | "no" | "abstain";
  rationale: string;
  evidenceIds: string[];
  /** Uncalibrated self-report. Never authority, permission, or a truth probability. */
  confidence?: number;
}

export interface Vote {
  id: string;
  decision: Decision;
}
export interface DecisionInput {
  scope: string;
  question: "relevance" | "novelty" | "uncertainty" | "interruption-cost";
  prompt: string;
  now: number;
  evidenceMaxAgeMs: number;
  evidence: Evidence[];
  /** Only critic/synthesis receive prior answers. */
  prior?: Vote[];
}

export type DecisionFunction = (
  input: DecisionInput,
  signal: AbortSignal,
) => Promise<Decision>;
export const abstain = (reason: string): Decision => ({
  answer: "abstain",
  rationale: reason,
  evidenceIds: [],
});

/** Strict boundary validation is independent of any vendor/API. */
export function validateDecision(
  value: unknown,
  input: DecisionInput,
): Decision {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return abstain("malformed-decision");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        !["answer", "rationale", "evidenceIds", "confidence"].includes(key),
    ) ||
    typeof record.answer !== "string" ||
    !["yes", "no", "abstain"].includes(record.answer) ||
    typeof record.rationale !== "string" ||
    !record.rationale.trim() ||
    record.rationale.length > 4000 ||
    !Array.isArray(record.evidenceIds) ||
    record.evidenceIds.length > input.evidence.length ||
    !record.evidenceIds.every(
      (id) => typeof id === "string" && input.evidence.some((e) => e.id === id),
    ) ||
    (record.answer !== "abstain" && !record.evidenceIds.length) ||
    (record.confidence !== undefined &&
      (typeof record.confidence !== "number" ||
        !Number.isFinite(record.confidence) ||
        record.confidence < 0 ||
        record.confidence > 1))
  )
    return abstain("malformed-decision");
  return {
    answer: record.answer as Decision["answer"],
    rationale: record.rationale,
    evidenceIds: [...new Set(record.evidenceIds as string[])],
    ...(record.confidence === undefined
      ? {}
      : { confidence: record.confidence as number }),
  };
}

/** Adapter over an actual injected typed provider, not a fabricated Jev integration. */
export function typedEvaluator(decide: DecisionFunction): DecisionFunction {
  return async (input, signal) => {
    const snapshot = structuredClone(input);
    return validateDecision(
      await decide(structuredClone(snapshot), signal),
      snapshot,
    );
  };
}

export function validDecisionContext(input: DecisionInput): boolean {
  return (
    !!input.scope.trim() &&
    !!input.prompt.trim() &&
    input.prompt.length <= 8000 &&
    ["relevance", "novelty", "uncertainty", "interruption-cost"].includes(
      input.question,
    ) &&
    input.evidence.length > 0 &&
    input.evidence.length <= 100 &&
    new Set(input.evidence.map((e) => e.id)).size === input.evidence.length &&
    input.evidence.every(
      (e) =>
        freshEvidence(e, input.scope, input.now, input.evidenceMaxAgeMs) &&
        e.text.length <= 16000,
    )
  );
}

/** Process-local provider limiter only. Durable scheduling/attempt ownership belongs to Rivet.
 * Timed-out/aborted calls retain slots until the provider actually settles.
 */
export class DecisionExecutor {
  private active = 0;
  constructor(
    private readonly capacity: number,
    private readonly timeoutMs: number,
  ) {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 300_000
    )
      throw new Error("Invalid executor bounds");
  }

  async evaluate(
    input: DecisionInput,
    decide: DecisionFunction,
    signal?: AbortSignal,
  ): Promise<Decision> {
    if (signal?.aborted) return abstain("cancelled");
    if (!validDecisionContext(input))
      return abstain("stale-or-invalid-evidence");
    if (this.active >= this.capacity) return abstain("capacity");
    const snapshot = structuredClone(input);
    const controller = new AbortController();
    this.active++;
    let stop!: (decision: Decision) => void;
    const interrupted = new Promise<Decision>((resolve) => {
      stop = resolve;
    });
    const abort = () => {
      stop(abstain("cancelled"));
      controller.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      stop(abstain("timeout"));
      controller.abort();
    }, this.timeoutMs);
    const work = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return abstain("cancelled");
        return decide(structuredClone(snapshot), controller.signal);
      })
      .then(
        (value) => validateDecision(value, snapshot),
        () => abstain("evaluator-failed"),
      )
      .finally(() => {
        this.active--;
      });
    try {
      return await Promise.race([interrupted, work]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

export interface JuryProviders {
  jurors: { id: string; decide: DecisionFunction }[];
  critic: DecisionFunction;
  synthesize: DecisionFunction;
}
export interface JuryResult {
  firstPass: Vote[];
  critic: Decision;
  synthesis: Decision;
  dissent: Vote[];
}

export async function runJury(
  input: DecisionInput,
  executor: DecisionExecutor,
  providers: JuryProviders,
  signal?: AbortSignal,
): Promise<JuryResult> {
  if (
    providers.jurors.length < 2 ||
    providers.jurors.length > 8 ||
    new Set(providers.jurors.map((j) => j.id)).size !==
      providers.jurors.length ||
    providers.jurors.some((j) => !j.id.trim() || j.id === "critic")
  )
    throw new Error("Jury requires 2–8 distinct jurors");
  // Deliberately project the input: no inherited prior votes or injected provider-specific fields.
  const base: DecisionInput = {
    scope: input.scope,
    question: input.question,
    prompt: input.prompt,
    now: input.now,
    evidenceMaxAgeMs: input.evidenceMaxAgeMs,
    evidence: structuredClone(input.evidence),
  };
  const firstPass = await Promise.all(
    providers.jurors.map(async (juror) => ({
      id: juror.id,
      decision: await executor.evaluate(base, juror.decide, signal),
    })),
  );
  const critic = await executor.evaluate(
    { ...base, prior: firstPass },
    providers.critic,
    signal,
  );
  const synthesis = await executor.evaluate(
    { ...base, prior: [...firstPass, { id: "critic", decision: critic }] },
    providers.synthesize,
    signal,
  );
  // Mechanical ledger, not the synthesizer's version of what the panel said.
  const dissent = [...firstPass, { id: "critic", decision: critic }].filter(
    (vote) =>
      vote.decision.answer === "abstain" ||
      vote.decision.answer !== synthesis.answer,
  );
  return { firstPass, critic, synthesis, dissent };
}
