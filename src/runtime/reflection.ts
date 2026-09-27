import { createHash } from "node:crypto";
import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import type { CompanionReply } from "../core/contracts.js";
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
} from "../reflection/domain.js";
import {
  type Decision,
  type DecisionFunction,
  type DecisionInput,
  validateDecision,
} from "../reflection/evaluator.js";
import type { Lifecycle } from "./lifecycle.js";

export type ReflectionMode = "interaction" | "idle" | "deep";

/** Exact host commands only; quoted text and model output never select review. */
export function parseReflectionReviewCommand(
  text: string,
): { action: "list" } | { action: "inspect"; id: string } | undefined {
  if (text.trim() === "!reflection list") return { action: "list" };
  const match = /^!reflection inspect ([a-f0-9]{64})$/.exec(text.trim());
  return match?.[1] ? { action: "inspect", id: match[1] } : undefined;
}

/** Internal IDs embed evidence IDs; private review uses bounded opaque tokens. */
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
  /** Trusted memory boundary: current audience authorization AND deletion lookup.
   * IDs must identify immutable versions. Return exactly the requested evidence.
   */
  retrieve(
    input: { ownerId: string; scope: string; evidenceIds: string[] },
    signal: AbortSignal,
  ): Promise<{ authorized: boolean; evidence: Evidence[] }>;
  idleMs: number;
  deepMs: number;
  pollMs: number;
  timeoutMs: number;
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
  createdAt: number;
  /** Generation epoch: later interactions revoke effects, not published review. */
  epoch: number;
  /** Set only by settled publication or conservative legacy migration. */
  publication?: { version: 1; expiresAt: number };
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
  liveActive: number;
  /** Optional for actors persisted before ID-based occupancy was introduced. */
  liveTurns?: { id: string; active: boolean }[];
  legacyLiveActive?: number;
  lastInteractionAt: number;
  epoch: number;
  interruptionEpoch: number;
  triggerIds: string[];
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

  /** With a scope, accept only opaque aliases in the configured private audience.
   * Without one, preserve the trusted operator's legacy internal-ID API.
   */
  async function readCandidate(
    c: {
      readonly state: ReflectionRuntimeState;
      vars: {
        prepareCandidates: () => Promise<void>;
        publishingCandidates: Set<string>;
      };
    },
    id: string,
    scope?: string,
  ) {
    if (
      scope !== undefined &&
      (scope !== JSON.stringify(["private", deps.ownerId]) ||
        !/^[a-f0-9]{64}$/.test(id))
    )
      return null;
    await c.vars.prepareCandidates();
    const candidate =
      scope === undefined
        ? c.state.candidates[id]
        : Object.values(c.state.candidates).find(
            (item) =>
              item.scope === scope && reflectionCandidateId(item.id) === id,
          );
    const request = c.state.reflection.requests.find(
      (item) =>
        item.id === candidate?.requestId && item.scope === candidate?.scope,
    );
    if (!candidate || !request) return null;
    const current = () =>
      c.state.candidates[candidate.id]?.id === candidate.id &&
      c.state.candidates[candidate.id]?.publication?.version === 1 &&
      (c.state.candidates[candidate.id]?.publication?.expiresAt ?? 0) >
        Date.now() &&
      c.state.invocations[candidate.id] === "settled" &&
      !c.vars.publishingCandidates.has(candidate.id) &&
      candidate.epoch === c.state.epoch &&
      !c.state.liveActive &&
      !isQuiet(Date.now(), deps.policy.quiet) &&
      !["cancelled", "cancelling"].includes(
        c.state.reflection.requests.find((item) => item.id === request.id)
          ?.status ?? "cancelled",
      );
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
      now: Date.now(),
      evidenceMaxAgeMs: deps.policy.evidenceMaxAgeMs,
      evidence,
    });
    return decision.answer === "yes" ? { candidate, evidence, decision } : null;
  }

  const expiresAt = (evidence: Evidence[]) =>
    Math.min(
      ...evidence.flatMap((e) => [
        e.expiresAt,
        e.observedAt + deps.policy.evidenceMaxAgeMs,
      ]),
    );

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
    let remaining = oldest.length;
    for (const [id] of oldest) {
      if (
        remaining <= 50 &&
        Buffer.byteLength(JSON.stringify(state.candidates)) <= 256 * 1024
      )
        break;
      remove(id);
      remaining--;
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
      /** June's explicit owner-private request. No model-controlled scope,
       * evidence body or immediate mode; the existing scheduler owns admission.
       */
      request: async (
        c,
        input: NonNullable<CompanionReply["reflectionRequest"]>,
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
          scope: JSON.stringify(["private", deps.ownerId]),
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
        reflection: c.state.reflection,
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
      /** Owner-private metadata only, with the same current-evidence read gates.
       * Never use the unvalidated status().candidateIds as reviewable candidates.
       */
      listCandidates: async (
        c,
        scope: string,
      ): Promise<ReflectionCandidateList> => {
        if (
          c.key.length !== 1 ||
          c.key[0] !== deps.ownerId ||
          scope !== JSON.stringify(["private", deps.ownerId])
        )
          throw new Error("Private reflection review required");
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
      /** Recheck memory on every read, including after actor recovery or forgetting. */
      candidate: async (c, id: string, scope?: string) => {
        if (c.key.length !== 1 || c.key[0] !== deps.ownerId) return null;
        return (await readCandidate(c, id, scope))?.candidate ?? null;
      },
      /** Exact owner-private inspection, not evidence or authorization for an effect.
       * Project only after current provenance checks; omit the whole result if it
       * exceeds the byte budget rather than silently clipping the rationale.
       */
      inspectCandidate: async (c, scope: string, id: string) => {
        if (
          c.key.length !== 1 ||
          c.key[0] !== deps.ownerId ||
          scope !== JSON.stringify(["private", deps.ownerId])
        )
          return null;
        const read = await readCandidate(c, id, scope);
        if (!read) return null;
        const { candidate, evidence, decision } = read;
        const result = {
          checkedAt: Date.now(),
          candidate: {
            id,
            kind: candidate.kind,
            mode: candidate.mode,
            createdAt: candidate.createdAt,
            hypothesisOnly: candidate.hypothesisOnly,
            decision,
          },
          evidence: evidence.map(({ id, source, observedAt, expiresAt }) => ({
            id,
            source,
            observedAt,
            expiresAt,
            cited: decision.evidenceIds.includes(id),
          })),
        };
        return Buffer.byteLength(JSON.stringify(result), "utf8") <= 24000
          ? result
          : null;
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
                const controller = new AbortController();
                step.vars.active.set(request.id, controller);
                const signal = AbortSignal.any([
                  controller.signal,
                  step.abortSignal,
                  AbortSignal.timeout(deps.timeoutMs),
                ]);
                let attempt: number | undefined;
                let invocation = "";
                try {
                  const evidence = await retrieve(request, signal);
                  if (signal.aborted || step.state.liveActive > 0) return;
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
                  const mode = step.state.modes[request.id] ?? "interaction";
                  const epoch = step.state.epoch;
                  const input: DecisionInput = {
                    scope: request.scope,
                    question:
                      request.kind === "curiosity"
                        ? "interruption-cost"
                        : "novelty",
                    prompt:
                      "Use only the supplied existing evidence. No web search was performed for this request; do not request additional sources, private account access or tool execution. " +
                      (mode === "deep"
                        ? "Consider patterns and alternative interpretations. Dreams are hypotheses, never independent evidence. Stage a proposal only; no actions or permission changes."
                        : "Evaluate whether these episodes support a useful reflection proposal or interruption candidate. Silence is normal; do not repeatedly contact an idle owner. No actions or permission changes."),
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
                    step.state.decisionOutcomes[invocation] = decision.answer;
                    const interruption = request.kind === "curiosity";
                    const hypothesisOnly = !current.some(
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
                        createdAt: Date.now(),
                        epoch,
                        publication: {
                          version: 1,
                          expiresAt: Math.min(
                            expiresAt(executionEvidence),
                            expiresAt(current),
                          ),
                        },
                      };
                      if (interruption) step.state.interruptionEpoch = epoch;
                    }
                  }
                } catch {
                  // No exception text or evidence enters receipts/state. Failure consumes
                  // the admitted attempt rather than causing automatic provider replay.
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
                  }
                  trimCandidates(step.state);
                  await step.vars.persist();
                  // Publication linearizes at the final checks + synchronous
                  // candidate/settled assignment. Later occupancy revokes effects,
                  // not that publication; the flush ACK only gates read visibility.
                  // Failed flushes remain hidden for this process. Recovery reads
                  // only the candidate plus matching receipt that reached disk.
                  step.vars.publishingCandidates.delete(invocation);
                }
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
