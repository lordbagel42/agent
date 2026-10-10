import { Script } from "node:vm";
import { z } from "zod";
import type { Json } from "../tools/broker.js";
import { runSandboxWorker } from "../tools/sandbox-worker.js";

export type { Json };
export const workflowName = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
const toolCall = z.strictObject({
  name: workflowName,
  tool: workflowName,
  args: z.json(),
});
export const operationSchema = z.discriminatedUnion("kind", [
  toolCall.extend({ kind: z.literal("step") }),
  z.strictObject({
    kind: z.literal("sleep"),
    name: workflowName,
    ms: z
      .number()
      .int()
      .min(0)
      .max(30 * 86400_000),
  }),
  z.strictObject({
    kind: z.literal("wait"),
    name: workflowName,
    timeout: z
      .number()
      .int()
      .min(0)
      .max(30 * 86400_000)
      .nullable(),
  }),
  z.strictObject({
    kind: z.literal("parallel"),
    name: workflowName,
    calls: z.array(toolCall).min(1).max(8),
  }),
]);
export type WorkflowOperation = z.infer<typeof operationSchema>;

export function jsonValue(value: unknown): Json {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > 16_384)
    throw new Error("workflow_json_limit");
  return JSON.parse(encoded) as Json;
}

export function validateSource(source: string) {
  if (!source.trim() || Buffer.byteLength(source) > 24_000)
    throw new Error("workflow_source_limit");
  // Syntax checking only. Authored code is NEVER executed by Node's vm.
  new Script(`(async function(workflow, input) {\n${source}\n})`);
}

export async function runWorkflowSource(
  source: string,
  input: Json,
  createdAt: number,
  dispatch: (operation: WorkflowOperation) => Promise<Json>,
  signal: AbortSignal,
): Promise<Json> {
  validateSource(source);
  return runSandboxWorker<Json>(
    "workflow",
    { source, input: jsonValue(input), createdAt },
    signal,
    async (operation) =>
      jsonValue(await dispatch(operationSchema.parse(operation))),
  );
}
