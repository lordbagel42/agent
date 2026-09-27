import { Script } from "node:vm";
import {
  getQuickJS,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten";
import { z } from "zod";
import type { Json } from "../tools/broker.js";

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

/** Each replay gets a fresh VM. Only the trusted host touches the Rivet context.
 * Native scheduler exceptions must never round-trip through guest JSON/errors. */
export async function runWorkflowSource(
  source: string,
  input: Json,
  createdAt: number,
  dispatch: (operation: WorkflowOperation) => Promise<Json>,
  signal: AbortSignal,
): Promise<Json> {
  validateSource(source);
  signal.throwIfAborted();
  const runtime = (await getQuickJS()).newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const vm = runtime.newContext();
  let budget = 2000;
  let deadline = 0;
  let failed = false;
  let failure: unknown;
  let active: Promise<void> | undefined;
  let deferred: QuickJSDeferredPromise | undefined;
  let result: QuickJSHandle | undefined;
  let calls = 0;
  let notify = Promise.withResolvers<void>();
  let closed = false;
  const fail = (error: unknown) => {
    if (!failed) {
      failed = true;
      failure = error;
    }
    notify.resolve();
  };
  const abort = () => fail(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  runtime.setInterruptHandler(() => failed || Date.now() > deadline);
  const execute = <T>(fn: () => T) => {
    const start = Date.now();
    deadline = start + budget;
    try {
      return fn();
    } finally {
      budget -= Date.now() - start;
    }
  };
  const bridge = vm.newFunction("call", (handle) => {
    if (failed) return vm.undefined;
    if (active || ++calls > 256) {
      fail(
        new Error(
          active
            ? "workflow_concurrent_operations_use_parallel"
            : "workflow_operation_limit",
        ),
      );
      return vm.undefined;
    }
    try {
      const raw = vm.getString(handle);
      if (Buffer.byteLength(raw) > 16_384)
        throw new Error("workflow_json_limit");
      const operation = operationSchema.parse(JSON.parse(raw));
      deferred = vm.newPromise();
      const pending = deferred;
      // Dispatch after leaving the guest stack; all guest execution stays in
      // execute() so CPU time excludes host I/O and durable waiting.
      active = Promise.resolve()
        .then(() => dispatch(operation))
        .then((value) => {
          if (!closed && !failed) {
            const encoded = vm.newString(JSON.stringify(jsonValue(value)));
            try {
              pending.resolve(encoded);
            } finally {
              encoded.dispose();
            }
          }
        }, fail)
        .catch(fail)
        .finally(() => {
          active = undefined;
          notify.resolve();
        });
      return pending.handle;
    } catch (error) {
      fail(error);
      return vm.undefined;
    }
  });
  vm.setProp(vm.global, "__call", bridge);
  bridge.dispose();
  try {
    result = execute(() =>
      vm.unwrapResult(
        vm.evalCode(
          `(async () => {
        const bridge = __call;
        delete globalThis.__call;
        const call = async operation => JSON.parse(await bridge(JSON.stringify(operation)));
        const NativeDate = Date;
        globalThis.Date = function(...args) {
          if (!new.target) return new NativeDate(${createdAt}).toString();
          return new NativeDate(...(args.length ? args : [${createdAt}]));
        };
        Date.prototype = NativeDate.prototype;
        Date.prototype.constructor = Date;
        Date.now = () => ${createdAt};
        Date.parse = NativeDate.parse;
        Date.UTC = NativeDate.UTC;
        Math.random = () => { throw new Error("Use a journaled random tool step"); };
        const workflow = Object.freeze({
          step: (name, tool, args = null) => call({kind:"step", name, tool, args}),
          sleep: (name, ms) => call({kind:"sleep", name, ms}),
          wait: (name, timeout = null) => call({kind:"wait", name, timeout}),
          parallel: (name, calls) => call({kind:"parallel", name, calls})
        });
        const authored = (0,eval)(${JSON.stringify(`(async function(workflow, input) { "use strict";\n${source}\n})`)});
        return JSON.stringify((await authored(workflow, JSON.parse(${JSON.stringify(JSON.stringify(jsonValue(input)))}))) ?? null);
      })()`,
          "workflow.js",
        ),
      ),
    );
    for (;;) {
      if (failed) throw failure;
      execute(() => vm.unwrapResult(runtime.executePendingJobs()));
      if (failed) throw failure;
      const state = vm.getPromiseState(result);
      if (state.type === "fulfilled") {
        try {
          if (active) throw new Error("workflow_unawaited_operation");
          const encoded = vm.getString(state.value);
          if (Buffer.byteLength(encoded) > 16_384)
            throw new Error("workflow_json_limit");
          return jsonValue(JSON.parse(encoded));
        } finally {
          state.value.dispose();
        }
      }
      if (state.type === "rejected") {
        try {
          throw new Error("workflow_guest_failed");
        } finally {
          state.error.dispose();
        }
      }
      if (!active) throw new Error("workflow_unsettled_promise");
      await notify.promise;
      notify = Promise.withResolvers<void>();
      deferred?.dispose();
      deferred = undefined;
    }
  } catch (error) {
    throw failed ? failure : error;
  } finally {
    closed = true;
    signal.removeEventListener("abort", abort);
    await active;
    deferred?.dispose();
    result?.dispose();
    vm.dispose();
    runtime.dispose();
  }
}
