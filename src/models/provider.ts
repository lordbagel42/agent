import { z } from "zod";
import type {
  CompanionReply,
  ModelProvider,
  ModelRequest,
} from "../core/contracts.js";
import { socialActionSchema } from "../core/social.js";
import {
  observeUsage,
  tokenUsage,
  type UsageLedger,
  type UsageStage,
} from "./usage.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;

export class ModelError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(`Model provider request failed (${code})`);
    this.name = "ModelError";
    this.code = code;
    this.retryable = retryable;
  }
}

const searchQuerySchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Array.from(value).length <= 500);

const companionReplySchema = z.strictObject({
  text: z.string().refine((text) => Array.from(text).length <= 3_500),
  social: socialActionSchema.optional(),
  coding: z
    .strictObject({
      workspace: z.string(),
      goal: z.string().refine((goal) => goal.trim().length > 0),
    })
    .optional(),
  reaction: z.string().optional(),
  search: searchQuerySchema.optional(),
  escalate: z.boolean().optional(),
  webSearch: searchQuerySchema.optional(),
  release: z
    .strictObject({
      action: z.enum(["request", "inspect"]),
      revision: z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .nullable(),
    })
    .refine((value) => value.action !== "request" || value.revision !== null)
    .optional(),
  mcp: z
    .strictObject({
      connection: z.string().min(1).max(256),
      tool: z.string().min(1).max(256),
      argumentsJson: z.string().max(4000),
    })
    .optional(),
  replyInThread: z.boolean().optional(),
});

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ReplyCapabilities = Pick<
  ModelRequest,
  | "searchAvailable"
  | "escalationAvailable"
  | "webSearchAvailable"
  | "releaseAvailable"
  | "mcpAvailable"
  | "replyPlacementAvailable"
  | "socialAvailable"
>;

function replyCapabilities(
  capabilities: ReplyCapabilities | boolean,
): ReplyCapabilities {
  return typeof capabilities === "boolean"
    ? { searchAvailable: capabilities }
    : capabilities;
}

