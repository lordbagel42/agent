import type {
  ChannelEvent,
  CodingRequest,
  ExecutionCommand,
  MessageEvent,
  Owner,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { isOwner } from "../core/social.js";
import type { EvidenceStore } from "../memory/store.js";
import { type CompressedJson, eventRecord } from "./conversation-storage.js";
import { type ExecutionRequest, executionLimits } from "./execution.js";
import type { ExecutionContext } from "./execution-context.js";
import type { ConversationState, MemoryReference } from "./registry.js";

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
  /** Immutable content-free retention classification, not confirmation authority. */
  controlCompletions?: string[];
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
  eventsArchive?: CompressedJson;
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
    const event = eventRecord(state, id)?.event;
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

/** A caller inside the stable catalog's durable callback, not an activity-state
 * copy. The caller retains its original journal step and live authorization
 * predicate. RPCs and persistence yield, so authorization is rechecked afterward.
 */
interface ScopeExecutionHost {
  state: Pick<
    ConversationState,
    "agents" | "delegations" | "memoryContexts" | "forgetCleanups"
  >;
  conversationKey: string[];
  scopeKey: string[];
  audience: string;
  eventId: string;
  event: MessageEvent;
  replyAddress: MessageEvent["address"];
  plan: {
    workerCapabilities?: ExecutionContext["capabilities"];
    deletionRevision?: number;
    workspaces: string[];
    web?: boolean;
  };
  enabled(): boolean;
  canStartAction(): boolean;
  personalityDigest(): string;
  persist(): Promise<void>;
  worker(id: string): {
    summary(): Promise<{ pending: number }>;
    result(requestId: string): Promise<unknown>;
    cancel(commandId: string): Promise<unknown>;
    submit(request: ExecutionRequest): Promise<boolean>;
  };
}

/** Stable roster, task identity and frozen authority stay together on dispatch.
 * Work runs in the independent execution actor, never in this catalog callback.
 */
export async function dispatchScopeExecution(
  host: ScopeExecutionHost,
  commands: readonly ExecutionCommand[],
): Promise<string[]> {
  const { state, eventId, plan } = host;
  const outcomes: string[] = [];
  for (const command of commands) {
    if (!host.canStartAction() || !host.enabled()) break;
    state.agents ??= {};
    let id = Object.hasOwn(state.agents, command.agent)
      ? state.agents[command.agent]
      : undefined;
    if (command.action === "cancel") {
      if (id) await host.worker(id).cancel(eventId);
      outcomes.push(
        `${command.agent}: ${id ? "cancellation requested" : "not found"}`,
      );
      continue;
    }
    if (
      id &&
      Object.values(state.forgetCleanups ?? {}).some(
        (cleanup) =>
          !cleanup.completed &&
          Object.values(cleanup.agents).some((agent) => agent === id),
      )
    ) {
      outcomes.push(
        `${command.agent}: forgetting cleanup pending; retry after cleanup or use another worker name`,
      );
      continue;
    }
    if (!id && Object.keys(state.agents).length >= executionLimits.roster) {
      outcomes.push(`${command.agent}: roster full; reuse an existing worker`);
      continue;
    }
    const pending = await Promise.all(
      Object.values(state.agents).map((key) => host.worker(key).summary()),
    );
    if (!host.canStartAction()) break;
    const requestId = `${eventId}:${command.agent}`;
    const existing = id ? await host.worker(id).result(requestId) : null;
    if (
      !existing &&
      pending.reduce((sum, worker) => sum + worker.pending, 0) >=
        executionLimits.pending
    ) {
      outcomes.push(`${command.agent}: busy; four tasks are already pending`);
      continue;
    }
    if (!host.canStartAction()) break;
    id ??= `${eventId}:${command.agent}`;
    state.agents[command.agent] = id;
    const reference = state.memoryContexts?.[eventId];
    const context: ExecutionContext | undefined = plan.workerCapabilities
      ? {
          version: 1,
          scopeKey: [...host.scopeKey],
          audience: host.audience,
          conversationKey: [...host.conversationKey],
          originEventId: eventId,
          deletionRevision: plan.deletionRevision ?? 0,
          sourceIds: [...(reference?.sourceIds ?? [])],
          contextSourceIds: [...(reference?.contextSourceIds ?? [])],
          personality: host.personalityDigest(),
          capabilities: plan.workerCapabilities,
        }
      : undefined;
    if (context) {
      state.delegations ??= {};
      state.delegations[requestId] ??= context;
    }
    await host.persist();
    if (!host.canStartAction()) break;
    const accepted = await host.worker(id).submit({
      id: requestId,
      source: host.event,
      replyAddress: host.replyAddress,
      task: command.task,
      ...(context ? { context: state.delegations?.[requestId] } : {}),
      workspaces: plan.workspaces,
      web: !!plan.web,
      deletionTracked: true,
      evidenceIds: [
        ...new Set([
          ...(state.memoryContexts?.[eventId]?.sourceIds ?? []),
          ...(state.memoryContexts?.[eventId]?.contextSourceIds ?? []),
        ]),
      ],
    });
    outcomes.push(`${command.agent}: ${accepted ? "queued" : "unavailable"}`);
  }
  return outcomes;
}

/** Render journaled dispatch receipts without exposing routine orchestration. */
export function executionDispatchText(
  outcomes: readonly string[],
  expected: number,
  acknowledgment: string,
): string {
  const accepted = outcomes.filter((outcome) =>
    outcome.endsWith(": queued"),
  ).length;
  if (outcomes.length === expected && accepted === expected)
    return acknowledgment;
  const reasons: Record<string, string> = {
    "cancellation requested":
      "Cancellation requested. This does not confirm that in-flight work stopped.",
    "not found":
      "I couldn't find that task to cancel. Nothing is confirmed stopped.",
    "forgetting cleanup pending; retry after cleanup or use another worker name":
      "I couldn't start that task while earlier context is being cleared.",
    "roster full; reuse an existing worker":
      "This conversation has reached its task limit; I couldn't start that work.",
    "busy; four tasks are already pending":
      "Four tasks are already pending, so I couldn't start that work.",
    unavailable: "I couldn't start that task.",
  };
  const notices = outcomes
    .filter((outcome) => !outcome.endsWith(": queued"))
    .map((outcome) => {
      const [name, status = ""] = outcome.split(": ", 2);
      const reason = reasons[status];
      if (!reason) return outcome;
      return expected > 1 && status !== "cancellation requested"
        ? `${name}: ${reason}`
        : reason;
    });
  // A mixed result must not repeat a pre-admission claim such as "both started".
  if (accepted && notices.length)
    notices.unshift(
      `${accepted} requested ${accepted === 1 ? "task was" : "tasks were"} accepted.`,
    );
  return [...new Set(notices)].join("\n");
}
