import { z } from "zod";
import type {
  CompanionReply,
  ModelProvider,
  ModelRequest,
} from "../core/contracts.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const REQUEST_TIMEOUT_MS = 30_000;

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

const companionReplySchema = z.strictObject({
  text: z.string().max(32_000),
  coding: z
    .strictObject({
      workspace: z.string(),
      goal: z.string().refine((goal) => goal.trim().length > 0),
    })
    .optional(),
  reaction: z.string().optional(),
  search: z
    .string()
    .trim()
    .min(1)
    .refine((value) => Array.from(value).length <= 500)
    .optional(),
  webhook: z
    .strictObject({ id: z.uuid(), text: z.string().min(1).max(32_000) })
    .optional(),
});

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function replyJsonSchema(
  workspaces: string[],
  searchAvailable = false,
  webhookIds: string[] = [],
  agentConversation = false,
) {
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
        description: agentConversation
          ? "One plain-text response, at most 32000 characters. Do not split or apply chat-platform formatting."
          : "Must be no more than 3500 Unicode characters.",
      },
      coding,
      reaction: agentConversation
        ? { type: "null" }
        : { type: ["string", "null"] },
      ...(webhookIds.length
        ? {
            webhook: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                id: { type: "string", enum: webhookIds },
                text: {
                  type: "string",
                  description:
                    "Message to the registered receiver, 1–32000 characters.",
                },
              },
              required: ["id", "text"],
            },
          }
        : {}),
      ...(searchAvailable
        ? {
            search: {
              type: ["string", "null"],
              description:
                "One on-demand search query, 1–500 Unicode characters. When set, leave text empty and coding/reaction null.",
            },
          }
        : {}),
    },
    required: [
      "text",
      "coding",
      "reaction",
      ...(searchAvailable ? ["search"] : []),
      ...(webhookIds.length ? ["webhook"] : []),
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
  searchAvailable = false,
  webhookIds: string[] = [],
  agentConversation = false,
): CompanionReply {
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
  if (normalized.coding === null) {
    delete normalized.coding;
  }
  if (normalized.reaction === null) {
    delete normalized.reaction;
  }
  if (normalized.search === null) {
    delete normalized.search;
  }
  if (normalized.webhook === null) delete normalized.webhook;

  const parsed = companionReplySchema.safeParse(normalized);
  if (!parsed.success) {
    throw new ModelError("invalid_response", false);
  }
  const reply = parsed.data;
  if (
    (!agentConversation && Array.from(reply.text).length > 3500) ||
    (agentConversation && (reply.reaction || reply.search)) ||
    (reply.webhook &&
      (!webhookIds.includes(reply.webhook.id) || reply.coding || reply.search))
  ) {
    throw new ModelError("invalid_response", false);
  }
  if (
    reply.coding !== undefined &&
    !workspaces.includes(reply.coding.workspace)
  ) {
    throw new ModelError("invalid_response", false);
  }
  if (
    reply.search !== undefined &&
    (!searchAvailable || reply.text.trim() || reply.coding || reply.reaction)
  ) {
    throw new ModelError("invalid_response", false);
  }
  return reply;
}

export interface JsonProviderOptions {
  protocol: "openai" | "anthropic";
  model: string;
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/** Tool-free transport shared by conversation and source-grounded extraction. */
export function createJsonProvider({
  protocol,
  model,
  apiKey,
  baseUrl,
  fetch: fetchImpl = globalThis.fetch,
}: JsonProviderOptions) {
  return async (
    request: {
      system: string;
      messages: ModelRequest["messages"];
      schema: object;
      name: string;
    },
    signal?: AbortSignal,
  ): Promise<string> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const isOpenAI = protocol === "openai";
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
                input: request.messages,
                store: false,
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
                max_tokens: 4_096,
                system: request.system,
                messages: request.messages,
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
      init.signal?.throwIfAborted();
      return isOpenAI ? openAIText(payload) : anthropicText(payload);
    } finally {
      clearTimeout(timeout);
    }
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
            schema: replyJsonSchema(
              request.workspaces,
              request.searchAvailable,
              request.webhookIds,
              request.agentConversation,
            ),
            name: "companion_reply",
          },
          signal,
        ),
        request.workspaces,
        request.searchAvailable,
        request.webhookIds,
        request.agentConversation,
      );
    },
  };
}
