import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
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
} from "../reflection/domain.js";
import {
  type Decision,
  type DecisionFunction,
  type DecisionInput,
  validateDecision,
} from "../reflection/evaluator.js";

export type ReflectionMode = "interaction" | "idle" | "deep";
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
  /** Invalidated by a subsequent interaction; never an authorization to send. */
  epoch: number;
}

export interface ReflectionRuntimeState {
  reflection: ReflectionState;
  modes: Record<string, ReflectionMode>;
  invocations: Record<string, "started" | "settled" | "uncertain">;
  candidates: Record<string, ReflectionCandidate>;
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
export function createReflectionActor(deps: ReflectionDependencies) {
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

  return actor({
    state: {
      reflection: initialState(),
      modes: {},
      invocations: {},
      candidates: {},
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
      active: Map<string, AbortController>;
    } => ({
      persist: () => c.saveState({ immediate: true }),
      active: new Map<string, AbortController>(),
    }),
    queues: { wake: queue<{ wake: true }>() },
    actions: {
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
        c.state.reflection = result.state;
        if (result.accepted) c.state.modes[result.id] = input.mode;
        await c.vars.persist();
        await c.queue.send("wake", { wake: true });
        return { id: result.id, accepted: result.accepted };
      },
      cancel: async (c, id: string) => {
        c.state.reflection = cancel(c.state.reflection, id);
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
          c.state.candidates = {};
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
        if (c.state.triggerIds.includes(event.id)) return;
        c.state.triggerIds.push(event.id);
        c.state.legacyLiveActive = event.liveActive;
        c.state.liveActive =
          event.liveActive +
          (c.state.liveTurns?.filter((turn) => turn.active).length ?? 0);
        if (event.type === "interaction") {
          c.state.lastInteractionAt = Date.now();
          c.state.epoch++;
          c.state.candidates = {};
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
        candidateIds: Object.keys(c.state.candidates),
        liveActive: c.state.liveActive,
        activeTurnIds: (c.state.liveTurns ?? [])
          .filter((turn) => turn.active)
          .map((turn) => turn.id),
        epoch: c.state.epoch,
      }),
      /** Recheck memory on every read, including after actor recovery or forgetting. */
      candidate: async (c, id: string) => {
        const candidate = c.state.candidates[id];
        const request = c.state.reflection.requests.find(
          (r) => r.id === candidate?.requestId,
        );
        if (!candidate || !request) return null;
        const evidence = await retrieve(
          request,
          AbortSignal.timeout(deps.timeoutMs),
        );
        if (
          !evidence ||
          c.state.candidates[id] !== candidate ||
          candidate.epoch !== c.state.epoch ||
          isQuiet(Date.now(), deps.policy.quiet) ||
          c.state.liveActive > 0
        )
          return null;
        return candidate;
      },
      /** Operator-only recovery after confirming the old worker/provider has stopped.
       * Never retries this request or clears its dedupe tombstone.
       */
      reconcile: async (c, id: string, confirmedStopped: boolean) => {
        if (!confirmedStopped || c.vars.active.has(id)) return false;
        const request = c.state.reflection.requests.find((r) => r.id === id);
        if (!request || !["running", "cancelling"].includes(request.status))
          return false;
        c.state.reflection = finish(
          cancel(c.state.reflection, id),
          id,
          request.attempts,
          Date.now(),
          [],
          deps.policy,
        );
        c.state.invocations[JSON.stringify([id, request.attempts])] = "settled";
        await c.vars.persist();
        return true;
      },
    },
    run: workflow(async (ctx) => {
      await ctx.loop("reflection-v1", async (loop) => {
        // Queue timeout is a Rivet durable timer, not a process-local scheduler.
        await loop.queue.nextBatch("wake-or-timer", {
          names: ["wake"],
          count: 100,
          timeout: deps.pollMs,
        });
        await loop.step({
          name: "reflect",
          timeout: 0,
          run: async (step) => {
            if (step.key.length !== 1 || step.key[0] !== deps.ownerId) return;
            // A started marker with no local worker means an interrupted step.
            // Never repeat a possibly completed external generation on replay.
            let recovered = false;
            for (const [key, phase] of Object.entries(step.state.invocations))
              if (phase === "started") {
                step.state.invocations[key] = "uncertain";
                recovered = true;
              }
            if (recovered) await step.vars.persist();
            if (step.state.liveActive > 0) return;
            const now = Date.now();
            const request = step.state.reflection.requests.find((r) => {
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
                  Math.max(r.createdAt, step.state.lastInteractionAt) + delay &&
                now >= (progress?.nextEligibleAt ?? 0)
              );
            });
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
                step.state.reflection = cancel(
                  step.state.reflection,
                  request.id,
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
              step.state.reflection = admitted.state;
              attempt = admitted.attempt;
              if (!attempt) {
                if (
                  admitted.reason === "stopped" ||
                  admitted.reason === "stale-evidence"
                )
                  step.state.reflection = cancel(
                    step.state.reflection,
                    request.id,
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
                step.state.reflection.requests.find((r) => r.id === request.id)
                  ?.status !== "running"
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
                  mode === "deep"
                    ? "Consider patterns and alternative interpretations. Dreams are hypotheses, never independent evidence. Stage a proposal only; no actions or permission changes."
                    : "Evaluate whether these episodes support a useful reflection proposal or interruption candidate. Silence is normal; do not repeatedly contact an idle owner. No actions or permission changes.",
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
                !isQuiet(Date.now(), deps.policy.quiet) &&
                decision.answer === "yes"
              ) {
                const interruption = request.kind === "curiosity";
                const hypothesisOnly = !current.some(
                  (e) =>
                    e.source !== "dream" && decision.evidenceIds.includes(e.id),
                );
                if (
                  !interruption ||
                  (!hypothesisOnly && step.state.interruptionEpoch !== epoch)
                ) {
                  step.state.candidates[invocation] = {
                    id: invocation,
                    requestId: request.id,
                    scope: request.scope,
                    attempt,
                    mode,
                    kind: interruption ? "interruption-candidate" : "proposal",
                    hypothesisOnly,
                    decision,
                    createdAt: Date.now(),
                    epoch,
                  };
                  if (interruption) step.state.interruptionEpoch = epoch;
                }
              }
            } catch {
              // No exception text or evidence enters receipts/state. Failure consumes
              // the admitted attempt rather than causing automatic provider replay.
              if (!attempt && !signal.aborted)
                step.state.reflection = cancel(
                  step.state.reflection,
                  request.id,
                );
            } finally {
              step.vars.active.delete(request.id);
              if (attempt) {
                step.state.reflection = finish(
                  step.state.reflection,
                  request.id,
                  attempt,
                  Date.now(),
                  [],
                  deps.policy,
                );
                step.state.invocations[invocation] = "settled";
              }
              await step.vars.persist();
            }
          },
        });
      });
    }),
  });
}
