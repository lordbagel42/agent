import { createHash } from "node:crypto";
import { actor, queue, type Registry } from "rivetkit";
import { Loop, workflow } from "rivetkit/workflow";
import { z } from "zod";
import type { MessageEvent } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import type { Dependencies } from "../runtime/registry.js";
import { WORKFLOW_HELP, workflowCommandSchema } from "./contracts.js";
import {
  type Json,
  jsonValue,
  runWorkflowSource,
  validateSource,
  type WorkflowOperation,
} from "./sandbox.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface Definition {
  name: string;
  source: string;
  revision: string;
  deletionRevision: number;
}
interface RunSpec extends Definition {
  id: string;
  input: Json;
  createdAt: number;
  origin: MessageEvent;
  tools: string[];
  abi: 1;
}
type Status =
  | "empty"
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "needs_review"
  | "cancelled"
  | "revoked";
interface Receipt {
  signature: string;
  status: "started" | "completed" | "unknown";
  value?: Json;
}
interface RunState {
  spec: RunSpec | null;
  status: Status;
  started: boolean;
  operations: Record<string, Receipt>;
  signals: string[];
  consumed: Record<string, { wait: string; value: Json }>;
  result?: Json;
  error?: string;
}
interface Binding {
  state: () => RunState;
  persist: () => Promise<void>;
  complete: (
    id: string | number | bigint,
    name: "start" | "signals" | "cancel",
  ) => Promise<void>;
  controller?: AbortController;
}
const terminal = (status: Status) =>
  ["completed", "failed", "needs_review", "cancelled", "revoked"].includes(
    status,
  );
const revision = (deps: Dependencies) =>
  deps.memory?.store.deletionRevision() ?? 0;
const authorized = (deps: Dependencies, origin: MessageEvent) =>
  routeEvent(origin, deps.owner)?.private === true;
const current = (deps: Dependencies, spec: RunSpec) =>
  !!deps.workflows &&
  authorized(deps, spec.origin) &&
  spec.deletionRevision === revision(deps);

