import type { MessageEvent, ModelRequest } from "../core/contracts.js";
import type { InjectionSentinel } from "./service.js";

/** Retain transient MCP observations only for this host invocation. The callback
 * is stripped by the MCP wrapper; it is not provider input or persisted history. */
export function withSentinelContext(
  sentinel: InjectionSentinel | undefined,
  event: MessageEvent,
  request: ModelRequest,
  signal: AbortSignal,
  current: () => boolean,
): ModelRequest {
  if (!sentinel) return request;
  const observations = [...request.messages];
  const guard = sentinel.context(
    event,
    {
      system: request.system,
      messages: observations,
      agentRole: request.agentRole,
    },
    signal,
    current,
  );
  return {
    ...request,
    effectGuard: (sink, action, extra) =>
      guard(sink, action, extra ? [...observations, ...extra] : observations),
    onSentinelObservation: (text) => {
      observations.push({
        role: "user",
        content: `Untrusted MCP result: ${text}`,
      });
      request.onSentinelObservation?.(text);
    },
  };
}
