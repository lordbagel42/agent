import { z } from "zod";
import type { MessageEvent, Owner } from "./contracts.js";
import { isOwner } from "./social.js";

export const rivetTargets = [
  "actors",
  "actor",
  "runners",
  "state",
  "summary",
  "connections",
  "rpcs",
  "queue",
  "workflow-history",
  "database-schema",
  "database-rows",
  "logs",
] as const;

export const rivetActorNames = [
  "conversation",
  "personality",
  "job",
  "reflection",
  "execution",
  "wakeups",
  "workflowRun",
  "workflowLibrary",
] as const;

export const rivetRequestSchema = z.strictObject({
  target: z.enum(rivetTargets),
  actorId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,128}$/)
    .nullable(),
  name: z.enum(rivetActorNames).nullable(),
  table: z.string().min(1).max(128).nullable(),
  cursor: z.string().max(2048).nullable(),
  pointer: z
    .string()
    .max(1024)
    .refine((v) => v === "" || v.startsWith("/")),
  offset: z.number().int().min(0).max(1_000_000),
  page: z.number().int().min(0).max(1000),
  format: z.enum(["answer", "raw"]),
});

export type RivetRequest = z.infer<typeof rivetRequestSchema>;

/** No inferred DM authority: verified ingress must identify a one-to-one IM. */
export function isOwnerRivetDm(event: MessageEvent, owner: Owner): boolean {
  return (
    isOwner(event, owner) &&
    event.address.channel === "slack" &&
    event.direct &&
    event.metadata?.channelType === "im"
  );
}

// This prefix also prevents Slack context fetches from reimporting volatile
// inspection answers after an uncertain send (when no message ID was recorded).
export const RIVET_REPLY_PREFIX = "[Private Rivet inspection — not retained]";
