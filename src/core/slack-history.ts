import { z } from "zod";

export const slackHistorySchema = z.strictObject({
  target: z.string().trim().min(1).max(256),
  threadTs: z
    .string()
    .regex(/^\d+\.\d{6}$/)
    .nullable(),
  cursor: z.string().max(2000).nullable(),
});

export type SlackHistoryRequest = z.infer<typeof slackHistorySchema>;

/** Host-generated transcripts must not reenter model context via Slack history. */
export const PRIVATE_SLACK_HISTORY_PREFIX =
  "June private Slack history — owner only\n";
