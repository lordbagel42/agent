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

## Generic capability host

The generic broker is absent by default. An optional
`"capabilities": { "directory": "/var/lib/june/capabilities" }` in June's config
mounts `/operator/capabilities` using the existing operator token and optional
console origin. The directory must already exist, be canonical, owner-only
(0700), owned by the service user, and outside repositories. This setting creates
the digest-only `capabilities.sqlite`; it **does not register any tools, resolve
credentials, or issue grants**. Browser/vault adapters need separate reviewed host
wiring and activation. MCP connections keep their existing integration.

Ask June to inspect generic capabilities in an admitted task. The June-callable directive
is `{"text":"","inspection":"capabilities"}`; it reports disabled/mounted
status and registration count without credentials, payloads, or authorization.
An owner-private conversation is not an ordinary tool prerequisite. June judges
task legitimacy, safety and audience; invocation ceilings still apply. The generic
broker is not exposed as a model-controlled grant API. Configured browser recipes
and MCP effects use trusted host wrappers to issue exact durable grants and run
fresh actions without compulsory human approval. Operator API entry points are
listed below; mounting and registration are not live health or execution evidence.

## June's metadata-only inspection

In an admitted task, ask June to inspect credential bindings. The
discoverable directive is `{"text":"","inspection":"credentials"}`, with no
other actions. This is metadata-only inspection, not a secret-reading tool.
The direct path sends a timestamped report without another model pass; an
execution worker can inspect the bounded report before answering. June judges
appropriate disclosure; synthesis and explicit specialist ceilings remain.
Nothing bypasses secret/PIN protections, login, enrollment or authenticated
administration. Operator endpoints keep their existing authentication.

`createBitwardenCredentialResolver` remains callable by the broker and also
exposes `inspect()`. This returns the validated snapshot's binding count and at
most ten entries containing only configuration-order numbers and field types
(`login` or `bearer`). It never calls the session provider or CLI, even if a
session is available, and never includes operator strings, vault IDs, paths,
credential values, auth tokens or vault item bodies. Reading or modifying a
returned snapshot cannot change resolver bindings.

Current startup passes only `{inspect: resolver.inspect}` as `credentials` to
`createInspectionReader`. The browser broker uses this same resolver only for
separately configured `browser.credentialOperations`, after exact recipe validation
and broker authorization; anonymous recipes never consult it. Without the inspection dependency June
reports the resolver **absent**; a configured resolver reports
its binding count, including zero. Vault authentication and item availability
remain **unverified**, not inferred from configuration or earlier resolution.
Inspection never unlocks, resolves, authorizes, enables, or tests credentials.
The default startup has no Bitwarden resolver and therefore reports absent;
this slice does not provision a profile/session or activate vault access.

## Opt-in host configuration

The optional top-level `credentials` configuration contains only host paths and
explicit bindings, never a session key, password, or model-selected vault search:

```json
{
  "credentials": {
    "executable": "/opt/bitwarden/bw",
    "appDataDir": "/var/lib/june-vault/profile",
    "sessionFile": "/run/june-vault/session.json",
    "bindings": [{
      "account": "mail",
      "item": "login",
      "origin": "https://mail.example",
      "vaultItemId": "12345678-1234-1234-1234-123456789abc",
      "field": "login"
    }]
  }
}
```

Absent configuration creates no resolver. Configuring it does not unlock a vault
or approve a browser operation. The host requires canonical private owner-only
profile and lease-parent directories outside repositories. Keep the executable,
profile and lease outside model-writable storage; same-account native coding is
not a secret isolation boundary. Use private tmpfs for the lease when available.

The owner separately provisions a mode-0600 regular JSON lease file containing
`{key, expiresAt}` (Unix milliseconds); the resolver requires at most 60 seconds
remaining. It reads that file only after an exact bound scope is requested, not
at startup or during June's `inspection: "credentials"`. Reads reject symlinks,
hard links, nonregular/group-accessible files, oversized or malformed content.
There is no session cache, renewal, unlock automation, or environment variable
handoff to the model. A missing/expired lease yields only `credential_unavailable`.
Inspection reports configured metadata with authentication and item availability
still **unverified**; it is not evidence that an operation is permitted or usable.

Credentialed browser integration calls `resolver.assertBrowserBinding(recipe)`
at startup and before resolving: account and item aliases, canonical origin and credential kind
must all match the same validated resolver snapshot. Anonymous or mixed-credential
recipes cannot use this check to fall back to a vault credential. Account aliases
are explicit owner mappings to exact item UUIDs, not proof of the website's logged-in
identity or the vault's signed-in account. Hostnames, ports and schemes are never
approximately matched: subdomains, lookalikes, alternate ports and userinfo URLs
do not inherit a binding. All browser redirects, even same-origin, remain denied.
The browser integration separately owns exact-operation authorization and isolated
execution; this configuration alone exposes no secret-reading tool to June.
`browserProposal: {operation:null}` discovers configured names without resolving
credentials. Selecting an exact name runs that configured recipe through a durable
one-use grant and receipt, including host-resolved credential references when
configured. It cannot add steps, reveal credentials or enroll another account.
Historical pending proposals stay inert and unknown outcomes never auto-retry.

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
   Resolve only on confirmed success. Broker receipts never store adapter output
   or exceptions; remote MCP's separate transient-result boundary sanitizes content
   before model use. Browser execution receipts expose no page text or secrets.
   Browser adapters additionally support `executeWithCredentialResolver`: the
   broker supplies a one-use callback, and the browser validates the recipe before
   invoking it. Grant/link expiry and revocation are rechecked after lookup before
   returning the secret. The broker's host resolver also receives the exact action
   as an optional second argument, allowing anonymous and credentialed recipes at
   the same scope to remain distinct. Never route anonymous operations to a vault.
   The broker snapshots its options and registered execute methods at construction;
   later caller-side registry or method replacements do not change existing bindings.
   Adapter-internal settings and callback closures still need trusted immutable
   destination policy. Across restarts, reject registration drift or use a database
   namespace bound to the immutable registration digest; revoke outstanding grants
   before changing a tool's destination, remote method or recipe. Those details
   are not separately included in the action fingerprint.
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

## Authenticated operator API

All routes retain bearer authentication and same-origin checks. Broader task-tool
availability does not expose these administrative routes or credentials to June.
GET never approves or executes.

| Method/path (relative to mount) | Body / response |
| --- | --- |
| GET `/status` | `{mounted:true,registeredTools}`; metadata only, not grants or live health |
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
A fresh exact grant is required for any intentional retry. Do not issue it while the
old effect is ambiguous. Reconciliation does not make external effects exactly-once.

The five-minute grant and sixty-second local session lease limit **admission**,
not the actual validity of a vault password or a running adapter. An unlocked
Bitwarden session remains valid until owner lock/logout; password revocation
requires the corresponding provider action. Neither JavaScript strings nor child
environment variables provide secure erasure. This is an application policy
boundary, **not an OS sandbox or protection against the host account itself**.
