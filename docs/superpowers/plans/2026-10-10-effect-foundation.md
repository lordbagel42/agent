# Effect Foundation (Phases 0–1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put an Effect 4 runtime under June with privacy-preserving telemetry, and move the first HTTP route group to Effect `HttpApi` behind the existing Hono listener.

**Architecture:** One process-wide `ManagedRuntime` built from a telemetry Layer that bridges Effect spans into June's existing private OpenTelemetry backend. Hono keeps the socket and mounts each migrated group's `HttpApi` web handler, so routes move one group at a time; the listener switches to `NodeHttpServer` only after Hono has no routes left (see the spec's HTTP section).

**Tech Stack:** `effect` 4.0.2, `@effect/platform-node` 4.0.2, `@effect/opentelemetry` 4.0.2, `@effect/vitest` 4.0.2, Node 24.21.0, RivetKit 2.3.21, Hono 4.13.9 (until removed).

**Spec:** `docs/superpowers/specs/2026-10-10-effect-migration-design.md`

## Global Constraints

- All `effect` and `@effect/*` packages pinned exactly to one version (4.0.2); `@effect/platform-node-shared` is overridden to match.
- `@ampcode/cli` is pinned by override to `0.0.1790683256-gc25f8e` so lockfile changes cannot move it.
- No behavior change: same routes, status codes, headers, bodies, body limits, raw-byte signature checks, shutdown order and telemetry records.
- `telemetry/privacy.ts` stays the boundary: every span name and attribute passes `safeName`/`safeAttributes`; no exception messages, stacks or status messages are recorded.
- Effect HTTP request tracing stays disabled until span names are added to the privacy allowlist (no new per-request spans).
- Per `AGENTS.md`: no new committed tests. Verify with typecheck, lint, the protected suites when touched, throwaway probes under `.amp/in/`, and the real deployment.

---

### Task 1: Dependencies and agent conventions

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`
- Modify: `AGENTS.md` (new "Effect" section)
- Modify: `docs/superpowers/specs/2026-10-10-effect-migration-design.md` (record spike results)

- [x] **Step 1:** `pnpm add -w --save-exact effect@4.0.2 @effect/platform-node@4.0.2 @effect/opentelemetry@4.0.2` and `pnpm add -w -D --save-exact @effect/vitest@4.0.2`, with the two overrides above in `pnpm-workspace.yaml`. Confirm the lockfile diff only adds Effect, its transitive `undici`/`redis` peers and the required `ws` 8.22.0.
- [x] **Step 2:** Add to `AGENTS.md`:

```markdown
## Effect

- June is migrating to Effect 4 (`docs/superpowers/specs/2026-10-10-effect-migration-design.md`).
  New code and code you substantially change use Effect; leave untouched modules alone.
- Most model knowledge is Effect 3. Read the version-matched guidance in
  `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/src/` before writing
  Effect code, and check signatures in `node_modules/effect/dist/*.d.ts`. Do not use v3
  APIs such as `Context.Tag`, `Effect.catchAll` or `@effect/platform`.
- Services are `Context.Service` classes with a `layer`; reusable functions use
  `Effect.fn("june.<area>.<operation>")`; errors are `Schema.TaggedError`; validation is
  `Schema`.
- Run Effect code from Rivet steps and legacy async code on the process runtime
  (`src/effect/runtime.ts`), passing the step's `abortSignal`. Durable retries stay Rivet
  steps; Effect `Schedule` retries only transient in-step failures within the step's deadline.
- New span names must be added to `src/telemetry/privacy.ts`; unlisted names are recorded
  as `june.operation`.
```

- [x] **Step 3:** Record in the spec's Phase 0 that the spikes passed: `flock` on a Node-held descriptor is already used by `src/deployment/standby.ts`; a root `spawn` with `uid`/`gid` leaves no supplementary groups; aborting the `signal` given to `ManagedRuntime.runPromise` interrupts the fiber and runs finalizers.
- [x] **Step 4:** `pnpm format && pnpm lint && pnpm typecheck`. Expected: clean.
- [x] **Step 5:** Commit `build(effect): add Effect 4 and agent conventions`.

### Task 2: Process runtime and telemetry bridge

**Files:**
- Modify: `src/telemetry/index.ts` (export `effectTracer`; let `facade` own `end` when asked)
- Create: `src/effect/runtime.ts`
- Modify: `src/main.ts` (create runtime after `initializeTelemetry`; dispose before `telemetry.shutdown()`)

**Interfaces:**
- Produces: `effectTracer(): import("@opentelemetry/api").Tracer | undefined` — a redacting tracer over the active private backend.
- Produces: `TelemetryLayer: Layer.Layer<never>` and `makeJuneRuntime(): ManagedRuntime.ManagedRuntime<never, never>` from `src/effect/runtime.ts`.

- [x] **Step 1:** In `src/telemetry/index.ts`, give `facade(raw, guard, ownsEnd = false)` a third parameter; when `ownsEnd` is true its `end(time)` calls `guard(() => raw.end(time))`. Add:

```ts
/** Effect's OpenTelemetry bridge starts and ends spans itself; keep both privacy boundaries. */
export function effectTracer(): Tracer | undefined {
  const backend = active;
  if (!backend) return undefined;
  return {
    startSpan(name, options, parent) {
      const raw = backend.tracer.startSpan(
        safeName(name),
        {
          kind: options?.kind,
          startTime: options?.startTime,
          attributes: safeAttributes(options?.attributes),
        },
        parent,
      );
      return facade(raw, (action) => backend.guard(action), true);
    },
    startActiveSpan() {
      throw new Error("effect_tracer_active_span_unsupported");
    },
  } as Tracer;
}
```

- [x] **Step 2:** Create `src/effect/runtime.ts`:

```ts
// Not the package index: it loads NodeSdk, which needs @opentelemetry/sdk-trace-node.
import * as OtelTracer from "@effect/opentelemetry/OtelTracer";
import { Layer, ManagedRuntime } from "effect";
import { effectTracer } from "../telemetry/index.js";

/** Evaluated when the runtime builds, after initializeTelemetry. Without a backend Effect keeps its in-memory tracer. */
export const TelemetryLayer = Layer.suspend(() => {
  const tracer = effectTracer();
  return tracer
    ? OtelTracer.layerWithoutOtelTracer.pipe(
        Layer.provide(Layer.succeed(OtelTracer.OtelTracer, tracer)),
      )
    : Layer.empty;
});

export const makeJuneRuntime = () => ManagedRuntime.make(TelemetryLayer);
```

- [x] **Step 3:** In `src/main.ts`, `const effectRuntime = makeJuneRuntime();` right after `initializeTelemetry`, and `await effectRuntime.dispose();` in the shutdown chain immediately before `await telemetry?.shutdown()`.
- [x] **Step 4:** Throwaway probe `.amp/in/probes/telemetry.ts`: initialize telemetry on a temp path, run an `Effect.fn("june.probe")` span that calls legacy `withSpan` inside it and is itself started inside a legacy `withSpan`; fail one span with an error message. Query the store and confirm: one trace, correct parent IDs in both directions, unknown names recorded as `june.operation`, no message/stack text anywhere in the SQLite file. Delete the probe.
- [x] **Step 5:** `pnpm format && pnpm lint && pnpm typecheck`; commit `feat(effect): add process runtime with private telemetry bridge`.

### Task 3: First `HttpApi` group inside Hono (operator reflection)

Superseded the earlier "serve the listener through Effect" task: that put all traffic through `toWeb`/`fromWeb` conversion before any route benefited. The listener swap moves to the final HTTP plan.

**Files:**
- Create: `src/http/reflection-api.ts` (the `HttpApi` group, its handlers and its web handler)
- Modify: `src/main.ts` (replace the five `/operator/reflection*` Hono routes with one mount)
- Modify: `src/telemetry/privacy.ts` (allowlist the group's span names)

**Contract to preserve exactly** (current routes in `src/main.ts` under `if (reflection)`):
- `GET /operator/reflection` → 200 `actor.status()`.
- `POST /operator/reflection/enqueue` with strict body `{ scope?: string, evidenceIds: string[1..100] of 1..2048 chars, kind: "curiosity"|"reflection", mode: "interaction"|"idle"|"deep" }` → 200 `actor.enqueue({ ...input, scope: audience(input.scope) })`.
- `POST /operator/reflection/cancel` `{ id }` (1..250000 chars) → 200 `{ cancelled }`; `/candidate` `{ id }` → 200 `actor.candidate(id)`; `/reconcile` `{ id, confirmedStopped: true, live?: boolean = false }` → 200 `{ reconciled }` with the existing `live` branch.
- Unknown keys, invalid bodies and thrown actor errors all currently reach `app.onError`: `automaticRepairs.report("http")` and 500 `{"error":"request_failed"}`. Keep that. Hono's `/operator/*` auth, `cache-control: no-store`, lifecycle fence and `june.http.request` span stay in front because Hono still routes the request.

- [ ] **Step 1:** Read `node_modules/effect/ai-docs/src/51_http-server/` (basics, testing, fixtures) for v4 `HttpApi`, `HttpApiGroup`, `HttpApiEndpoint`, `HttpApiBuilder` and `toWebHandler` usage. Write `src/http/reflection-api.ts`: Schema structs mirroring the zod bodies (strict: reject excess properties), handlers calling the reflection actor passed in, every failure (decode or handler) mapped to a single 500 `{"error":"request_failed"}` response that also calls the `report` callback passed in. Handlers use `Effect.fn("june.http.reflection.<endpoint>")`; add those names to `privacy.ts`.
- [ ] **Step 2:** In `src/main.ts`, build the web handler once and replace the five routes with `app.all("/operator/reflection", h)` and `app.all("/operator/reflection/*", h)`, where `h = (c) => handler(c.req.raw)`.
- [ ] **Step 3:** Throwaway parity probe `.amp/in/probes/reflection.ts`: build the old Hono routes and the new mount around the same fake actor and compare status, headers and JSON for: valid status/enqueue/cancel/candidate/reconcile (live and not); missing field; extra field; wrong enum; empty `evidenceIds`; 101 IDs; non-JSON body; actor throwing. Every pair must match, including the repair-report call count. Delete the probe.
- [ ] **Step 4:** `pnpm format && pnpm lint && pnpm typecheck` and the protected suites; Oracle review; commit `refactor(http): serve operator reflection routes through Effect HttpApi`.

### Delivery

Push each task to `main` when it passes (Tasks 1 and 2 shipped together as `1613613` and `b690dae`). After each push, follow the deployment to a verified live revision per `AGENTS.md` (`june/deploy` check, `/health` ready with the loaded revision, intake routed). For Task 3, also call each migrated route on the live slot with the operator token and compare with the pre-migration responses.
