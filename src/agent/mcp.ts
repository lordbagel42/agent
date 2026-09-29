import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { operatorSchema } from "./operator.js";
import { type AgentService, sendMessageSchema } from "./service.js";
import { registerWebhookSchema, sendWebhookSchema } from "./webhooks.js";

const idSchema = z.strictObject({ id: z.uuid() });
const empty = z.strictObject({});

export function createAgentMcp(options: {
  service: AgentService;
  origin: string;
  status(): Promise<unknown>;
  operator(input: z.infer<typeof operatorSchema>): Promise<unknown>;
}) {
  const { service } = options;
  const expected = new URL(options.origin);
  const windows = new Map<
    string,
    { start: number; count: number; active: number }
  >();
  let globalStart = 0;
  let globalCount = 0;
  let active = 0;
  const tools = {
    get_status: {
      schema: empty,
      description:
        "June readiness and enabled capabilities; configuration is not proof of live provider health.",
      run: () => options.status(),
    },
    send_message: {
      schema: sendMessageSchema,
      description:
        "Send plain text into June's SHARED OWNER-PRIVATE conversation. For notifications, generate a webhook for your thread and supply its URL through register_webhook with reply/message events. Reuse the same idempotencyKey for retries. Acceptance is not completion. /approve and /resume-stopped retain their explicit command semantics.",
      run: (input: unknown, client: string) =>
        service.sendMessage(client, input),
    },
    read_messages: {
      schema: z.strictObject({
        after: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50).default(30),
      }),
      description:
        "Read shared owner-private history, including human and other agent messages. Cursor can expire after forgetting.",
      run: (input: { after?: string; limit: number }) =>
        service.readMessages(input.after, input.limit),
    },
    get_message: {
      schema: idSchema,
      description:
        "Inspect an admitted message's processing/reply and local outbox status. A local sent receipt does not prove callback acceptance.",
      run: ({ id }: { id: string }) => service.getMessage(id),
    },
    operator_request: {
      schema: operatorSchema,
      description:
        "Owner-level debugging and controls. Select a named operation, optional path id, and JSON body matching the operator API. Mutations retain confirmations: resume_job needs confirmedStopped:true and UUID idempotencyKey; forget_memory needs sourceId and confirmed:true; start_import needs confirmed:true,digest,expectedPages. Disabled features stay unavailable. Never confirm stoppage without evidence. No arbitrary URL or shell execution.",
      run: options.operator,
    },
    register_webhook: {
      schema: registerWebhookSchema,
      description:
        "Register an HTTPS callback within the configured destination policy. expiresAt is epoch milliseconds (up to 90 days). events selects reply/message. The signing key is returned ONLY on first creation; if its response is lost, revoke and register anew. All owner-trusted agents can manage registrations.",
      run: (input: unknown, client: string) =>
        service.webhooks.register(client, input),
    },
    list_webhooks: {
      schema: empty,
      description: "List callback metadata, never URLs or signing keys.",
      run: () => ({ webhooks: service.webhooks.list() }),
    },
    get_webhook: {
      schema: idSchema,
      description: "Inspect callback metadata by ID.",
      run: ({ id }: { id: string }) => service.webhooks.get(id) ?? null,
    },
    revoke_webhook: {
      schema: idSchema,
      description:
        "Revoke a callback before future dispatch. Already dispatched effects cannot be recalled.",
      run: ({ id }: { id: string }) => service.webhooks.revoke(id) ?? null,
    },
    send_webhook: {
      schema: sendWebhookSchema,
      description:
        "Durably queue one signed event to a registered callback. Reuse idempotencyKey for identical retries; uncertain dispatch is never automatically repeated. A queued receipt is not delivery.",
      run: (input: unknown, client: string) =>
        service.webhooks.enqueue(client, input),
    },
    get_webhook_delivery: {
      schema: idSchema,
      description:
        "Inspect queued/accepted/rejected/unknown callback receipt; HTTP acceptance is not downstream completion.",
      run: ({ id }: { id: string }) => service.webhooks.delivery(id) ?? null,
    },
    list_clients: {
      schema: empty,
      description:
        "List administrative MCP identities and expiry/revocation, never credentials.",
      run: () => ({ clients: service.clients() }),
    },
    revoke_client: {
      schema: z.strictObject({
        id: z.string().max(80),
        confirmed: z.literal(true),
      }),
      description:
        "Permanently revoke an MCP client ID, including yourself. Blocks future authentication and callbacks; cannot undo past disclosures/effects. Reissue under a new ID.",
      run: ({ id }: { id: string }) => service.revokeClient(id),
    },
    read_audit: {
      schema: z.strictObject({ after: z.number().int().min(0).default(0) }),
      description:
        "Read the last 10,000 content-free tool audit records, 100 per page.",
      run: ({ after }: { after: number }) => ({
        events: service.readAudit(after),
      }),
    },
  };

  return async (request: Request): Promise<Response> => {
    const headers = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    const fail = (status: number, error: string) =>
      Response.json({ error }, { status, headers });
    const now = Date.now();
    if (now - globalStart >= 60_000) {
      globalStart = now;
      globalCount = 0;
    }
    if (++globalCount > 600) return fail(429, "rate_limited");
    // Ignore forwarded headers; ingress must preserve the explicitly configured Host.
    if (
      (request.headers.get("host") ?? new URL(request.url).host) !==
        expected.host ||
      (request.headers.has("origin") &&
        request.headers.get("origin") !== options.origin) ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      return fail(403, "origin_denied");
    const client = service.authenticate(
      request.headers.get("authorization") ?? "",
    );
    if (!client) return fail(401, "unauthorized");
    if (request.method !== "POST") return fail(405, "post_only");
    let window = windows.get(client);
    if (!window) {
      window = { start: now, count: 0, active: 0 };
      windows.set(client, window);
    }
    if (now - window.start >= 60_000) {
      window.start = now;
      window.count = 0;
    }
    if (++window.count > 120 || window.active >= 4 || active >= 16)
      return fail(429, "rate_limited");
    window.active++;
    active++;
    const server = new Server(
      { name: "june-owner-agent", version: "1.0.0" },
      {
        capabilities: { tools: {} },
        instructions:
          "June supports callbacks to agent-provided thread webhooks. If your environment can generate a webhook for this thread, generate it and call register_webhook with its HTTPS URL, expiry, and events ['reply','message']. Set conversationId to match send_message for scoped automatic replies. June can then send notifications to that registered destination. The URL must satisfy the host destination policy and accept June's signed JSON envelope with message text in payload.text. Keep capability URLs and signing keys private. June does not need to create the thread webhook or integrate with your agent's API. Without a callback, poll get_message/read_messages.",
      },
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 128 * 1024,
    });
    try {
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: Object.entries(tools).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: z.toJSONSchema(tool.schema, {
            io: "input",
            unrepresentable: "any",
          }) as { type: "object" },
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (call) => {
        const name = call.params.name;
        if (!Object.hasOwn(tools, name))
          return {
            isError: true,
            content: [{ type: "text", text: "unknown_tool" }],
          };
        const tool = tools[name as keyof typeof tools];
        try {
          if (!service.clientActive(client)) throw new Error("agent_inactive");
          service.audit(client, name, "started");
          const input = tool.schema.parse(call.params.arguments ?? {});
          const result = await (
            tool.run as (input: unknown, client: string) => unknown
          )(input, client);
          const structuredContent = { result: result ?? null };
          const text = JSON.stringify(structuredContent);
          if (Buffer.byteLength(text) > 512 * 1024)
            throw new Error("result_too_large");
          service.audit(client, name, "completed");
          return { content: [{ type: "text", text }], structuredContent };
        } catch (error) {
          service.audit(client, name, "failed_or_uncertain");
          // Never echo Zod inputs, network errors, paths, URLs, or credentials.
          const code =
            error instanceof Error &&
            /^(webhook_|message_|agent_|cursor_|result_)[a-z_]+$/.test(
              error.message,
            )
              ? error.message
              : "request_failed_or_invalid";
          return { isError: true, content: [{ type: "text", text: code }] };
        }
      });
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      for (const [name, value] of Object.entries(headers))
        response.headers.set(name, value);
      return response;
    } catch {
      return fail(500, "mcp_request_failed");
    } finally {
      await server.close();
      window.active--;
      active--;
    }
  };
}
