import { Schema } from "effect";

/** Host-owned vocabulary only. Never classify by matching remote error text. */
export const MCP_FAILURE_DETAILS = {
  unclassified: "the host could not identify the cause",
  configuration: "the adapter configuration is invalid",
  credential: "the configured credential is missing or invalid",
  closed: "the local adapter is closed",
  authorization_required: "the endpoint rejected authentication or access",
  rate_limited: "the endpoint rate-limited the request",
  http: "the endpoint returned an HTTP error",
  transport: "network transport failed",
  timeout: "the host's MCP deadline expired",
  cancelled: "local MCP work was cancelled",
  response_too_large: "the response exceeded the host's byte limit",
  discovery_limit: "tool discovery exceeded the host's limits",
  tool_missing: "the configured tool was not in the returned catalog",
  task_required: "the tool requires an unsupported task protocol",
  schema_invalid: "the tool contract is unsupported or invalid",
  contract_changed: "the tool contract no longer matches its reviewed version",
  invalid_arguments: "the arguments failed the tool's input contract",
  denied: "current authorization blocked tool dispatch",
  tool_error: "the server returned a tool error",
  invalid_result: "the returned result failed the tool's output contract",
} as const;

export const MCP_FAILURE_STAGES = [
  "unclassified",
  "validation",
  "connection",
  "discovery",
  "call",
] as const;

export class McpAdapterError extends Schema.TaggedError<McpAdapterError>()(
  "McpAdapterError",
  {
    outcome: Schema.Literals(["not_started", "unknown"]),
    stage: Schema.Literals(MCP_FAILURE_STAGES),
    code: Schema.Literals(
      Object.keys(MCP_FAILURE_DETAILS) as (keyof typeof MCP_FAILURE_DETAILS)[],
    ),
  },
) {
  constructor(
    outcome: "not_started" | "unknown",
    stage: (typeof MCP_FAILURE_STAGES)[number] = "unclassified",
    code: keyof typeof MCP_FAILURE_DETAILS = "unclassified",
  ) {
    super({ outcome, stage, code });
  }

  override get message() {
    return `MCP ${this.stage}: ${MCP_FAILURE_DETAILS[this.code]} (code ${this.code}; tool dispatch ${this.outcome}).`;
  }
}
