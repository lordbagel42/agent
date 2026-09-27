import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.string().min(1).max(2048);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().nonnegative().safe();
const refs = z
  .array(id)
  .max(1000)
  .refine((value) => new Set(value).size === value.length);
const address = z.strictObject({
  channel: z.enum(["slack", "whatsapp"]),
  accountId: id,
  conversationId: id,
  threadId: id.optional(),
});
const content = z.discriminatedUnion("retention", [
  z.strictObject({
    retention: z.literal("retained"),
    text: z.string().max(1_000_000),
  }),
  z.strictObject({
    retention: z.literal("omitted"),
    reason: z.enum(["retention_excluded", "unavailable", "no_message"]),
  }),
]);
const entry = z.discriminatedUnion("role", [
  z.strictObject({
    role: z.literal("user"),
    address,
    author: id,
    messageId: id,
    observedAt: timestamp,
    sourceId: id.optional(),
    content,
  }),
  z.strictObject({
    role: z.literal("assistant"),
    address,
    observedAt: timestamp,
    messageId: id.optional(),
    delivery: z.enum(["sent", "rejected", "unknown", "not_sent"]),
    content,
  }),
]);

const data = z.strictObject({
  sourceIds: refs,
  // Full host-supplied deletion provenance, never independent corroboration.
  contextSourceIds: refs,
  entries: z.array(entry).max(50),
});
const receipt = {
  eventId: hash,
  sequence: z.number().int().positive().safe(),
  receivedAt: timestamp,
};
export const sessionArchiveInputSchema = z.strictObject({
  sessionId: hash,
  audience: id,
  openedAt: timestamp,
  turn: z.strictObject({ ...receipt, data }),
});
export const sessionArchiveSchema = z.strictObject({
  id: hash,
  audience: id,
  openedAt: timestamp,
  turns: z.array(
    z.strictObject({
      id: z.string().regex(/^session-turn:[a-f0-9]{64}$/),
      ...receipt,
      // Forgetting removes data, not the immutable archival acknowledgment.
      data: data.optional(),
    }),
  ),
});
export type SessionArchiveInput = z.infer<typeof sessionArchiveInputSchema>;
export type SessionArchive = z.infer<typeof sessionArchiveSchema>;
export type ArchivedTurn = SessionArchive["turns"][number];

export function sessionTurnId(sessionId: string, eventId: string): string {
  return `session-turn:${createHash("sha256")
    .update(JSON.stringify([sessionId, eventId]))
    .digest("hex")}`;
}

export function archiveDependencies(turn: ArchivedTurn): string[] {
  return turn.data
    ? [
        ...turn.data.sourceIds,
        ...turn.data.contextSourceIds,
        ...turn.data.entries.flatMap((item) =>
          item.role === "user" && item.sourceId ? [item.sourceId] : [],
        ),
      ]
    : [];
}

export type SessionArchivePage = {
  session: { id: string; openedAt: number; archivedThrough: number } | null;
  turns: ArchivedTurn[];
  omitted: number;
  nextAfter?: number;
};
export type SessionArchiveSearch = {
  sessions: {
    id: string;
    openedAt: number;
    lastReceivedAt: number;
    matchingTurns: number;
  }[];
  omitted: number;
};
