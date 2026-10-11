import { Cause, Effect, Schema } from "effect";
import type { JuneRuntime } from "../effect/runtime.js";
import {
  type Environment,
  EnvironmentCapacityError,
  type EnvironmentCommand,
  type EnvironmentProvider,
  type EnvironmentResult,
  environmentCommandSchema,
} from "./contracts.js";
import {
  type SandboxActivity,
  type SandboxSnapshot,
  workerFingerprint,
} from "./inspection.js";

interface Lease {
  opening: Promise<Environment>;
  running?: Promise<EnvironmentResult>;
  stopping?: Promise<void>;
  releasing?: boolean;
  failed?: boolean;
}

export class EnvironmentCleanupUnconfirmed extends Schema.TaggedError<EnvironmentCleanupUnconfirmed>()(
  "EnvironmentCleanupUnconfirmed",
  {},
) {
  override readonly message = "Environment cleanup unconfirmed";
}
export class EnvironmentInventoryUnavailable extends Schema.TaggedError<EnvironmentInventoryUnavailable>()(
  "EnvironmentInventoryUnavailable",
  {},
) {
  override readonly message = "Inventory unavailable";
}
/** A provider operation failed; keeps the provider's error and its message. */
export class EnvironmentProviderError extends Schema.TaggedError<EnvironmentProviderError>()(
  "EnvironmentProviderError",
  { cause: Schema.Defect() },
) {
  override readonly message =
    this.cause instanceof Error ? this.cause.message : String(this.cause);
}

const provider = <A>(work: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) => new EnvironmentProviderError({ cause }),
  });

/** Owns capacity until provider operations AND VM teardown settle. No timeout
 * race releases an uncertain VM. Durable worker receipts own replay prevention.
 * Programs are uninterruptible by design: a caller's abort is observed through
 * the command signal and becomes a stop request, never an abandoned await. */
export class EnvironmentService {
  private readonly leases = new Map<string, Lease>();
  private readonly revoked = new Set<string>();
  private closing = false;
  private readonly activity: SandboxActivity[] = [];
  private readonly activitySince = new Date().toISOString();
  private sequence = 0;
  readonly available = true;

  constructor(
    private readonly provider: EnvironmentProvider,
    private readonly effectRuntime: JuneRuntime,
  ) {}

  get binding() {
    return this.provider.binding;
  }

  isSettled() {
    return this.leases.size === 0;
  }

  private record(
    owner: string,
    kind: SandboxActivity["kind"],
    result?: EnvironmentResult,
  ) {
    this.activity.unshift({
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      worker: workerFingerprint(owner),
      kind,
      ...(result?.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result?.code ? { code: result.code } : {}),
    });
    this.activity.length = Math.min(this.activity.length, 200);
  }

  private readonly inspectEffect = Effect.fn("june.environment.inspect")(
    function* (this: EnvironmentService) {
      const inspect = this.provider.inspect?.bind(this.provider);
      if (!inspect) return yield* new EnvironmentInventoryUnavailable();
      const boxes = yield* provider(inspect);
      const leases: SandboxSnapshot["leases"] = [...this.leases].map(
        ([owner, lease]) => ({
          worker: workerFingerprint(owner),
          state: lease.failed
            ? "needs_review"
            : lease.releasing || lease.stopping
              ? "stopping"
              : lease.running
                ? "executing"
                : "active",
        }),
      );
      return {
        boxes,
        leases,
        activity: this.activity.map((entry) => ({ ...entry })),
        activitySince: this.activitySince,
      };
    },
  );

  inspect() {
    return this.effectRuntime.runPromise(this.inspectEffect.call(this));
  }

