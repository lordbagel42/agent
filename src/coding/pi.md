# Pi coding runtime

`createPiRuntime` implements June's unchanged `CodingRuntime` contract using
Pi's supported JSONL RPC interface. No Pi SDK dependency is loaded into June.
The operator must install and pin an absolute executable for
`@earendil-works/pi-coding-agent` **0.87.1** (the upstream Pi coding agent,
formerly `mariozechner/pi-mono`, not Rivet's transitive agentOS Pi).

Configure `executable`, exact `provider` and `model`, dedicated absolute
`agentDir` and `sessionDir`, explicit `env` (including sandbox `HOME` and `PATH`),
and `hostSandboxAcknowledged: true`. `HOME` must be absolute. `timeoutMs` defaults
to 30 minutes and accepts positive integer milliseconds through 2,147,483,647.
The adapter checks Pi's resolved provider/model before dispatching work, so
fuzzy CLI model fallback cannot silently select a different model.

```ts
createPiRuntime({
  executable, provider, model, agentDir, sessionDir, env,
  hostSandboxAcknowledged: true,
  timeoutMs, // optional
  spawnProcess, // optional typeof node:child_process.spawn, for offline fixtures
});
// run({ prompt, cwd, threadId?, signal, onThread }) -> { threadId, report }
```

The factory and `PiRuntimeOptions`/`PiRuntimeError` exports live in `pi.ts`.
This is a POSIX subprocess adapter, not root configuration or a runtime registry.

## Authentication and isolation

The operator must explicitly provision Pi's own `auth.json` in `agentDir` through
Pi's supported API-key or provider-specific `/login` flow, or supply a supported
provider API-key environment variable in `env`. No interactive authentication is
performed by June. There is no ambient parent-environment inheritance. Never copy
another coding tool's subscription tokens here or relabel OAuth tokens as API
keys. Examples of supported API-key variables are `OPENAI_API_KEY` and
`ANTHROPIC_API_KEY`. Pi-managed OAuth remains provider-specific: upstream Pi
support is not proof the provider permits a subscription for this autonomous
use. The operator must verify that separately; this adapter does not implement
provider login or credential conversion. Pi settings/models/auth files are
trusted operator input; they can contain commands, custom endpoints and
credentials. Use a dedicated sandbox HOME, not a personal home directory. Do not
spread `process.env` into this configuration.

**Pi's built-in read/write/edit/bash tools are not permission-scoped to `cwd`.**
The acknowledgment is an explicit opt-in, not a sandbox implementation. Run the
worker under a dedicated OS/container sandbox with only the approved worktree,
dedicated Pi credentials/session storage, controlled network, and no June service
credentials, personal files, deployment keys, host sockets, or unrelated mounts.
The executable can be an operator-owned sandbox launcher that preserves stdio,
arguments, paths and signals. The adapter disables discovered extensions,
skills, templates and themes, and passes `--no-approve` so a saved trust decision
cannot enable project `.pi` settings or packages. Repository context files still
load; neither those instructions nor Pi's own tools are a security boundary.
Credentials visible to a worker remain accessible to its tools; scope them
appropriately. Keep session storage operator-controlled and
private, outside the repository. This adapter does not defend against a hostile
same-UID process racing or rewriting that storage; enforce separation externally.

## Continuity and outcomes

Pi itself generates the UUID in an initially empty explicit session file. June
validates and syncs that native v3 header, stores a private UUID-to-session/workspace
binding, syncs directory entries, and awaits `onThread` before submitting any
prompt. On resume, both the registry binding and native header must contain the
same UUID and canonical workspace; Pi uses the header's cwd, not merely the child
process cwd. Empty or changed headers, arbitrary paths, partial UUID lookup,
symlinked binding/session paths, unknown IDs, and replacement IDs reject before
prompting. Header mismatches on resume reject before spawning. No ID is generated
from message text. A per-session lock prevents concurrent launches. A crash or
unconfirmed shutdown leaves locks for explicit operator reconciliation; never
clear one automatically and retry a possibly executed prompt. Supervisor admission
remains authoritative after failed/unknown execution even when this adapter has
reaped its process. Resume still requires a new supervisor command and confirmed
stoppage; the adapter does not authorize that transition itself.

`agent_end` and assistant text alone are not completion. The adapter requires
`agent_settled`, a final assistant message with `stopReason: stop`, a nonempty
report, orderly exit code 0, and a matching final assistant message in the synced
session records appended by this invocation; an identical earlier answer does
not qualify. Pi emits `message_end` before its disk append and can settle
in a `finally` path; a streamed report alone does not prove persistence succeeded.
Reports are capped at 32,000 characters, JSONL protocol/transcript records at
4 MiB and session headers at 1 MiB. Transcript verification streams the newly
appended records with bounded memory. Provider failures, cancellation, malformed/oversized records,
lost streams, timeout, missing final results, and failed persistence reject. The
adapter never relaunches or retries a prompt; Pi may perform its own documented
model retries/compaction within that prompt before `agent_settled`. Reports remain
worker claims, not independent verification of edits/deployments.

Cancellation/deadline races also cover a hanging `onThread`. Cleanup sends RPC
abort and closes stdin, waits 500 ms, then escalates the detached process group
through TERM and KILL with 500 ms waits each. Forced/nonzero shutdown or stream
failure cannot turn a provisional report into success. A process whose closure
is still unconfirmed rejects as unknown and retains its lock. POSIX groups do not
contain descendants that detach themselves; a host sandbox/cgroup must own and
reap those. A hard-killed June process cannot promise cleanup. Do not infer safe
retry or rolled-back external effects from cancellation or process termination.

## Evidence and limitations

Offline injected process/stream fixtures cover the permission and duplicate-effect
boundaries: persisted native identity before prompting, UUID/cwd continuity,
traversal and cross-workspace rejection, symlinks, concurrent admission, late
callbacks after abort, text without settlement, lost transcript appends, nonzero
and failed shutdown, retained locks for unconfirmed closure, malformed/multibyte
oversized JSONL, and deadline/cancellation after dispatch. They simulate Pi's
protocol and disk writes; they are not an installed-Pi compatibility test. No real
Pi execution, sign-in or paid calls were performed. Compatibility with the pinned
executable, provider authorization/authentication and actual OS isolation must be
verified by the operator before enabling this runtime; older protocols without
`agent_settled`/prompt disposition fail closed. No dependency, config, production
mount, deployment, or supervisor implementation is changed here.

Authoritative source inspected at upstream revision
[`d6af72e`](https://github.com/earendil-works/pi/commit/d6af72e1857cfb10b41d8ff8e69f0d72b4cf6d31):

- [RPC protocol](https://github.com/earendil-works/pi/blob/d6af72e1857cfb10b41d8ff8e69f0d72b4cf6d31/packages/coding-agent/docs/rpc.md)
- [RPC implementation](https://github.com/earendil-works/pi/blob/d6af72e1857cfb10b41d8ff8e69f0d72b4cf6d31/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [Session manager](https://github.com/earendil-works/pi/blob/d6af72e1857cfb10b41d8ff8e69f0d72b4cf6d31/packages/coding-agent/src/core/session-manager.ts)
- [Message persistence and settlement](https://github.com/earendil-works/pi/blob/d6af72e1857cfb10b41d8ff8e69f0d72b4cf6d31/packages/coding-agent/src/core/agent-session.ts)
- [CLI](https://github.com/earendil-works/pi/blob/d6af72e1857cfb10b41d8ff8e69f0d72b4cf6d31/packages/coding-agent/docs/cli.md)
- [Provider authentication](https://github.com/earendil-works/pi/blob/d6af72e1857cfb10b41d8ff8e69f0d72b4cf6d31/packages/coding-agent/docs/providers.md)
- [Project trust and isolation](https://github.com/earendil-works/pi/blob/d6af72e1857cfb10b41d8ff8e69f0d72b4cf6d31/packages/coding-agent/docs/security.md)
