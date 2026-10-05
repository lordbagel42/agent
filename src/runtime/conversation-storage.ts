import { gunzipSync, gzipSync } from "node:zlib";
import type { ConversationState } from "./registry.js";
import type {
  DebugSnapshot,
  SessionCommandReceipt,
} from "./session-controls.js";

/** Lossless storage only, never a summary or a new disclosure scope. */
export interface CompressedJson {
  bytes: number;
  gzip: string;
}

function compress(value: unknown): CompressedJson {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes: bytes.length, gzip: gzipSync(bytes).toString("base64") };
}

function expand<T>(value: CompressedJson): T {
  const bytes = gunzipSync(Buffer.from(value.gzip, "base64"), {
    maxOutputLength: value.bytes,
  });
  if (bytes.length !== value.bytes)
    throw new Error("Compressed state size mismatch");
  return JSON.parse(bytes.toString()) as T;
}

export function readHistory(
  state: Pick<ConversationState, "history" | "historyArchive">,
) {
  return state.historyArchive
    ? [
        ...expand<ConversationState["history"]>(state.historyArchive),
        ...state.history,
      ]
    : state.history;
}

/** Mutators must edit the complete history, including its compact prefix. */
export function editHistory(
  state: Pick<ConversationState, "history" | "historyArchive">,
) {
  if (state.historyArchive) {
    // Do not reassign Rivet read proxies into state and nest proxy generations.
    state.history = JSON.parse(JSON.stringify(readHistory(state)));
    delete state.historyArchive;
  }
  return state.history;
}

export function commandSnapshot(
  receipt: SessionCommandReceipt,
): DebugSnapshot | undefined {
  return (
    receipt.snapshot ??
    (receipt.snapshotCompressed
      ? expand<DebugSnapshot>(receipt.snapshotCompressed)
      : undefined)
  );
}

/** Settled markers still fence replay and are not provider-settlement proof. */
export function readModelInvocations(state: {
  modelInvocations?: ConversationState["modelInvocations"];
  modelInvocationsArchive?: CompressedJson;
}) {
  return state.modelInvocationsArchive
    ? {
        ...expand<NonNullable<ConversationState["modelInvocations"]>>(
          state.modelInvocationsArchive,
        ),
        ...state.modelInvocations,
      }
    : state.modelInvocations;
}

/** Complete read projections. Archived records are not mutable actor state. */
export function readEvents<T>(state: {
  events: Record<string, T>;
  eventsArchive?: CompressedJson;
}): Record<string, T> {
  return state.eventsArchive
    ? { ...expand<Record<string, T>>(state.eventsArchive), ...state.events }
    : state.events;
}

export function readDeliveries<T>(state: {
  deliveries: Record<string, T>;
  deliveriesArchive?: CompressedJson;
}): Record<string, T> {
  return state.deliveriesArchive
    ? {
        ...expand<Record<string, T>>(state.deliveriesArchive),
        ...state.deliveries,
      }
    : state.deliveries;
}

export function eventRecord<T>(
  state: { events: Record<string, T>; eventsArchive?: CompressedJson },
  id: string,
): T | undefined {
  return state.events[id] ?? readEvents(state)[id];
}

export function deliveryRecord<T>(
  state: { deliveries: Record<string, T>; deliveriesArchive?: CompressedJson },
  id: string,
): T | undefined {
  return state.deliveries[id] ?? readDeliveries(state)[id];
}

/** Promote only for mutation. Read-only deduplication must not inflate state. */
export function editEvent<T>(
  state: { events: Record<string, T>; eventsArchive?: CompressedJson },
  id: string,
): T | undefined {
  const record = eventRecord(state, id);
  if (record && !state.events[id]) state.events[id] = record;
  return state.events[id];
}

export function editDelivery<T>(
  state: { deliveries: Record<string, T>; deliveriesArchive?: CompressedJson },
  id: string,
): T | undefined {
  const record = deliveryRecord(state, id);
  if (record && !state.deliveries[id]) state.deliveries[id] = record;
  return state.deliveries[id];
}

export function conversationSnapshot(
  state: ConversationState,
): ConversationState {
  const {
    eventsArchive: _events,
    deliveriesArchive: _deliveries,
    modelInvocationsArchive: _models,
    ...rest
  } = state;
  return {
    ...rest,
    events: readEvents(state),
    deliveries: readDeliveries(state),
    ...(readModelInvocations(state)
      ? { modelInvocations: readModelInvocations(state) }
      : {}),
  };
}

/** Run before persistence and synchronously before legacy workflow replay. */
export function compactConversation(state: ConversationState) {
  if (Buffer.byteLength(JSON.stringify(state.history)) > 64 * 1024) {
    state.historyArchive = compress(readHistory(state));
    state.history = [];
  }
  // These scalar replay markers have no retained mutable callback object.
  // Live overlays can demote archived settled markers to uncertain on replay.
  // Never discard a key or interpret "settled" as a natural-drain certificate.
  const settledModels = Object.fromEntries(
    Object.entries(readModelInvocations(state) ?? {}).filter(
      ([, marker]) => marker === "settled",
    ),
  );
  if (
    state.modelInvocationsArchive ||
    Buffer.byteLength(JSON.stringify(settledModels)) > 64 * 1024
  ) {
    state.modelInvocationsArchive = compress(settledModels);
    for (const id of Object.keys(settledModels))
      delete state.modelInvocations?.[id];
  }
  // Leave unfinished turns and their deliveries in place: asynchronous callbacks
  // can still own their objects. Storage classification is not drain evidence.
  const completed = Object.fromEntries(
    Object.entries(readEvents(state)).filter(([, record]) => record.done),
  );
  if (
    state.eventsArchive ||
    Buffer.byteLength(JSON.stringify(completed)) > 64 * 1024
  ) {
    state.eventsArchive = compress(completed);
    for (const id of Object.keys(completed)) delete state.events[id];
  }
  const completedIds = Object.keys(completed);
  const deliveries = Object.fromEntries(
    Object.entries(readDeliveries(state)).filter(
      ([id, delivery]) =>
        delivery.phase === "settled" &&
        delivery.result &&
        !(delivery.result.status === "rejected" && delivery.result.retryable) &&
        completedIds.some((eventId) => id.startsWith(`${eventId}:`)),
    ),
  );
  if (
    state.deliveriesArchive ||
    Buffer.byteLength(JSON.stringify(deliveries)) > 64 * 1024
  ) {
    state.deliveriesArchive = compress(deliveries);
    for (const id of Object.keys(deliveries)) delete state.deliveries[id];
  }
  for (const receipt of Object.values(state.sessionCommands ?? {})) {
    if (receipt.snapshot) {
      receipt.snapshotId = receipt.snapshot.id;
      if (
        !receipt.published &&
        Buffer.byteLength(JSON.stringify(receipt.snapshot)) > 64 * 1024
      ) {
        receipt.snapshotCompressed = compress(receipt.snapshot);
        delete receipt.snapshot;
      }
    }
    // Publication ACK follows the destination's durable full-snapshot save.
    // Retain identity and delivery state; never retire an unpublished body.
    if (receipt.published && receipt.snapshotId) {
      delete receipt.snapshot;
      delete receipt.snapshotCompressed;
    }
  }
}
