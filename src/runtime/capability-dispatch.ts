import { findCapability } from "../capabilities/catalog.js";
import type { CapabilityInvocationContext } from "../capabilities/contracts.js";
import type { CompanionReply, ModelRequest } from "../core/contracts.js";
import { parseReply } from "../models/provider.js";
import type { CapabilityContext } from "./capabilities.js";
import {
  availableMetadataCapabilityIds,
  mountCapabilityPorts,
} from "./capability-mounts.js";

const observationLimit = 64 * 1024;
const unavailable = (code: string) => ({
  text: JSON.stringify({
    status: "unavailable",
    code,
    instruction:
      "No complete capability observation is available. Do not infer readiness, repair anything or repeat an uncertain operation.",
  }),
  terminal: true,
});

/** Uses the worker's existing started receipt and raw callback lifetime. This
 * adds no journal, retry, timeout race or effect authority. Non-metadata and
 * event-decision dispatch wait for real owner-fenced host integrations.
 */
export async function runModularCapability(
  reply: CompanionReply,
  input: ModelRequest,
  context: CapabilityContext,
): Promise<{ text: string; terminal: boolean }> {
  if (
    input.agentRole !== "execution" ||
    input.capabilityTurn !== "execution" ||
    context.origin !== "event" ||
    context.phase === "synthesis" ||
    !context.operationId ||
    !context.execution ||
    !context.canStartAction ||
    !context.canDeliver
  )
    return unavailable("invocation_not_admitted");
  let command: CompanionReply["capability"];
  try {
    command = parseReply(
      JSON.stringify(reply),
      input.workspaces,
      input,
    ).capability;
  } catch {
    return unavailable("command_not_admitted");
  }
  if (!command) return unavailable("command_not_admitted");
  const { id } = command;
  const definition = findCapability(id);
  const execution = context.execution;
  const current = () =>
    !context.signal.aborted &&
    context.valid() &&
    context.canStartAction?.() === true &&
    execution.audience === context.audience &&
    input.capabilityIds?.includes(id) === true &&
    execution.capabilities.capabilityIds?.includes(id) === true &&
    availableMetadataCapabilityIds(context.deps).includes(id);
  if (!definition || !current()) return unavailable("capability_not_current");
  const canDeliver = context.canDeliver;
  try {
    if (!(await canDeliver()) || !current())
      return unavailable("invocation_not_current");
    const invocation: CapabilityInvocationContext = {
      event: context.event,
      scope: context.scope,
      audience: context.audience,
      eventId: context.eventId,
      operationId: context.operationId,
      deletionRevision: context.deletionRevision,
      signal: context.signal,
      valid: context.valid,
      turn: "execution",
      execution,
      canStartAction: current,
      canDeliver: async () => current() && (await canDeliver()) && current(),
    };
    const handler = definition.create(
      mountCapabilityPorts(context.deps, invocation),
    );
    if (!handler || !current()) return unavailable("capability_not_current");
    const text = await handler.execute(command.command, invocation);
    if (!current() || !(await canDeliver()) || !current())
      return unavailable("invocation_not_current");
    if (typeof text !== "string" || Buffer.byteLength(text) > observationLimit)
      return unavailable("observation_exceeds_64_kib");
    return { text, terminal: false };
  } catch {
    // No raw error/provider body, partial JSON, automatic retry or fallback.
    return unavailable("observation_unconfirmed");
  }
}
