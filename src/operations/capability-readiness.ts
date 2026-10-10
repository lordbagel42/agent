import { accessSync, constants, statSync } from "node:fs";
import type {
  CapabilityObservation,
  CapabilityPrerequisite,
  CapabilityStatus,
} from "../capabilities/contracts.js";
import type { Config } from "../config.js";

type Value = CapabilityObservation["value"];
type Resolver = CapabilityPrerequisite["resolver"];

/** A snapshot is short-lived metadata, never reusable admission or consent. */
export const READINESS_FRESHNESS_MS = 60_000;

export function currentObservation(
  observation: CapabilityObservation,
  now: number,
): CapabilityObservation {
  const { observedAt, expiresAt } = observation;
  const valid =
    observedAt !== null &&
    expiresAt !== null &&
    Number.isSafeInteger(now) &&
    Number.isSafeInteger(observedAt) &&
    Number.isSafeInteger(expiresAt) &&
    observedAt >= 0 &&
    observedAt <= now &&
    expiresAt > observedAt;
  const freshness = !valid ? "unknown" : expiresAt <= now ? "stale" : "fresh";
  return {
    ...observation,
    value: freshness === "fresh" ? observation.value : "unknown",
    freshness,
  };
}

/** Device metadata/permission check only: never opens KVM, loads an SDK or boots a VM. */
function kvmDeviceAccess(): Value {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    return "no";
  try {
    if (!statSync("/dev/kvm").isCharacterDevice()) return "no";
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return "yes";
  } catch (error) {
    return ["ENOENT", "EACCES", "EPERM"].includes(
      (error as NodeJS.ErrnoException).code ?? "",
    )
      ? "no"
      : "unknown";
  }
}

