import { Predicate, Schema } from "effect";
import type { CapabilityOutputGuards } from "../capabilities/contracts.js";

class CapabilityOutputUnavailable extends Schema.TaggedError<CapabilityOutputUnavailable>()(
  "CapabilityOutputUnavailable",
  { message: Schema.Literal("Capability invocation unavailable") },
) {}

export const unavailableCapabilityObservation = (code: string) => ({
  text: JSON.stringify({
    status: "unavailable",
    code,
    instruction:
      "No complete capability observation is available. Do not infer readiness, repair anything or repeat an uncertain operation.",
  }),
  terminal: true,
});

/** One modular invocation, owned by the worker until first history insertion.
 * These synchronous callbacks are the host/producer ABI, not another runtime or
 * an Effect scope that can close before the worker's final Promise handoff.
 */
export function createCapabilityOutputController() {
  const entries = new Map<
    object,
    { current: () => boolean; claimed: boolean }
  >();
  let failed = false;
  let closed = false;
  const deny = () => {
    failed = true;
    return false;
  };
  const current = () => {
    if (closed || failed) return false;
    for (const entry of entries.values()) {
      if (!entry.claimed) continue;
      try {
        const verdict: unknown = entry.current();
        if (verdict !== true) {
          // Never await a malformed guard or expose its rejection body.
          if (Predicate.isPromise(verdict)) void verdict.catch(() => {});
          return deny();
        }
      } catch {
        return deny();
      }
    }
    return !closed && !failed;
  };
  const producer: CapabilityOutputGuards = Object.freeze({
    register(result: object, guard: () => boolean) {
      if (
        closed ||
        failed ||
        !Predicate.isObject(result) ||
        !Predicate.isFunction(guard) ||
        entries.has(result)
      ) {
        deny();
        throw new CapabilityOutputUnavailable({
          message: "Capability invocation unavailable",
        });
      }
      entries.set(result, { current: guard, claimed: false });
    },
  });
  return {
    producer,
    claim(result: object): boolean {
      if (closed || failed) return false;
      const entry = entries.get(result);
      if (!entry || entry.claimed) return deny();
      entry.claimed = true;
      return current();
    },
    current,
    invalidate: deny,
    dispose() {
      closed = true;
      entries.clear();
    },
  };
}

export type CapabilityOutputController = ReturnType<
  typeof createCapabilityOutputController
>;
