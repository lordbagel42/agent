# Effect Foundation (Phases 0–1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put an Effect 4 runtime under June with privacy-preserving telemetry, and serve her main HTTP listener through Effect while the existing Hono app keeps handling every route.

**Architecture:** One process-wide `ManagedRuntime` built from a telemetry Layer that bridges Effect spans into June's existing private OpenTelemetry backend. The main listener becomes an Effect `NodeHttpServer` whose only route forwards to the Hono app's `fetch`, so routes can move to `HttpApi` one group at a time in later plans.

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

- [ ] **Step 1:** `pnpm add -w --save-exact effect@4.0.2 @effect/platform-node@4.0.2 @effect/opentelemetry@4.0.2` and `pnpm add -w -D --save-exact @effect/vitest@4.0.2`, with the two overrides above in `pnpm-workspace.yaml`. Confirm the lockfile diff only adds Effect, its transitive `undici`/`redis` peers and the required `ws` 8.22.0.
- [ ] **Step 2:** Add to `AGENTS.md`:

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

- [ ] **Step 3:** Record in the spec's Phase 0 that the spikes passed: `flock` on a Node-held descriptor is already used by `src/deployment/standby.ts`; a root `spawn` with `uid`/`gid` leaves no supplementary groups; aborting the `signal` given to `ManagedRuntime.runPromise` interrupts the fiber and runs finalizers.
- [ ] **Step 4:** `pnpm format && pnpm lint && pnpm typecheck`. Expected: clean.
- [ ] **Step 5:** Commit `build(effect): add Effect 4 and agent conventions`.

### Task 2: Process runtime and telemetry bridge

**Files:**
- Modify: `src/telemetry/index.ts` (export `effectTracer`; let `facade` own `end` when asked)
- Create: `src/effect/runtime.ts`
- Modify: `src/main.ts` (create runtime after `initializeTelemetry`; dispose before `telemetry.shutdown()`)

**Interfaces:**
- Produces: `effectTracer(): import("@opentelemetry/api").Tracer | undefined` — a redacting tracer over the active private backend.
- Produces: `TelemetryLayer: Layer.Layer<never>` and `makeJuneRuntime(): ManagedRuntime.ManagedRuntime<never, never>` from `src/effect/runtime.ts`.

- [ ] **Step 1:** In `src/telemetry/index.ts`, give `facade(raw, guard, ownsEnd = false)` a third parameter; when `ownsEnd` is true its `end(time)` calls `guard(() => raw.end(time))`. Add:

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

- [ ] **Step 2:** Create `src/effect/runtime.ts`:

```ts
import { OtelTracer } from "@effect/opentelemetry";
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

- [ ] **Step 3:** In `src/main.ts`, `const effectRuntime = makeJuneRuntime();` right after `initializeTelemetry`, and `await effectRuntime.dispose();` in the shutdown chain immediately before `await telemetry?.shutdown()`.
- [ ] **Step 4:** Throwaway probe `.amp/in/probes/telemetry.ts`: initialize telemetry on a temp path, run an `Effect.fn("june.probe")` span that calls legacy `withSpan` inside it and is itself started inside a legacy `withSpan`; fail one span with an error message. Query the store and confirm: one trace, correct parent IDs in both directions, unknown names recorded as `june.operation`, no message/stack text anywhere in the SQLite file. Delete the probe.
- [ ] **Step 5:** `pnpm format && pnpm lint && pnpm typecheck`; commit `feat(effect): add process runtime with private telemetry bridge`.

### Task 3: Serve the main listener through Effect

**Files:**
- Create: `src/http/server.ts`
- Modify: `src/main.ts` (replace the main `serve(...)` call and its `server.close` in shutdown; the artifact server stays on `@hono/node-server` until its routes migrate)

**Interfaces:**
- Consumes: `makeJuneRuntime()` from Task 2.
- Produces: `startHttpServer(runtime, options: { fetch: (request: Request) => Response | Promise<Response>; host: string; port: number; onListen: () => void }): { close(): Promise<void> }`.

- [ ] **Step 1:** Create `src/http/server.ts`: an `HttpRouter` with one `*` route that converts the `HttpServerRequest` to a web `Request` (`HttpServerRequest.toWeb` with an `AbortSignal` that aborts when the handler fiber is interrupted), awaits `options.fetch`, and returns `HttpServerResponse.fromWeb`. Serve it with `HttpRouter.serve(..., { disableLogger: true })` on `NodeHttpServer.layer(() => createServer(), { host, port })`, with request tracing disabled. Launch with `runtime.runFork(Layer.launch(...))`; `close()` interrupts that fiber and resolves after the server has closed. Call `onListen` once the listener is bound.
- [ ] **Step 2:** Before wiring it in, run a throwaway parity probe `.amp/in/probes/http.ts` serving one small Hono app through both `@hono/node-server` and `startHttpServer`, and compare: raw-body HMAC over identical bytes; a `bodyLimit` rejection on an oversized chunked body without buffering it whole; a streamed response arriving incrementally; client disconnect aborting `c.req.raw.signal`; two `Set-Cookie` headers; 404 and thrown-error status codes; `HEAD`. Fix any difference before continuing. Delete the probe.
- [ ] **Step 3:** In `src/main.ts`, replace `const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {...})` with `startHttpServer(effectRuntime, { fetch: app.fetch, host: config.host, port: config.port, onListen: () => {...same logs...} })`, and the shutdown's `server.close` promise with `await server.close()`, keeping its position in the shutdown order.
- [ ] **Step 4:** `pnpm format && pnpm lint && pnpm typecheck`, then the protected startup and lifecycle suites: `pnpm vitest run tests/startup.test.ts src/runtime/lifecycle.test.ts src/runtime/delivery.test.ts src/core/routing.test.ts src/deployment`.
- [ ] **Step 5:** Oracle review of the server swap (high impact: every request goes through it). Commit `feat(http): serve June's listener through Effect`.

### Delivery

Push each task to `main` when it passes (Task 1 and 2 may go together). After each push, follow the deployment to a verified live revision per `AGENTS.md` (`june/deploy` check, `/health` ready with the loaded revision, intake routed), and for Task 3 confirm a real Slack round trip and a `/health` probe through the new listener.
