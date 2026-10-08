# MCP adapter

`src/tools/mcp.ts` uses the pinned official MCP TypeScript SDK (`1.30.1`) and
Ajv (`8.20.0`). With MCP configured, `main.ts` mounts the authenticated
[Connections](mcp-connections.md) interface, including dedicated Amp consent on
an HTTPS console. June can use the enabled catalog from admitted tasks, judging
legitimacy, safety and result disclosure at runtime; an owner-private conversation
or per-action human approval is not an ordinary prerequisite. Reads run directly.
Fresh effects retain the stored policy name `approval`, but persist exact arguments
and execute immediately through a durable one-use grant and receipt. Remote MCP
adapters can return bounded, sanitized transient results; receipts never store
those bodies. Legacy pending proposals never auto-execute, disabled tools remain
disabled, and unknown outcomes never auto-retry.

The explicit public-web research specialist ceiling remains read-only: only
host-selected enabled read connections are available, with no effects, built-in
integrations, enrollment or permission changes. Credentials, OAuth consent and
authenticated administration remain separate controls on every path.
The optional narrower `createPuckConnection` boundary below is not mounted by the
default runtime; its presence alone does not establish Amp access.

## Mounting

Construct one `McpToolAdapter` per configured remote tool from operator-owned
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
JSON canonicalization, exact host-issued grants, durable intent, revocation and
replay prevention. Never call `execute` outside that boundary.

`await adapter.discover(credential)` is an optional **trusted operator probe**.
It performs initialization and paginated discovery/schema checks, makes no tool
call, and returns only the configured `{ serverId, tool }`. It does not grant
authority. Server-supplied names other than the configured name, descriptions,
annotations, instructions, and results never create permissions. `execute`
discards result content even on success, consistent with the broker's privacy
contract. `read` returns bounded, redacted evidence under its pinned read contract;
the mounted effect path uses `executeWithResult` under the exact broker grant.
Its transient result is not a read classification or permission to repeat an
effect. Only the synthesized answer enters conversation history. Legacy cached
Puck replies remain one-use, expire within ten minutes and disappear on restart
or revocation; absence is not permission to resend.

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
  grant. Verify external state and worker stoppage, then use authenticated
  reconciliation before deciding on any new action.

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
health. This optional boundary only produces coding proposals; it does not
execute tasks. The mounted runtime's fresh-task execution policy is separate.

`createPuckOAuth` in `src/tools/puck-oauth.ts` supplies the dedicated bootstrap
using the SDK's authorization-code/S256/CIMD flow. It pins the Amp issuer and
resource, accepts one expiring callback state, and attempts one token exchange.
Standalone hosts must publish metadata at the exact public HTTPS client ID URL,
bind the exact HTTPS or loopback callback, obtain owner consent, verify identity
and persist tokens outside repositories/journals. Do not import CLI or browser
credentials.

`createPuckConsoleOAuth` supplies that identity and storage boundary for June's
console: owner-bound attempt, connection-generation check, signed RS256 ID-token
verification against Amp's pinned issuer/JWKS, and nonce/audience/expiry checks.
Only an authenticated same-origin confirmation POST exchanges the code. The
runtime mounts static client metadata, but an authorized operator must make its
exact path publicly fetchable through ingress. The owner still needs to consent
and save the connection; authenticated discovery supplies actual tool contracts.
New contracts default to the effect policy, while saved disabled decisions are
preserved. Discovery and configuration are not proof of live success. The first
console flow requests no refresh grant; expired access needs reconnect. See
[activation gates](mcp-connections.md#amp-consent-and-activation-gates).

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
