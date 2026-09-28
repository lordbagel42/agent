import type { MessageEvent } from "../core/contracts.js";
import { slackSourceId } from "../imports/identity.js";
import type { Source } from "../memory/store.js";
import type { Delivery } from "../runtime/delivery.js";
import type { MemoryReference } from "../runtime/registry.js";
import {
  type SessionArchiveInput,
  sessionArchiveInputSchema,
} from "./archive.js";

/** Read-only trusted-host evidence view at the caller's deletion revision.
 * Context checks must prove existence, audience access and transitive deletion
 * validity (including unretained original context). !isDeleted(id) alone is NOT
 * sufficient. Missing historical evidence must return false, not be inferred.
 */
export interface ArchiveEvidence {
  source(audience: string, id: string): Source | undefined;
  isDeleted(id: string): boolean;
  contextAvailable(audience: string, id: string): boolean;
}

export interface SessionArchiveTurnInput {
  sessionId: string;
  audience: string;
  openedAt: number;
  eventId: string;
  sequence: number;
  /** Persisted first host receipt time, not projection or platform time. */
  receivedAt: number;
  /** Actual authenticated inbound only. Notifications have no inbound. */
  inbound?: { event: MessageEvent; sourceId?: string };
  /** Actual receipts in dispatch order, with the provenance of each output. */
  deliveries: readonly { delivery: Delivery; reference?: MemoryReference }[];
  /** Explicit host classification: sensitive/control/forget-preview turns. */
  retentionExcluded: boolean;
}

/** Pure projection, never settlement or a write. The caller must still use
 * archiveSessionTurn(result, capturedDeletionRevision) and handle its fence.
 * No tool results, model transcripts or notification-as-human fallbacks enter.
 */
export function produceSessionArchiveTurn(
  input: SessionArchiveTurnInput,
  evidence: ArchiveEvidence,
): SessionArchiveInput {
  const data: SessionArchiveInput["turn"]["data"] = {
    sourceIds: [],
    contextSourceIds: [],
    entries: [],
  };
  const entrySchema =
    sessionArchiveInputSchema.shape.turn.shape.data.shape.entries.element;
  const append = (entry: unknown): boolean => {
    const parsed = entrySchema.safeParse(entry);
    if (!parsed.success) {
      data.incomplete = true;
      return false;
    }
    data.entries.push(parsed.data);
    return true;
  };
  const source = (id: string) => {
    if (evidence.isDeleted(id)) return undefined;
    const value = evidence.source(input.audience, id);
    return value?.id === id &&
      value.audiences.includes(input.audience) &&
      !(value.platform === "slack" && value.text.startsWith("##"))
      ? value
      : undefined;
  };
  const addRefs = (ids: readonly string[], target: string[]) => {
    for (const id of ids) if (!target.includes(id)) target.push(id);
  };
  const omitted = (
    reason: "retention_excluded" | "unavailable" | "no_message",
  ) => ({ retention: "omitted", reason }) as const;

  if (input.inbound) {
    const { event, sourceId } = input.inbound;
    const original =
      !input.retentionExcluded && sourceId ? source(sourceId) : undefined;
    let originalId = sourceId;
    let observedAt = event.occurredAt;
    if (event.address.channel === "slack") {
      try {
        originalId = slackSourceId(
          event.address.accountId,
          event.address.conversationId,
          event.messageId,
        );
        // Same canonical message time as slackSource, not envelope event_time.
        observedAt = Number(BigInt(event.messageId.replace(".", "")) / 1000n);
      } catch {
        originalId = undefined;
        observedAt = Number.NaN;
      }
    }
    // Slack originals use channel/thread (or channel/message for root posts).
    // Other original sources may use the exact opaque conversation ID.
    const conversation =
      event.address.channel === "slack"
        ? `${event.address.conversationId}/${event.address.threadId ?? event.messageId}`
        : event.address.conversationId;
    const retained =
      !!original &&
      original.id === originalId &&
      original.text === event.text &&
      original.author === event.senderId &&
      original.platform === event.address.channel &&
      original.account === event.address.accountId &&
      original.conversation === conversation &&
      original.observedAt === observedAt;
    if (!retained && !input.retentionExcluded) data.incomplete = true;
    const added = append({
      role: "user",
      address: event.address,
      author: event.senderId,
      messageId: event.messageId,
      observedAt,
      ...(retained ? { sourceId } : {}),
      content: retained
        ? { retention: "retained", text: event.text }
        : omitted(
            input.retentionExcluded ? "retention_excluded" : "unavailable",
          ),
    });
    if (added && retained && sourceId) addRefs([sourceId], data.sourceIds);
  }

  for (const { delivery, reference } of input.deliveries) {
    // Volatile context references propagate through interactions and workers,
    // but cannot prove complete archive deletion ancestry. Keep receipts, not text.
    const excluded =
      input.retentionExcluded ||
      delivery.ephemeral === true ||
      reference?.contextSourceIds?.some((id) =>
        id.startsWith("volatile-context:"),
      );
    const text = delivery.message.content.type === "text";
    const valid =
      !excluded &&
      text &&
      reference?.deletionTracked === true &&
      // Missing context lists on old references do not prove completeness.
      Array.isArray(reference.contextSourceIds) &&
      Array.isArray(reference.sourceIds) &&
      reference.sourceIds.every((id) => !!source(id)) &&
      reference.contextSourceIds.every(
        (id) =>
          !evidence.isDeleted(id) &&
          evidence.contextAvailable(input.audience, id),
      );
    if (!excluded && text && !valid) data.incomplete = true;
    // Never use lastInboundAt/receivedAt as an invented outcome observation.
    // An in-flight intent may still carry an earlier retry's rejected result.
    if (
      delivery.phase === "sending" ||
      (delivery.result?.status === "sent" && !delivery.result.messageId)
    ) {
      data.incomplete = true;
      continue;
    }
    const status =
      delivery.result?.status ??
      (delivery.phase === "ready" && delivery.attempts === 0
        ? "not_sent"
        : "unknown");
    const added = append({
      role: "assistant",
      address: delivery.message.address,
      observedAt: delivery.outcomeObservedAt,
      delivery: status,
      ...(delivery.result?.status === "sent"
        ? { messageId: delivery.result.messageId }
        : {}),
      content:
        valid && delivery.message.content.type === "text"
          ? { retention: "retained", text: delivery.message.content.text }
          : omitted(
              excluded
                ? "retention_excluded"
                : text
                  ? "unavailable"
                  : "no_message",
            ),
    });
    if (added && valid && reference) {
      addRefs(reference.sourceIds, data.sourceIds);
      addRefs(reference.contextSourceIds ?? [], data.contextSourceIds);
    }
  }
  return sessionArchiveInputSchema.parse({
    sessionId: input.sessionId,
    audience: input.audience,
    openedAt: input.openedAt,
    turn: {
      eventId: input.eventId,
      sequence: input.sequence,
      receivedAt: input.receivedAt,
      data,
    },
  });
}
