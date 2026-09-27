import { z } from "zod";
import type { ChannelEvent, Owner } from "./contracts.js";

export const RAYGEN_SLACK_ID = "U08R4KDL6UF";

export function isOwner(event: ChannelEvent, owner: Owner): boolean {
  const sender =
    event.type === "receipt" ? event.address.conversationId : event.senderId;
  return owner.identities.some(
    (identity) =>
      identity.channel === event.address.channel &&
      identity.accountId === event.address.accountId &&
      identity.senderId === sender,
  );
}

export const socialActionSchema = z.union([
  z.strictObject({
    kind: z.literal("post"),
    conversationId: z.string().regex(/^[CDGUW][A-Z0-9]+$/),
    threadId: z
      .string()
      .regex(/^\d+\.\d+$/)
      .nullable(),
    text: z.string().trim().min(1).max(3000),
  }),
  z.strictObject({
    kind: z.literal("request_access"),
    userId: z.string().regex(/^[UW][A-Z0-9]+$/),
    conversationId: z.string().regex(/^[CDG][A-Z0-9]+$/),
    topic: z.string().trim().min(1).max(300),
    sharedContext: z.string().max(3000),
    tools: z.array(z.enum(["webSearch", "deep"])).max(2),
    via: z.enum(["dm", "thread"]),
  }),
  z.strictObject({
    kind: z.literal("outreach"),
    userId: z.string().regex(/^[UW][A-Z0-9]+$/),
    text: z.string().trim().min(1).max(3000),
  }),
  z.strictObject({
    kind: z.literal("interruption_proposal"),
    candidateId: z.string().regex(/^[a-f0-9]{64}$/),
    userId: z.string().regex(/^[UW][A-Z0-9]+$/),
    text: z.string().trim().min(1).max(3000),
  }),
]);

export type SocialAction = z.infer<typeof socialActionSchema>;
