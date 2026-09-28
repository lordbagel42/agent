import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import type {
  ChannelAdapter,
  CompanionReply,
  ConversationMessage,
  MessageEvent,
  ModelProvider,
  ModelRequest,
  ModelSettlement,
  Owner,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { isOwner } from "../core/social.js";
import type { EvidenceStore } from "../memory/store.js";
import { beginModelReply } from "../models/invocation.js";
import { parseReply } from "../models/provider.js";
import { type Delivery, deliver } from "../runtime/delivery.js";
import type { Lifecycle } from "../runtime/lifecycle.js";
import type { MemoryReference } from "../runtime/registry.js";
import type { SessionArchiveInput } from "./archive.js";
import { type ArchiveEvidence, produceSessionArchiveTurn } from "./producer.js";
import { sessionActorKey } from "./state.js";

/** Catalog-owned assignment. It never supplies a new audience or worker key. */
export interface ActivityAssignment {
  scopeKey: string[];
  sessionId: string;
  eventId: string;
  sequence: number;
  receivedAt: number;
  openedAt: number;
  kind: "message" | "notification";
}

interface TurnContext {
  source: MessageEvent;
  sourceId?: string;
  reference: MemoryReference;
  deletionRevision: number;
  replyAddress: MessageEvent["address"];
  retentionExcluded: boolean;
}

/** Trusted metadata interface; implementations stay on the stable coordinator.
 * prepare freezes provenance/capabilities there before returning. apply is keyed
 * by this assignment and may dispatch idempotent worker requests, not tools.
 * acknowledge must verify the exact assignment and receipts before releasing it.
 */
export interface ActivityCatalog {
  /** Historical acknowledgment is an exact metadata receipt, not renewed effect
   * permission. Keep it available after release, revocation and lost RPC ACKs. */
  assignmentStatus(
    assignment: ActivityAssignment,
  ): Promise<"active" | "acknowledged" | "unavailable">;
  prepare(
    assignment: ActivityAssignment,
    history: (ConversationMessage & { reference: MemoryReference })[],
  ): Promise<TurnContext & { request: ModelRequest }>;
  apply(
    assignment: ActivityAssignment,
    reply: CompanionReply,
  ): Promise<{ text: string; messages?: string[] }>;
  acknowledge(
    assignment: ActivityAssignment,
    outcome: {
      inference: Exclude<ModelSettlement, "unknown">;
      deliveries: Delivery[];
      archivedThrough: number;
    },
  ): Promise<void>;
}

interface ActivityTurn {
  assignment: ActivityAssignment;
  context?: TurnContext;
  inference?: ModelSettlement | "started";
  reply?: CompanionReply;
  deliveries?: Delivery[];
  archive?: { input: SessionArchiveInput; deletionRevision: number };
  archivedThrough?: number;
  acknowledged?: true;
  hold?: "inference" | "delivery" | "provenance";
}

interface ActivityState {
  binding?: Pick<ActivityAssignment, "scopeKey" | "sessionId" | "openedAt">;
  turns: Record<string, ActivityTurn>;
  history: (ConversationMessage & { eventId: string; context: TurnContext })[];
  acknowledgedThrough: number;
}

export interface ActivityDependencies {
  owner: Owner;
  model: ModelProvider;
  channel: Pick<ChannelAdapter, "send">;
  lifecycle?: Lifecycle;
  catalog(scopeKey: string[]): ActivityCatalog;
  memory: {
    store: Pick<EvidenceStore, "archiveSessionTurn" | "deletionRevision">;
    evidence: ArchiveEvidence;
    current(audience: string, reference: MemoryReference): boolean;
  };
}

/** New actor only: no legacy journal is reinterpreted as an activity workflow.
 * Owns interaction state, never a worker/proposal catalog. Runtime registration
 * and coordinator admission are deliberately separate from constructing it.
 */
export function createActivityActor(deps: ActivityDependencies) {
  const current = (assignment: ActivityAssignment, context: TurnContext) =>
    context.deletionRevision === deps.memory.store.deletionRevision() &&
    deps.memory.current(JSON.stringify(assignment.scopeKey), context.reference);
  const keyMatches = (key: string[], assignment: ActivityAssignment) =>
    isDeepStrictEqual(
      key,
      sessionActorKey(assignment.scopeKey, assignment.sessionId),
    );
  return actor({
    state: {
      turns: {},
      history: [],
      acknowledgedThrough: 0,
    } as ActivityState,
    createVars: (c) => ({
      persist: () => c.saveState({ immediate: true }),
      receiving: Promise.resolve(),
    }),
    queues: { turns: queue<{ eventId: string }>() },
    onWake: async (c) => {
      for (const turn of Object.values(c.state.turns))
        if (!turn.acknowledged)
          await c.queue.send("turns", { eventId: turn.assignment.eventId });
    },
    actions: {
      receive: async (c, assignment: ActivityAssignment) => {
        if (
          !keyMatches(c.key, assignment) ||
          !/^[a-f0-9]{64}$/.test(assignment.eventId) ||
          !Number.isSafeInteger(assignment.sequence) ||
          assignment.sequence < 1 ||
          !Number.isSafeInteger(assignment.receivedAt) ||
          assignment.receivedAt < assignment.openedAt ||
          !Number.isSafeInteger(assignment.openedAt) ||
          assignment.openedAt < 0 ||
          !["message", "notification"].includes(assignment.kind) ||
          !isDeepStrictEqual(assignment.scopeKey, ["private", deps.owner.id])
        )
          throw new Error("Invalid activity assignment");
        const receive = c.vars.receiving.then(async () => {
          if (
            (await deps
              .catalog(assignment.scopeKey)
              .assignmentStatus(assignment)) === "unavailable"
          )
            throw new Error("Unassigned activity input");
          const binding = {
            scopeKey: assignment.scopeKey,
            sessionId: assignment.sessionId,
            openedAt: assignment.openedAt,
          };
          if (c.state.binding && !isDeepStrictEqual(c.state.binding, binding))
            throw new Error("Activity binding conflict");
          const previous = c.state.turns[assignment.eventId];
          if (previous) {
            if (!isDeepStrictEqual(previous.assignment, assignment))
              throw new Error("Activity assignment conflict");
          } else {
            if (
              assignment.sequence !== c.state.acknowledgedThrough + 1 ||
              Object.values(c.state.turns).some((turn) => !turn.acknowledged)
            )
              throw new Error("Previous activity input is not acknowledged");
            c.state.binding ??= binding;
            c.state.turns[assignment.eventId] = { assignment };
          }
          await c.vars.persist();
          await c.queue.send("turns", { eventId: assignment.eventId });
        });
        c.vars.receiving = receive.catch(() => {});
        await receive;
      },
      status: (c) => ({
        acknowledgedThrough: c.state.acknowledgedThrough,
        turns: Object.values(c.state.turns).map((turn) => ({
          sequence: turn.assignment.sequence,
          inference: turn.inference ?? "not_started",
          archivedThrough: turn.archivedThrough ?? 0,
          acknowledged: turn.acknowledged === true,
          hold: turn.hold ?? null,
        })),
      }),
    },
    run: workflow(
      async (ctx) => {
        await ctx.loop("activity-v1", async (loop) => {
          const [message] = await loop.queue.nextBatch("turn", {
            names: ["turns"],
            count: 1,
          });
          if (!message) return;
          const release = await deps.lifecycle?.enter(ctx.abortSignal);
          try {
            await loop.step({
              name: "interaction",
              timeout: 0,
              run: async (step) => {
                const turn = step.state.turns[message.body.eventId];
                if (!turn || turn.acknowledged) return;
                const assignment = turn.assignment;
                const audience = JSON.stringify(assignment.scopeKey);
                const catalog = deps.catalog(assignment.scopeKey);
                const status = await catalog.assignmentStatus(assignment);
                if (status === "acknowledged") {
                  // The catalog can commit and release before its RPC response
                  // reaches us. Repair only local metadata, never repeat effects.
                  turn.acknowledged = true;
                  delete turn.hold;
                  step.state.acknowledgedThrough = Math.max(
                    step.state.acknowledgedThrough,
                    assignment.sequence,
                  );
                  await step.vars.persist();
                  return;
                }
                if (status !== "active") return;
                // An answer or a lost callback is not a settlement receipt. Never
                // reopen a paid call or release another turn after interruption.
                if (turn.inference === "started") {
                  turn.inference = "unknown";
                  turn.hold = "inference";
                  await step.vars.persist();
                }
                if (!turn.inference) {
                  for (const [index, entry] of [
                    ...step.state.history.entries(),
                  ].reverse())
                    if (!current(assignment, entry.context))
                      step.state.history.splice(index, 1);
                  const history = step.state.history
                    .slice(-40)
                    .map(({ role, content, source, context }) => ({
                      role,
                      content,
                      ...(source ? { source } : {}),
                      reference: context.reference,
                    }));
                  const prepared = await catalog.prepare(assignment, history);
                  const { request, ...context } = prepared;
                  const sourceScope = routeEvent(context.source, deps.owner);
                  if (
                    !sourceScope?.private ||
                    !isOwner(context.source, deps.owner) ||
                    context.source.address.channel !== "slack" ||
                    !context.source.direct ||
                    !isDeepStrictEqual(sourceScope.key, assignment.scopeKey) ||
                    context.replyAddress.channel !==
                      context.source.address.channel ||
                    context.replyAddress.accountId !==
                      context.source.address.accountId ||
                    context.replyAddress.conversationId !==
                      context.source.address.conversationId ||
                    request.agentRole !== "interaction" ||
                    (context.sourceId !== undefined &&
                      !context.reference.sourceIds.includes(
                        context.sourceId,
                      )) ||
                    history.some(
                      ({ reference }) =>
                        reference.sourceIds.some(
                          (id) => !context.reference.sourceIds.includes(id),
                        ) ||
                        (reference.contextSourceIds ?? []).some(
                          (id) =>
                            !context.reference.contextSourceIds?.includes(id),
                        ),
                    ) ||
                    !current(assignment, context)
                  ) {
                    turn.hold = "provenance";
                    await step.vars.persist();
                    return;
                  }
                  turn.context = context;
                  turn.inference = "started";
                  await step.vars.persist();
                  const valid = () =>
                    !step.abortSignal.aborted && current(assignment, context);
                  if (!valid()) {
                    turn.inference = "not_started";
                    turn.hold = "provenance";
                    await step.vars.persist();
                    return;
                  }
                  const invocation = beginModelReply(
                    deps.model,
                    request,
                    step.abortSignal,
                    valid,
                    valid,
                  );
                  try {
                    const answer = await invocation.answer;
                    if (valid()) {
                      turn.reply = parseReply(
                        JSON.stringify(answer),
                        request.workspaces,
                        request,
                      );
                      await step.vars.persist();
                      await sendReply();
                    }
                  } catch {
                    // No provider/tool replay; receipt below still accounts for all
                    // native calls even when answer validation or delivery fails.
                    if (!turn.reply && valid()) {
                      turn.reply = {
                        text: "I couldn't complete that answer. I won't repeat the model request automatically.",
                      };
                      await step.vars.persist();
                    }
                  } finally {
                    turn.inference = await invocation.settlement;
                    await step.vars.persist();
                  }
                  // A definitive failed call may send the host error once. An
                  // unknown call remains held without dispatching more effects.
                  if (turn.inference !== "unknown") await sendReply();
                } else if (turn.inference !== "unknown") {
                  await sendReply();
                }
                const context = turn.context;
                if (!context || !current(assignment, context)) {
                  turn.hold = "provenance";
                  await step.vars.persist();
                  return;
                }
                if (
                  !turn.deliveries ||
                  turn.deliveries.some(
                    (delivery) =>
                      delivery.phase !== "settled" ||
                      !delivery.result ||
                      (delivery.result.status === "sent" &&
                        !delivery.result.messageId) ||
                      (delivery.result.status === "rejected" &&
                        delivery.result.retryable),
                  )
                ) {
                  turn.hold =
                    turn.inference === "unknown" ? "inference" : "delivery";
                  await step.vars.persist();
                  return;
                }
                if (!turn.archive) {
                  turn.archive = {
                    deletionRevision: context.deletionRevision,
                    input: produceSessionArchiveTurn(
                      {
                        sessionId: assignment.sessionId,
                        audience,
                        openedAt: assignment.openedAt,
                        eventId: assignment.eventId,
                        sequence: assignment.sequence,
                        receivedAt: assignment.receivedAt,
                        ...(assignment.kind === "message"
                          ? {
                              inbound: {
                                event: context.source,
                                sourceId: context.sourceId,
                              },
                            }
                          : {}),
                        retentionExcluded: context.retentionExcluded,
                        deliveries: turn.deliveries.map((delivery) => ({
                          delivery,
                          reference: context.reference,
                        })),
                      },
                      deps.memory.evidence,
                    ),
                  };
                  // Projection is immutable across write-before-ACK failures.
                  await step.vars.persist();
                }
                turn.archivedThrough = deps.memory.store.archiveSessionTurn(
                  turn.archive.input,
                  turn.archive.deletionRevision,
                );
                if (
                  !context.retentionExcluded &&
                  !step.state.history.some(
                    (entry) => entry.eventId === assignment.eventId,
                  )
                ) {
                  for (const entry of turn.archive.input.turn.data.entries) {
                    if (entry.content.retention !== "retained") continue;
                    step.state.history.push({
                      role: entry.role,
                      content:
                        entry.role === "assistant" && entry.delivery !== "sent"
                          ? `[Text delivery ${entry.delivery}; do not assume the user saw this] ${entry.content.text}`
                          : entry.content.text,
                      eventId: assignment.eventId,
                      // Never nest Rivet read proxies inside another state record.
                      context: JSON.parse(
                        JSON.stringify({
                          ...context,
                          reference: {
                            ...context.reference,
                            sourceIds: [
                              ...new Set([
                                ...context.reference.sourceIds,
                                ...turn.archive.input.turn.data.sourceIds,
                              ]),
                            ],
                            contextSourceIds: [
                              ...new Set([
                                ...(context.reference.contextSourceIds ?? []),
                                ...turn.archive.input.turn.data
                                  .contextSourceIds,
                              ]),
                            ],
                          },
                        }),
                      ),
                    });
                  }
                }
                await step.vars.persist();
                // Searchable recorded speech is not permission to rotate. Keep
                // uncertainty and its original assignment even after archival.
                if (
                  turn.inference === "unknown" ||
                  turn.deliveries.some(
                    (delivery) => delivery.result?.status === "unknown",
                  )
                ) {
                  turn.hold =
                    turn.inference === "unknown" ? "inference" : "delivery";
                  await step.vars.persist();
                  return;
                }
                await catalog.acknowledge(assignment, {
                  inference: turn.inference,
                  deliveries: turn.deliveries,
                  archivedThrough: turn.archivedThrough,
                });
                turn.acknowledged = true;
                delete turn.hold;
                step.state.acknowledgedThrough = assignment.sequence;
                await step.vars.persist();

                async function sendReply() {
                  if (
                    !turn?.context ||
                    !turn.reply ||
                    !current(assignment, turn.context)
                  )
                    return;
                  if (!turn.deliveries) {
                    const output = await catalog.apply(assignment, turn.reply);
                    if (!current(assignment, turn.context)) return;
                    const context = turn.context;
                    turn.deliveries = (output.messages ?? [output.text])
                      .filter((text) => text.trim())
                      .map((text) => ({
                        phase: "ready",
                        attempts: 0,
                        message: {
                          id: randomUUID(),
                          address: { ...context.replyAddress },
                          lastInboundAt: context.source.occurredAt,
                          content: { type: "text", text },
                        },
                      }));
                    await step.vars.persist();
                  }
                  for (const [index, delivery] of turn.deliveries.entries()) {
                    await deliver(
                      delivery,
                      step.vars.persist,
                      async (outbound) => {
                        if (
                          !turn?.context ||
                          (await catalog.assignmentStatus(assignment)) !==
                            "active" ||
                          step.abortSignal.aborted ||
                          !current(assignment, turn.context)
                        )
                          return {
                            status: "rejected",
                            code: "activity_invalidated",
                            retryable: false,
                          };
                        return deps.channel.send(outbound);
                      },
                    );
                    if (delivery.result?.status !== "sent") {
                      if (
                        delivery.result?.status === "unknown" ||
                        (delivery.result?.status === "rejected" &&
                          !delivery.result.retryable)
                      ) {
                        // Account for unsent parts without inventing transport
                        // attempts or upgrading the uncertain prefix to success.
                        for (const tail of turn.deliveries.slice(index + 1)) {
                          if (tail.phase !== "ready" || tail.attempts !== 0)
                            continue;
                          tail.result = {
                            status: "rejected",
                            code: "previous_part_not_sent",
                            retryable: false,
                          };
                          tail.outcomeObservedAt = Date.now();
                          tail.phase = "settled";
                        }
                        await step.vars.persist();
                      }
                      break;
                    }
                  }
                }
              },
            });
          } finally {
            release?.();
          }
        });
      },
      {
        onError: (c) => {
          if (!c.abortSignal.aborted) deps.lifecycle?.fail();
        },
      },
    ),
  });
}
