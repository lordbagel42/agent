import { capabilityDefinitions } from "../capabilities/catalog.js";
import { isCapabilityEnabled } from "../capabilities/config.js";
import type {
  CapabilityHostPorts,
  CapabilityInvocationContext,
} from "../capabilities/contracts.js";
import type { Dependencies } from "./registry.js";

type MetadataDependencies = Pick<
  Dependencies,
  "capabilityInspection" | "capabilityConfig"
>;

/** Only the existing authenticated metadata reader is mounted in wave 0.
 * Missing intent/policy/budget/evidence services remain absent, not allow stubs.
 * Never fall back to direct inspection: its transport projection can omit data.
 * Without an invocation this is availability metadata only, never dispatch.
 */
export function mountCapabilityPorts(
  deps: MetadataDependencies,
  invocation?: Pick<
    CapabilityInvocationContext,
    "event" | "signal" | "canStartAction" | "canDeliver"
  >,
): CapabilityHostPorts {
  const inspection = deps.capabilityInspection;
  const read = inspection?.capabilityMatrix;
  return inspection
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
