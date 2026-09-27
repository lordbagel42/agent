# MCP adapter

`src/tools/mcp.ts` uses the pinned official MCP TypeScript SDK (`1.30.1`) and
Ajv (`8.20.0`). General execution remains receipt-only. The optional Puck
connector adds a separately reviewed private read boundary; neither path is
mounted by `main.ts` without dedicated authorization and host wiring.

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
annotations, instructions, and results never create permissions. `execute`
discards result content even on success, consistent with the broker's privacy
contract. Only the private read boundary below can return bounded, redacted
evidence; ordinary tool receipts never carry server content into model context.

Call `await adapter.close()` during application shutdown, before closing the
broker. It rejects new work, requests abort, and drains actual fetches, body reads,
and body cancellation promises, including bodies returned after abort. Neither
execution nor shutdown settles merely because the SDK reports a closed transport.
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
  within the operation deadline; servers must expire abandoned sessions. Failure
  to delete a session does not invalidate an already validated successful tool reply.
- One cancellation deadline (default 30 seconds, configurable 1–120000 ms),
  covering initialization, discovery, call, and session deletion. Progress cannot
  extend it. Draining continues until transport cleanup actually settles; a
  transport that ignores cancellation can delay execution/shutdown beyond this
  deadline. This is not a hard wall-clock bound or proof of remote cancellation.
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

## Puck private reads and dedicated consent

`createPuckConnection` in `src/tools/puck.ts` fixes the endpoint to
`https://ampcode.com/mcp`. Configure only actual read/search tools reviewed from
an authenticated `tools/list`, pin their contract digest, and supply a trusted
schema-specific argument policy limited to June's own saved coding threads.
The local operation names are not claims about remote tool names. No broad
discovery, mutation, automatic retry, or deployment capability is enabled.

Reads require a current dedicated grant for the verified owner/account and
the exact private audience. A result is a one-use closure for that turn,
rechecked at consumption, capped at 12 KB and secret-redacted. Treat it as
untrusted evidence; never persist or journal its text. Capability status reports
configuration, missing authorization, and the last verified request, not live
health. Coding requests remain proposals for the existing approval supervisor.

`createPuckOAuth` in `src/tools/puck-oauth.ts` supplies an operator-only bootstrap
using the SDK's authorization-code/S256/CIMD flow. It pins the Amp issuer and
resource, accepts one expiring callback state, and attempts one token exchange.
Before use, the host must publish its generated metadata at the exact public
HTTPS client ID URL, bind/forward the exact loopback callback, obtain owner
consent, verify identity, and persist tokens outside repositories/journals.
Refresh and revocation remain credential-store responsibilities. Request
`offline_access` only when unattended refresh is intended. Do not import CLI or
browser credentials. No metadata host, callback, token store, live grant, or
authenticated tool registration is configured by the default runtime.

## Offline verification

`pnpm exec vitest run src/tools/mcp.test.ts` starts only ephemeral loopback fake
MCP HTTP servers. A trusted test fetch rewrites the fixed HTTPS fixture endpoint
to loopback; no personal server is contacted and TLS interoperability is not
tested. Checks exercise the official client handshake, paginated discovery,
JSON/SSE responses, exact arguments, scope/redirect/schema rejection, credential
non-disclosure, output limits, timeout/shutdown, rejection of asynchronous schemas,
and durable broker no-replay behavior after ambiguous effects. Shutdown regressions
hold a fetch past abort and hold body cancellation pending, then verify execution
and `close()` wait for actual settlement rather than just the SDK close event.

Authoritative SDK documentation:

- https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x
- https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/client.md
- https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/protocol.md
