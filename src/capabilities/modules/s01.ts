import { z } from "zod";
import { CAPABILITY_READINESS_HELP } from "../../operations/knowledge.js";
import {
  type CapabilityDefinition,
  capabilityModuleConfigSchema,
  defineCapability,
} from "../contracts.js";

export const configSchema = capabilityModuleConfigSchema;
export const definitions: readonly CapabilityDefinition[] = [
  defineCapability({
    id: "s01.capability-inspection",
    commandSchema: z.strictObject({ action: z.literal("inspect") }),
    effect: "metadata",
    allowedTurns: ["execution"],
    requiredPorts: ["inspection"],
    knowledge:
      "Inspect selected capability metadata without probing, enrolling, enabling or repairing anything. Unknown is not ready or failed; a ready local inspection route is not live provider evidence.",
    help: CAPABILITY_READINESS_HELP,
    availability: () => ({ status: "available" }),
    create: ({ inspection }) => ({
      execute: (_command, context) =>
        inspection.capabilityMatrix(context.event, context.signal),
    }),
  }),
];
