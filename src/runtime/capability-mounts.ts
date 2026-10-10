import { Effect, Schema } from "effect";
import { capabilityDefinitions } from "../capabilities/catalog.js";
import { isCapabilityEnabled } from "../capabilities/config.js";
import type {
  CapabilityHostPorts,
  CapabilityInvocationContext,
} from "../capabilities/contracts.js";
import type { CapabilityOutputController } from "./capability-output.js";
import type { Dependencies } from "./registry.js";

type MetadataDependencies = Pick<
  Dependencies,
  | "capabilityInspection"
  | "capabilityTasks"
  | "capabilityConfig"
  | "effectRuntime"
>;

class TaskInspectionUnavailable extends Schema.TaggedError<TaskInspectionUnavailable>()(
  "TaskInspectionUnavailable",
  { message: Schema.Literal("Capability invocation unavailable") },
) {}

const taskUnavailable = () =>
  new TaskInspectionUnavailable({
    message: "Capability invocation unavailable",
  });

/** Mount only named authenticated metadata readers.
 * Missing intent/policy/budget/evidence services remain absent, not allow stubs.
 * Never fall back to direct inspection: its transport projection can omit data.
 * Without an invocation this is availability metadata only, never dispatch.
 */
export function mountCapabilityPorts(
  deps: MetadataDependencies,
  invocation?: CapabilityInvocationContext,
  outputGuards?: CapabilityOutputController,
): CapabilityHostPorts {
  const inspection = deps.capabilityInspection;
  const read = inspection?.capabilityMatrix;
  const ports: CapabilityHostPorts = inspection
    ? {
        inspection: {
          async capabilityMatrix(event, signal) {
            const current = () =>
              !!invocation &&
              !invocation.signal.aborted &&
              event === invocation.event &&
              signal === invocation.signal &&
              deps.capabilityInspection === inspection &&
              inspection.capabilityMatrix === read &&
              invocation.canStartAction();
            if (!invocation || !read || !current())
              throw new Error("Capability invocation unavailable");
            if (!(await invocation.canDeliver()) || !current())
              throw new Error("Capability invocation unavailable");
            // A handler may await preparation before using its port. Recheck at
            // this actual host call, not only around the enclosing handler.
            const result = await read.call(inspection, event, signal);
            if (!current() || !(await invocation.canDeliver()) || !current())
              throw new Error("Capability invocation unavailable");
            return result;
          },
        },
      }
    : {};
  const tasks = deps.capabilityTasks;
  const inspect = tasks?.inspect;
  const runtime = deps.effectRuntime;
  if (tasks && runtime) {
    const inspectTask = Effect.fn("june.capability.tasks.inspect")(
      (context: CapabilityInvocationContext, id: string) =>
        Effect.uninterruptible(
          Effect.tryPromise({
            try: async () => {
              const current = () =>
                !!invocation &&
                context === invocation &&
                !invocation.signal.aborted &&
                deps.effectRuntime === runtime &&
                deps.capabilityTasks === tasks &&
                tasks.inspect === inspect &&
                outputGuards?.current() !== false &&
                invocation.valid() &&
                invocation.canStartAction();
              if (!invocation || !inspect || !current())
                throw taskUnavailable();
              if (!(await invocation.canDeliver()) || !current())
                throw taskUnavailable();
              // Keep this synchronous fence and the original reader call in
              // one callback. Effect interruption must await raw settlement,
              // while the original signal still reaches a cooperative reader.
              const result = await inspect.call(tasks, invocation, id);
              // Claim this exact return before another await. Prior registrations
              // cannot certify a different result from an overlapping read.
              if (
                result !== null &&
                (!outputGuards ||
                  invocation.outputGuards !== outputGuards.producer ||
                  !outputGuards.claim(result))
              )
                throw taskUnavailable();
              if (!current() || !(await invocation.canDeliver()) || !current())
                throw taskUnavailable();
              return result;
            },
            catch: () => {
              // A handler catching a port failure cannot publish a partial view.
              outputGuards?.invalidate();
              return taskUnavailable();
            },
          }),
        ),
    );
    ports.tasks = {
      inspect(context, id) {
        return runtime.runPromise(inspectTask(context, id), {
          signal: invocation?.signal,
        });
      },
    };
  }
  return ports;
}

/** Metadata-only execution support, not enrollment or live readiness evidence.
 * Capture at delegation and intersect at every use; never expand queued work.
 */
export function availableMetadataCapabilityIds(
  deps: MetadataDependencies,
): string[] {
  const ports = mountCapabilityPorts(deps);
  return capabilityDefinitions
    .filter((definition) => {
      if (
        definition.effect !== "metadata" ||
        !definition.allowedTurns.includes("execution") ||
        !isCapabilityEnabled(definition.id, deps.capabilityConfig)
      )
        return false;
      try {
        return definition.inspectAvailability(ports).status === "available";
      } catch {
        // Bad or missing availability evidence cannot become authority.
        return false;
      }
    })
    .map(({ id }) => id);
}
