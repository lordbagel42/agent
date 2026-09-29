import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  containsArtifactSecret,
  redactBrowserPin,
} from "../core/private-input.js";
import { PRIVATE_REFLECTION_REVIEW_PREFIX } from "../core/reflection-review.js";
import { RIVET_REPLY_PREFIX } from "../core/rivet.js";
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
  allowUnauthenticated?: boolean;
  /** Explicit operator review, NOT a server readOnlyHint. Enables read() only
   * for this exact tool contract; execute() continues discarding all output. */
  readContractDigest?: string;
}

/** Untrusted, ephemeral data. Never journal, log, or treat as instructions. */
export interface McpReadResult {
  text: string;
  truncated: boolean;
}

/** Compute from the operator-inspected tools/list entry, never auto-approve it.
 * Pins descriptions/annotations too: any changed contract needs fresh review. */
export function mcpToolContractDigest(tool: Tool): string {
  function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, child]) => child !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, sorted(child)]),
      );
    return value;
  }
  return createHash("sha256")
    .update(JSON.stringify(sorted(tool)))
    .digest("hex");
}

// Inspect the complete result before choosing content or truncating it. Text
// blocks often contain JSON with escaped Unicode; scan decoded values as well.
function containsPrivateInspection(value: unknown, depth = 0): boolean {
  if (depth > 32) return true; // Uninspectably deep results fail closed.
  if (typeof value === "string") {
    if (
      value.includes(RIVET_REPLY_PREFIX) ||
      containsArtifactSecret(value) ||
      value.includes(PRIVATE_REFLECTION_REVIEW_PREFIX)
    )
      return true;
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch {
      return false;
    }
    return containsPrivateInspection(decoded, depth + 1);
  }
  return (
    !!value &&
    typeof value === "object" &&
    Object.entries(value).some(
      ([key, child]) =>
        key.includes(RIVET_REPLY_PREFIX) ||
        containsArtifactSecret(key) ||
        key.includes(PRIVATE_REFLECTION_REVIEW_PREFIX) ||
        containsPrivateInspection(child, depth + 1),
    )
  );
}

function readText(text: string, token: string): McpReadResult {
  text = redactBrowserPin(text);
  // Remove the released credential before truncating, including common wire
  // encodings. A trusted remote server can encode secrets arbitrarily; this is
  // not a DLP sandbox and does not make a malicious server safe.
  for (const secret of new Set([
    token,
    encodeURIComponent(token),
    Buffer.from(token).toString("base64"),
  ]))
    if (secret) text = text.replaceAll(secret, "[credential redacted]");
  text = text.replace(/[\p{Cc}\p{Cf}]/gu, (c) =>
    c === "\n" || c === "\t" ? c : " ",
  );
  const bytes = Buffer.from(text);
  if (bytes.length <= 12_000) return { text, truncated: false };
  return {
    text: `${bytes
      .subarray(0, 11_980)
      .toString("utf8")
      .replace(/\uFFFD$/u, "")}\n[truncated]`,
    truncated: true,
  };
}

