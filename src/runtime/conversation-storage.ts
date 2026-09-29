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

/** Run before persistence and synchronously before legacy workflow replay. */
export function compactConversation(state: ConversationState) {
  if (Buffer.byteLength(JSON.stringify(state.history)) > 64 * 1024) {
    state.historyArchive = compress(readHistory(state));
    state.history = [];
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