export function createCapabilityReadiness(
  config: Config,
  env: NodeJS.ProcessEnv,
  runningRevision: string | undefined,
  now = Date.now(),
) {
  // Never infer the loaded revision from Git, a release link or untrusted config.
  const revision =
    runningRevision && /^[a-f0-9]{40}$/.test(runningRevision)
      ? runningRevision
      : null;
  const state = (value: boolean | null): Value =>
    value === null ? "unknown" : value ? "yes" : "no";

  return (
    id: string,
    integrated: boolean,
    callable: boolean | null,
    enabled: boolean | null,
  ): CapabilityStatus => {
    const scope = `current-process:${id}`;
    const observe = (
      value: Value,
      source: string,
      reason?: string,
    ): CapabilityObservation =>
      currentObservation(
        {
          value,
          revision,
          observedAt: now,
          expiresAt: now + READINESS_FRESHNESS_MS,
          freshness: "unknown",
          scope,
          source,
          ...(reason ? { reason } : {}),
        },
        now,
      );
    const unknown = (
      source: string,
      reason: string,
    ): CapabilityObservation => ({
      value: "unknown",
      revision: null,
      observedAt: null,
      expiresAt: null,
      freshness: "unknown",
      scope,
      source,
      reason,
    });
    const prerequisites: CapabilityPrerequisite[] = [];
    const prerequisite = (
      code: string,
      value: Value,
      resolver: Resolver,
      instruction: string,
      reason: string,
    ) => {
      prerequisites.push({
        code: `${id}.${code}`,
        resolver,
        nextAction: {
          kind:
            resolver === "june"
              ? "inspect"
              : resolver === "owner"
                ? "setup"
                : "operator-review",
          instruction,
        },
        observation:
          value === "unknown"
            ? unknown("not-observed", reason)
            : observe(value, "local-prerequisite", reason),
      });
    };
    prerequisite(
      "integration",
      state(integrated),
      "operator",
      "Ask the existing operator to review the missing host integration; do not install or repair it yourself.",
      "Dependency mounted in this process, not provider health.",
    );
    prerequisite(
      "activation",
      state(enabled),
      "operator",
      "Ask the owner/operator to review configuration and host activation gates. Preserve explicit disables and existing grants.",
      "Configuration and activation gates only; not consent or health.",
    );
    prerequisite(
      "model-invocation",
      state(!config.setupMode),
      "operator",
      "Setup mode prevents model invocation. Ask the operator to finish authorized setup; inspection cannot change modes.",
      "Current process setup-mode gate.",
    );
    let enrolled = unknown(
      "not-observed",
      "Account enrollment and authorization were not checked.",
    );
    const localEnrollment = () =>
      observe(
        "yes",
        "source-contract",
        "No separate external account enrollment for this local interface; audience and per-call grants still apply.",
      );
    switch (id) {
      case "subsystem-inspection":
      case "release-inspection":
      case "retained-memory":
      case "boxlite-environments":
        enrolled = localEnrollment();
        break;
    }
    switch (id) {
      case "native-coding":
        prerequisite(
          "runtime-selection",
          state(!!config.coding.runtime),
          "operator",
          "Ask the operator to configure an explicitly permitted coding runtime and isolated workspace; native coding is not a sandbox.",
          "Runtime selection only, not authentication or containment.",
        );
        prerequisite(
          "workspace-selection",
          state(Object.keys(config.coding.workspaces).length > 0),
          "operator",
          "Ask the operator to select permitted coding workspaces and matching isolation policy.",
          "At least one configured workspace; no path or process probe.",
        );
        prerequisite(
          "runtime-acceptance",
          "unknown",
          "june",
          'Use inspection:"native-coding" when exposed; remaining authentication and isolation acceptance belongs to the operator.',
          "Protected-host acceptance and runtime authentication are unverified.",
        );
        break;
      case "dynamic-apps":
        prerequisite(
          "companion-compatibility",
          "unknown",
          "operator",
          "Ask the app-host operator for a fresh loaded-revision, compatibility and readiness receipt. Do not deploy or retry an unknown app operation.",
          "Separate app-host revision, connectivity and viewer routing are not observed; no wrong-revision diagnosis is inferred.",
        );
        break;
      case "history-imports":
        prerequisite(
          "source-selection",
          state(Object.keys(config.imports).length > 0),
          "owner",
          "Ask the owner to select the exact source and audience through existing private import setup; never request credentials in chat.",
          "Selection presence does not establish source consent, account health or imported coverage.",
        );
        break;
      case "mcp-tools":
        prerequisite(
          "account-and-tool-grants",
          "unknown",
          "june",
          'Use inspection:"mcp-enrollment" for missing/expired credentials and owner Connections setup, then permitted MCP discovery; respect manual disconnections.',
          "Mounting is not enrollment, enabled tool discovery or current provider authorization.",
        );
        break;
      case "public-web-search":
        prerequisite(
          "credential-presence",
          state(
            !!config.webSearch && !!env[config.webSearch.apiKeyEnv]?.trim(),
          ),
          "owner",
          "Ask the owner to supply the selected search credential through existing private operator setup, never chat; entitlement and quota still need verification.",
          "Credential presence only, not validity, enrollment consent, quota or a successful search.",
        );
        break;
      case "boxlite-environments":
        prerequisite(
          "kvm-device-access",
          kvmDeviceAccess(),
          "operator",
          "Ask the environment operator to verify supported Linux hardware and service access to /dev/kvm; do not change hosting or device permissions yourself.",
          "Local platform and device metadata/access only, not a successful KVM open, VM command, isolation or teardown proof.",
        );
        prerequisite(
          "isolation-and-teardown",
          "unknown",
          "june",
          'Use inspection:"sandboxes" for existing metadata; independent isolation, crash-fence and teardown acceptance belongs to the environment operator.',
          "Provider availability and SDK state are not independent containment or teardown proof.",
        );
        break;
      case "browser-companion":
        prerequisite(
          "secret-safe-intake",
          state(!config.deployment?.blueGreen),
          "operator",
          "Ask the browser/intake owners to resolve secret-safe PIN ingress. Do not send PINs through durable intake, disable its safeguards or take over deployment.",
          "Current browser PIN route is incompatible with durable blue/green intake; absence of that mode is not a security attestation.",
        );
        break;
    }
    const blocked = prerequisites.some(
      ({ observation }) => observation.value === "no",
    );
    const metadataOnly = id === "subsystem-inspection";
    return {
      id,
      implemented: observe("yes", "loaded-source"),
      hostIntegrated: observe(state(integrated), "runtime-mount"),
      juneCallable: observe(
        state(callable),
        "runtime-route",
        "Route existence only; current role/schema, scope and lifecycle admission still apply.",
      ),
      enrolled,
      enabled: observe(state(enabled), "runtime-config"),
      ready: blocked
        ? observe(
            "no",
            "prerequisites",
            "At least one current prerequisite is missing.",
          )
        : metadataOnly && callable === true
          ? observe(
              "yes",
              "local-metadata-route",
              "Local metadata route only, not process health or any provider workflow.",
            )
          : unknown(
              "not-probed",
              "No end-to-end readiness probe was performed.",
            ),
      liveVerified: unknown(
        "no-attestation-provider",
        "No independent live feature attestation is connected to this view.",
      ),
      // Positive gates are visible in the axes; return actionable missing/unknown prerequisites.
      prerequisites: prerequisites.filter(
        ({ observation }) => observation.value !== "yes",
      ),
    };
  };
}
