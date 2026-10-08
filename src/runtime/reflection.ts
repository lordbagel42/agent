import { createHash } from "node:crypto";
import { SpanStatusCode } from "@opentelemetry/api";
import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import type {
  CompanionReply,
  MessageEvent,
  SendResult,
} from "../core/contracts.js";
import type { EvidenceStore } from "../memory/store.js";
import {
  cancel,
  claim,
  type Evidence,
  enqueue,
  finish,
  freshEvidence,
  initialState,
  isQuiet,
  type Policy,
  type ReflectionState,
  type RequestInput,
  reflectionPriority,
  type SkillChangeProposal,
  type SkillEvaluationReceipt,
} from "../reflection/domain.js";
import {
  abstain,
  type Decision,
  type DecisionFunction,
  type DecisionInput,
  evaluateSkillCandidate,
  type SkillEvaluationInput,
  skillEvaluationContext,
  validateDecision,
} from "../reflection/evaluator.js";
import { correlationId, withSpan } from "../telemetry/index.js";
import type { Lifecycle } from "./lifecycle.js";
import type { InterruptionReference, SocialPermissions } from "./social.js";

export type ReflectionMode = "interaction" | "idle" | "deep";

/** Exact host commands only; quoted text and model output never select review. */
export function parseReflectionReviewCommand(
  text: string,
):
  | { action: "list" }
  | { action: "inspect" | "reject"; id: string }
  | { action: "propose"; candidateId: string; userId: string; text: string }
  | { action: "memory"; id: string; subjectSourceId: string }
  | undefined {
  const command = text.trim();
  if (command === "!reflection list") return { action: "list" };
  const match = /^!reflection inspect ([a-f0-9]{64})$/.exec(command);
  if (match?.[1]) return { action: "inspect", id: match[1] };
  const id = /^!reflection reject ([a-f0-9]{64})$/.exec(command)?.[1];
  if (id) return { action: "reject", id };
  const memory = /^!reflection memory ([a-f0-9]{64}) (\S{1,2048})$/.exec(
    command,
  );
  if (memory?.[1] && memory[2])
    return { action: "memory", id: memory[1], subjectSourceId: memory[2] };
  const proposal = command.match(
    /^!reflection propose ([a-f0-9]{64}) ([UW][A-Z0-9]+) ([\s\S]{1,3000})$/,
  );
  return proposal
    ? {
        action: "propose",
        candidateId: proposal[1] as string,
        userId: proposal[2] as string,
        text: proposal[3] as string,
      }
    : undefined;
}

/** Internal IDs embed evidence IDs; scoped review uses bounded opaque tokens. */
export function reflectionCandidateId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

export interface ReflectionCandidateList {
  status: "ready" | "live" | "quiet" | "changed";
  checkedAt: number;
  ids: string[];
  /** A bounded scan, not a claim that the complete candidate set was read. */
  truncated: boolean;
}

export interface ReflectionInput extends RequestInput {
  mode: ReflectionMode;
}
export interface ReflectionDependencies {
  ownerId: string;
  policy: Policy;
  decide: DecisionFunction;
  /** Trusted synchronous store callback; only the actor's staging action may use it. */
  stageInterruption?: SocialPermissions["stageInterruption"];
  deletionRevision?: () => number;
  /** Host-injected staging only; this actor has no memory acceptance API. */
  memory?: Pick<EvidenceStore, "stageProposals">;
  /** Trusted memory boundary: current audience authorization AND deletion lookup.
   * IDs must identify immutable versions. Return exactly the requested evidence.
   */
  retrieve(
    input: { ownerId: string; scope: string; evidenceIds: string[] },
    signal: AbortSignal,
  ): Promise<{ authorized: boolean; evidence: Evidence[] }>;
  /** Synchronous authorization/deletion/value fence for the retrieved immutable
   * versions. Historical reads fail closed when this boundary is unavailable.
   */
  evidenceCurrent?(scope: string, evidence: Evidence[]): boolean;
  /** When a bridge is mounted, synchronously persist revocation of its pending
   * proposals before returning. Must be idempotent; failure leaves actor state
   * unchanged. Earlier accepted changes are not retroactively erased.
   */
  rejectProposals?(scope: string, candidateId: string): undefined;
  idleMs: number;
  deepMs: number;
  pollMs: number;
  timeoutMs: number;
  /** Host-only outbox; the synchronous gate must run adjacent to dispatch. */
  sendInterruption?: (
    proposalId: string,
    reference: InterruptionReference,
    commandId: string,
    check: () => Extract<SendResult, { status: "rejected" }> | undefined,
  ) => Promise<SendResult>;
}

export interface ReflectionCandidate {
  id: string;
  requestId: string;
  scope: string;
  attempt: number;
  mode: ReflectionMode;
  kind: "proposal" | "interruption-candidate";
  hypothesisOnly: boolean;
  decision: Decision;
  /** Immutable, host-bound review data; never installed or granted authority. */
  skillChange?: SkillChangeProposal;
  createdAt: number;
  /** Generation epoch: later interactions revoke effects, not published review. */
  epoch: number;
  /** Set only by settled publication or conservative legacy migration. */
  publication?: { version: 1; expiresAt: number };
}

export interface CuriosityProgress {
  truncated: boolean;
  rows: {
    reference: string;
    status: ReflectionState["requests"][number]["status"];
    progress: "pending" | "settled" | "unknown";
    attempt: number;
    invocation: "started" | "settled" | "uncertain" | "not-started" | "unknown";
    currentInputs: {
      episodes: number;
      ownerCorrections: number;
      dreamHypotheses: number;
    } | null;
    recordedOutcome: Decision["answer"] | "not-recorded" | "withheld";
  }[];
}

export interface ReflectionRuntimeState {
  reflection: ReflectionState;
  modes: Record<string, ReflectionMode>;
  invocations: Record<string, "started" | "settled" | "uncertain">;
  /** Optional for older actors. Settlement alone is not a completed evaluation.
   * Outcomes are judgments over existing evidence, never new observations.
   */
  decisionOutcomes?: Record<string, Decision["answer"]>;
  candidates: Record<string, ReflectionCandidate>;
  /** Separate from the scheduler domain format; absent on legacy actors. */
  candidateFormatVersion?: 1;
  /** Opaque IDs only; retained across replay and interaction invalidation. */
  rejectedCandidateIds?: string[];
  liveActive: number;
  /** Optional for actors persisted before ID-based occupancy was introduced. */
  liveTurns?: { id: string; active: boolean }[];
  legacyLiveActive?: number;
  lastInteractionAt: number;
  epoch: number;
  interruptionEpoch: number;
  triggerIds: string[];
}

type CandidateContext = {
  readonly state: ReflectionRuntimeState;
  vars: {
    prepareCandidates: () => Promise<void>;
    publishingCandidates: Set<string>;
  };
};

export interface ReflectionReviewReference {
  id: string;
  digest: string;
}

/** One actor keyed [ownerId], never one actor per scope (capacity is owner-wide).
 * Actions are trusted host APIs, not an internet-facing authorization boundary.
 */