/** Shared privacy boundary for structured results from host-owned adapters. */
export function safeToolReadResult(
  value: unknown,
  token: string,
): McpReadResult {
  if (containsPrivateInspection(value))
    return { text: RIVET_REPLY_PREFIX, truncated: false };
  return readText(JSON.stringify(value), token);
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

/** Streamable HTTP MCP adapter; one statically registered tool per instance.
 * For mutations the broker MUST grant the action and persist unknown intent first.
 * No OAuth/upscoping, redirects, reconnects, task execution, sampling, roots,
 * elicitation, stdio, or server-instruction handling. Not a network sandbox.
 * execute() discards results. Explicitly reviewed read() returns bounded text;
 * caller must enforce its private audience and current read authorization.
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
      maxResponseBytes > 4194304 ||
      (config.readContractDigest !== undefined &&
        !/^[a-f0-9]{64}$/u.test(config.readContractDigest))
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

  /** Owner-triggered discovery only. Does not approve or invoke any tool. */
  async listTools(credential: unknown): Promise<Tool[]> {
    let tools: Tool[] = [];
    await this.#run(credential, undefined, undefined, (found) => {
      tools = found;
    });
    return tools;
  }

  async execute(
    action: ToolAction,
    credential: unknown,
    authorization?: (() => boolean) | AbortSignal,
  ): Promise<void> {
    // Preserve the host permission predicate; broker cancellation can also
    // prevent dispatch after discovery, without claiming remote stoppage.
    const authorized =
      typeof authorization === "function"
        ? authorization
        : authorization && (() => !authorization.aborted);
    await this.#invoke(action, credential, undefined, authorized);
  }

  /** Exact owner-approved effect through the broker, with a transient sanitized
   * reply. This is NOT a read grant and never retries or bypasses authorization. */
  async executeWithResult(
    action: ToolAction,
    credential: unknown,
    authorized: () => boolean,
  ): Promise<McpReadResult | undefined> {
    return this.#invoke(action, credential, undefined, authorized, true);
  }

  /** Only for operator-reviewed reads. This does not grant authorization and
   * must not wrap mutations. Rechecks current authority after async discovery.
   * No automatic OAuth, retry, or second tool call. */
  async read(
    action: ToolAction,
    credential: unknown,
    authorized: () => boolean,
  ): Promise<McpReadResult> {
    if (!this.#config.readContractDigest)
      throw new McpAdapterError("not_started");
    const result = await this.#invoke(action, credential, authorized);
    if (!result) throw new McpAdapterError("unknown");
    return result;
  }

  async #invoke(
    action: ToolAction,
    credential: unknown,
    read?: () => boolean,
    authorized?: () => boolean,
    captureResult = false,
  ): Promise<McpReadResult | undefined> {
    const config = this.#config;
    if (
      action.tool !== config.tool ||
      action.account !== config.account ||
      action.item !== config.item ||
      action.origin !== config.origin
    )
      throw new McpAdapterError("not_started");
    // Snapshot before the first await. Mutation callers must already have gone
    // through the broker's strict JSON canonicalization and exact grant binding.
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
    return this.#run(
      credential,
      args,
      read,
      undefined,
      authorized,
      captureResult,
    );
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
    read?: () => boolean,
    discovered?: (tools: Tool[]) => void,
    authorized?: () => boolean,
    captureResult = false,
  ): Promise<McpReadResult | undefined> {
    if (this.#closed) throw new McpAdapterError("not_started");
    let token = "";
    try {
      if (credential === undefined && this.#config.allowUnauthenticated) {
        credential = { bearerToken: "" };
      }
      if (!credential || typeof credential !== "object") throw new Error();
      const value = Object.getOwnPropertyDescriptor(
        credential,
        "bearerToken",
      )?.value;
      if (
        typeof value !== "string" ||
        (!/^[A-Za-z0-9._~+/-]+=*$/u.test(value) &&
          !(value === "" && this.#config.allowUnauthenticated)) ||
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
    // SDK close rejects requests immediately; it does not await transport I/O.
    const pending = new Set<Promise<unknown>>();
    const track = <T>(work: Promise<T>): Promise<T> => {
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    };
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: (input, init) =>
        track(
          (async () => {
            const target = input instanceof Request ? input.url : String(input);
            if (target !== config.url) throw new Error();
            // Unsolicited server streams are unnecessary; never open one.
            if (init?.method === "GET")
              return new Response(null, { status: 405 });
            const headers = new Headers(init?.headers);
            if (token) headers.set("authorization", `Bearer ${token}`);
            const signal = AbortSignal.any([
              controller.signal,
              ...(init?.signal ? [init.signal] : []),
            ]);
            signal.throwIfAborted();
            if (typeof init?.body === "string") {
              const message = JSON.parse(init.body);
              if (message.method === "tools/call") {
                // SDK transport header preparation yields after callTool().
                // Check again at actual HTTP dispatch, with no intervening await.
                if (
                  dispatched ||
                  (read && !read()) ||
                  (authorized && !authorized())
                )
                  throw new Error();
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
            // A fetch can settle after abort. Dispose its late body before draining.
            if (signal.aborted) {
              await response.body?.cancel();
              signal.throwIfAborted();
            }
            if (!response.body) return response;
            // Bound bytes before SDK JSON/SSE parsing, across the whole operation.
            const reader = response.body.getReader();
            let cancellation: Promise<void> | undefined;
            const finish = () => {
              signal.removeEventListener("abort", cancelBody);
              reader.releaseLock();
            };
            // A second reader.cancel() may resolve before the first cancellation
            // finishes. Keep the original promise, including underlying cleanup.
            const cancel = () =>
              (cancellation ??= track(
                reader
                  .cancel()
                  .catch(() => {})
                  .finally(finish),
              ));
            const cancelBody = () => {
              void cancel();
            };
            signal.addEventListener("abort", cancelBody, { once: true });
            const body = new ReadableStream<Uint8Array>({
              pull: (stream) =>
                track(
                  (async () => {
                    try {
                      const chunk = await reader.read();
                      if (chunk.done) {
                        stream.close();
                        if (!cancellation) finish();
                        return;
                      }
                      remainingBytes -= chunk.value.byteLength;
                      if (remainingBytes < 0) {
                        controller.abort();
                        await cancel();
                        throw new Error();
                      }
                      stream.enqueue(chunk.value);
                    } catch {
                      stream.error(new Error("mcp_transport_failed"));
                      await cancel();
                    }
                  })(),
                ),
              cancel,
            });
            return new Response(body, {
              status: response.status,
              headers: response.headers,
            });
          })(),
        ),
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
    // Abort rejects SDK requests and requests cancellation of transport I/O.
    const abort = () => void client.close().catch(() => {});
    controller.signal.addEventListener("abort", abort, { once: true });
    const options = { signal: controller.signal, timeout: config.timeoutMs };
    try {
      await client.connect(transport, options);
      let cursor: string | undefined;
      let selected: Tool | undefined;
      const names = new Set<string>();
      const tools: Tool[] = [];
      for (let page = 0; ; page++) {
        if (page >= 16) throw new Error();
        const result = await client.listTools({ cursor }, options);
        for (const tool of result.tools) {
          if (names.has(tool.name) || names.size >= 256) throw new Error();
          names.add(tool.name);
          tools.push(tool);
          if (tool.name === config.remoteTool) selected = tool;
        }
        cursor = result.nextCursor;
        if (cursor === undefined) break;
      }
      if (discovered) {
        discovered(tools);
        return;
      }
      if (!selected || selected.execution?.taskSupport === "required")
        throw new Error();
      const validate = compileSchema(selected.inputSchema);
      // SDK metadata caches are per-page; retain the selected output contract.
      const validateOutput = selected.outputSchema
        ? compileSchema(selected.outputSchema)
        : undefined;
      if (
        config.readContractDigest &&
        mcpToolContractDigest(selected) !== config.readContractDigest
      )
        throw new Error();
      if (args !== undefined) {
        if (
          !validate(args) ||
          (read && read() !== true) ||
          (authorized && authorized() !== true)
        )
          throw new Error();
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
        if (read || captureResult) {
          // Return only the marker so the caller can explain why this copy was
          // withheld without ever passing its body to ordinary synthesis.
          if (containsPrivateInspection(result))
            return { text: RIVET_REPLY_PREFIX, truncated: false };
          // No resource fetching, media, _meta, annotations, or server prompts.
          // Structured-only results remain data, serialized rather than executed.
          const content = result.content as { type: string; text?: string }[];
          const texts = content
            .filter(
              (block) =>
                block.type === "text" && typeof block.text === "string",
            )
            .map((block) => block.text);
          // Some servers put the reply in text and conversation IDs only in
          // structuredContent. Preserve both, within one shared privacy budget.
          const text =
            result.structuredContent === undefined
              ? texts.join("\n")
              : JSON.stringify({
                  structuredContent: result.structuredContent,
                  text: texts.join("\n"),
                });
          return readText(text, token);
        }
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
      // Closing the SDK is only an abort request. Keep this operation active
      // until every fetch, read, and body cancellation has actually settled.
      while (pending.size) await Promise.allSettled(pending);
      token = "";
      this.#active.delete(controller);
      finished.resolve();
    }
  }
}
