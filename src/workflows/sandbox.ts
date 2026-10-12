import { Script } from "node:vm";
import { Schema } from "effect";
import {
  decodeStrict,
  discriminated,
  Int,
  isPattern,
  ZodJson,
} from "../effect/schema.js";
import type { Json } from "../tools/broker.js";
import { runSandboxWorker } from "../tools/sandbox-worker.js";

export type { Json };
export const workflowName = Schema.String.check(
  isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/),
);
const toolCallFields = {
  name: workflowName,
  tool: workflowName,
  args: ZodJson,
};
const toolCall = Schema.Struct(toolCallFields);
const delay = Int({ minimum: 0, maximum: 30 * 86400_000 });
export const operationSchema = discriminated("kind", [
  Schema.Struct({ ...toolCallFields, kind: Schema.Literal("step") }),
  Schema.Struct({
    kind: Schema.Literal("sleep"),
    name: workflowName,
    ms: delay,
  }),
  Schema.Struct({
    kind: Schema.Literal("wait"),
    name: workflowName,
    timeout: Schema.NullOr(delay),
  }),
  Schema.Struct({
    kind: Schema.Literal("parallel"),
    name: workflowName,
    calls: Schema.Array(toolCall).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8),
    ),
  }),
]);
export type WorkflowOperation = typeof operationSchema.Type;
export const decodeOperation = decodeStrict(operationSchema);

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
    async (operation) => jsonValue(await dispatch(decodeOperation(operation))),
  );
}