export function replyJsonSchema(
  workspaces: string[],
  capabilities: ReplyCapabilities | boolean = false,
) {
  const {
    searchAvailable,
    escalationAvailable,
    webSearchAvailable,
    releaseAvailable,
    mcpAvailable,
    replyPlacementAvailable,
    socialAvailable,
  } = replyCapabilities(capabilities);
  const { $schema: _schema, ...socialSchema } = z.toJSONSchema(
    socialActionSchema.nullable(),
    {
      target: "draft-7",
      override({ jsonSchema }) {
        // Raw Anthropic structured outputs reject these constraints. Keep the
        // strict Zod checks locally and describe the bounds on the wire.
        for (const key of ["minLength", "maxLength", "maxItems"] as const) {
          const limit = jsonSchema[key];
          if (limit !== undefined) {
            jsonSchema.description =
              `${jsonSchema.description ?? ""} ${key}: ${limit}.`.trim();
            delete jsonSchema[key];
          }
        }
      },
    },
  );
  const permittedWorkspaces = [...new Set(workspaces)];
  const coding =
    permittedWorkspaces.length === 0
      ? { type: "null" }
      : {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            workspace: { type: "string", enum: permittedWorkspaces },
            goal: {
              type: "string",
              description:
                "Must contain at least one non-whitespace character.",
            },
          },
          required: ["workspace", "goal"],
        };

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      text: {
        type: "string",
        description: "Must be no more than 3500 Unicode characters.",
      },
      coding,
      reaction: { type: ["string", "null"] },
      ...(releaseAvailable
        ? {
            release: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                action: { type: "string", enum: ["request", "inspect"] },
                revision: {
                  type: ["string", "null"],
                  description:
                    "Exact lowercase 40-character SHA; required for request, null inspects recent events.",
                },
              },
              required: ["action", "revision"],
              description:
                "Request release tracking or inspect controller evidence. No activation, approval, push, or retry. Leave text empty and other actions unset.",
            },
          }
        : {}),
      ...(socialAvailable
        ? {
            social: {
              ...socialSchema,
              description:
                "For Raygen's current turn, post sends directly to a chosen Slack destination. request_access and outreach create approval proposals, never grant permission. Leave text empty and other actions unset.",
            },
          }
        : {}),
      ...(mcpAvailable
        ? {
            mcp: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                connection: { type: "string" },
                tool: { type: "string" },
                argumentsJson: {
                  type: "string",
                  description:
                    "JSON object of tool arguments, at most 4000 characters. No credentials.",
                },
              },
              required: ["connection", "tool", "argumentsJson"],
            },
          }
        : {}),
      ...(searchAvailable
        ? {
            search: {
              type: ["string", "null"],
              description:
                "One current-channel search query, 1–500 Unicode characters, not a public web search. When set, leave text empty and other action directives unset. The host performs the lookup.",
            },
          }
        : {}),
      ...(escalationAvailable
        ? {
            escalate: {
              type: ["boolean", "null"],
              description:
                "Reply directly to casual or straightforward turns. Set true only when this turn needs the configured deeper model. Text may be empty or a brief context-sensitive acknowledgment, not a final answer or claim of completed work. Leave other action directives unset. The host durably sends any acknowledgment and calls the deeper model once; it cannot escalate again. Use false or null for a direct reply.",
            },
          }
        : {}),
      ...(webSearchAvailable
        ? {
            webSearch: {
              type: ["string", "null"],
              description:
                "One public web query, 1–500 Unicode characters, never a private Slack-history search. Do not include private conversation details or secrets in a public query. When set, leave text empty and other action directives unset. The host performs the lookup.",
            },
          }
        : {}),
      ...(replyPlacementAvailable
        ? {
            replyInThread: {
              type: ["boolean", "null"],
              description:
                "Choose Slack placement: true uses the incoming thread or starts one on the incoming message; false posts in the main DM/channel, even for threaded input; null preserves incoming placement. Prefer unthreaded DM and ongoing channel replies unless a thread helps. May accompany any otherwise valid reply or directive.",
            },
          }
        : {}),
    },
    required: [
      "text",
      "coding",
      "reaction",
      ...(releaseAvailable ? ["release"] : []),
      ...(mcpAvailable ? ["mcp"] : []),
      ...(searchAvailable ? ["search"] : []),
      ...(escalationAvailable ? ["escalate"] : []),
      ...(webSearchAvailable ? ["webSearch"] : []),
      ...(replyPlacementAvailable ? ["replyInThread"] : []),
      ...(socialAvailable ? ["social"] : []),
    ],
  };
}

