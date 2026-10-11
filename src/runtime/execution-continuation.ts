import { isDeepStrictEqual } from "node:util";
import { Effect, Schema } from "effect";
import type { ExecutionCommand } from "../core/contracts.js";
import { delegationRecord, eventRecord } from "./conversation-storage.js";
import {
  type ExecutionRequest,
  type ExecutionResult,
  executionLimits,
} from "./execution.js";
import type { ExecutionContext } from "./execution-context.js";
import type { ConversationState } from "./registry.js";

export interface ContinuationHost {
  state: ConversationState;
  key: string[];
  eventId: string;
  current(): boolean;
  authority(requestId: string, expanded?: ExecutionContext): ExecutionContext;
  persist(): Promise<void>;
  worker(id: string): {
    result(id: string): Promise<ExecutionResult | null>;
    summary(): Promise<{ pending: number }>;
    reserveContinuation(
      parentId: string,
      childId: string,
      task: string,
      reference: { sourceIds: string[]; contextSourceIds: string[] },
    ): Promise<ExecutionRequest | null>;
    submit(request: ExecutionRequest): Promise<boolean>;
  };
}

interface Parent {
  agentId: string;
  requestId: string;
}

class ContinuationError extends Schema.TaggedError<ContinuationError>()(
  "ContinuationError",
  { cause: Schema.Defect() },
) {}

const call = <T>(work: () => Promise<T>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) => new ContinuationError({ cause }),
  });

/** Recheck the same host facts at rendering and at the effect boundary. */
export const readExecutionContinuation = Effect.fn(
  "june.execution.continuation.read",
)(function* (host: ContinuationHost, parent: Parent, resume = false) {
  if (!host.current()) return undefined;
  const agent = Object.entries(host.state.agents ?? {}).find(
    ([, id]) => id === parent.agentId,
  )?.[0];
  if (!agent) return undefined;
  const result = yield* call(() =>
    host.worker(parent.agentId).result(parent.requestId),
  );
  if (
    !host.current() ||
    !result ||
    result.id !== parent.requestId ||
    result.status !== "completed" ||
    result.silent ||
    result.continuationOf ||
    result.continuationRevoked ||
    result.coding ||
    result.skillCodingProposal ||
    result.operation?.status === "started" ||
    Object.keys(result.deliveries ?? {}).length > 0 ||
    (!result.continuationEligible &&
      !(
        resume &&
        result.continuationReservation?.id === `${host.eventId}:${agent}`
      ))
  )
    return undefined;
  let authority: ExecutionContext;
  try {
    authority = host.authority(parent.requestId, result.context);
  } catch {
    return undefined;
  }
  const original = eventRecord(host.state, authority.originEventId)?.event;
  if (
    !result.context ||
    !isDeepStrictEqual(authority.conversationKey, host.key) ||
    !isDeepStrictEqual(original, result.source) ||
    host.state.clearedInputs?.[authority.originEventId] ||
    Object.values(host.state.forgetCleanups ?? {}).some(
      (cleanup) =>
        !cleanup.completed &&
        Object.values(cleanup.agents).includes(parent.agentId),
    )
  )
    return undefined;
  return { agent };
}, Effect.uninterruptible);

/** Reserve on the existing worker, persist the frozen authority, then submit.
 * Neither completion prose nor its freshly computed capabilities grants work.
 * RPC loss repeats only this exact identity, never another task or worker.
 */
export const dispatchExecutionContinuation = Effect.fn(
  "june.execution.continuation.dispatch",
)(
  function* (
    host: ContinuationHost,
    parent: Parent,
    commands: readonly ExecutionCommand[],
  ) {
    const denied = commands.map((command) => `${command.agent}: unavailable`);
    const command = commands[0];
    if (commands.length !== 1 || command?.action !== "run") return denied;
    const offer = yield* readExecutionContinuation(host, parent, true);
    if (!offer || command.agent !== offer.agent) return denied;
    const worker = host.worker(parent.agentId);
    const childId = `${host.eventId}:${offer.agent}`;
    const existing = yield* call(() => worker.result(childId));
    if (!existing) {
      const pending = yield* call(() =>
        Promise.all(
          Object.values(host.state.agents ?? {}).map((id) =>
            host.worker(id).summary(),
          ),
        ),
      );
      if (
        pending.reduce((sum, entry) => sum + entry.pending, 0) >=
        executionLimits.pending
      )
        return [`${offer.agent}: busy; four tasks are already pending`];
    }
    if (!host.current()) return denied;
    const reference = host.state.memoryContexts?.[host.eventId];
    const child = yield* call(() =>
      worker.reserveContinuation(parent.requestId, childId, command.task, {
        sourceIds: reference?.sourceIds ?? [],
        contextSourceIds: reference?.contextSourceIds ?? [],
      }),
    );
    if (!child?.context || !host.current()) return denied;
    const saved = delegationRecord(host.state, child.id);
    if (saved && !isDeepStrictEqual(saved, child.context)) return denied;
    host.state.delegations ??= {};
    if (!saved) host.state.delegations[child.id] = child.context;
    yield* call(host.persist);
    if (!host.current()) return denied;
    try {
      host.authority(parent.requestId);
      host.authority(child.id);
    } catch {
      return denied;
    }
    const accepted = yield* call(() => worker.submit(child));
    return [`${offer.agent}: ${accepted ? "queued" : "unavailable"}`];
  },
  // Do not release Rivet/lifecycle admission while a raw reserve/submit RPC lives.
  Effect.uninterruptible,
);
