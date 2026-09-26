import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ToolAction, ToolAdapter } from "./broker.js";

/** Operator-owned configuration. Never construct this from model output. */
export interface McpToolConfig {
  id: string;
  tool: string;
  remoteTool: string;
  account: string;
  item: string;
  origin: string;
  url: string;
  allowedOrigins: readonly string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class McpAdapterError extends Error {
  constructor(readonly outcome: "not_started" | "unknown") {
    super(`mcp_${outcome}`);
    this.name = "McpAdapterError";
  }
}

// Schemas are untrusted executable input to a compiler. Bound complexity and
// reject regex/reference extensions instead of fetching or executing them.
function compileSchema(schema: object) {
  if (Buffer.byteLength(JSON.stringify(schema)) > 32768) throw new Error();
  let nodes = 0;
  function visit(value: unknown, depth: number) {
    if (++nodes > 2000 || depth > 16) throw new Error();
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        [
          "$ref",
          "$dynamicRef",
          "$async",
          "pattern",
          "patternProperties",
          "format",
        ].includes(key)
      )
        throw new Error();
      visit(child, depth + 1);
    }
  }
  visit(schema, 0);
  const validate = new Ajv2020({
    strict: true,
    allErrors: false,
    // No coercion, defaults, or removal: granted arguments must not change.
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  }).compile(schema);
  // An async Ajv validator returns a truthy Promise, not a validation verdict.
  // Enforce the same synchronous contract for input, output, and SDK callbacks.
  if ("$async" in validate) throw new Error();
  return (input: unknown): boolean => validate(input) === true;
}

/** Streamable HTTP MCP adapter; one statically registered broker tool per instance.
 * The broker MUST grant the complete action and persist unknown intent first.
 * No OAuth/upscoping, redirects, reconnects, task execution, sampling, roots,
 * elicitation, stdio, or server-instruction handling. Not a network sandbox.
 * Results/descriptions never become authority and are deliberately discarded.
 */
export class McpToolAdapter implements ToolAdapter {
  readonly #config: Readonly<McpToolConfig>;
  readonly #fetch: typeof fetch;
  readonly #active = new Map<AbortController, Promise<void>>();
  #closed = false;

