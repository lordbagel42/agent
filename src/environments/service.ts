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

/** Owns capacity until provider operations AND VM teardown settle. No timeout
 * race releases an uncertain VM. Durable worker receipts own replay prevention. */
export class EnvironmentService {
  private readonly leases = new Map<string, Lease>();
  private readonly revoked = new Set<string>();
  private closing = false;
  private readonly activity: SandboxActivity[] = [];
  private readonly activitySince = new Date().toISOString();
  private sequence = 0;
  readonly available = true;

  constructor(private readonly provider: EnvironmentProvider) {}

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

  async inspect() {
    if (!this.provider.inspect) throw new Error("Inventory unavailable");
    const boxes = await this.provider.inspect();
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
  }

  async run(
    owner: string,
    raw: EnvironmentCommand,
    signal: AbortSignal,
    authorized: () => boolean = () => true,
  ): Promise<EnvironmentResult> {
    const command = environmentCommandSchema.parse(raw);
    const base = {
      provider: this.provider.name,
      persistence: this.provider.persistence,
    };
    let lease = this.leases.get(owner);
    if (this.closing || this.revoked.has(owner) || lease?.failed)
      return { ...base, status: "unavailable", code: "needs_review" };
    if (signal.aborted || !authorized())
      return { ...base, status: "error", code: "cancelled" };
    if (command.action === "status")
      return { ...base, status: "ok", state: lease ? "active" : "stopped" };
    if (
      lease?.running ||
      lease?.stopping ||
      lease?.releasing ||
      (!lease && this.leases.size >= 4)
    )
      return { ...base, status: "unavailable", code: "busy" };
    if (!lease) {
      lease = {
        opening: Promise.resolve().then(() => this.provider.connect(owner)),
      };
      this.leases.set(owner, lease);
      this.record(owner, "opening");
    }
    const current = lease;
    const running = this.execute(current, command.command, signal, authorized);
    current.running = running;
    try {
      const result = await running;
      this.record(
        owner,
        result.status === "ok" && result.exitCode === 0
          ? "command_completed"
          : "command_failed",
        result,
      );
      return result;
    } finally {
      current.running = undefined;
    }
  }

  private stop(lease: Lease): Promise<void> {
    lease.stopping ??= lease.opening.then((environment) => environment.stop());
    return lease.stopping;
  }

  private async execute(
    lease: Lease,
    command: string,
    signal: AbortSignal,
    authorized: () => boolean,
  ): Promise<EnvironmentResult> {
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
    interruption.addEventListener("abort", abort, { once: true });
    let bytes = 0;
    try {
      const environment = await lease.opening;
      interruption.throwIfAborted();
      if (!authorized()) {
        result.code = "cancelled";
        throw new Error("Environment authorization changed");
      }
      result.exitCode = await environment.exec(command, (stream, text) => {
        if (lease.failed) return;
        bytes += Buffer.byteLength(text);
        if (bytes > 8000) {
          result.code = "output_limit";
          abort();
          return;
        }
        result[stream] += text;
      });
      interruption.throwIfAborted();
      if (!lease.failed) result.status = "ok";
    } catch (error) {
      if (error instanceof EnvironmentCapacityError) {
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
    } finally {
      interruption.removeEventListener("abort", abort);
      if (lease.failed) {
        try {
          await this.stop(lease);
          result.cleanup = "confirmed";
        } catch {
          result.cleanup = "unknown";
        }
      }
    }
    return result;
  }

  async release(owner: string): Promise<void> {
    const lease = this.leases.get(owner);
    if (!lease) return;
    lease.releasing = true;
    await lease.running;
    try {
      await this.stop(lease);
      this.leases.delete(owner);
      this.record(owner, "stopped");
    } catch {
      lease.failed = true;
      this.record(owner, "cleanup_unknown");
      throw new Error("Environment cleanup unconfirmed");
    }
  }

  async revoke(owner: string): Promise<void> {
    this.revoked.add(owner);
    await this.release(owner);
    await this.provider.destroy(owner);
    this.record(owner, "destroyed");
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(
      [...this.leases.keys()].map((owner) => this.release(owner)),
    );
    await this.provider.close();
  }
}