export function createWorkflowRunActor(deps: Dependencies) {
  // Ephemeral steps also replay cached outputs. Keep non-serializable live
  // bindings per actor incarnation, while registering the native workflow
  // handler directly so Rivet's workflow inspector remains available.
  const bindings = new Map<string, Binding>();
  return actor({
    state: {
      spec: null,
      status: "empty",
      started: false,
      operations: {},
      signals: [],
      consumed: {},
    } as RunState,
    createVars: (c): Binding => {
      const binding: Binding = {
        state: () => c.state,
        persist: () => c.saveState({ immediate: true }),
        complete: (id, name) => c.queue.complete({ id: BigInt(id), name }),
      };
      bindings.set(JSON.stringify(c.key), binding);
      return binding;
    },
    onSleep: (c) => {
      bindings.delete(JSON.stringify(c.key));
    },
    onDestroy: (c) => {
      bindings.delete(JSON.stringify(c.key));
    },
    queues: {
      start: queue<null>(),
      signals: queue<{ id: string; value: Json }>(),
      cancel: queue<null>(),
    },
    actions: {
      submit: async (c, spec: RunSpec) => {
        if (
          c.key[0] !== deps.owner.id ||
          c.key[1] !== spec.id ||
          !current(deps, spec) ||
          spec.abi !== 1 ||
          spec.revision !== hash(spec.source)
        )
          throw new Error("workflow_denied");
        validateSource(spec.source);
        jsonValue(spec.input);
        if (!c.state.spec) {
          c.state.spec = spec;
          c.state.status = "queued";
        } else if (hash(c.state.spec) !== hash(spec))
          throw new Error("workflow_run_conflict");
        await c.vars.persist();
        if (!c.state.started && !terminal(c.state.status))
          await c.queue.send("start", null);
      },
      presentation: (c) => {
        const spec = c.state.spec;
        if (!spec || !current(deps, spec) || c.state.status === "revoked")
          return null;
        return {
          runId: spec.id,
          name: spec.name,
          revision: spec.revision,
          status: c.state.status,
          operations: Object.entries(c.state.operations).map(
            ([name, receipt]) => ({ name, status: receipt.status }),
          ),
        };
      },
      inspect: (c) => {
        const spec = c.state.spec;
        if (!spec || !current(deps, spec) || c.state.status === "revoked")
          return { status: "revoked" as Status };
        return {
          runId: spec.id,
          name: spec.name,
          revision: spec.revision,
          status: c.state.status,
          input: spec.input,
          source: spec.source,
          operations: c.state.operations,
          result: c.state.result,
          error: c.state.error,
        };
      },
      signal: async (c, id: string, value: Json) => {
        if (
          !c.state.spec ||
          !current(deps, c.state.spec) ||
          terminal(c.state.status)
        )
          throw new Error("workflow_not_active");
        if (c.state.signals.includes(id)) return;
        if (c.state.signals.length >= 256)
          throw new Error("workflow_signal_limit");
        jsonValue(value);
        // A replay can repair a send/save gap. The journaled receiver deduplicates
        // this stable ID, including duplicates already removed from the queue.
        await c.queue.send("signals", { id, value });
        c.state.signals.push(id);
        await c.vars.persist();
      },
      cancel: async (c, revoke = false) => {
        if (revoke) {
          c.state.status = "revoked";
          if (c.state.spec) {
            c.state.spec.source = "";
            c.state.spec.input = null;
            c.state.spec.origin.text = "";
          }
          c.state.operations = {};
          c.state.consumed = {};
          delete c.state.result;
        } else if (!terminal(c.state.status)) c.state.status = "cancelled";
        await c.vars.persist();
        c.vars.controller?.abort();
        await c.queue.send("cancel", null);
      },
    },
    run: workflow(
      async (ctx) => {
        const binding = bindings.get(JSON.stringify(ctx.key));
        if (!binding) throw new Error("workflow_binding_unavailable");
        const start = await ctx.queue.next("start", {
          names: ["start"],
          completable: true,
        });
        await ctx.step("accept-start", async () => {
          binding.state().started = true;
          await binding.persist();
          await binding.complete(start.id, start.name);
        });
        await start.complete();
        const state = binding.state();
        const spec = state.spec;
        if (!spec || terminal(state.status)) return;
        if (!current(deps, spec)) {
          state.status = "revoked";
          await binding.persist();
          return;
        }
        const controller = new AbortController();
        binding.controller = controller;
        const signal = AbortSignal.any([
          controller.signal,
          ctx.abortSignal,
          AbortSignal.timeout(120_000),
        ]);
        let nativeFailure = false;
        const native = async <T>(promise: Promise<T>): Promise<T> => {
          try {
            return await promise;
          } catch (error) {
            nativeFailure = true;
            throw error;
          }
        };
        const usable = () =>
          !signal.aborted && !terminal(state.status) && current(deps, spec);
        const requireCurrent = () => {
          if (!usable()) throw new Error("workflow_cancelled_or_revoked");
        };
        type Call = Extract<WorkflowOperation, { kind: "step" }>;
        const stepCall = async (
          context: typeof ctx,
          id: string,
          call: Omit<Call, "kind">,
        ): Promise<Json> => {
          requireCurrent();
          const signature = hash(call);
          const key = `step:${id}`;
          const tool = deps.workflows?.tools[call.tool];
          if (
            !spec.tools.includes(call.tool) ||
            !tool ||
            !Object.hasOwn(deps.workflows?.tools ?? {}, call.tool)
          )
            throw new Error("workflow_tool_unavailable");
          const args = jsonValue(tool.schema.parse(call.args));
          const receipt = await native(
            context.step({
              name: call.name,
              timeout: 0,
              maxRetries: 0,
              run: async (): Promise<Receipt> => {
                requireCurrent();
                const previous = state.operations[key];
                if (previous)
                  return previous.status === "started"
                    ? { ...previous, status: "unknown" }
                    : previous;
                const release = await deps.lifecycle?.enter(ctx.abortSignal);
                try {
                  requireCurrent();
                  state.operations[key] = { signature, status: "started" };
                  await binding.persist();
                  requireCurrent();
                  let next: Receipt;
                  try {
                    const value = jsonValue(
                      await tool.execute(args, {
                        source: spec.origin,
                        operationId: `${spec.id}:${id}`,
                        signal,
                      }),
                    );
                    next = usable()
                      ? { signature, status: "completed", value }
                      : { signature, status: "unknown" };
                  } catch {
                    next = { signature, status: "unknown" };
                  }
                  if (state.status !== "revoked" && current(deps, spec))
                    state.operations[key] = next;
                  await binding.persist();
                  return next;
                } finally {
                  release?.();
                }
              },
            }),
          );
          requireCurrent();
          if (receipt.signature !== signature)
            throw new Error("workflow_history_changed");
          if (receipt.status !== "completed") {
            state.status = "needs_review";
            throw new Error("workflow_tool_result_unknown");
          }
          return receipt.value ?? null;
        };
        try {
          state.status = "running";
          await binding.persist();
          const names = new Set<string>();
          const result = await runWorkflowSource(
            spec.source,
            spec.input,
            spec.createdAt,
            async (operation) => {
              requireCurrent();
              if (names.has(operation.name))
                throw new Error("workflow_duplicate_name");
              names.add(operation.name);
              const key = `operation:${operation.name}`;
              const signature = hash(operation);
              const previous = state.operations[key];
              if (previous && previous.signature !== signature)
                throw new Error("workflow_history_changed");
              if (!previous) {
                state.operations[key] = { signature, status: "started" };
                await binding.persist();
              }
              requireCurrent();
              let value: Json;
              if (operation.kind === "step")
                value = await stepCall(ctx, operation.name, operation);
              else if (operation.kind === "parallel") {
                if (
                  new Set(operation.calls.map((c) => c.name)).size !==
                  operation.calls.length
                )
                  throw new Error("workflow_duplicate_branch");
                const branches = Object.fromEntries(
                  operation.calls.map((call) => [
                    call.name,
                    {
                      run: (branch: typeof ctx) =>
                        stepCall(
                          branch,
                          `${operation.name}/${call.name}`,
                          call,
                        ),
                    },
                  ]),
                );
                value = jsonValue(
                  await native(ctx.join(operation.name, branches)),
                );
              } else {
                state.status = "waiting";
                await binding.persist();
                const timeout =
                  operation.kind === "sleep" ? operation.ms : operation.timeout;
                const deadline = await native(
                  ctx.step(`${operation.name}:deadline`, async () =>
                    timeout === null ? null : Date.now() + timeout,
                  ),
                );
                value = await native(
                  ctx.loop(operation.name, async (loop) => {
                    const messages = await loop.queue.nextBatch("receive", {
                      completable: true,
                      names:
                        operation.kind === "sleep"
                          ? ["cancel"]
                          : ["signals", "cancel"],
                      count: 1,
                      ...(deadline === null
                        ? {}
                        : { timeout: Math.max(0, deadline - Date.now()) }),
                    });
                    const message = messages[0];
                    if (!message) return Loop.break(null as Json);
                    if (message.name === "cancel") {
                      await loop.step("cancel", async () =>
                        binding.complete(message.id, message.name),
                      );
                      await message.complete();
                      return Loop.break(null as Json);
                    }
                    const body = message.body as { id: string; value: Json };
                    const received = await loop.step("consume", async () => {
                      const previous = state.consumed[body.id];
                      // Repair a crash after the actor save but before this
                      // step's journal commit without dropping the signal.
                      state.consumed[body.id] ??= {
                        wait: operation.name,
                        value: body.value,
                      };
                      await binding.persist();
                      // RivetKit 2.3.21's workflow completion fallback is an
                      // incarnation-local callback map. Delete durably too.
                      await binding.complete(message.id, message.name);
                      return {
                        duplicate:
                          !!previous && previous.wait !== operation.name,
                        value: previous?.value ?? body.value,
                      };
                    });
                    // Also clear native workflow pending-completion bookkeeping;
                    // this must run even when consume replays a cached result.
                    await message.complete();
                    return received.duplicate
                      ? Loop.continue(undefined)
                      : Loop.break(received.value);
                  }),
                );
                requireCurrent();
                state.status = "running";
              }
              state.operations[key] = { signature, status: "completed" };
              await binding.persist();
              return value;
            },
            signal,
          );
          requireCurrent();
          state.result = result;
          state.status = "completed";
          await binding.persist();
        } catch (error) {
          if (nativeFailure || ctx.abortSignal.aborted) throw error;
          if (!terminal(state.status))
            state.status = current(deps, spec) ? "failed" : "revoked";
          state.error =
            error instanceof Error && /^workflow_[a-z_]+$/.test(error.message)
              ? error.message
              : "workflow_failed";
          await binding.persist();
        } finally {
          delete binding.controller;
        }
      },
      {
        onError: async (c) => {
          if (c.abortSignal.aborted || terminal(c.state.status)) return;
          // Native scheduler yields never reach onError. Unhandled journal/storage
          // faults must not masquerade as a permanently running workflow.
          c.state.status = "needs_review";
          c.state.error = "workflow_native_failure";
          await c.vars.persist();
        },
      },
    ),
  });
}