  constructor(
    config: McpToolConfig,
    /** Trusted dependency injection for offline tests, never runtime input. */
    dependencies: { fetch?: typeof fetch } = {},
  ) {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new McpAdapterError("not_started");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.origin !== config.origin ||
      !config.allowedOrigins.includes(url.origin) ||
      ![
        config.id,
        config.tool,
        config.remoteTool,
        config.account,
        config.item,
      ].every(
        (value) =>
          typeof value === "string" && /^[\x21-\x7e]{1,256}$/u.test(value),
      )
    )
      throw new McpAdapterError("not_started");
    const timeoutMs = config.timeoutMs ?? 30000;
    const maxResponseBytes = config.maxResponseBytes ?? 1048576;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120000 ||
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes < 1024 ||
      maxResponseBytes > 4194304
    )
      throw new McpAdapterError("not_started");
    this.#config = Object.freeze({
      ...config,
      url: url.href,
      allowedOrigins: Object.freeze([...config.allowedOrigins]),
      timeoutMs,
      maxResponseBytes,
    });
    this.#fetch = dependencies.fetch ?? fetch;
  }

  /** Trusted operator probe only. Does not grant permission or return server text. */
  async discover(
    credential: unknown,
  ): Promise<{ serverId: string; tool: string }> {
    await this.#run(credential);
    return { serverId: this.#config.id, tool: this.#config.tool };
  }

  async execute(action: ToolAction, credential: unknown): Promise<void> {
    const config = this.#config;
    if (
      action.tool !== config.tool ||
      action.account !== config.account ||
      action.item !== config.item ||
      action.origin !== config.origin
    )
      throw new McpAdapterError("not_started");
    // Snapshot before the first await; the broker already canonicalized strict JSON.
    let args: Record<string, unknown>;
    try {
      const encoded = JSON.stringify(action.arguments);
      if (Buffer.byteLength(encoded) > 65536) throw new Error();
      args = JSON.parse(encoded);
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error();
    } catch {
      throw new McpAdapterError("not_started");
    }
    await this.#run(credential, args);
  }

  /** Stops local work; cancellation is NOT proof that a remote effect stopped. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#active.keys()) controller.abort();
    await Promise.all(this.#active.values());
  }

  async #run(
    credential: unknown,
    args?: Record<string, unknown>,
  ): Promise<void> {
    if (this.#closed) throw new McpAdapterError("not_started");
    let token: string;
    try {
      if (!credential || typeof credential !== "object") throw new Error();
      const value = Object.getOwnPropertyDescriptor(
        credential,
        "bearerToken",
      )?.value;
      if (
        typeof value !== "string" ||
        !/^[A-Za-z0-9._~+/-]+=*$/u.test(value) ||
        value.length > 8192
      )
        throw new Error();
      token = value;
    } catch {
      throw new McpAdapterError("not_started");
    }
    const config = this.#config;
    const controller = new AbortController();
    const finished = Promise.withResolvers<void>();
    this.#active.set(controller, finished.promise);
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let dispatched = false;
    let remainingBytes = config.maxResponseBytes ?? 1048576;
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: async (input, init) => {
        const target = input instanceof Request ? input.url : String(input);
        if (target !== config.url) throw new Error();
        // Unsolicited server streams are unnecessary; never open one.
        if (init?.method === "GET") return new Response(null, { status: 405 });
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${token}`);
        const signal = AbortSignal.any([
          controller.signal,
          ...(init?.signal ? [init.signal] : []),
        ]);
        signal.throwIfAborted();
        if (typeof init?.body === "string") {
          const message = JSON.parse(init.body);
          if (message.method === "tools/call") {
            if (dispatched) throw new Error();
            dispatched = true;
          }
        }
        const response = await this.#fetch(input, {
          ...init,
          headers,
          signal,
          redirect: "error",
          credentials: "omit",
        });
        if (!response.body) return response;
        // Bound bytes before SDK JSON/SSE parsing, across the whole operation.
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(stream) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                stream.close();
                reader.releaseLock();
                return;
              }
              remainingBytes -= chunk.value.byteLength;
              if (remainingBytes < 0) {
                controller.abort();
                await reader.cancel();
                throw new Error();
              }
              stream.enqueue(chunk.value);
            } catch {
              stream.error(new Error("mcp_transport_failed"));
            }
          },
          cancel: () => reader.cancel(),
        });
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      },
    });
    const client = new Client(
      { name: "june", version: "0.1.0" },
      {
        capabilities: {},
        jsonSchemaValidator: {
          getValidator: <T>(schema: object) => {
            const validate = compileSchema(schema);
            return (input: unknown) =>
              validate(input)
                ? {
                    valid: true as const,
                    data: input as T,
                    errorMessage: undefined,
                  }
                : {
                    valid: false as const,
                    data: undefined,
                    errorMessage: "invalid_output",
                  };
          },
        },
      },
    );
    // Abort closes outstanding SDK requests as well as underlying fetch streams.
    const abort = () => void client.close().catch(() => {});
    controller.signal.addEventListener("abort", abort, { once: true });
    const options = { signal: controller.signal, timeout: config.timeoutMs };
    try {
      await client.connect(transport, options);
      let cursor: string | undefined;
      let selected: Tool | undefined;
      const names = new Set<string>();
      for (let page = 0; ; page++) {
        if (page >= 16) throw new Error();
        const result = await client.listTools({ cursor }, options);
        for (const tool of result.tools) {
          if (names.has(tool.name) || names.size >= 256) throw new Error();
          names.add(tool.name);
          if (tool.name === config.remoteTool) selected = tool;
        }
        cursor = result.nextCursor;
        if (cursor === undefined) break;
      }
      if (!selected || selected.execution?.taskSupport === "required")
        throw new Error();
      const validate = compileSchema(selected.inputSchema);
      // SDK metadata caches are per-page; retain the selected output contract.
      const validateOutput = selected.outputSchema
        ? compileSchema(selected.outputSchema)
        : undefined;
      if (args !== undefined) {
        if (!validate(args)) throw new Error();
        controller.signal.throwIfAborted();
        const result = await client.callTool(
          { name: config.remoteTool, arguments: args },
          undefined,
          options,
        );
        if (
          result.isError ||
          (validateOutput && !validateOutput(result.structuredContent))
        )
          throw new Error();
        // Never expose arbitrary server content or echoed credentials to the model.
      }
    } catch {
      throw new McpAdapterError(dispatched ? "unknown" : "not_started");
    } finally {
      // Best effort session deletion within the same operation deadline; never retry.
      if (!controller.signal.aborted)
        await transport.terminateSession().catch(() => {});
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      await client.close().catch(() => {});
      token = "";
      this.#active.delete(controller);
      finished.resolve();
    }
  }
}
