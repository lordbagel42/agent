import type {
  ChannelEvent,
  CodingRequest,
  MessageEvent,
  Owner,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { isOwner } from "../core/social.js";
import type { EvidenceStore } from "../memory/store.js";
import type { ExecutionContext } from "./execution-context.js";
import type { MemoryReference } from "./registry.js";

/** Stable catalog records owned by the conversation actor, not its workers. */
export interface ScopeCatalog {
  jobs: Record<
    string,
    CodingRequest & {
      runtimeId?: string;
      preview?: string;
      /** Frozen origin for a candidate-keyed proposal, including queue retries. */
      source?: MessageEvent;
    }
  >;
  agents?: Record<string, string>;
  jobAgents?: Record<string, { agentId: string; requestId: string }>;
  delegations?: Record<string, ExecutionContext>;
  forgetConfirmations?: Record<
    string,
    {
      sourceId: string;
      fingerprint: string;
      /** Absent on old previews: do not retroactively authorize archive loss. */
      includeArchives?: true;
      archivedTurns?: number;
      previewEventId: string;
      expiresAt: number;
      commandEventId?: string;
      status: "pending" | "started" | "completed";
    }
  >;
}

interface CatalogAuthorityState
  extends Pick<ScopeCatalog, "jobs" | "delegations"> {
  events: Record<string, { event: ChannelEvent }>;
  forgottenEvents?: string[];
  memoryContexts?: Record<string, MemoryReference>;
}

interface CatalogAuthorityDependencies {
  owner: Owner;
  store?: Pick<EvidenceStore, "deletionRevision" | "source" | "isDeleted">;
  current(audience: string, reference: MemoryReference): boolean;
  personalityDigest(audience: string): string;
}

// Trusted metadata reads only. Tool execution stays in the worker, and never
// takes the conversation inbox or copies its approval catalog into worker state.
export function createScopeCatalogAuthority(
  deps: CatalogAuthorityDependencies,
) {
  function delegatedScope(
    state: CatalogAuthorityState,
    key: string[],
    requestId: string,
  ) {
    const context = state.delegations?.[requestId];
    const id = context?.originEventId ?? "";
    const event = state.events[id]?.event;
    const scope = event && routeEvent(event, deps.owner);
    if (
      !context ||
      !event ||
      !scope ||
      !isOwner(event, deps.owner) ||
      state.forgottenEvents?.includes(id) ||
      JSON.stringify(context.conversationKey) !== JSON.stringify(key) ||
      JSON.stringify(context.scopeKey) !== JSON.stringify(scope.key) ||
      context.audience !== JSON.stringify(scope.key) ||
      context.personality !== deps.personalityDigest(context.audience) ||
      context.deletionRevision !== (deps.store?.deletionRevision() ?? 0) ||
      context.sourceIds.some(
        (sourceId) => !deps.store?.source(context.audience, sourceId),
      ) ||
      context.contextSourceIds.some((sourceId) =>
        deps.store?.isDeleted(sourceId),
      ) ||
      (state.memoryContexts?.[id] &&
        !deps.current(context.audience, state.memoryContexts[id]))
    )
      throw new Error("Execution authority is no longer current");
    return context;
  }

  function visibleJob(
    state: CatalogAuthorityState,
    audience: string,
    id: string,
  ) {
    const reference = state.memoryContexts?.[id];
    return (
      Object.hasOwn(state.jobs, id) &&
      !state.forgottenEvents?.includes(id) &&
      (!reference || deps.current(audience, reference))
    );
  }

  return { delegatedScope, visibleJob };
}
