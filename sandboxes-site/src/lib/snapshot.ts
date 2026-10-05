import { z } from "zod";

const date = z.iso.datetime({ offset: true });
const worker = z.string().regex(/^[a-f0-9]{32}$/);
export const snapshotSchema = z.object({
  version: z.literal(1),
  observedAt: date,
  revision: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  status: z.enum(["enabled", "disabled", "unavailable"]),
  provider: z.literal("boxlite"),
  limits: z.object({
    active: z.number().int().positive(),
    retained: z.number().int().positive(),
    commandSeconds: z.number().int().positive(),
    outputBytes: z.number().int().positive(),
  }),
  boxes: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        worker,
        state: z.string().max(40),
        running: z.boolean(),
        image: z.string().max(256),
        cpus: z.number().nonnegative(),
        memoryMib: z.number().nonnegative(),
        createdAt: date,
        startedAt: date.nullable(),
        outbound: z.enum(["enabled", "disabled", "unknown"]),
      }),
    )
    .max(128),
  leases: z
    .array(
      z.object({
        worker,
        state: z.enum(["active", "executing", "stopping", "needs_review"]),
      }),
    )
    .max(128),
  activity: z
    .array(
      z.object({
        sequence: z.number().int(),
        at: date,
        worker,
        kind: z.enum([
          "opening",
          "command_completed",
          "command_failed",
          "stopped",
          "cleanup_unknown",
          "destroyed",
        ]),
        exitCode: z.number().int().optional(),
        code: z.string().max(80).optional(),
      }),
    )
    .max(200),
  activitySince: date,
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Activity = Snapshot["activity"][number];
export const activityLabel: Record<Activity["kind"], string> = {
  opening: "Opening environment",
  command_completed: "Command completed",
  command_failed: "Command failed",
  stopped: "Compute stopped",
  cleanup_unknown: "Cleanup needs review",
  destroyed: "Sandbox removed",
};
export function timestamp(value: string | null) {
  return value
    ? `${new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(value))} UTC`
    : "Not recorded";
}
