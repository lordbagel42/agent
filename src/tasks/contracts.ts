import { z } from "zod";

/** A reference selects a run, never its requester, audience or read authority. */
export const workflowTaskIdSchema = z.string().regex(/^workflow:[a-f0-9]{64}$/);

export const taskInspectionCommandSchema = z.strictObject({
  action: z.literal("inspect"),
  id: workflowTaskIdSchema,
});
