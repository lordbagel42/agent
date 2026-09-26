# MCP adapter

`src/tools/mcp.ts` uses the official MCP TypeScript SDK. The integration owner
must add exact direct dependencies `@modelcontextprotocol/sdk: 1.30.1` and
`ajv: 8.20.0` and regenerate the root lockfile. No root configuration or startup
wiring is included in this independently owned workstream.

## Mounting

Construct one `McpToolAdapter` per approved remote tool from operator-owned
configuration, then register it under exactly `config.tool` in
`CapabilityBroker`'s `tools` map. Example (identifiers only; not credentials):

```ts
const adapter = new McpToolAdapter({
  id: "work-tools",
  tool: "mcp.work.create_issue",
  remoteTool: "create_issue",
  account: "work-account",
  item: "work-mcp-token",
  origin: "https://mcp.example.com",
  url: "https://mcp.example.com/mcp",
  allowedOrigins: ["https://mcp.example.com"],
});
// BrokerOptions.tools: { "mcp.work.create_issue": adapter }
```

The broker's `resolveCredential` must return `{ bearerToken: string }` only for
that exact account/item/origin scope. Do not expose adapters, credential resolvers,
or constructors to models. A `ToolAction.arguments` value is the remote tool's
argument object itself, **not** a server URL/tool-name/command envelope. Every
execution compares tool/account/item/origin to the frozen configuration, discovers
the configured tool, validates the arguments without coercion or defaults, and
sends that exact argument snapshot. The broker remains responsible for strict
JSON canonicalization, owner approval, durable intent, revocation, and replay
prevention. Never call `execute` outside that boundary.

`await adapter.discover(credential)` is an optional **trusted operator probe**.
It performs initialization and paginated discovery/schema checks, makes no tool
call, and returns only the configured `{ serverId, tool }`. It does not grant
authority. Server-supplied names other than the configured name, descriptions,
annotations, instructions, and results never create permissions. This adapter
discards result content even on success, consistent with the current broker's
privacy contract; it is not yet a model-facing result retrieval API. This also
prevents a server from echoing released credentials into model context.

Call `await adapter.close()` during application shutdown, before closing the
broker. It rejects new work, aborts active requests, and waits for local cleanup.
No credentials are persisted or logged. Tokens exist in operation-local memory
and HTTP Authorization headers; JavaScript cannot guarantee memory zeroization.
The optional second constructor argument is trusted fetch dependency injection
for offline tests, never a user-configurable transport bypass.

## Supported protocol and safety limits

- HTTPS Streamable HTTP, including JSON and POST SSE replies, with normal TLS
  verification. Endpoint paths are fixed; query strings, fragments, userinfo,
  redirects, and non-allowlisted origins are rejected. No dynamic URLs or commands.
- Per-operation sessions avoid sharing authenticated state between accounts.
  Bearer-token authentication only; no OAuth discovery, refresh, or upscoping.
  No stdio/legacy SSE transport, sampling, elicitation, roots, or required tasks.
  Optional GET event streams are not opened. Session deletion is best-effort
  within the operation deadline; servers must expire abandoned sessions.
- One total deadline (default 30 seconds, configurable 1–120000 ms), including
  initialization, discovery, call, and session cleanup. Progress cannot extend it.
  The default aggregate response budget is 1 MiB (configurable 1 KiB–4 MiB),
  enforced on decoded bytes before SDK JSON/SSE parsing. At most 16 discovery
  pages and 256 distinct tools; duplicate names fail closed.
- Strict JSON Schema 2020-12 validation with non-mutating Ajv. Unsupported schemas
  fail closed: no references, `$async`, regular-expression keywords, or formats;
  compiled input/output validators must be synchronous and return `true` to pass.
  Schema size/depth/node limits are 32 KiB/16/2000. These conservative limits reduce
  untrusted compiler work; they are not a process-isolation or hard CPU guarantee.
  Operators should review server schemas before enabling a tool. Structured output
  is validated when an output schema is advertised, including paginated discovery.
- `McpAdapterError.outcome` is `not_started` before tool dispatch and `unknown`
  after dispatch on timeout, cancellation, protocol/transport errors, oversized
  output, invalid output, or `isError`. Messages contain only fixed error codes,
  never remote payloads. Even an explicit tool error can follow a partial effect.
  Neither adapter nor SDK reconnects/retries tool calls. The broker conservatively
  retains its durable unknown receipt on **any** exception; do not retry that
  grant. Reconcile externally before deciding on a new owner-approved action.

An allowlisted server receives its scoped credential and is trusted to implement
the selected operation. This is not a network/process sandbox or a restriction
on what that remote service can do internally. Server identity is the configured
HTTPS endpoint (TLS), not its self-reported `serverInfo` name. Keep host allowlists
and configuration outside the model's writable authority. Never reuse a tool
registration for a different server or operation while old grants remain valid;
revoke outstanding grants before remapping a registration.

## Offline verification

`pnpm exec vitest run src/tools/mcp.test.ts` starts only ephemeral loopback fake
MCP HTTP servers. A trusted test fetch rewrites the fixed HTTPS fixture endpoint
to loopback; no personal server is contacted and TLS interoperability is not
tested. Checks exercise the official client handshake, paginated discovery,
JSON/SSE responses, exact arguments, scope/redirect/schema rejection, credential
non-disclosure, output limits, timeout/shutdown, and durable broker no-replay
behavior after ambiguous effects.

Authoritative SDK documentation:

- https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x
- https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/client.md
- https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/protocol.md
