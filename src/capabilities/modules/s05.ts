import { taskInspectionCommandSchema } from "../../tasks/contracts.js";
import { TASK_VIEW_HELP, TASK_VIEW_KNOWLEDGE } from "../../tasks/knowledge.js";
import {
  type CapabilityDefinition,
  capabilityModuleConfigSchema,
  defineCapability,
} from "../contracts.js";

export const configSchema = capabilityModuleConfigSchema;
export const definitions: readonly CapabilityDefinition[] = [
  defineCapability({
    id: "s05.task-inspection",
    commandSchema: taskInspectionCommandSchema,
    effect: "metadata",
    allowedTurns: ["execution"],
    requiredPorts: ["tasks"],
    knowledge: TASK_VIEW_KNOWLEDGE,
    help: TASK_VIEW_HELP,
    availability: () => ({ status: "available" }),
    create: ({ tasks }) => ({
      execute: async (command, context) =>
        JSON.stringify(
          (await tasks.inspect(context, command.id)) ?? {
            status: "unavailable",
            reason:
              "No current task metadata is available in this authenticated source. Missing, expired, evicted, post-restart, inactive, denied, revoked and deleted evidence are not distinguished. Do not wake a workflow, broaden access or start another run.",
          },
        ),
    }),
  }),
];
