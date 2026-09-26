# Codex coding runtime

`createCodexRuntime({ home, model?, executable?, timeoutMs?, runner? })` implements
`CodingRuntime`. It is separate from the conversational Codex model provider and
does not configure June's runtime registry. The default command resolves the
repository's pinned official `@openai/codex` **0.157.1** package; Node 24 or newer
is required by this project. App-server is experimental, even though this client
does not enable its experimental APIs. Revalidate the protocol before upgrading.

## Operator prerequisites

- Run only inside an externally protected execution host. A detached worktree,
  filtered environment, process group, or `cwd` is **not an OS sandbox**. This
  adapter does not isolate filesystem/network access or protect June's state and
  credentials from native tools. Do not enable it on a shared, secret-bearing
  development host merely because fixture checks pass.
- Provision an absolute, dedicated `home` with the official CLI's supported
  login flow, explicitly using `cli_auth_credentials_store="file"`. Protect its
  `auth.json` and session files. A ChatGPT subscription login and an API-key login
  are distinct supported account types; subscription tokens are not API keys.
  The adapter requires saved authentication even for custom model providers.
- The operator performs provisioning separately. The adapter never signs in,
  copies a desktop login, reads a keyring, or attaches to a daemon/browser. Do not
  borrow desktop credentials for development checks. Keep one execution owner
  for each runtime session and do not concurrently resume it elsewhere.
- Audit the dedicated home's and repository's Codex configuration, hooks,
  plugins, MCP servers, remote-control settings, model endpoint, and PATH. They
  are executable authority, not sanitized task data. Configure approvals and
  sandbox permissions within the protected host; the adapter does not override
  them or answer any server-originated approval/input/login request.
- Only `PATH`, `LANG`, `LC_ALL`, `TZ`, `SSL_CERT_FILE`, and `SSL_CERT_DIR` are
  inherited. `HOME` and `CODEX_HOME` both point to `home`; ambient API keys, SSH
  agents, desktop/session variables, and proxy variables are not inherited.
  This is environment hygiene, not filesystem credential isolation.
- `executable` replaces the pinned launcher for a trusted operator wrapper or
  fixtures only; it must honor the same stdio protocol/version. `runner` is an
  in-process test seam, not user/model configuration. Neither may come from a
  coding prompt. Do not supply flags or shell commands through `executable`.

## Launch, resume, and completion

`run({ prompt, cwd, threadId?, signal, onThread })` uses the supervisor's exact
absolute worktree path. It initializes a private stdio app-server and checks the
saved account without initiating login. New threads are non-ephemeral. Resumes
use exactly the supplied thread ID, never search/fork/replace it, and require an
idle thread. The adapter awaits `onThread(actualThreadId)` before `turn/start`.
Failed persistence or cancellation at that boundary prevents the turn.

Success requires all of these, not successful-sounding agent text:

1. A matching turn-start response and `turn/completed` with status `completed`.
2. `thread/unsubscribe` returning `unsubscribed` and a matching `thread/closed`
   notification. Either response/notification order is accepted.
3. Stdin EOF followed by drained stdio and a zero, unsignalled app-server exit.

The adapter sets `thread_unload_delay_secs=0` so unsubscribe does not wait the
default minute. In the pinned server, `thread/closed` follows the session-loop
shutdown wait. EOF then drains RPCs/background work and shuts down remaining
threads. Plain EOF/exit alone is insufficient: server-wide shutdown can merely
warn when an individual thread exceeds its shutdown deadline.

Session teardown attempts to flush persistence and stop managed tools, but the
upstream unified-exec cleanup uses `terminate()`, not confirmed process reaping;
some persistence/teardown failures are warnings. **Neither `thread/closed`,
process exit, nor cancellation certifies that arbitrary detached/remote tools
have stopped or that every session write is durable.** The external host must
contain and reconcile such execution before reuse. A thread created without a
first turn may not survive a restart. A missing saved session is a resume failure,
never permission to create a replacement. Authenticated persistence/restart and
child-process containment remain protected-host acceptance checks.

## Failure and output handling

- Caller cancellation rejects with `cancelled`; the default 30-minute runtime
  deadline rejects with `completion_unknown`. Both initiate EOF cleanup. EOF has
  a 50-second grace period, slightly longer than the pinned server's 45-second
  watchdog. Expiry force-kills the owned process/group and releases pipe handles;
  forced/nonzero exit can never produce success. This does not kill every
  possible detached descendant. The supervisor must retain its admission hold.
- Aggregate stdout plus stderr is capped at 16 MiB, including shutdown output.
  Overflow force-stops the transport and rejects. Stderr is drained and never
  logged; raw RPC errors are not exposed. The latest completed agent message is
  limited to 32,000 UTF-16 code units including a truncation notice. Reports remain
  untrusted, audience-scoped model output, not independent verification.
- Sanitized error codes are `invalid_configuration`, `authentication_required`,
  `interaction_required`, `thread_mismatch`, `thread_save_failed`, `cancelled`,
  `execution_failed`, and `completion_unknown`. A failed/interrupted turn, missing
  receipt, malformed/truncated transport, output overflow, or abnormal exit never
  becomes success. Server requests are rejected by closing the connection, not
  by sending an approval response.
- Do not automatically replay/retry a rejected run. The supervisor owns durable
  admission and reconciliation; resume requires a new authorized command and
  explicit `confirmedStopped`, with the same saved thread/worktree binding.

## Verification and pinned sources

The focused checks use synthetic protocol streams and temporary fake executables
in Git directories: pre-turn persistence, exact resume, approval refusal,
completion receipts, delayed EOF cleanup, nonzero exit, active cancellation,
report truncation, and individual/combined output limits. Run with Node 24+:

```sh
pnpm exec biome check src/coding/codex.ts src/coding/codex.test.ts
pnpm lint
pnpm typecheck
pnpm exec vitest run src/coding/codex.test.ts
```

A real pinned-CLI check with a fresh unauthenticated home rejects before thread
creation or a paid turn. No authenticated coding job, login, deployment, or
desktop attachment was used to validate this adapter. Fixtures are not evidence
of real-provider completion, durable resume, or OS containment.

Authoritative sources inspected at tag `rust-v0.157.1`:

- [App-server protocol and authentication](https://developers.openai.com/codex/app-server)
  and [supported authentication](https://developers.openai.com/codex/auth).
- [Stdio EOF/SIGTERM transport and watchdog](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/app-server-transport/src/transport/stdio.rs).
- [Server cleanup path](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/app-server/src/lib.rs)
  and [thread unload/closed receipt](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/app-server/src/request_processors/thread_lifecycle.rs).
- [Session teardown and persistence](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/core/src/session/handlers.rs)
  and [managed process termination](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/core/src/unified_exec/process_manager.rs).

The pinned CLI's `codex app-server generate-ts` output supplies the wire shapes;
do not substitute a protocol inferred from a different installed desktop CLI.
