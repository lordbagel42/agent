import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "../core/contracts.js";
import { createModelProvider, ModelError } from "./provider.js";

type FetchArguments = Parameters<typeof globalThis.fetch>;

const request: ModelRequest = {
  system: "You are June. Keep the owner's intent intact.",
  messages: [
    { role: "user", content: "Can you inspect the app?" },
    { role: "assistant", content: "Which workspace?" },
    { role: "user", content: "The garden workspace." },
  ],
  workspaces: ["garden", "notes"],
};

function mockFetch(
  implementation: (...arguments_: FetchArguments) => Promise<Response>,
): typeof globalThis.fetch {
  return vi.fn(implementation) as unknown as typeof globalThis.fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openAIResponseText(text: string): Response {
  return jsonResponse({
    id: "resp_fixture",
    object: "response",
    status: "completed",
    output: [
      {
        type: "message",
        id: "message_fixture",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
  });
}

function anthropicResponseText(
  text: string,
  stopReason = "end_turn",
): Response {
  return jsonResponse({
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });
}

function openAIProviderReturning(value: unknown) {
  return createModelProvider({
    protocol: "openai",
    model: "gpt-test",
    apiKey: "openai-test-key",
    fetch: mockFetch(async () => openAIResponseText(JSON.stringify(value))),
  });
}

async function caughtModelError(
  promise: Promise<unknown>,
): Promise<ModelError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelError);
    return error as ModelError;
  }
  throw new Error("Expected the model request to reject");
}

const expectedReplySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: {
      type: "string",
      description: "Must be no more than 3500 Unicode characters.",
    },
    coding: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        workspace: { type: "string", enum: ["garden", "notes"] },
        goal: {
          type: "string",
          description: "Must contain at least one non-whitespace character.",
        },
      },
      required: ["workspace", "goal"],
    },
    reaction: { type: ["string", "null"] },
  },
  required: ["text", "coding", "reaction"],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createModelProvider", () => {
  it("sends an OpenAI Responses request with exact roles and structured output", async () => {
    let captured: FetchArguments | undefined;
    const fetch = mockFetch(async (...arguments_) => {
      captured = arguments_;
      return jsonResponse({
        id: "resp_123",
        object: "response",
        status: "completed",
        output: [
          { type: "reasoning", id: "reasoning_123", summary: [] },
          {
            type: "message",
            id: "message_123",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  text: "I'll inspect it.",
                  coding: {
                    workspace: "garden",
                    goal: "Inspect the app",
                  },
                  reaction: "👍",
                }),
                annotations: [],
              },
            ],
          },
        ],
      });
    });
    const provider = createModelProvider({
      protocol: "openai",
      model: "gpt-test",
      apiKey: "openai-test-key",
      baseUrl: "https://gateway.example.test/models/openai/v1/",
      fetch,
    });

    await expect(provider.reply(request)).resolves.toEqual({
      text: "I'll inspect it.",
      coding: { workspace: "garden", goal: "Inspect the app" },
      reaction: "👍",
    });

    expect(captured?.[0]).toBe(
      "https://gateway.example.test/models/openai/v1/responses",
    );
    const init = captured?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers)).toEqual(
      new Headers({
        authorization: "Bearer openai-test-key",
        "content-type": "application/json",
      }),
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gpt-test",
      instructions: request.system,
      input: request.messages,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "companion_reply",
          strict: true,
          schema: expectedReplySchema,
        },
      },
    });
  });

  it("sends an Anthropic Messages request with system separate from exact roles", async () => {
    let captured: FetchArguments | undefined;
    const fetch = mockFetch(async (...arguments_) => {
      captured = arguments_;
      return jsonResponse({
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [
          { type: "thinking", thinking: "private reasoning", signature: "sig" },
          { type: "text", text: '{"text":"No coding needed.",' },
          {
            type: "tool_use",
            id: "tool_123",
            name: "not_requested",
            input: { secret: "ignore this block" },
          },
          { type: "text", text: '"coding":null,"reaction":null}' },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 30, output_tokens: 20 },
      });
    });
    const provider = createModelProvider({
      protocol: "anthropic",
      model: "claude-test",
      apiKey: "anthropic-test-key",
      baseUrl: "https://gateway.example.test/models/anthropic/v1/",
      fetch,
    });

    await expect(provider.reply(request)).resolves.toEqual({
      text: "No coding needed.",
    });

    expect(captured?.[0]).toBe(
      "https://gateway.example.test/models/anthropic/v1/messages",
    );
    const init = captured?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers)).toEqual(
      new Headers({
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": "anthropic-test-key",
      }),
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "claude-test",
      max_tokens: 4_096,
      system: request.system,
      messages: request.messages,
      output_config: {
        format: {
          type: "json_schema",
          schema: expectedReplySchema,
        },
      },
    });
  });

  it("uses each provider's official v1 base URL by default", async () => {
    const urls: string[] = [];
    const fetch = mockFetch(async (input) => {
      const url = String(input);
      urls.push(url);
      const reply = JSON.stringify({ text: "hello" });
      return url.endsWith("/responses")
        ? openAIResponseText(reply)
        : anthropicResponseText(reply);
    });
    const openAI = createModelProvider({
      protocol: "openai",
      model: "gpt-test",
      apiKey: "openai-test-key",
      fetch,
    });
    const anthropic = createModelProvider({
      protocol: "anthropic",
      model: "claude-test",
      apiKey: "anthropic-test-key",
      fetch,
    });

    await openAI.reply(request);
    await anthropic.reply(request);

    expect(urls).toEqual([
      "https://api.openai.com/v1/responses",
      "https://api.anthropic.com/v1/messages",
    ]);
  });

  it("makes coding impossible in the output schema when no workspace is allowed", async () => {
    let body: unknown;
    const fetch = mockFetch(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as unknown;
      return openAIResponseText(
        JSON.stringify({ text: "No workspace configured.", coding: null }),
      );
    });
    const provider = createModelProvider({
      protocol: "openai",
      model: "gpt-test",
      apiKey: "openai-test-key",
      fetch,
    });

    await expect(
      provider.reply({ ...request, workspaces: [] }),
    ).resolves.toEqual({ text: "No workspace configured." });
    expect(body).toMatchObject({
      text: {
        format: {
          schema: {
            properties: { coding: { type: "null" } },
          },
        },
      },
    });
  });

  it.each([
    ["an extra reply property", { text: "hello", unexpected: true }],
    [
      "an extra coding property",
      {
        text: "hello",
        coding: { workspace: "garden", goal: "work", extra: true },
      },
    ],
    [
      "a blank coding goal",
      { text: "hello", coding: { workspace: "garden", goal: " \n\t " } },
    ],
    ["more than 3500 Unicode characters", { text: "😀".repeat(3_501) }],
  ])("rejects a schema-invalid reply containing %s", async (_case, reply) => {
    const provider = openAIProviderReturning(reply);

    const error = await caughtModelError(provider.reply(request));
    expect(error).toMatchObject({ code: "invalid_response", retryable: false });
  });

  it("rejects a coding workspace that was not permitted by this request", async () => {
    const provider = openAIProviderReturning({
      text: "I'll do that.",
      coding: { workspace: "production", goal: "Deploy everything" },
    });

    const error = await caughtModelError(provider.reply(request));
    expect(error).toMatchObject({ code: "invalid_response", retryable: false });
  });

  it.each([
    [
      "an OpenAI refusal block",
      "openai",
      () =>
        jsonResponse({
          id: "resp_refusal",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              id: "message_refusal",
              role: "assistant",
              status: "completed",
              content: [
                { type: "refusal", refusal: "private provider refusal" },
              ],
            },
          ],
        }),
      "refused",
    ],
    [
      "an incomplete OpenAI response",
      "openai",
      () =>
        jsonResponse({
          id: "resp_incomplete",
          object: "response",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
        }),
      "truncated",
    ],
    [
      "an Anthropic refusal stop reason",
      "anthropic",
      () => anthropicResponseText("private provider refusal", "refusal"),
      "refused",
    ],
    [
      "an Anthropic max_tokens stop reason",
      "anthropic",
      () => anthropicResponseText('{"text":"partial', "max_tokens"),
      "truncated",
    ],
  ] as const)("handles %s", async (_case, protocol, response, code) => {
    const provider = createModelProvider({
      protocol,
      model: "test-model",
      apiKey: "provider-test-key",
      fetch: mockFetch(async () => response()),
    });

    const error = await caughtModelError(provider.reply(request));
    expect(error).toMatchObject({ code, retryable: false });
    expect(error.message).not.toContain("private provider refusal");
  });

  it.each([
    [
      "a non-JSON HTTP body",
      () =>
        new Response("private malformed provider body", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "an envelope without output text",
      () =>
        jsonResponse({
          id: "resp_malformed",
          object: "response",
          status: "completed",
          output: [{ type: "reasoning", summary: [] }],
        }),
    ],
    [
      "non-JSON structured output",
      () => openAIResponseText("private malformed structured output"),
    ],
  ] as const)("rejects %s as a malformed response", async (_case, response) => {
    const provider = createModelProvider({
      protocol: "openai",
      model: "gpt-test",
      apiKey: "openai-test-key",
      fetch: mockFetch(async () => response()),
    });

    const error = await caughtModelError(provider.reply(request));
    expect(error).toMatchObject({
      code: "malformed_response",
      retryable: false,
    });
    expect(error.message).not.toContain("private malformed");
  });

  it.each([
    [401, "authentication_failed", false],
    [403, "authentication_failed", false],
    [429, "rate_limited", true],
    [500, "provider_unavailable", true],
    [503, "provider_unavailable", true],
    [400, "request_failed", false],
  ] as const)(
    "classifies HTTP %i failures as %s",
    async (status, code, retryable) => {
      const provider = createModelProvider({
        protocol: "openai",
        model: "gpt-test",
        apiKey: "openai-test-key",
        fetch: mockFetch(
          async () =>
            new Response("private provider body containing openai-test-key", {
              status,
            }),
        ),
      });

      const error = await caughtModelError(provider.reply(request));
      expect(error).toMatchObject({ code, retryable });
      expect(error.message).not.toContain("private provider body");
      expect(error.message).not.toContain("openai-test-key");
    },
  );

  it("classifies network failures as retryable without exposing their details", async () => {
    const provider = createModelProvider({
      protocol: "anthropic",
      model: "claude-test",
      apiKey: "anthropic-test-key",
      fetch: mockFetch(async () => {
        throw new Error("private socket failure containing anthropic-test-key");
      }),
    });

    const error = await caughtModelError(provider.reply(request));
    expect(error).toMatchObject({ code: "network_error", retryable: true });
    expect(error.message).not.toContain("private socket failure");
    expect(error.message).not.toContain("anthropic-test-key");
  });

  it("aborts a model request after a finite timeout", async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("private abort detail", "AbortError")),
          { once: true },
        );
      });
    });
    const provider = createModelProvider({
      protocol: "openai",
      model: "gpt-test",
      apiKey: "openai-test-key",
      fetch,
    });

    const errorPromise = caughtModelError(provider.reply(request));
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await errorPromise;

    expect(error).toMatchObject({ code: "timeout", retryable: true });
    expect(error.message).not.toContain("private abort detail");
  });

  it("counts the 3500-character text limit by Unicode code point", async () => {
    const text = "😀".repeat(3_500);
    const provider = openAIProviderReturning({ text });

    await expect(provider.reply(request)).resolves.toEqual({ text });
  });

  it("accepts a search request only when the current channel offers search", async () => {
    const provider = openAIProviderReturning({ text: "", search: "heron" });
    await expect(
      provider.reply({ ...request, searchAvailable: true }),
    ).resolves.toEqual({ text: "", search: "heron" });
    await expect(provider.reply(request)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it.each(["openai", "anthropic"] as const)(
    "advertises search in the %s wire schema only when available",
    async (protocol) => {
      const bodies: Record<string, unknown>[] = [];
      const provider = createModelProvider({
        protocol,
        model: "fixture",
        apiKey: "fixture",
        fetch: mockFetch(async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          const text = JSON.stringify({ text: "", search: "heron" });
          return protocol === "openai"
            ? openAIResponseText(text)
            : anthropicResponseText(text);
        }),
      });
      await provider.reply({ ...request, searchAvailable: true });
      const body = bodies[0] as {
        text?: { format: { schema: unknown } };
        output_config?: { format: { schema: unknown } };
      };
      expect((body.text ?? body.output_config)?.format.schema).toMatchObject({
        required: ["text", "coding", "reaction", "search"],
        properties: { search: { type: ["string", "null"] } },
      });
    },
  );

  it.each([
    { text: "", search: "  " },
    { text: "", search: "a".repeat(501) },
    { text: "done", search: "heron" },
    { text: "", reaction: "heart", search: "heron" },
    {
      text: "",
      coding: { workspace: "garden", goal: "work" },
      search: "heron",
    },
  ])("rejects an invalid search query", async (reply) => {
    const provider = openAIProviderReturning(reply);
    await expect(
      provider.reply({ ...request, searchAvailable: true }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});
