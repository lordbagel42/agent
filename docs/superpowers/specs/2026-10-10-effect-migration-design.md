# June on Effect

Status: approved direction; not implemented. The owner approved this design in
[the design thread](https://ampcode.com/threads/T-01a12609-bba4-7638-a482-ad88b297ea7e).

## Goal

Run all of June's TypeScript and all of her host services on Effect 4, keeping
RivetKit only for what it uniquely provides. Delete the Python. Gain typed
errors, structured cancellation and timeouts, Layer-based wiring and Effect's
built-in tracing everywhere, without changing what June does.

## Decisions

- **Effect 4** (`effect` 4.0.x with the lockstep `@effect/*` packages) for all
  application code and host services. Pin one matching version set; at the time
  of writing `effect` is 4.0.2 while `@effect/platform-node` is 4.0.3 with a
  `^4.0.3` peer, so check before pinning.
- **Rivet stays** for actors, actor state and SQLite, queues, journaled
  workflows, AgentOS and Dynamic Apps. AgentOS is the main reason to keep
  Rivet; `docs/architecture.md` is updated to accept it.
- **No Alchemy.** Infrastructure stays in `pulumi-homelab`; deployment stays
  June's own controller.
- **Every Python file under `scripts/deploy/` is rewritten in Effect
  TypeScript**, including the self-heal controller and its protected tests.
- **Effect `HttpApi` replaces Hono.**

## Non-goals

- Behavior changes. Each slice preserves observable behavior, wire formats,
  persisted shapes and receipts. Fixes found along the way ship separately.
- Effect's durable `workflow` and `cluster` modules. Rivet stays the only
  durable workflow engine.
- Replacing vendor SDKs (Anthropic, Codex, Amp, MCP, E2B) with `effect/ai`.
  They are wrapped in Effect services instead.
- The Svelte frontends (`debug-site`, `sandboxes-site`).

## Boundary with Rivet

```diagram
┌──────────────────────────────────────────────┐
│ Rivet actor / journaled step (durable)       │
│ owns: persistence, replay, durable retries   │
└──────────────────────┬───────────────────────┘
                       ▼ runtime.runPromise(program, { signal: ctx.abortSignal })
┌──────────────────────────────────────────────┐
│ Effect program on the process ManagedRuntime │
│ owns: in-step timeouts, short retries,       │
│ scoped resources, typed errors, spans        │
└──────────────────────────────────────────────┘
```

- One `ManagedRuntime` per process, built from the application Layer. Actors
  and steps run programs on it rather than building their own.
- A step's `ctx.abortSignal` interrupts the program's fiber. Effect finalizers
  replace the hand-written `AbortSignal.any` and cleanup chains.
- **Retry ownership:** retries that must survive a restart are Rivet steps.
  Effect `Schedule` retries are only for transient in-step failures and must
  fit inside the step's deadline. One failure is never retried by both layers.
- **Journal compatibility:** step outputs, actor state and queue payloads keep
  their encoded shape. Effect Schema decoders for persisted data must accept
  every shape already written; a shape change needs an explicit versioned
  decoder, never a silent reinterpretation.
- Tagged errors are mapped deliberately at the step boundary into what Rivet
  treats as retryable or terminal; defects stay defects.

## Application structure

- **Services and Layers.** Each subsystem (models, channels, tools, memory,
  credentials, telemetry, sessions, wakeups and so on) becomes a
  `Context.Service` with a `Layer`. `main.ts` shrinks to Layer composition and
  `NodeRuntime.runMain`. `runtime/registry.ts` (7,000 lines) is split along
  service ownership as its callers migrate, not in one rewrite.
- **Functions** use `Effect.fn("Service.method")` so every call is a named span.
- **Config** uses Effect `Config` and `Redacted` for secrets, reading the
  existing `config.json` and environment with no format change.
- **Errors** become `Schema.TaggedError` classes, replacing the 21 `Error`
  subclasses and their `instanceof` checks.
- **Schema.** Effect Schema replaces Zod (85 files). Tool input schemas given
  to models are generated from Effect Schema and must produce equivalent JSON
  Schema. `ajv` remains only for validating third-party JSON Schema such as MCP
  tool inputs.
- **HTTP.** `effect/http-api` defines the API and `@effect/platform-node`
  serves it. While routes migrate, the remaining Hono app is mounted as a
  fallback web handler so routes move one group at a time. Webhook routes
  (Slack, GitHub, WhatsApp, wakeups) keep signature verification over the raw
  request bytes. The lifecycle fence becomes middleware. Rivet's registry
  handler is mounted the same way it is today.
- **Telemetry.** June queries her own telemetry through the local `Store`, and
  `telemetry/privacy.ts` redacts attributes before anything is recorded. Both
  stay. Phase 1 bridges Effect's tracer into the existing OpenTelemetry
  providers with `@effect/opentelemetry`, so Effect spans, library spans and the
  local store share one trace and nothing exported changes. Moving to Effect's
  native `effect/observability` OTLP exporters is a later, separate decision.
  Span and metric names stay stable so dashboards keep working. `privacy.ts`
  records only allowlisted names, so each migrated service registers its
  `june.*` span names there; otherwise they record as `june.operation`.
- **Tests** use `@effect/vitest`. Per `AGENTS.md`, no new tests are added; only
  the protected self-heal suites are ported.

## Host services

The Python is about 12,500 lines: 15 programs run by 11 systemd units and the
Actions build, plus about 3,700 lines of protected tests. It runs on June's host and, for the issue
worker, on amp-runner. It uses only the standard library and is installed
outside June's releases so that a broken release cannot break its own
redeploy or rollback. The replacement keeps that property.

- **Package.** A workspace package `host/` (`@raygen/june-host`). Each service
  is an esbuild bundle: one self-contained `.mjs` with no runtime
  `node_modules`, run by a pinned Node binary installed beside it under
  `/usr/local/lib/...`. It never imports from June's release.
- **Building blocks.** `effect/cli` for arguments, `effect/process` for child
  processes, `effect/http` with manual redirects for GitHub and artifact
  downloads, `node:sqlite`, `node:zlib` and `node:crypto`. GitHub App JWTs are
  signed with `node:crypto`, removing the `/usr/bin/openssl` dependency.
- **Locks.** Node has no `flock`. The service opens the lock file itself and
  runs `/usr/bin/flock <fd>` against that descriptor; the lock belongs to the
  open file description, so it is held until the service closes it. This
  interoperates with existing operator locks such as
  `/run/lock/june-operator-deploy.lock`.
- **Slot launcher.** `slot.py` must leave Node as `MainPID` holding the FD9
  owner lock, and Node cannot `exec`. The launcher becomes a short shell
  `ExecStart` that opens FD9, takes the lock with `flock -n 9` and `exec`s the
  pinned Node.
- **Privilege drop.** Children that `issues.py` drops to `amp` must also lose
  supplementary groups. Verify libuv clears them for `uid`/`gid` spawns.
- **Archives.** Bounded ZIP and ZIP64 central-directory parsing (64 KiB
  directory, exactly one entry) is a small purpose-written reader; tar limits
  use the bundled `tar-stream`. Every existing size, entry, header and
  disk-space limit is preserved exactly.
- **Formats.** Receipts, state files, check-run output and operation records
  stay byte-compatible, because June, the debug site and recovery threads read
  them.

### Cutover, per service

1. Port that service's protected tests to `@effect/vitest`, one test per
   Python test with the same name, and make them the spec.
2. Port the service until they pass. Oracle review for every controller slice.
3. Install it beside the Python copy. `deploy.py`'s replacement first runs in
   shadow mode: it computes decisions from the same inputs, takes no actions
   or exclusive locks, and its decisions are compared with the Python
   controller's receipts.
4. Switch the unit's `ExecStart`. Keep the Python copy installed for one
   release as a rollback, then delete it.

Order: `slot`, `runner`, `jobs_runner`, `issue_credentials`, `build_release`
(which also runs in Actions), `source_status`, `github_intake`, `debugshare`
and its runner, `debug_site`, `companions`, `issues`, `operations`,
`slack_responder`, and `deploy` last.

## Delivery

Trunk-based, as `AGENTS.md` requires: small Conventional Commits pushed to
`main`, each deployed and verified live before the next risky slice.

0. **Foundation and spikes.** Add Effect v4 conventions to `AGENTS.md` (models
   mostly know v3) and dependencies. The three unproven mechanisms passed their
   spikes: `flock` on a Node-held descriptor is already how
   `src/deployment/standby.ts` takes the runtime lock; a root `spawn` with
   `uid`/`gid` leaves the child no supplementary groups; and aborting the
   `signal` given to `ManagedRuntime.runPromise` interrupts the fiber and runs
   its finalizers.
1. **Runtime spine.** Application Layer, `ManagedRuntime`, config, telemetry
   bridge, and the `HttpApi` server with the Hono fallback mount.
2. **Leaf services.** Model providers, channel adapters, tools, memory and the
   remaining subsystems, each wrapped as a service with its callers moved.
3. **Runtime core.** `registry.ts`, `main.ts`, and actor and workflow bodies.
4. **Host services**, in parallel with phases 1–3, in the order above.
5. **Removal.** Zod, Hono, Python, and `python3` in units and the Actions
   workflow. Update `docs/`, `AGENTS.md`'s protected-test and preflight lists,
   and the installed preflight policy.

Other agents are working on the same files. Slices stay per module so rebases
stay small; no repository-wide reformatting or renaming.

## June-facing knowledge

When behavior June relies on moves (her telemetry query, deployment status,
error messages she sees from tools), the same commit updates her runtime
instructions, as `AGENTS.md` requires. The migration should be invisible to
her; where it is not, she is told.

## Verification

Typecheck, lint and the real workflow for every slice, plus the protected
suites for anything touching recovery, rollback or redeploy. Each push is
followed through to a verified live deployment, and host-service cutovers are
verified on the host, by loaded revision and readiness, not by publication.

## Risks

- Effect 4 shipped on 2026-09-30; expect early patch releases and thin model
  knowledge. Mitigated by pinning and the `AGENTS.md` guidance.
- Any encoded-shape change to journaled or persisted data breaks replay.
- The controller rewrite can break self-healing itself. Mitigated by ported
  suites, shadow mode, a retained Python rollback and Oracle review.
- Two styles coexist for a long time. Each module is either fully converted or
  untouched.

## Done when

No Python, Zod or Hono remains; every request, step and host service runs
through an Effect runtime; the protected suites pass in TypeScript; all host
services run the TypeScript bundles live; and the documentation and June's
runtime instructions describe the new system.
