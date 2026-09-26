# Credential host wiring

`createBitwardenCredentialResolver` uses the supported Password Manager CLI:
[`bw get item <UUID>`](https://bitwarden.com/help/cli/), with the unlocked session
in `BW_SESSION`, not command arguments. An API-key login alone does not unlock
vault data. The owner must provision a dedicated CLI profile and unlock it through
Bitwarden's supported flow. This module never logs in, enrolls credentials, lists
the vault, starts `bw serve`, or uses undocumented endpoints.

The documented [Secrets Manager machine-account access](https://bitwarden.com/help/developer-quick-start/)
is scoped to Secrets Manager secrets/projects. It is not evidence of access to an
existing personal Password Manager vault. No agent-specific personal-vault API
was verified for this implementation; the supported CLI is the narrow fallback.
Documentation was checked via Context7's Bitwarden documentation index and the
official CLI page (including `--nointeraction` and `BITWARDENCLI_APPDATA_DIR`).
No live vault was accessed.

## Trusted host setup

1. Run Node 24+ and install an owner-reviewed `bw` executable outside the model's
   writable checkout. Pass its absolute path and an absolute private
   `appDataDir`. Use a dedicated owner-provisioned CLI profile, not an interactive
   user's shared profile. The host must protect the profile, session provider,
   bindings, executable, broker code and SQLite directory against model writes.
   Use a private directory (0700) and restrictive file creation mask (0077).
2. Build `createBitwardenCredentialResolver({ executable, appDataDir, bindings,
   session })`. Each binding is `{account, item, origin, vaultItemId, field}`;
   `account` and `item` are non-secret aliases, `origin` is an exact canonical
   HTTPS origin, `vaultItemId` is an exact UUID, and `field` is `bearer` or
   `login`. The former returns `{bearerToken}` from the login item's password
   field, the latter `{kind:"login",username,password}`.
   An explicit owner mapping is authoritative, not the vault's permissive URI
   matching rules. Changes require a new resolver; do not take bindings from a
   model request. No secret material belongs in JSON config or action arguments.
3. Supply a trusted `session(): Promise<{key,expiresAt}>` callback from protected
   host state. It must refuse unavailable/revoked sessions. Local leases must
   have at most 60 seconds remaining. CLI reads have a 15-second maximum timeout,
   with no cache and no inherited environment other than a fixed system PATH.
   The session exists only in trusted memory and the child environment. `bw`
   must be runnable using that PATH; set up a trusted launcher if necessary.
   Do not pass the session into the model runtime's environment.
4. Construct `new CapabilityBroker(privateDbPath, {owner,tools,resolveCredential})`.
   `tools` must contain trusted, fixed-destination adapters. Both MCP and browser
   adapters retain `execute(action, credential): Promise<unknown>`. They must
   enforce the approved origin through redirects/subrequests, never log secrets,
   never persist credentials/browser sessions, and never retry side effects.
   Resolve only on confirmed success. Results and exceptions are not exposed.
   Keep registry/adapter settings immutable while grants exist; revoke outstanding
   grants before changing a tool's destination, remote method or recipe. Those
   implementation details are not separately included in the action fingerprint.
   Read-only history-import tokens must be separately provisioned, not borrowed
   from these action credentials. Anonymous null/undefined credentials require an
   explicit trusted host policy; the vault resolver never falls back to anonymous.
5. Mount `createCapabilityRoutes({broker,owner,operatorToken,consoleOrigin?})`
   at `/operator/capabilities`. Use the same trusted owner identifier as the
   broker. It independently verifies bearer authentication and rejects foreign
   Origin/cross-site requests. Omit `consoleOrigin` for non-browser-only use.
   Use TLS; disable request-body/header logging in proxies, tracing and host
   middleware. Do not give the model the owner token, broker, or resolver.
   Worker-facing wrappers bind their principal from trusted authentication,
   and expose only proposal validation and exact-grant execution.

## Owner API

All routes require bearer authentication. GET never approves or executes.

| Method/path (relative to mount) | Body / response |
| --- | --- |
| POST `/proposals` | `ToolAction` → validated snapshot (not an approval) |
| POST `/grants` | `{audience,action,expiresAt}` → `{grantId}`; audience must equal owner, lifetime ≤5 minutes |
| POST `/grants/:id/execute` | Exact `ToolAction` → receipt; only owner-audience grants |
| POST `/grants/:id/revoke` | No body → `{revoked:true}` |
| POST `/grants/:id/cancel` | No body → `{revoked:true,receipt}` |
| POST `/grants/:id/reconcile` | `{confirmedStopped:true,outcome:"succeeded"\|"failed"}` → receipt |
| GET `/grants/:id/receipt` | `{receipt}` including revoked/expired grants; null before execution |
| GET `/audit?after=0` | `{events}`; 100 metadata-only events, use last sequence for next page |

SQLite keeps grant identifiers, audiences, action digests, expiry/revocation,
receipts and audit events—not arguments, credentials, adapter output or errors.
Audit is local operational history, not a tamper-proof log against the host.
Existing databases are upgraded additively; prior events cannot be reconstructed.
`broker.matchesGrant(owner, grantId, action)` lets the trusted host find an exact
matching named, non-secret operator action for link redemption without storing
arbitrary payloads. It is owner-only inspection, including revoked/expired grants,
not authorization; execution still checks audience, expiry and revocation.

## Cancellation and reconciliation

One durable `unknown` receipt is committed before credential resolution. A
second call or restart never automatically retries that grant. Expiry/revocation
are checked again in an atomic adapter-admission transaction after resolution.
Cancellation before admission prevents execution. After admission it only blocks
future admissions: it cannot recall an external request, interrupt an arbitrary
adapter, undo an effect or invalidate a password. `unknown` is intentionally
conservative even when failure happened before an external effect.

For an unknown result, stop/verify the previous worker and inspect the external
system out of band. Then the owner can reconcile it as succeeded or failed.
Reconciliation refuses a locally active execution, requires explicit confirmation,
records the decision, revokes the grant and **never reopens it**. Across processes
the owner must actually establish quiescence; the checkbox cannot prove it.
A new approval is required for any intentional retry. Do not issue it while the
old effect is ambiguous. Reconciliation does not make external effects exactly-once.

The five-minute grant and sixty-second local session lease limit **admission**,
not the actual validity of a vault password or a running adapter. An unlocked
Bitwarden session remains valid until owner lock/logout; password revocation
requires the corresponding provider action. Neither JavaScript strings nor child
environment variables provide secure erasure. This is an application policy
boundary, **not an OS sandbox or protection against the host account itself**.