type RunRegistry = Registry<{
  workflowRun: ReturnType<typeof createWorkflowRunActor>;
}>;
interface LibraryState {
  definitions: Record<string, Definition>;
  runs: Record<string, RunSpec>;
  receipts: Record<string, string | { deletionRevision: number; text: string }>;
}

export function createWorkflowLibraryActor(deps: Dependencies) {
  return actor({
    state: { definitions: {}, runs: {}, receipts: {} } as LibraryState,
    createVars: () => ({ tail: Promise.resolve() }),
    actions: {
      recover: async (c) => {
        if (c.key.length !== 1 || c.key[0] !== deps.owner.id || !deps.workflows)
          throw new Error("workflow_denied");
        const previous = c.vars.tail;
        const lock = Promise.withResolvers<void>();
        c.vars.tail = lock.promise;
        await previous;
        try {
          // A lost host leaves actors asleep. Action calls wake them without
          // resetting journals. Resubmission also repairs admission interrupted
          // between saving the library's roster and submitting the run.
          for (const spec of Object.values(c.state.runs)) {
            if (!current(deps, spec)) continue;
            await c
              .client<RunRegistry>()
              .workflowRun.getOrCreate([deps.owner.id, spec.id])
              .submit(spec);
          }
        } finally {
          lock.resolve();
        }
      },
      invalidate: async (c, beforeDeletionRevision?: number) => {
        if (beforeDeletionRevision !== undefined)
          z.number().int().nonnegative().parse(beforeDeletionRevision);
        const previous = c.vars.tail;
        const lock = Promise.withResolvers<void>();
        c.vars.tail = lock.promise;
        await previous;
        try {
          const remove = (entry: { deletionRevision: number }) =>
            beforeDeletionRevision === undefined ||
            entry.deletionRevision < beforeDeletionRevision;
          for (const [name, definition] of Object.entries(c.state.definitions))
            if (remove(definition)) delete c.state.definitions[name];
          for (const [id, spec] of Object.entries(c.state.runs)) {
            if (!remove(spec)) continue;
            await c
              .client<RunRegistry>()
              .workflowRun.getOrCreate([deps.owner.id, id])
              .cancel(true);
            delete c.state.runs[id];
          }
          for (const [id, receipt] of Object.entries(c.state.receipts)) {
            // Legacy receipts have no revision. Retain their deduplication
            // evidence on bounded cleanup rather than guessing their age.
            if (
              beforeDeletionRevision === undefined ||
              (typeof receipt !== "string" && remove(receipt))
            )
              delete c.state.receipts[id];
          }
          await c.saveState({ immediate: true });
        } finally {
          lock.resolve();
        }
      },
      manage: async (
        c,
        origin: MessageEvent,
        requestId: string,
        raw: unknown,
        deletionRevision = 0,
      ): Promise<string> => {
        const previous = c.vars.tail;
        const lock = Promise.withResolvers<void>();
        c.vars.tail = lock.promise;
        await previous;
        try {
          if (
            c.key.length !== 1 ||
            c.key[0] !== deps.owner.id ||
            !deps.workflows ||
            !authorized(deps, origin) ||
            deletionRevision !== revision(deps)
          )
            throw new Error("workflow_denied");
          const command = workflowCommandSchema.parse(raw);
          const receiptId = hash([requestId, command]);
          const write = ["define", "start", "signal", "cancel"].includes(
            command.action,
          );
          if (write && Object.hasOwn(c.state.receipts, receiptId)) {
            const receipt = c.state.receipts[receiptId];
            if (typeof receipt === "string") return receipt;
            if (!receipt || receipt.deletionRevision !== deletionRevision)
              throw new Error("workflow_revoked");
            return receipt.text;
          }
          if (
            write &&
            command.action !== "cancel" &&
            Object.keys(c.state.receipts).length >= 1024
          )
            throw new Error("workflow_library_limit");
          let report: unknown;
          const name = command.name ?? "";
          let definition = Object.hasOwn(c.state.definitions, name)
            ? c.state.definitions[name]
            : undefined;
          if (command.action === "help")
            report = {
              instructions: WORKFLOW_HELP,
              tools: Object.entries(deps.workflows.tools).map(
                ([name, tool]) => ({
                  name,
                  description: tool.description,
                  inputSchema: z.toJSONSchema(tool.schema),
                }),
              ),
            };
          else if (command.action === "define") {
            validateSource(command.source ?? "");
            if (!definition && Object.keys(c.state.definitions).length >= 32)
              throw new Error("workflow_definition_limit");
            const next = {
              name,
              source: command.source as string,
              revision: hash(command.source),
              deletionRevision: revision(deps),
            };
            c.state.definitions[name] = next;
            report = { name, revision: next.revision, status: "defined" };
          } else if (command.action === "start") {
            const id = hash([deps.owner.id, requestId, "workflow"]);
            let spec = c.state.runs[id];
            if (!spec) {
              if (command.source) {
                validateSource(command.source);
                if (
                  !definition &&
                  Object.keys(c.state.definitions).length >= 32
                )
                  throw new Error("workflow_definition_limit");
                definition = {
                  name,
                  source: command.source,
                  revision: hash(command.source),
                  deletionRevision,
                };
              }
              if (!definition || definition.deletionRevision !== revision(deps))
                throw new Error("workflow_definition_unavailable");
              if (Object.keys(c.state.runs).length >= 128)
                throw new Error("workflow_run_limit");
              const statuses = await Promise.all(
                Object.keys(c.state.runs).map(
                  async (id) =>
                    (
                      await c
                        .client<RunRegistry>()
                        .workflowRun.getOrCreate([deps.owner.id, id])
                        .inspect()
                    ).status,
                ),
              );
              if (deletionRevision !== revision(deps))
                throw new Error("workflow_revoked");
              if (statuses.filter((s) => !terminal(s)).length >= 8)
                throw new Error("workflow_capacity");
              spec = {
                ...definition,
                id,
                input: jsonValue(JSON.parse(command.dataJson ?? "null")),
                origin: {
                  type: "message",
                  id: origin.id,
                  messageId: origin.messageId,
                  occurredAt: origin.occurredAt,
                  senderId: origin.senderId,
                  direct: origin.direct,
                  address: origin.address,
                  text: "",
                },
                createdAt: Date.now(),
                tools: Object.keys(deps.workflows.tools),
                abi: 1,
              };
              c.state.definitions[name] = definition;
              c.state.runs[id] = spec;
              await c.saveState({ immediate: true });
            }
            await c
              .client<RunRegistry>()
              .workflowRun.getOrCreate([deps.owner.id, id])
              .submit(spec);
            report = {
              runId: id,
              name: spec.name,
              revision: spec.revision,
              status: "accepted",
            };
          } else if (command.action === "list") {
            report = {
              definitions: Object.values(c.state.definitions)
                .filter((d) => d.deletionRevision === revision(deps))
                .map(({ name, revision }) => ({ name, revision })),
              runs: await Promise.all(
                Object.keys(c.state.runs).map(async (runId) => ({
                  runId,
                  ...(await c
                    .client<RunRegistry>()
                    .workflowRun.getOrCreate([deps.owner.id, runId])
                    .inspect()),
                  source: undefined,
                  input: undefined,
                  operations: undefined,
                  result: undefined,
                })),
              ),
            };
          } else if (command.action === "inspect" && !command.runId) {
            if (!definition || definition.deletionRevision !== revision(deps))
              throw new Error("workflow_definition_unavailable");
            report = definition;
          } else {
            const id = command.runId ?? "";
            if (!Object.hasOwn(c.state.runs, id))
              throw new Error("workflow_run_unavailable");
            const run = c
              .client<RunRegistry>()
              .workflowRun.getOrCreate([deps.owner.id, id]);
            if (command.action === "signal") {
              await run.signal(
                receiptId,
                jsonValue(JSON.parse(command.dataJson ?? "null")),
              );
              report = { runId: id, status: "signal_queued" };
            } else if (command.action === "cancel") {
              await run.cancel();
              report = { runId: id, status: "cancellation_requested" };
            } else report = await run.inspect();
          }
          if (deletionRevision !== revision(deps))
            throw new Error("workflow_revoked");
          const text = JSON.stringify(report);
          if (write && Object.keys(c.state.receipts).length < 1024) {
            c.state.receipts[receiptId] = { deletionRevision, text };
            await c.saveState({ immediate: true });
          }
          if (text.length <= 3000 && command.offset === 0) return text;
          const end = Math.min(text.length, command.offset + 480);
          return JSON.stringify({
            chunk: text.slice(command.offset, end),
            nextOffset: end < text.length ? end : null,
          });
        } finally {
          lock.resolve();
        }
      },
    },
  });
}