export function createReflectionActor(
  deps: ReflectionDependencies,
  lifecycle?: Pick<Lifecycle, "enter" | "fail">,
) {
  for (const ms of [deps.idleMs, deps.deepMs, deps.pollMs, deps.timeoutMs]) {
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 86_400_000)
      throw new Error("Invalid reflection timing");
  }
  if (deps.deepMs < deps.idleMs || !deps.ownerId.trim())
    throw new Error("Invalid reflection configuration");
  // Validate the domain policy before activating any actor.
  claim(initialState(), "", Date.now(), deps.policy, [], 0);
  isQuiet(Date.now(), deps.policy.quiet);

  async function retrieve(input: RequestInput, signal: AbortSignal) {
    const result = await deps.retrieve(
      {
        ownerId: deps.ownerId,
        scope: input.scope,
        evidenceIds: [...input.evidenceIds],
      },
      signal,
    );
    const now = Date.now();
    if (
      signal.aborted ||
      !result.authorized ||
      result.evidence.length !== input.evidenceIds.length ||
      new Set(result.evidence.map((e) => e.id)).size !==
        result.evidence.length ||
      !result.evidence.every(
        (e) =>
          input.evidenceIds.includes(e.id) &&
          freshEvidence(e, input.scope, now, deps.policy.evidenceMaxAgeMs) &&
          e.text.length <= 16000,
      )
    )
      return null;
    return structuredClone(result.evidence);
  }

  /** With a host scope, accept only opaque aliases in that exact audience.
   * Without one, preserve the trusted operator's legacy internal-ID API.
   */
  async function readPublication(
    c: CandidateContext,
    id: string,
    scope?: string,
  ) {
    if (scope !== undefined && !/^[a-f0-9]{64}$/.test(id)) return null;
    await c.vars.prepareCandidates();
    const found =
      scope === undefined
        ? c.state.candidates[id]
        : Object.values(c.state.candidates).find(
            (item) =>
              item.scope === scope && reflectionCandidateId(item.id) === id,
          );
    const sourceRequest = c.state.reflection.requests.find(
      (item) => item.id === found?.requestId && item.scope === found?.scope,
    );
    if (!found || !sourceRequest) return null;
    // Snapshot values, not Rivet proxy identities: replaceReflection replaces the
    // root while reads await memory. Published bodies themselves never change.
    const encoded = JSON.stringify(found);
    const candidate: ReflectionCandidate = JSON.parse(encoded);
    const request = {
      id: sourceRequest.id,
      scope: sourceRequest.scope,
      kind: sourceRequest.kind,
      evidenceIds: [...sourceRequest.evidenceIds],
    };
    const current = () => {
      const latest = c.state.reflection.requests.find(
        (item) => item.id === request.id,
      );
      return (
        c.state.candidateFormatVersion === 1 &&
        JSON.stringify(c.state.candidates[candidate.id]) === encoded &&
        candidate.id === JSON.stringify([request.id, candidate.attempt]) &&
        Number.isSafeInteger(candidate.attempt) &&
        candidate.attempt > 0 &&
        candidate.attempt <= (latest?.attempts ?? 0) &&
        latest?.scope === candidate.scope &&
        latest.kind === request.kind &&
        // Deep curiosity used to publish interruption-shaped hypotheses. Keep
        // those immutable historical records readable, without rearming them.
        ((candidate.mode === "deep" && candidate.kind === "proposal") ||
          candidate.kind ===
            (request.kind === "curiosity"
              ? "interruption-candidate"
              : "proposal")) &&
        JSON.stringify(latest.evidenceIds) ===
          JSON.stringify(request.evidenceIds) &&
        candidate.publication?.version === 1 &&
        Number.isFinite(candidate.publication.expiresAt) &&
        candidate.publication.expiresAt > Date.now() &&
        c.state.invocations[candidate.id] === "settled" &&
        !c.vars.publishingCandidates.has(candidate.id) &&
        !c.state.rejectedCandidateIds?.includes(
          reflectionCandidateId(candidate.id),
        ) &&
        !["cancelled", "cancelling"].includes(latest.status)
      );
    };
    if (!current()) return null;
    const evidence = await retrieve(
      request,
      AbortSignal.timeout(deps.timeoutMs),
    ).catch(() => null);
    if (!evidence || !current()) return null;
    const decision = validateDecision(candidate.decision, {
      scope: candidate.scope,
      question: "novelty",
      prompt: "Inspect the existing hypothesis; do not generate evidence.",
      ...(candidate.mode === "deep" && candidate.decision.alternativeResponses
        ? { simulateResponses: true }
        : {}),
      now: Date.now(),
      evidenceMaxAgeMs: deps.policy.evidenceMaxAgeMs,
      evidence,
    });
    const isCurrent = () => {
      try {
        return (
          current() &&
          (deps.evidenceCurrent?.(candidate.scope, evidence) ?? true) &&
          evidence.every((item) =>
            freshEvidence(
              item,
              candidate.scope,
              Date.now(),
              deps.policy.evidenceMaxAgeMs,
            ),
          )
        );
      } catch {
        // Missing/deleted/unauthorized store records throw at the trusted boundary.
        return false;
      }
    };
    return decision.answer === "yes"
      ? { candidate, evidence, decision, isCurrent }
      : null;
  }

  /** Historical read only. Retained publication never grants effect authority. */
  async function reviewCandidate(
    c: CandidateContext,
    id: string,
    scope: string,
  ) {
    if (!deps.evidenceCurrent) return null;
    const read = await readPublication(c, id, scope);
    return read?.isCurrent() ? read : null;
  }

  /** Action reads retain the original generation, live-work and quiet-hour gates. */
  async function readCandidate(
    c: CandidateContext,
    id: string,
    scope?: string,
  ) {
    const epoch = c.state.epoch;
    const eligible = () =>
      c.state.epoch === epoch &&
      !c.state.liveActive &&
      !isQuiet(Date.now(), deps.policy.quiet);
    if (!eligible()) return null;
    const read = await readPublication(c, id, scope);
    return read?.isCurrent() && read.candidate.epoch === epoch && eligible()
      ? read
      : null;
  }

  function reviewDto(
    read: NonNullable<Awaited<ReturnType<typeof reviewWithEvaluation>>>,
  ) {
    if (!read.isCurrent()) return null;
    const { candidate, evidence, decision } = read;
    const body = {
      candidate: {
        id: reflectionCandidateId(candidate.id),
        kind: candidate.kind,
        mode: candidate.mode,
        createdAt: candidate.createdAt,
        epoch: candidate.epoch,
        publication: candidate.publication,
        hypothesisOnly: candidate.hypothesisOnly,
        decision,
        ...(candidate.skillChange
          ? { skillChange: candidate.skillChange }
          : {}),
      },
      evidence: evidence
        .map(({ id, source, observedAt, expiresAt }) => ({
          id,
          source,
          observedAt,
          expiresAt,
          cited: decision.evidenceIds.includes(id),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      ...(read.evaluation ? { skillEvaluation: read.evaluation.receipt } : {}),
    };
    const result = {
      checkedAt: Date.now(),
      ...body,
      // Eligibility is a checked-at advisory value, not part of immutable content.
      ...(read.evaluation
        ? { skillEvaluationEligible: read.evaluation.isEligible() }
        : {}),
      reference: {
        id: body.candidate.id,
        digest: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      },
    };
    return Buffer.byteLength(JSON.stringify(result), "utf8") <= 24000
      ? result
      : null;
  }

  const expiresAt = (evidence: Evidence[]) =>
    Math.min(
      ...evidence.flatMap((e) => [
        e.expiresAt,
        e.observedAt + deps.policy.evidenceMaxAgeMs,
      ]),
    );

  type EvaluationContext = Parameters<typeof readCandidate>[0] & {
    vars: { publishingEvaluations: Set<string> };
  };

  /** One current read of ALL training and held-out provenance, never model bodies. */
  async function evaluationInput(
    c: EvaluationContext,
    id: string,
    scope: string,
    heldOutEvidenceIds: string[],
  ) {
    const read = await reviewCandidate(c, id, scope);
    if (!read?.candidate.skillChange) return null;
    const proposal = read.candidate.skillChange;
    const { candidate } = read;
    const trainingIds = read.evidence.map((e) => e.id);
    const evidenceIds = [
      ...new Set([...trainingIds, ...heldOutEvidenceIds]),
    ].sort();
    const evidence = await retrieve(
      { scope, evidenceIds, kind: "reflection" },
      AbortSignal.timeout(deps.timeoutMs),
    ).catch(() => null);
    if (!evidence || !read.isCurrent()) return null;
    const isCurrent = () => {
      try {
        return (
          read.isCurrent() &&
          deps.evidenceCurrent?.(scope, evidence) === true &&
          evidence.every((e) =>
            freshEvidence(e, scope, Date.now(), deps.policy.evidenceMaxAgeMs),
          )
        );
      } catch {
        return false;
      }
    };
    const input: SkillEvaluationInput = {
      candidateId: id,
      candidateDigest: proposal.digest,
      proposedBehavior: proposal.proposedBehavior,
      scope,
      trainingEvidence: evidence.filter((e) => trainingIds.includes(e.id)),
      heldOutEvidence: heldOutEvidenceIds.flatMap((id) =>
        evidence.filter((e) => e.id === id),
      ),
      now: Date.now(),
      evidenceMaxAgeMs: deps.policy.evidenceMaxAgeMs,
    };
    const context = skillEvaluationContext(input);
    return context && isCurrent()
      ? { candidate, evidenceIds, evidence, input, context, isCurrent }
      : null;
  }

  async function readSkillEvaluation(
    c: EvaluationContext,
    id: string,
    scope: string,
  ) {
    const epoch = c.state.epoch;
    const request = c.state.reflection.requests.find(
      (r) => r.evaluationFor === id && r.scope === scope,
    );
    if (
      !request?.skillEvaluation ||
      c.vars.publishingEvaluations.has(request.id)
    )
      return null;
    const receipt: SkillEvaluationReceipt = JSON.parse(
      JSON.stringify(request.skillEvaluation),
    );
    const read = await evaluationInput(
      c,
      id,
      scope,
      receipt.heldOutEvidenceIds,
    );
    const current = c.state.reflection.requests.find(
      (r) => r.id === request.id,
    );
    if (
      !read?.isCurrent() ||
      !current ||
      receipt.status === "invalidated" ||
      c.vars.publishingEvaluations.has(request.id) ||
      JSON.stringify(current.skillEvaluation) !== JSON.stringify(receipt) ||
      receipt.candidateId !== id ||
      receipt.sourceRequestId !== read.candidate.requestId ||
      receipt.skillChangeId !== read.candidate.skillChange?.id ||
      receipt.candidateDigest !== read.candidate.skillChange?.digest ||
      JSON.stringify(current.evidenceIds) !==
        JSON.stringify(read.evidenceIds) ||
      receipt.cases.length !== receipt.heldOutEvidenceIds.length ||
      receipt.cases.some(
        (item, i) => item.evidenceId !== receipt.heldOutEvidenceIds[i],
      )
    )
      return null;
    const status = current.status;
    const attempts = current.attempts;
    const isCurrent = () => {
      const latest = c.state.reflection.requests.find(
        (r) => r.id === request.id,
      );
      return (
        read.isCurrent() &&
        !c.vars.publishingEvaluations.has(request.id) &&
        latest?.status === status &&
        latest.attempts === attempts &&
        JSON.stringify(latest.skillEvaluation) === JSON.stringify(receipt)
      );
    };
    const isEligible = () =>
      isCurrent() &&
      receipt.status === "settled" &&
      c.state.invocations[JSON.stringify([request.id, attempts])] ===
        "settled" &&
      !["cancelled", "cancelling"].includes(status) &&
      !c.state.liveActive &&
      epoch === c.state.epoch &&
      !isQuiet(Date.now(), deps.policy.quiet) &&
      receipt.cases.every(
        (item) =>
          item.status === "settled" &&
          item.decision &&
          validateDecision(item.decision, {
            ...read.context,
            now: Date.now(),
            evidence: read.input.heldOutEvidence.filter(
              (e) => e.id === item.evidenceId,
            ),
          }).answer === "yes",
      );
    return { ...read, receipt, isEligible, isCurrent };
  }

  /** One DTO/reference binds both the immutable proposal and its attached receipt. */
  async function reviewWithEvaluation(
    c: EvaluationContext,
    id: string,
    scope: string,
  ) {
    const read = await reviewCandidate(c, id, scope);
    if (!read) return null;
    const hasEvaluation = () =>
      c.state.reflection.requests.some((r) => r.evaluationFor === id);
    if (!hasEvaluation())
      return {
        ...read,
        evaluation: undefined,
        isCurrent: () => !hasEvaluation() && read.isCurrent(),
      };
    const evaluation = await readSkillEvaluation(c, id, scope);
    if (!evaluation?.isCurrent() || !read.isCurrent()) return null;
    return {
      ...read,
      evidence: evaluation.evidence,
      evaluation,
      isCurrent: () => read.isCurrent() && evaluation.isCurrent(),
    };
  }

  // Remove bodies only. Request/invocation/rejection receipts remain authoritative
  // and prevent eviction or expiry from restarting a previously admitted attempt.
  function trimCandidates(state: ReflectionRuntimeState): boolean {
    let changed = false;
    const remove = (id: string) => {
      delete state.candidates[id];
      changed = true;
    };
    for (const [id, candidate] of Object.entries(state.candidates)) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        candidate.id !== id ||
        typeof candidate.requestId !== "string" ||
        typeof candidate.scope !== "string" ||
        !Number.isSafeInteger(candidate.attempt) ||
        candidate.attempt < 1 ||
        !Number.isSafeInteger(candidate.epoch) ||
        !Number.isFinite(candidate.createdAt) ||
        typeof candidate.hypothesisOnly !== "boolean" ||
        !["interaction", "idle", "deep"].includes(candidate.mode) ||
        !["proposal", "interruption-candidate"].includes(candidate.kind) ||
        candidate.publication?.version !== 1 ||
        !Number.isFinite(candidate.publication.expiresAt) ||
        candidate.publication.expiresAt <= Date.now()
      )
        remove(id);
    }
    const oldest = Object.entries(state.candidates).sort(
      ([aId, a], [bId, b]) =>
        a.createdAt - b.createdAt || aId.localeCompare(bId),
    );
    const aliases = new Set(oldest.map(([id]) => reflectionCandidateId(id)));
    const resultBytes = () =>
      state.reflection.requests.reduce(
        (bytes, request) =>
          bytes +
          (request.skillEvaluation &&
          aliases.has(request.skillEvaluation.candidateId)
            ? Buffer.byteLength(JSON.stringify(request.skillEvaluation))
            : 0),
        0,
      );
    let remaining = oldest.length;
    for (const [id] of oldest) {
      if (
        remaining <= 50 &&
        Buffer.byteLength(JSON.stringify(state.candidates)) + resultBytes() <=
          256 * 1024
      )
        break;
      remove(id);
      aliases.delete(reflectionCandidateId(id));
      remaining--;
    }
    // Results share the publication's body budget/expiry; no second retained store.
    // Keep case phases and request identity so retirement cannot rearm evaluation.
    for (const request of state.reflection.requests) {
      const receipt = request.skillEvaluation;
      if (
        receipt &&
        !aliases.has(receipt.candidateId) &&
        (receipt.status !== "invalidated" ||
          receipt.cases.some((item) => item.decision))
      ) {
        receipt.status = "invalidated";
        for (const item of receipt.cases) delete item.decision;
        changed = true;
      }
    }
    return changed;
  }

  return actor({
    state: {
      reflection: initialState(),
      modes: {},
      invocations: {},
      decisionOutcomes: {},
      candidates: {},
      candidateFormatVersion: 1,
      liveActive: 0,
      liveTurns: [],
      legacyLiveActive: 0,
      lastInteractionAt: 0,
      epoch: 0,
      interruptionEpoch: -1,
      triggerIds: [],
    } as ReflectionRuntimeState,
    createVars: (
      c,
    ): {
      persist: () => Promise<void>;
      replaceReflection: (reflection: ReflectionState) => void;
      active: Map<string, AbortController>;
      prepareCandidates: () => Promise<void>;
      publishingCandidates: Set<string>;
      publishingEvaluations: Set<string>;
    } => {
      let prepared: Promise<void> | undefined;
      return {
        persist: () => c.saveState({ immediate: true }),
        replaceReflection: (reflection) => {
          // Domain spreads retain proxied children. Only Rivet's whole-state setter
          // unwraps them; workflow steps expose state through a getter only.
          c.state = { ...c.state, reflection };
        },
        active: new Map<string, AbortController>(),
        publishingCandidates: new Set<string>(),
        publishingEvaluations: new Set<string>(),
        prepareCandidates: () =>
          (prepared ??= (async () => {
            if (c.state.candidateFormatVersion === 1) return;
            if (c.state.candidateFormatVersion !== undefined)
              throw new Error("Unsupported reflection candidate format");
            // Old records did not capture their original expiry policy. Current
            // retrieval cannot prove that cap after a TTL increase. Drop those
            // bodies, retaining receipts; only capped partial migrations qualify.
            trimCandidates(c.state);
            const epoch = c.state.epoch;
            const signal = AbortSignal.timeout(Math.min(deps.timeoutMs, 5000));
            for (const id of Object.keys(c.state.candidates)) {
              const candidate = c.state.candidates[id];
              const request = c.state.reflection.requests.find(
                (r) => r.id === candidate?.requestId,
              );
              const bound = () => {
                const current = c.state.candidates[id];
                const latest = c.state.reflection.requests.find(
                  (r) => r.id === request?.id,
                );
                return (
                  current &&
                  request &&
                  latest &&
                  current.id === id &&
                  id === JSON.stringify([request.id, current.attempt]) &&
                  current.scope === request.scope &&
                  current.epoch === epoch &&
                  c.state.epoch === epoch &&
                  Number.isSafeInteger(current.attempt) &&
                  current.attempt > 0 &&
                  current.attempt <= latest.attempts &&
                  c.state.invocations[id] === "settled" &&
                  !["cancelled", "cancelling"].includes(latest.status) &&
                  current.kind ===
                    (request.kind === "curiosity"
                      ? "interruption-candidate"
                      : "proposal") &&
                  ["interaction", "idle", "deep"].includes(current.mode) &&
                  Number.isFinite(current.createdAt)
                );
              };
              const evidence =
                bound() && request
                  ? await retrieve(request, signal).catch(() => null)
                  : null;
              const current = c.state.candidates[id];
              if (
                !evidence ||
                !bound() ||
                !current?.publication ||
                current.publication.expiresAt <= Date.now() ||
                validateDecision(current.decision, {
                  scope: current.scope,
                  question: "novelty",
                  prompt: "Validate legacy publication",
                  now: Date.now(),
                  evidenceMaxAgeMs: deps.policy.evidenceMaxAgeMs,
                  evidence,
                }).answer !== "yes" ||
                current.hypothesisOnly !==
                  !evidence.some(
                    (e) =>
                      e.source !== "dream" &&
                      current.decision.evidenceIds.includes(e.id),
                  ) ||
                (current.kind === "interruption-candidate" &&
                  current.hypothesisOnly)
              ) {
                delete c.state.candidates[id];
                continue;
              }
              current.publication = {
                version: 1,
                expiresAt: Math.min(
                  current.publication.expiresAt,
                  expiresAt(evidence),
                ),
              };
            }
            c.state.candidateFormatVersion = 1;
            trimCandidates(c.state);
            await c.saveState({ immediate: true });
          })()),
      };
    },
    queues: { wake: queue<{ wake: true }>() },
    actions: {
      /** Scope is authenticated by the host, never selected by the model input.
       * Omission preserves the legacy owner-private caller contract.
       */
      requestSkillEvaluation: async (
        c,
        input: NonNullable<CompanionReply["skillEvaluationRequest"]>,
        expectedDeletionRevision: number,
        scope = JSON.stringify(["private", deps.ownerId]),
      ) => {
        if (c.key.length !== 1 || c.key[0] !== deps.ownerId)
          throw new Error("Wrong reflection owner");
        if (
          !input ||
          Object.keys(input).some(
            (key) => !["candidateId", "heldOutEvidenceIds"].includes(key),
          ) ||
          !/^[a-f0-9]{64}$/.test(input.candidateId) ||
          !Array.isArray(input.heldOutEvidenceIds) ||
          input.heldOutEvidenceIds.length < 2 ||
          input.heldOutEvidenceIds.length > 5 ||
          input.heldOutEvidenceIds.some(
            (id) =>
              typeof id !== "string" ||
              !id.trim() ||
              id !== id.trim() ||
              id.length > 2048,
          ) ||
          new Set(input.heldOutEvidenceIds).size !==
            input.heldOutEvidenceIds.length
        )
          throw new Error("Invalid skill evaluation request");
        // Capture the operation epoch before migration/retrieval can yield.
        const epoch = c.state.epoch;
        // The caller's frozen turn revision must survive the RPC gap. Capturing
        // the store revision on entry would reauthorize deleted originating input.
        const current = () =>
          expectedDeletionRevision === (deps.deletionRevision?.() ?? 0) &&
          epoch === c.state.epoch &&
          !c.state.liveActive &&
          !isQuiet(Date.now(), deps.policy.quiet);
        if (!current()) return { status: "unavailable" as const };
        const heldOutEvidenceIds = [...input.heldOutEvidenceIds].sort();
        const read = await evaluationInput(
          c,
          input.candidateId,
          scope,
          heldOutEvidenceIds,
        );
        if (!read?.isCurrent() || !current())
          return { status: "unavailable" as const };
        if (
          c.state.reflection.requests.some(
            (r) => r.evaluationFor === input.candidateId,
          )
        )
          return { status: "duplicate" as const };
        const result = enqueue(
          c.state.reflection,
          {
            scope,
            evidenceIds: read.evidenceIds,
            kind: "reflection",
            evaluationFor: input.candidateId,
          },
          Date.now(),
        );
        c.vars.replaceReflection(result.state);
        const request = c.state.reflection.requests.find(
          (r) => r.id === result.id,
        );
        if (!request || !read.candidate.skillChange)
          throw new Error("Missing evaluation request");
        request.skillEvaluation = {
          candidateId: input.candidateId,
          skillChangeId: read.candidate.skillChange.id,
          candidateDigest: read.candidate.skillChange.digest,
          sourceRequestId: read.candidate.requestId,
          heldOutEvidenceIds,
          status: "pending",
          cases: heldOutEvidenceIds.map((evidenceId) => ({
            evidenceId,
            status: "pending",
          })),
        };
        c.state.modes[result.id] = "idle";
        c.vars.publishingEvaluations.add(result.id);
        await c.vars.persist();
        c.vars.publishingEvaluations.delete(result.id);
        await c.queue.send("wake", { wake: true });
        return { status: "queued" as const };
      },
      /** Advisory history plus separately computed current all-yes eligibility. */
      skillEvaluation: async (c, id: string, scope: string) => {
        if (c.key.length !== 1 || c.key[0] !== deps.ownerId) return null;
        const read = await readSkillEvaluation(c, id, scope);
        if (!read?.isCurrent()) return null;
        const { candidate, receipt, evidenceIds } = read;
        return {
          candidate,
          receipt,
          evidenceIds,
          eligible: read.isEligible(),
          checkedAt: Date.now(),
        };
      },
      /** June's explicit request in the host-authenticated scope. No model-controlled
       * scope, evidence body or immediate mode; the scheduler owns admission.
       * Omission preserves the legacy owner-private caller contract.
       */
      request: async (
        c,
        input: NonNullable<CompanionReply["reflectionRequest"]>,
        scope = JSON.stringify(["private", deps.ownerId]),
      ) => {
        if (c.key.length !== 1 || c.key[0] !== deps.ownerId)
          throw new Error("Wrong reflection owner");
        if (
          !["idle", "deep"].includes(input.mode) ||
          (input.kind !== undefined &&
            !["reflection", "curiosity"].includes(input.kind)) ||
          !Array.isArray(input.evidenceIds) ||
          !input.evidenceIds.length ||
          input.evidenceIds.length > 20 ||
          input.evidenceIds.some(
            (id) => typeof id !== "string" || !id.trim() || id.length > 2048,
          )
        )
          throw new Error("Invalid reflection request");
        const request: ReflectionInput = {
          scope,
          evidenceIds: [...new Set(input.evidenceIds)].sort(),
          mode: input.mode,
          kind: input.kind ?? "reflection",
        };
        const evidence = await retrieve(
          request,
          AbortSignal.timeout(deps.timeoutMs),
        ).catch(() => null);
        if (!evidence) return { status: "unavailable" as const };
        const result = enqueue(c.state.reflection, request, Date.now());
        c.vars.replaceReflection(result.state);
        if (result.accepted) c.state.modes[result.id] = request.mode;
        await c.vars.persist();
        if (result.accepted) await c.queue.send("wake", { wake: true });
        return {
          status: result.accepted
            ? ("queued" as const)
            : ("duplicate" as const),
        };
      },
      enqueue: async (c, input: ReflectionInput) => {
        if (c.key.length !== 1 || c.key[0] !== deps.ownerId)
          throw new Error("Wrong reflection owner");
        if (
          !["interaction", "idle", "deep"].includes(input.mode) ||
          !["curiosity", "reflection"].includes(input.kind) ||
          input.evidenceIds.length > 100
        )
          throw new Error("Invalid reflection request");
        const result = enqueue(c.state.reflection, input, Date.now());
        c.vars.replaceReflection(result.state);
        if (result.accepted) c.state.modes[result.id] = input.mode;
        await c.vars.persist();
        await c.queue.send("wake", { wake: true });
        return { id: result.id, accepted: result.accepted };
      },
      cancel: async (c, id: string) => {
        c.vars.replaceReflection(cancel(c.state.reflection, id));
        for (const [key, candidate] of Object.entries(c.state.candidates))
          if (candidate.requestId === id) delete c.state.candidates[key];
        await c.vars.persist();
        c.vars.active.get(id)?.abort();
        return true;
      },
      /** Trusted scope-bound revocation, not cancellation or evidence recall.
       * No evidence/attention gate may prevent revoking an extant candidate.
       */
      rejectCandidate: async (c, scope: string, id: string) => {
        if (
          c.key.length !== 1 ||
          c.key[0] !== deps.ownerId ||
          !/^[a-f0-9]{64}$/.test(id)
        )
          return false;
        if (c.state.rejectedCandidateIds?.includes(id)) {
          // The body is gone, but retained receipts still bind duplicate
          // revocation to its original audience without requiring live evidence.
          const invocation = Object.keys(c.state.invocations).find(
            (key) => reflectionCandidateId(key) === id,
          );
          if (!invocation) return false;
          try {
            const [requestId, attempt] = JSON.parse(invocation);
            if (
              !Number.isSafeInteger(attempt) ||
              attempt < 1 ||
              invocation !== JSON.stringify([requestId, attempt]) ||
              !c.state.reflection.requests.some(
                (request) =>
                  request.id === requestId &&
                  request.scope === scope &&
                  attempt <= request.attempts,
              )
            )
              return false;
          } catch {
            return false;
          }
          deps.rejectProposals?.(scope, id);
          // A duplicate must still await a flush that may have failed earlier.
          await c.vars.persist();
          return true;
        }
        const candidate = Object.values(c.state.candidates).find(
          (candidate) =>
            candidate.scope === scope &&
            reflectionCandidateId(candidate.id) === id,
        );
        if (!candidate) return false;
        // Persist dependent revocations first: a crash before the actor flush
        // must not let an old candidate stage or promote a copied proposal.
        deps.rejectProposals?.(scope, id);
        c.state.rejectedCandidateIds ??= [];
        c.state.rejectedCandidateIds.push(id);
        delete c.state.candidates[candidate.id];
        await c.vars.persist();
        return true;
      },
      /** Stable live turn/attempt IDs. Release only after actual provider settlement
       * or authenticated confirmation that the old worker/provider has stopped.
       */
      occupancy: async (c, id: string, active: boolean) => {
        if (c.key.length !== 1 || c.key[0] !== deps.ownerId)
          throw new Error("Wrong reflection owner");
        if (!id.trim() || typeof active !== "boolean")
          throw new Error("Invalid reflection occupancy");
        await c.vars.prepareCandidates();
        trimCandidates(c.state);
        c.state.legacyLiveActive ??= c.state.liveActive;
        c.state.liveTurns ??= [];
        const turns = c.state.liveTurns;
        const turn = turns.find((entry) => entry.id === id);
        if (turn && (active || !turn.active)) {
          // A retry must still await the original state flush, but cannot reopen
          // a finished ID or advance the interaction epoch again.
          await c.vars.persist();
          return;
        }
        if (turn) turn.active = false;
        else turns.push({ id, active });
        c.state.liveActive =
          c.state.legacyLiveActive +
          turns.filter((entry) => entry.active).length;
        if (active) {
          c.state.lastInteractionAt = Date.now();
          c.state.epoch++;
        }
        await c.vars.persist();
        if (active)
          for (const controller of c.vars.active.values()) controller.abort();
        await c.queue.send("wake", { wake: true });
      },
      /** Legacy absolute occupancy, separate from ID-based live turns.
       * Only interaction advances the idle epoch; idle is not an owner message.
       */
      trigger: async (
        c,
        event: { id: string; type: "interaction" | "idle"; liveActive: number },
      ) => {
        if (
          !event.id.trim() ||
          !["interaction", "idle"].includes(event.type) ||
          !Number.isSafeInteger(event.liveActive) ||
          event.liveActive < 0
        )
          throw new Error("Invalid reflection trigger");
        await c.vars.prepareCandidates();
        trimCandidates(c.state);
        if (c.state.triggerIds.includes(event.id)) return;
        c.state.triggerIds.push(event.id);
        c.state.legacyLiveActive = event.liveActive;
        c.state.liveActive =
          event.liveActive +
          (c.state.liveTurns?.filter((turn) => turn.active).length ?? 0);
        if (event.type === "interaction") {
          c.state.lastInteractionAt = Date.now();
          c.state.epoch++;
        }
        await c.vars.persist();
        if (event.liveActive > 0 || event.type === "interaction")
          for (const controller of c.vars.active.values()) controller.abort();
        await c.queue.send("wake", { wake: true });
      },
      /** Metadata only: no raw evidence or model rationale can leak through polling. */
      status: (c) => ({
        reflection: {
          ...c.state.reflection,
          requests: c.state.reflection.requests.map((request) => {
            const metadata = { ...request };
            delete metadata.skillEvaluation;
            return metadata;
          }),
        },
        invocations: { ...c.state.invocations },
        decisionOutcomes: { ...c.state.decisionOutcomes },
        candidateIds: Object.keys(c.state.candidates),
        liveActive: c.state.liveActive,
        activeTurnIds: (c.state.liveTurns ?? [])
          .filter((turn) => turn.active)
          .map((turn) => turn.id),
        epoch: c.state.epoch,
      }),
      /** Host drain check under the lifecycle fence, not reconciliation. A quiet
       * local callback cannot prove that a pre-recovery provider stopped. */
      isSettled: (c) =>
        c.vars.active.size === 0 &&
        c.state.liveActive === 0 &&
        Object.values(c.state.invocations).every(
          (phase) => phase === "settled",
        ) &&
        !c.state.reflection.requests.some((request) =>
          ["running", "cancelling"].includes(request.status),
        ),
      /** Scope-bound metadata only, with the same current-evidence read gates.
       * Never use the unvalidated status().candidateIds as reviewable candidates.
       */
      listCandidates: async (
        c,
        scope: string,
      ): Promise<ReflectionCandidateList> => {
        if (c.key.length !== 1 || c.key[0] !== deps.ownerId)
          throw new Error("Wrong reflection owner");
        await c.vars.prepareCandidates();
        const epoch = c.state.epoch;
        const blocked = (): ReflectionCandidateList["status"] | undefined =>
          c.state.liveActive > 0
            ? "live"
            : isQuiet(Date.now(), deps.policy.quiet)
              ? "quiet"
              : c.state.epoch !== epoch
                ? "changed"
                : undefined;
        const initialBlock = blocked();
        if (initialBlock)
          return {
            status: initialBlock,
            checkedAt: Date.now(),
            ids: [],
            truncated: false,
          };
        const selected: ReflectionCandidate[] = [];
        let truncated = false;
        for (const id in c.state.candidates) {
          const candidate = c.state.candidates[id];
          if (
            !candidate ||
            candidate.scope !== scope ||
            candidate.epoch !== epoch ||
            candidate.publication?.version !== 1 ||
            candidate.publication.expiresAt <= Date.now() ||
            c.vars.publishingCandidates.has(id)
          )
            continue;
          if (selected.length === 20) {
            truncated = true;
            break;
          }
          selected.push(candidate);
        }
        const signal = AbortSignal.timeout(Math.min(deps.timeoutMs, 5000));
        const checked = await Promise.all(
          selected.map(async (candidate) => {
            const request = c.state.reflection.requests.find(
              (r) => r.id === candidate.requestId && r.scope === scope,
            );
            if (
              !request ||
              ["cancelled", "cancelling"].includes(request.status) ||
              c.state.invocations[candidate.id] !== "settled"
            )
              return null;
            const evidence = await retrieve(request, signal);
            return evidence ? { candidate, evidence } : null;
          }),
        );
        const checkedAt = Date.now();
        const finalBlock = blocked();
        if (finalBlock)
          return { status: finalBlock, checkedAt, ids: [], truncated: false };
        if (signal.aborted) throw new Error("Reflection review timed out");
        const current = checked.flatMap((entry) =>
          entry &&
          c.state.candidates[entry.candidate.id] === entry.candidate &&
          !c.vars.publishingCandidates.has(entry.candidate.id) &&
          (entry.candidate.publication?.expiresAt ?? 0) > checkedAt &&
          entry.evidence.every((e) =>
            freshEvidence(e, scope, checkedAt, deps.policy.evidenceMaxAgeMs),
          )
            ? [reflectionCandidateId(entry.candidate.id)]
            : [],
        );
        return {
          status: "ready",
          checkedAt,
          ids: current.slice(0, 10),
          truncated: truncated || current.length > 10,
        };
      },
      /** Scope-bound metadata only. Current inputs do not prove attempt success. */
      curiosityProgress: async (
        c,
        scope: string,
      ): Promise<CuriosityProgress> => {
        if (c.key.length !== 1 || c.key[0] !== deps.ownerId)
          throw new Error("Wrong reflection audience");
        const requests = c.state.reflection.requests.filter(
          (request) => request.scope === scope && request.kind === "curiosity",
        );
        const rows: CuriosityProgress["rows"] = [];
        const signal = AbortSignal.timeout(deps.timeoutMs);
        for (const selected of requests.slice(-10).reverse()) {
          // One bounded read per row, with the same authorization/deletion/freshness
          // checks as execution. Never retain source IDs, text, or rationale here.
          const evidence = await retrieve(selected, signal).catch(() => null);
          const request = c.state.reflection.requests.find(
            (entry) => entry.id === selected.id,
          );
          if (!request || request.scope !== scope) continue;
          const key = JSON.stringify([request.id, request.attempts]);
          const invocation =
            c.state.invocations[key] ??
            (request.attempts ? "unknown" : "not-started");
          const progress =
            invocation === "uncertain" || invocation === "unknown"
              ? "unknown"
              : invocation === "started" ||
                  ["pending", "running", "cancelling"].includes(request.status)
                ? "pending"
                : "settled";
          rows.push({
            reference: createHash("sha256").update(request.id).digest("hex"),
            status: request.status,
            progress,
            attempt: request.attempts,
            invocation,
            currentInputs: evidence
              ? {
                  episodes: evidence.filter((e) => e.source === "episode")
                    .length,
                  ownerCorrections: evidence.filter(
                    (e) => e.source === "owner-correction",
                  ).length,
                  dreamHypotheses: evidence.filter((e) => e.source === "dream")
                    .length,
                }
              : null,
            recordedOutcome: evidence
              ? (c.state.decisionOutcomes?.[key] ?? "not-recorded")
              : "withheld",
          });
        }
        return { truncated: requests.length > 10, rows };
      },
      /** Inert staging may read an older publication, never re-arm its epoch.
       * No asynchronous gap is allowed between the final fence and store write.
       * Scope comes from the host; omission preserves legacy private callers. */
      stageInterruption: async (
        c,
        event: MessageEvent,
        input: { candidateId: string; userId: string; text: string },
        expectedDeletionRevision: number,
        retained = false,
        scope = JSON.stringify(["private", deps.ownerId]),
      ): Promise<string> => {
        const unavailable =
          "That interruption candidate is unavailable or blocked. Nothing was staged or sent.";
        if (c.key.length !== 1 || c.key[0] !== deps.ownerId)
          throw new Error("Wrong reflection owner");
        const epoch = c.state.epoch;
        const blocked = () =>
          c.state.epoch !== epoch ||
          c.state.liveActive > 0 ||
          isQuiet(Date.now(), deps.policy.quiet) ||
          expectedDeletionRevision !== (deps.deletionRevision?.() ?? 0);
        if (!deps.stageInterruption || blocked()) return unavailable;
        const read = await (retained
          ? reviewCandidate(c, input.candidateId, scope)
          : readCandidate(c, input.candidateId, scope));
        if (!read || blocked() || !read.isCurrent()) return unavailable;
        return deps.stageInterruption(
          event,
          input,
          {
            ...read.candidate,
            evidenceIds: read.evidence.map((e) => e.id),
          },
          read.candidate.epoch === epoch,
        );
      },
      /** Recheck memory on every read, including after actor recovery or forgetting. */
      candidate: async (c, id: string, scope?: string) => {
        if (c.key.length !== 1 || c.key[0] !== deps.ownerId) return null;
        const read = await readCandidate(c, id, scope);
        return read
          ? { ...read.candidate, evidenceIds: read.evidence.map((e) => e.id) }
          : null;
      },
      /** Admit inert pending staging against the operation's current epoch,
       * never the historical publication's generation. This is not a lock
       * through the destination actor's later synchronous store write.
       */
      stageAdmission: async (c, scope: string, id: string) => {
        if (c.key.length !== 1 || c.key[0] !== deps.ownerId) return null;
        const epoch = c.state.epoch;
        const eligible = () =>
          c.state.epoch === epoch &&
          !c.state.liveActive &&
          !isQuiet(Date.now(), deps.policy.quiet);
        if (!eligible()) return null;
        const read = await reviewCandidate(c, id, scope);
        if (
          !read?.isCurrent() ||
          !eligible() ||
          !read.candidate.publication ||
          read.decision.confidence === undefined
        )
          return null;
        return {
          evidenceIds: read.decision.evidenceIds,
          explanation: read.decision.rationale.trim().slice(0, 240),
          confidence: read.decision.confidence,
          binding: {
            candidateId: id,
            sourceIds: read.evidence.map((item) => item.id),
            expiresAt: read.candidate.publication.expiresAt,
          },
        };
      },
      /** Bounded historical metadata for model review, never a readiness grant. */
      reviewCandidates: async (c, scope: string) => {
        if (
          !deps.evidenceCurrent ||
          c.key.length !== 1 ||
          c.key[0] !== deps.ownerId
        )
          return null;
        await c.vars.prepareCandidates();
        const ids = Object.values(c.state.candidates)
          .filter((candidate) => candidate.scope === scope)
          .map((candidate) => reflectionCandidateId(candidate.id));
        const checked = await Promise.all(
          ids.slice(0, 20).map((id) => reviewWithEvaluation(c, id, scope)),
        );
        const references = checked.flatMap((read) => {
          const dto = read && reviewDto(read);
          return dto ? [dto.reference] : [];
        });
        return {
          checkedAt: Date.now(),
          references: references.slice(0, 10),
          truncated: ids.length > 20 || references.length > 10,
        };
      },
      /** Content-free receipts bind exactly what a continuation consumed. */
      validateReview: async (
        c,
        scope: string,
        references: ReflectionReviewReference[],
      ) => {
        if (
          !deps.evidenceCurrent ||
          c.key.length !== 1 ||
          c.key[0] !== deps.ownerId ||
          references.length > 10 ||
          new Set(references.map((ref) => ref.id)).size !== references.length
        )
          return false;
        const checked = await Promise.all(
          references.map((ref) => reviewWithEvaluation(c, ref.id, scope)),
        );
        return checked.every(
          (read, index) =>
            read &&
            reviewDto(read)?.reference.digest === references[index]?.digest,
        );
      },
      /** Exact scope-bound inspection, not evidence or authorization for an effect.
       * Project only after current provenance checks; omit the whole result if it
       * exceeds the byte budget rather than silently clipping the rationale.
       */
      inspectCandidate: async (c, scope: string, id: string) => {
        if (c.key.length !== 1 || c.key[0] !== deps.ownerId) return null;
        const read = await reviewWithEvaluation(c, id, scope);
        return read ? reviewDto(read) : null;
      },
      /** Host-admitted pending staging after inference settles; never acceptance. */
      stageMemory: async (
        c,
        scope: string,
        id: string,
        subjectSourceId: string,
        expectedDeletionRevision: number,
      ) => {
        if (
          c.key.length !== 1 ||
          c.key[0] !== deps.ownerId ||
          !deps.memory ||
          expectedDeletionRevision !== (deps.deletionRevision?.() ?? 0)
        )
          return null;
        const epoch = c.state.epoch;
        await c.vars.prepareCandidates();
        const current = await reviewCandidate(c, id, scope);
        if (!current) return null;
        const { evidence, decision } = current;
        const cited = evidence.filter((item) =>
          decision.evidenceIds.includes(item.id),
        );
        const text = `Reflection hypothesis: ${decision.rationale}`;
        if (
          expectedDeletionRevision !== (deps.deletionRevision?.() ?? 0) ||
          epoch !== c.state.epoch ||
          c.state.liveActive > 0 ||
          isQuiet(Date.now(), deps.policy.quiet) ||
          evidence.some((item) => item.source === "dream") ||
          !cited.some((item) => item.id === subjectSourceId) ||
          cited.some((item) => !item.text.trim() || item.text.length > 4000) ||
          text.length > 4000 ||
          !current.isCurrent()
        )
          return null;
        // No await between the current actor gates and the transactional ledger
        // write. The store rechecks the exact original sources, never rationale
        // or a simulation as an observation, and deduplicates by candidate ID.
        try {
          const [proposal] = deps.memory.stageProposals(
            scope,
            evidence.map((item) => item.id),
            [
              {
                subjectSourceId,
                text,
                category: "pattern",
                citations: cited.map((item) => ({
                  sourceId: item.id,
                  quote: item.text,
                })),
                confidence: decision.confidence ?? null,
                validFrom: null,
                validTo: null,
                contradicts: [],
                supersedes: [],
              },
            ],
            undefined,
            [],
            id,
          );
          return proposal ? { id: proposal.id, status: proposal.status } : null;
        } catch {
          return null;
        }
      },
      /** Approval remains in the social ledger. Evidence retrieval alone never
       * grants a send: check live actor state again inside the durable outbox. */
      deliverInterruption: async (
        c,
        proposalId: string,
        reference: InterruptionReference,
        commandId: string,
      ): Promise<SendResult> => {
        if (
          !deps.sendInterruption ||
          c.key.length !== 1 ||
          c.key[0] !== deps.ownerId
        )
          return { status: "rejected", code: "unavailable", retryable: false };
        const read = await reviewCandidate(
          c,
          reference.candidateId,
          reference.scope,
        );
        return deps.sendInterruption(proposalId, reference, commandId, () => {
          if (
            !read?.isCurrent() ||
            JSON.stringify(read.candidate.publication) !==
              JSON.stringify(reference.publication) ||
            read.candidate.kind !== "interruption-candidate" ||
            read.candidate.hypothesisOnly ||
            read.candidate.requestId !== reference.requestId ||
            read.candidate.epoch !== reference.epoch ||
            read.candidate.epoch !== c.state.epoch ||
            JSON.stringify(read.evidence.map((item) => item.id).sort()) !==
              JSON.stringify([...reference.evidenceIds].sort())
          )
            return {
              status: "rejected",
              code: "candidate_invalidated",
              retryable: false,
            };
          if (c.state.liveActive > 0)
            return {
              status: "rejected",
              code: "live_activity",
              retryable: true,
            };
          // Synchronous provenance reads can cross a wall-clock boundary too.
          if (isQuiet(Date.now(), deps.policy.quiet))
            return { status: "rejected", code: "quiet_hours", retryable: true };
          return undefined;
        });
      },
      /** Operator-only recovery after confirming the old worker/provider has stopped.
       * Never retries this request or clears its dedupe tombstone.
       */
      reconcile: async (c, id: string, confirmedStopped: boolean) => {
        if (!confirmedStopped || c.vars.active.has(id)) return false;
        const request = c.state.reflection.requests.find((r) => r.id === id);
        if (!request || !["running", "cancelling"].includes(request.status))
          return false;
        c.vars.replaceReflection(
          finish(
            cancel(c.state.reflection, id),
            id,
            request.attempts,
            Date.now(),
            [],
            deps.policy,
          ),
        );
        c.state.invocations[JSON.stringify([id, request.attempts])] = "settled";
        await c.vars.persist();
        return true;
      },
    },
    run: workflow(
      async (ctx) => {
        await ctx.loop("reflection-v1", async (loop) => {
          // Queue timeout is a Rivet durable timer, not a process-local scheduler.
          await loop.queue.nextBatch("wake-or-timer", {
            names: ["wake"],
            count: 100,
            timeout: deps.pollMs,
          });
          // Admission is process-local, outside the journal so replay reacquires it.
          // The timeout-free step awaits the raw provider AND its final state flush.
          const release = await lifecycle?.enter(ctx.abortSignal);
          try {
            await loop.step({
              name: "reflect",
              timeout: 0,
              run: async (step) => {
                if (step.key.length !== 1 || step.key[0] !== deps.ownerId)
                  return;
                await step.vars.prepareCandidates();
                if (trimCandidates(step.state)) await step.vars.persist();
                // A started marker with no local worker means an interrupted step.
                // Never repeat a possibly completed external generation on replay.
                let recovered = false;
                for (const [key, phase] of Object.entries(
                  step.state.invocations,
                ))
                  if (phase === "started") {
                    step.state.invocations[key] = "uncertain";
                    const receipt = step.state.reflection.requests.find(
                      (r) => JSON.stringify([r.id, r.attempts]) === key,
                    )?.skillEvaluation;
                    if (receipt && receipt.status !== "invalidated") {
                      receipt.status = "uncertain";
                      for (const item of receipt.cases)
                        if (item.status === "started")
                          item.status = "uncertain";
                    }
                    recovered = true;
                  }
                if (recovered) await step.vars.persist();
                if (step.state.liveActive > 0) return;
                const now = Date.now();
                const eligible = step.state.reflection.requests.filter((r) => {
                  const mode = step.state.modes[r.id];
                  const delay =
                    mode === "deep"
                      ? deps.deepMs
                      : mode === "idle"
                        ? deps.idleMs
                        : 0;
                  const progress = step.state.reflection.scopes.find(
                    (s) => s.scope === r.scope,
                  );
                  return (
                    r.status === "pending" &&
                    !step.vars.publishingEvaluations.has(r.id) &&
                    (!r.evaluationFor ||
                      r.skillEvaluation?.status === "pending") &&
                    !step.state.reflection.requests.some(
                      (other) =>
                        other.scope === r.scope &&
                        ["running", "cancelling"].includes(other.status),
                    ) &&
                    now >=
                      Math.max(r.createdAt, step.state.lastInteractionAt) +
                        delay &&
                    now >= (progress?.nextEligibleAt ?? 0)
                  );
                });
                // Stable ties preserve enqueue order. Drives do not change identity,
                // idle age, cooldown, evidence authorization or the claim budget.
                const request = eligible
                  .map((request) => ({
                    request,
                    priority: reflectionPriority(request, now),
                  }))
                  .sort((a, b) => b.priority - a.priority)[0]?.request;
                if (!request || isQuiet(now, deps.policy.quiet)) return;
                return withSpan(
                  "june.reflection.run",
                  {
                    "june.operation.id": correlationId(request.id),
                    "june.role": "reflection",
                  },
                  async (span) => {
                    const controller = new AbortController();
                    step.vars.active.set(request.id, controller);
                    const signal = AbortSignal.any([
                      controller.signal,
                      step.abortSignal,
                      AbortSignal.timeout(deps.timeoutMs),
                    ]);
                    let attempt: number | undefined;
                    let invocation = "";
                    const operationEpoch = step.state.epoch;
                    try {
                      const evidence = await retrieve(request, signal);
                      if (
                        signal.aborted ||
                        step.state.liveActive > 0 ||
                        (request.evaluationFor &&
                          operationEpoch !== step.state.epoch)
                      )
                        return;
                      if (!evidence) {
                        step.vars.replaceReflection(
                          cancel(step.state.reflection, request.id),
                        );
                        await step.vars.persist();
                        return;
                      }
                      const admitted = claim(
                        step.state.reflection,
                        request.id,
                        Date.now(),
                        deps.policy,
                        evidence,
                        step.state.liveActive,
                      );
                      step.vars.replaceReflection(admitted.state);
                      attempt = admitted.attempt;
                      if (attempt) span.setAttribute("june.attempt", attempt);
                      if (!attempt) {
                        if (
                          admitted.reason === "stopped" ||
                          admitted.reason === "stale-evidence"
                        )
                          step.vars.replaceReflection(
                            cancel(step.state.reflection, request.id),
                          );
                        await step.vars.persist();
                        return;
                      }
                      invocation = JSON.stringify([request.id, attempt]);
                      step.state.invocations[invocation] = "started";
                      await step.vars.persist();
                      if (request.evaluationFor) {
                        const alias = request.evaluationFor;
                        const currentRequest = () =>
                          step.state.reflection.requests.find(
                            (r) => r.id === request.id,
                          );
                        const canRun = () =>
                          !signal.aborted &&
                          operationEpoch === step.state.epoch &&
                          !step.state.liveActive &&
                          !isQuiet(Date.now(), deps.policy.quiet) &&
                          currentRequest()?.status === "running";
                        const persistReceipt = async () => {
                          step.vars.publishingEvaluations.add(request.id);
                          try {
                            await step.vars.persist();
                          } catch (error) {
                            controller.abort();
                            throw error;
                          }
                          step.vars.publishingEvaluations.delete(request.id);
                        };
                        const read = await readSkillEvaluation(
                          step,
                          alias,
                          request.scope,
                        );
                        if (!read?.isCurrent() || !canRun()) return;
                        await evaluateSkillCandidate(
                          read.input,
                          async (context, callSignal) => {
                            const evidenceId = context.evidence[0]?.id;
                            const before = await readSkillEvaluation(
                              step,
                              alias,
                              request.scope,
                            );
                            const receipt = currentRequest()?.skillEvaluation;
                            const item = receipt?.cases.find(
                              (item) => item.evidenceId === evidenceId,
                            );
                            if (
                              !before?.isCurrent() ||
                              !receipt ||
                              !item ||
                              item.status !== "pending" ||
                              !canRun()
                            )
                              return abstain("stale-or-invalid-evidence");
                            receipt.status = "started";
                            item.status = "started";
                            await persistReceipt();
                            // Persistence yields: recheck every source and the operation
                            // fence again immediately before the shared provider call.
                            const current = await readSkillEvaluation(
                              step,
                              alias,
                              request.scope,
                            );
                            if (!current?.isCurrent() || !canRun())
                              return abstain("stale-or-invalid-evidence");
                            return deps.decide(
                              {
                                ...context,
                                now: Date.now(),
                                evidence: current.input.heldOutEvidence.filter(
                                  (e) => e.id === evidenceId,
                                ),
                              },
                              callSignal,
                            );
                          },
                          signal,
                          async (result) => {
                            const receipt = currentRequest()?.skillEvaluation;
                            const item = receipt?.cases.find(
                              (item) => item.evidenceId === result.evidenceId,
                            );
                            if (
                              !receipt ||
                              !item ||
                              receipt.status === "invalidated"
                            )
                              return;
                            item.status = "settled";
                            item.decision = result.decision;
                            await persistReceipt();
                          },
                        );
                        return;
                      }
                      const executionEvidence = await retrieve(request, signal);
                      if (
                        !executionEvidence ||
                        signal.aborted ||
                        step.state.liveActive > 0 ||
                        isQuiet(Date.now(), deps.policy.quiet) ||
                        step.state.reflection.requests.find(
                          (r) => r.id === request.id,
                        )?.status !== "running"
                      )
                        return;
                      const mode =
                        step.state.modes[request.id] ?? "interaction";
                      const epoch = step.state.epoch;
                      const input: DecisionInput = {
                        scope: request.scope,
                        question:
                          request.kind === "curiosity" && mode !== "deep"
                            ? "interruption-cost"
                            : "novelty",
                        prompt:
                          "Use only the supplied existing evidence. No web search was performed for this request; do not request additional sources, private account access or tool execution. " +
                          (mode === "deep"
                            ? "Simulate 1–3 alternative responses to these episodes, each at most 2000 characters. Alternatives and predicted effects are hypothetical, never independent evidence. Optionally suggest a bounded skillChange describing better behavior, with a rationale grounded in original cited evidence. Stage a proposal only; no code, installed instructions, actions or permission changes."
                            : "Evaluate whether these episodes support a useful reflection proposal or interruption candidate. Silence is normal; do not repeatedly contact an idle owner. No actions or permission changes."),
                        ...(mode === "deep" ? { simulateResponses: true } : {}),
                        now: Date.now(),
                        evidenceMaxAgeMs: deps.policy.evidenceMaxAgeMs,
                        evidence: executionEvidence,
                      };
                      // Await actual settlement. An uncooperative provider keeps its durable
                      // claim; abort is not evidence that its external request has stopped.
                      const decision = validateDecision(
                        await deps.decide(structuredClone(input), signal),
                        input,
                      );
                      const current = await retrieve(request, signal);
                      const running = step.state.reflection.requests.find(
                        (r) => r.id === request.id,
                      );
                      if (
                        current &&
                        !signal.aborted &&
                        running?.status === "running" &&
                        epoch === step.state.epoch &&
                        !step.state.liveActive &&
                        !isQuiet(Date.now(), deps.policy.quiet)
                      ) {
                        step.state.decisionOutcomes ??= {};
                        step.state.decisionOutcomes[invocation] =
                          decision.answer;
                        const interruption =
                          request.kind === "curiosity" && mode !== "deep";
                        // Citing original episodes does not turn simulated replies into
                        // observations or independent grounds for an interruption.
                        const hypothesisOnly =
                          mode === "deep" ||
                          !current.some(
                            (e) =>
                              e.source !== "dream" &&
                              decision.evidenceIds.includes(e.id),
                          );
                        if (
                          decision.answer === "yes" &&
                          (!interruption ||
                            (!hypothesisOnly &&
                              step.state.interruptionEpoch !== epoch))
                        ) {
                          const createdAt = Date.now();
                          const skillChange: SkillChangeProposal | undefined =
                            decision.skillChange
                              ? {
                                  ...decision.skillChange,
                                  id: reflectionCandidateId(
                                    `skill-change:${invocation}`,
                                  ),
                                  digest: reflectionCandidateId(
                                    JSON.stringify([
                                      "skill-change-v1",
                                      invocation,
                                      epoch,
                                      request.evidenceIds,
                                      decision,
                                    ]),
                                  ),
                                  createdAt,
                                  hypothesisOnly: true,
                                }
                              : undefined;
                          step.vars.publishingCandidates.add(invocation);
                          step.state.candidates[invocation] = {
                            id: invocation,
                            requestId: request.id,
                            scope: request.scope,
                            attempt,
                            mode,
                            kind: interruption
                              ? "interruption-candidate"
                              : "proposal",
                            hypothesisOnly,
                            decision,
                            ...(skillChange ? { skillChange } : {}),
                            createdAt,
                            epoch,
                            publication: {
                              version: 1,
                              expiresAt: Math.min(
                                expiresAt(executionEvidence),
                                expiresAt(current),
                              ),
                            },
                          };
                          if (interruption)
                            step.state.interruptionEpoch = epoch;
                        }
                      }
                    } catch {
                      // No exception text or evidence enters receipts/state. Failure consumes
                      // the admitted attempt rather than causing automatic provider replay.
                      span.setStatus({ code: SpanStatusCode.ERROR });
                      span.setAttribute("june.outcome", "unknown");
                      if (!attempt && !signal.aborted)
                        step.vars.replaceReflection(
                          cancel(step.state.reflection, request.id),
                        );
                    } finally {
                      step.vars.active.delete(request.id);
                      if (attempt) {
                        step.vars.replaceReflection(
                          finish(
                            step.state.reflection,
                            request.id,
                            attempt,
                            Date.now(),
                            [],
                            deps.policy,
                          ),
                        );
                        step.state.invocations[invocation] = "settled";
                        const current = step.state.reflection.requests.find(
                          (r) => r.id === request.id,
                        );
                        if (current?.skillEvaluation) {
                          // An admitted evaluation is once-only, including partial
                          // failure/abort. Never run the remaining cases on replay.
                          if (current.status === "pending")
                            current.status = "stopped";
                          if (current.skillEvaluation.status !== "invalidated")
                            current.skillEvaluation.status =
                              current.skillEvaluation.cases.every(
                                (item) => item.status === "settled",
                              )
                                ? "settled"
                                : "uncertain";
                          step.vars.publishingEvaluations.add(request.id);
                        }
                      }
                      trimCandidates(step.state);
                      await step.vars.persist();
                      step.vars.publishingEvaluations.delete(request.id);
                      // Publication linearizes at the final checks + synchronous
                      // candidate/settled assignment. Later occupancy revokes effects,
                      // not that publication; the flush ACK only gates read visibility.
                      // Failed flushes remain hidden for this process. Recovery reads
                      // only the candidate plus matching receipt that reached disk.
                      step.vars.publishingCandidates.delete(invocation);
                    }
                  },
                );
              },
            });
          } finally {
            release?.();
          }
        });
      },
      {
        // Normal durable queue/timer suspension is not a workflow failure.
        onError(ctx) {
          if (!ctx.abortSignal.aborted) lifecycle?.fail();
        },
      },
    ),
  });
}
