import { z } from "zod";

export const researchCommandSchema = z
  .strictObject({
    action: z.enum(["start", "list", "inspect", "pause", "resume", "stop"]),
    id: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    goal: z.string().trim().min(1).max(3000).nullable(),
    connections: z
      .array(z.string().min(1).max(256))
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length),
    intervalMinutes: z.number().int().min(1).max(1440).nullable(),
    dailyBatches: z.number().int().min(1).max(200).nullable(),
    offset: z.number().int().min(0).max(1_000_000),
  })
  .refine((command) => {
    if (command.action === "start")
      return command.id === null && command.goal !== null;
    return (
      (command.action === "list") === (command.id === null) &&
      command.goal === null &&
      command.connections.length === 0 &&
      command.intervalMinutes === null &&
      command.dailyBatches === null
    );
  });

export type ResearchCommand = z.infer<typeof researchCommandSchema>;

export const RESEARCH_HELP =
  "Ongoing public research is available in admitted channels and DMs when configured; June judges task safety and what can be shared with the current audience at runtime, rather than requiring an owner-private conversation. Use research:{action:'start',id:null,goal:'bounded public research goal',connections:[],intervalMinutes:null,dailyBatches:null,offset:0} only for explicit intent for ongoing research, not an ordinary one-off question. Goal is trimmed, 1–3000 characters. Select at most eight distinct exact configured read MCP connection IDs permitted for this task, each 1–256 characters; an empty selection grants no MCP access. Public web research and these selected reads only: no private account crawling, outreach, messages, writes, approval-required tools or new permissions. Null intervalMinutes defaults to five minutes (otherwise integer 1–1440); null dailyBatches defaults to 48 per day (otherwise integer 1–200). To discover sessions use action:'list',id:null; use action:'inspect' with an exact returned 64-character lowercase hex id for status/results, or pause, resume, stop to manage that same session. Listing, inspection and control are bound to the original authenticated sender, conversation/thread and audience, not all of the owner's sessions; histories and evidence are not combined across scopes. Every non-start command must set goal:null,connections:[],intervalMinutes:null,dailyBatches:null; it cannot change scope, connections or limits. All commands require offset, an integer 0–1000000; begin at 0 and use the returned nextOffset for further list/inspect pages. There is no name field. Leave text empty and all other actions unset. Only a host receipt proves admission or a state change; a queued session is not verified progress or a delivered notification. Inspect the existing session in its original scope rather than creating a replacement or another schedule. Pause/stop prevent future batches, not already-dispatched effects; resume is not authority to repeat an uncertain call. Unknown outcomes require review, never automatic replay.";