function endpoint(baseUrl: string, resource: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${resource}`;
}

function httpError(status: number): ModelError {
  if (status === 401 || status === 403) {
    return new ModelError("authentication_failed", false);
  }
  if (status === 429) {
    return new ModelError("rate_limited", true);
  }
  if (status >= 500 && status <= 599) {
    return new ModelError("provider_unavailable", true);
  }
  if (status === 408) {
    return new ModelError("timeout", true);
  }
  return new ModelError("request_failed", false);
}

async function fetchJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  controller: AbortController,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new ModelError(
      controller.signal.aborted ? "timeout" : "network_error",
      true,
    );
  }

  if (!response.ok) {
    throw httpError(response.status);
  }

  try {
    return (await response.json()) as unknown;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ModelError("timeout", true);
    }
    if (error instanceof SyntaxError) {
      throw new ModelError("malformed_response", false);
    }
    throw new ModelError("network_error", true);
  }
}

function openAIText(payload: unknown): string {
  if (!isJsonObject(payload)) {
    throw new ModelError("malformed_response", false);
  }
  if (payload.status === "incomplete") {
    const details = payload.incomplete_details;
    if (isJsonObject(details) && details.reason === "content_filter") {
      throw new ModelError("refused", false);
    }
    throw new ModelError("truncated", false);
  }
  if (payload.status === "failed") {
    throw new ModelError("request_failed", false);
  }
  if (payload.status !== "completed" || !Array.isArray(payload.output)) {
    throw new ModelError("malformed_response", false);
  }

  let text = "";
  for (const item of payload.output) {
    if (!isJsonObject(item)) {
      throw new ModelError("malformed_response", false);
    }
    if (item.type !== "message") {
      continue;
    }
    if (item.status === "incomplete") {
      throw new ModelError("truncated", false);
    }
    if (
      item.role !== "assistant" ||
      item.status !== "completed" ||
      !Array.isArray(item.content)
    ) {
      throw new ModelError("malformed_response", false);
    }
    for (const block of item.content) {
      if (!isJsonObject(block)) {
        throw new ModelError("malformed_response", false);
      }
      if (block.type === "refusal") {
        throw new ModelError("refused", false);
      }
      if (block.type === "output_text") {
        if (typeof block.text !== "string") {
          throw new ModelError("malformed_response", false);
        }
        text += block.text;
      }
    }
  }
  if (text.length === 0) {
    throw new ModelError("malformed_response", false);
  }
  return text;
}

function anthropicText(payload: unknown): string {
  if (
    !isJsonObject(payload) ||
    payload.type !== "message" ||
    payload.role !== "assistant"
  ) {
    throw new ModelError("malformed_response", false);
  }
  if (payload.stop_reason === "refusal") {
    throw new ModelError("refused", false);
  }
  if (
    payload.stop_reason === "max_tokens" ||
    payload.stop_reason === "model_context_window_exceeded"
  ) {
    throw new ModelError("truncated", false);
  }
  if (
    (payload.stop_reason !== "end_turn" &&
      payload.stop_reason !== "stop_sequence") ||
    !Array.isArray(payload.content)
  ) {
    throw new ModelError("malformed_response", false);
  }

  let text = "";
  for (const block of payload.content) {
    if (!isJsonObject(block)) {
      throw new ModelError("malformed_response", false);
    }
    if (block.type === "text") {
      if (typeof block.text !== "string") {
        throw new ModelError("malformed_response", false);
      }
      text += block.text;
    }
  }
  if (text.length === 0) {
    throw new ModelError("malformed_response", false);
  }
  return text;
}

export function parseReply(
  text: string,
  workspaces: string[],
  capabilities: ReplyCapabilities | boolean = false,
): CompanionReply {
  const {
    searchAvailable,
    escalationAvailable,
    webSearchAvailable,
    releaseAvailable,
    mcpAvailable,
    replyPlacementAvailable,
    socialAvailable,
  } = replyCapabilities(capabilities);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ModelError("malformed_response", false);
  }
  if (!isJsonObject(value)) {
    throw new ModelError("invalid_response", false);
  }

  const normalized = { ...value };
  for (const key of [
    "coding",
    "reaction",
    "search",
    "escalate",
    "webSearch",
    "release",
    "mcp",
    "replyInThread",
    "social",
  ]) {
    if (normalized[key] === null) delete normalized[key];
  }

  const parsed = companionReplySchema.safeParse(normalized);
  if (!parsed.success) {
    throw new ModelError("invalid_response", false);
  }
  const reply = parsed.data;
  if (
    reply.coding !== undefined &&
    !workspaces.includes(reply.coding.workspace)
  ) {
    throw new ModelError("invalid_response", false);
  }
  if (
    (reply.search !== undefined && !searchAvailable) ||
    (reply.escalate !== undefined && !escalationAvailable) ||
    (reply.webSearch !== undefined && !webSearchAvailable) ||
    (reply.release !== undefined && !releaseAvailable) ||
    (reply.social !== undefined && !socialAvailable) ||
    (reply.mcp !== undefined && !mcpAvailable) ||
    (reply.replyInThread !== undefined && !replyPlacementAvailable)
  ) {
    throw new ModelError("invalid_response", false);
  }
  const directiveCount =
    Number(reply.mcp !== undefined) +
    Number(reply.search !== undefined) +
    Number(reply.webSearch !== undefined) +
    Number(reply.release !== undefined) +
    Number(reply.social !== undefined) +
    Number(reply.escalate === true);
  if (
    directiveCount > 1 ||
    (directiveCount > 0 &&
      (reply.coding !== undefined || reply.reaction !== undefined)) ||
    ((reply.search !== undefined ||
      reply.webSearch !== undefined ||
      reply.release !== undefined ||
      reply.social !== undefined ||
      reply.mcp !== undefined) &&
      reply.text.trim().length > 0)
  ) {
    throw new ModelError("invalid_response", false);
  }
  return reply;
}

export interface JsonProviderOptions {
  usage?: UsageLedger;
  protocol: "openai" | "anthropic";
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** Responses max_output_tokens or Messages max_tokens; includes reasoning. */
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** OpenAI Responses only; select an effort supported by the configured model. */
  reasoningEffort?: "low" | "medium" | "high";
  fetch?: typeof globalThis.fetch;
}

/** Tool-free transport shared by conversation and source-grounded extraction. */
export function createJsonProvider({
  usage,
  protocol,
  model,
  apiKey,
  baseUrl,
  maxOutputTokens,
  timeoutMs = REQUEST_TIMEOUT_MS,
  reasoningEffort,
  fetch: fetchImpl = globalThis.fetch,
}: JsonProviderOptions) {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMER_MS ||
    (maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)) ||
    (reasoningEffort !== undefined &&
      (protocol !== "openai" ||
        !["low", "medium", "high"].includes(reasoningEffort)))
  ) {
    throw new ModelError("invalid_configuration", false);
  }
  return async (
    request: {
      system: string;
      messages: ModelRequest["messages"];
      schema: object;
      name: string;
      usageStage?: UsageStage;
    },
    signal?: AbortSignal,
  ): Promise<string> => {
    signal?.throwIfAborted();
    return observeUsage(
      usage,
      { provider: protocol, model, stage: request.usageStage ?? "fast" },
      async (report) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const isOpenAI = protocol === "openai";
          // Source metadata belongs to the host, not either API's message schema.
          const messages = request.messages.map(({ role, content }) => ({
            role,
            content,
          }));
          const url = endpoint(
            baseUrl ?? (isOpenAI ? OPENAI_BASE_URL : ANTHROPIC_BASE_URL),
            isOpenAI ? "responses" : "messages",
          );
          const init: RequestInit = {
            method: "POST",
            headers: isOpenAI
              ? {
                  authorization: `Bearer ${apiKey}`,
                  "content-type": "application/json",
                }
              : {
                  "anthropic-version": "2023-06-01",
                  "content-type": "application/json",
                  "x-api-key": apiKey,
                },
            body: JSON.stringify(
              isOpenAI
                ? {
                    model,
                    instructions: request.system,
                    input: messages,
                    store: false,
                    ...(maxOutputTokens === undefined
                      ? {}
                      : { max_output_tokens: maxOutputTokens }),
                    ...(reasoningEffort === undefined
                      ? {}
                      : { reasoning: { effort: reasoningEffort } }),
                    text: {
                      format: {
                        type: "json_schema",
                        name: request.name,
                        strict: true,
                        schema: request.schema,
                      },
                    },
                  }
                : {
                    model,
                    max_tokens: maxOutputTokens ?? 4_096,
                    system: request.system,
                    messages,
                    output_config: {
                      format: { type: "json_schema", schema: request.schema },
                    },
                  },
            ),
            redirect: "error",
            signal: signal
              ? AbortSignal.any([signal, controller.signal])
              : controller.signal,
          };
          init.signal?.throwIfAborted();
          const payload = await fetchJson(fetchImpl, url, init, controller);
          report(
            tokenUsage(
              protocol,
              isJsonObject(payload) ? payload.usage : undefined,
            ),
          );
          init.signal?.throwIfAborted();
          return isOpenAI ? openAIText(payload) : anthropicText(payload);
        } finally {
          clearTimeout(timeout);
        }
      },
    );
  };
}

export function createModelProvider(
  options: JsonProviderOptions,
): ModelProvider {
  const generate = createJsonProvider(options);
  return {
    async reply(request, signal) {
      return parseReply(
        await generate(
          {
            ...request,
            schema: replyJsonSchema(request.workspaces, request),
            name: "companion_reply",
          },
          signal,
        ),
        request.workspaces,
        request,
      );
    },
  };
}