  private readonly runEffect = Effect.fn("june.environment.run")(function* (
    this: EnvironmentService,
    owner: string,
    raw: EnvironmentCommand,
    signal: AbortSignal,
    authorized: () => boolean,
  ) {
    const command = environmentCommandSchema.parse(raw);
    const base = {
      provider: this.provider.name,
      persistence: this.provider.persistence,
    };
    let lease = this.leases.get(owner);
    if (this.closing || this.revoked.has(owner) || lease?.failed)
      return { ...base, status: "unavailable", code: "needs_review" } as const;
    if (signal.aborted || !authorized())
      return { ...base, status: "error", code: "cancelled" } as const;
    if (command.action === "status")
      return {
        ...base,
        status: "ok",
        state: lease ? "active" : "stopped",
      } as const;
    if (
      lease?.running ||
      lease?.stopping ||
      lease?.releasing ||
      (!lease && this.leases.size >= 4)
    )
      return { ...base, status: "unavailable", code: "busy" } as const;
    if (!lease) {
      lease = {
        opening: Promise.resolve().then(() => this.provider.connect(owner)),
      };
      this.leases.set(owner, lease);
      this.record(owner, "opening");
    }
    const current = lease;
    // The lease's running promise is shared with release(), which must wait
    // for this command and its teardown to settle.
    const running = this.effectRuntime.runPromise(
      this.execute(current, command.command, signal, authorized),
    );
    current.running = running;
    const result = yield* Effect.promise(() => running).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          current.running = undefined;
        }),
      ),
    );
    this.record(
      owner,
      result.status === "ok" && result.exitCode === 0
        ? "command_completed"
        : "command_failed",
      result,
    );
    return result;
  }, Effect.uninterruptible);

  run(
    owner: string,
    raw: EnvironmentCommand,
    signal: AbortSignal,
    authorized: () => boolean = () => true,
  ): Promise<EnvironmentResult> {
    return this.effectRuntime.runPromise(
      this.runEffect.call(this, owner, raw, signal, authorized),
    );
  }

  private stop(lease: Lease): Promise<void> {
    lease.stopping ??= lease.opening.then((environment) => environment.stop());
    return lease.stopping;
  }

  private readonly execute = Effect.fn("june.environment.exec")(function* (
    this: EnvironmentService,
    lease: Lease,
    command: string,
    signal: AbortSignal,
    authorized: () => boolean,
  ) {
    const result: EnvironmentResult = {
      provider: this.provider.name,
      persistence: this.provider.persistence,
      status: "error",
      stdout: "",
      stderr: "",
    };
    const timeout = AbortSignal.timeout(30_000);
    const interruption = AbortSignal.any([signal, timeout]);
    const abort = () => {
      result.code ??= signal.aborted ? "cancelled" : "timeout";
      lease.failed = true;
      // Attach a handler immediately; settlement is still awaited below.
      void this.stop(lease).catch(() => {});
    };
    let bytes = 0;
    const attempt = Effect.gen(function* () {
      const environment = yield* provider(() => lease.opening);
      interruption.throwIfAborted();
      if (!authorized()) {
        result.code = "cancelled";
        throw new Error("Environment authorization changed");
      }
      result.exitCode = yield* provider(() =>
        environment.exec(command, (stream, text) => {
          if (lease.failed) return;
          bytes += Buffer.byteLength(text);
          if (bytes > 8000) {
            result.code = "output_limit";
            abort();
            return;
          }
          result[stream] += text;
        }),
      );
      interruption.throwIfAborted();
      if (!lease.failed) result.status = "ok";
    }).pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        if (
          error instanceof EnvironmentProviderError &&
          error.cause instanceof EnvironmentCapacityError
        ) {
          result.status = "unavailable";
          result.code ??= "busy";
          // A proven pre-creation refusal has no resource to stop; other opening
          // failures retain their rejected stop promise and cannot release capacity.
          lease.stopping = Promise.resolve();
        } else {
          result.code ??= signal.aborted
            ? "cancelled"
            : timeout.aborted
              ? "timeout"
              : "provider_failure";
        }
        lease.failed = true;
        return Effect.void;
      }),
    );
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        interruption.addEventListener("abort", abort, { once: true }),
      ),
      () => attempt,
      () => Effect.sync(() => interruption.removeEventListener("abort", abort)),
    );
    if (lease.failed)
      result.cleanup = yield* provider(() => this.stop(lease)).pipe(
        Effect.as("confirmed" as const),
        Effect.catch(() => Effect.succeed("unknown" as const)),
      );
    return result;
  }, Effect.uninterruptible);

  private readonly releaseEffect = Effect.fn("june.environment.release")(
    function* (this: EnvironmentService, owner: string) {
      const lease = this.leases.get(owner);
      if (!lease) return;
      lease.releasing = true;
      yield* Effect.promise(async () => {
        await lease.running;
      });
      yield* provider(() => this.stop(lease)).pipe(
        Effect.catch(() => {
          lease.failed = true;
          this.record(owner, "cleanup_unknown");
          return Effect.fail(new EnvironmentCleanupUnconfirmed());
        }),
      );
      this.leases.delete(owner);
      this.record(owner, "stopped");
    },
    Effect.uninterruptible,
  );

  release(owner: string): Promise<void> {
    return this.effectRuntime.runPromise(this.releaseEffect.call(this, owner));
  }

  private readonly revokeEffect = Effect.fn("june.environment.revoke")(
    function* (this: EnvironmentService, owner: string) {
      this.revoked.add(owner);
      yield* this.releaseEffect.call(this, owner);
      yield* provider(() => this.provider.destroy(owner));
      this.record(owner, "destroyed");
    },
    Effect.uninterruptible,
  );

  revoke(owner: string): Promise<void> {
    return this.effectRuntime.runPromise(this.revokeEffect.call(this, owner));
  }

  private readonly closeEffect = Effect.fn("june.environment.close")(function* (
    this: EnvironmentService,
  ) {
    this.closing = true;
    yield* Effect.forEach(
      [...this.leases.keys()],
      (owner) => this.releaseEffect.call(this, owner),
      { concurrency: "unbounded", discard: true },
    );
    yield* provider(() => this.provider.close());
  }, Effect.uninterruptible);

  close(): Promise<void> {
    return this.effectRuntime.runPromise(this.closeEffect.call(this));
  }
}
