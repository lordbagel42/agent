import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().min(1).max(256);
const timestamp = z.number().int().nonnegative();
const compatibility = z.strictObject({
  state: label,
  journal: label,
  /** This increment cannot authorize migrations, including reversible ones. */
  migrations: z.literal("none"),
  rollbackSafe: z.literal(true),
});
const planSchema = z.strictObject({
  current: digest,
  target: digest,
  review: label,
  verificationId: label,
  compatibility,
});
const evidenceSchema = z.strictObject({
  currentDigest: digest,
  artifactDigest: digest,
  verifierDigest: digest,
  compatibility,
  passed: z.literal(true),
  completedAt: timestamp,
});
const healthSchema = z.strictObject({ digest, healthy: z.boolean() });
export type ReleasePlan = z.infer<typeof planSchema>;
export type VerificationEvidence = z.infer<typeof evidenceSchema>;
export interface ReleaseAdapter {
  /** Drain writers/workers and stop this exact release. No internal retries.
   * Resolve only when definitively stopped. Throw means unknown, never retry. */
  stop(expectedDigest: string): Promise<void>;
  /** Opaque artifact, not necessarily an archive. Paths are supervisor-generated.
   * Adapter must safely materialize/install it and select the version itself. */
  start(release: { digest: string; artifactPath: string }): Promise<void>;
  /** Must observe actual running identity, not merely echo the requested digest. */
  health(): Promise<{ digest: string; healthy: boolean }>;
  /** Hold an exclusive service-wide fence while observe runs. Refuse until ALL
   * preceding supervisor/adapter operations cannot cause any later effects.
   * Never implement this as a caller-supplied boolean or a health check alone. */
  withQuiescence(observe: () => Promise<void>): Promise<void>;
}
export interface ReleaseOptions {
  /** Pre-created canonical 0700 directory owned by the supervisor UID. */
  root: string;
  owner: string;
  initial: { digest: string; state: string; journal: string };
  /** Digest of independently installed verifier code + policy/configuration. */
  verifierDigest: string;
  verificationMaxAgeMs: number;
  approvalTtlMs: number;
  /** Trusted independent verifier lookup, not a candidate-supplied result. */
  verification(id: string): VerificationEvidence;
  adapter?: ReleaseAdapter;
  now?: () => number;
}
export interface ReleaseReview {
  id: string;
  plan: ReleasePlan;
  evidence: VerificationEvidence;
  generation: number;
  reviewedAt: number;
}
export interface ReleaseReceipt extends ReleaseReview {
  status:
    | "approved"
    | "deploy_unknown"
    | "healthy"
    | "unhealthy"
    | "rollback_unknown"
    | "rolled_back"
    | "unchanged"
    | "cancelled";
  approvedAt: number;
  expiresAt: number;
  effectGeneration?: number;
  deployStartedAt?: number;
  rollbackStartedAt?: number;
  observation?: { digest: string; healthy: boolean; at: number };
}
interface StoredReceipt extends ReleaseReceipt {
  tokenHash: string;
}
interface State {
  version: 1;
  current: string;
  state: string;
  journal: string;
  generation: number;
  active: string | null;
  reviews: Record<string, ReleaseReview>;
  receipts: Record<string, StoredReceipt>;
}
function denied(): never {
  throw new Error("release_denied");
}
function privateFile(stat: Stats, mode: number): void {
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== mode ||
    stat.nlink !== 1
  )
    denied();
}
export function artifactDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Install this module and its dependencies outside June's writable checkout.
 * Principal strings are NOT authentication: the operator transport must derive
 * them from trusted authentication and never expose approval to the agent. */
export class ReleaseSupervisor {
  private readonly db: DatabaseSync;
  private readonly options: ReleaseOptions;
  private busy = false;
  constructor(options: ReleaseOptions) {
    this.options = { ...options, initial: { ...options.initial } };
    const stat = lstatSync(options.root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(options.root) !== options.root ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700 ||
      !Number.isSafeInteger(options.verificationMaxAgeMs) ||
      options.verificationMaxAgeMs <= 0 ||
      !Number.isSafeInteger(options.approvalTtlMs) ||
      options.approvalTtlMs <= 0
    )
      denied();
    digest.parse(options.initial.digest);
    digest.parse(options.verifierDigest);
    label.parse(options.owner);
    label.parse(options.initial.state);
    label.parse(options.initial.journal);
    const file = path.join(options.root, "release.sqlite");
    const fd = openSync(
      file,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    try {
      privateFile(fstatSync(fd), 0o600);
    } finally {
      closeSync(fd);
    }
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = lstatSync(`${file}${suffix}`, { throwIfNoEntry: false });
      if (sidecar) privateFile(sidecar, 0o600);
    }
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
      );
      this.db.prepare("INSERT OR IGNORE INTO state VALUES (1, ?)").run(
        JSON.stringify({
          version: 1,
          current: options.initial.digest,
          state: options.initial.state,
          journal: options.initial.journal,
          generation: 0,
          active: null,
          reviews: {},
          receipts: {},
        } satisfies State),
      );
      const state = this.read();
      if (
        state.version !== 1 ||
        state.state !== options.initial.state ||
        state.journal !== options.initial.journal
      )
        denied();
      this.syncDirectory();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    if (this.busy) denied();
    this.db.close();
  }
  private now(): number {
    return timestamp.parse((this.options.now ?? Date.now)());
  }
  private owner(principal: string): void {
    if (principal !== this.options.owner) denied();
  }
  private read(): State {
    return JSON.parse(
      (
        this.db.prepare("SELECT value FROM state WHERE id=1").get() as {
          value: string;
        }
      ).value,
    ) as State;
  }
  private change<T>(fn: (state: State) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.read();
      const result = fn(state);
      this.db
        .prepare("UPDATE state SET value=? WHERE id=1")
        .run(JSON.stringify(state));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private syncDirectory(): void {
    const dir = openSync(
      this.options.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
  private artifact(release: string): string {
    return path.join(this.options.root, `${digest.parse(release)}.artifact`);
  }
  private checkArtifact(release: string): string {
    const file = this.artifact(release);
    const fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      privateFile(fstatSync(fd), 0o400);
      if (artifactDigest(readFileSync(fd)) !== release) denied();
    } finally {
      closeSync(fd);
    }
    return file;
  }
  /** Bytes are copied, hashed, and written exclusively; no checkout paths or extraction. */
  stage(bytes: Uint8Array, expectedDigest: string): void {
    const copy = Buffer.from(bytes);
    if (artifactDigest(copy) !== digest.parse(expectedDigest)) denied();
    const file = this.artifact(expectedDigest);
    const temporary = path.join(this.options.root, `.${randomUUID()}.staging`);
    const fd = openSync(temporary, "wx", 0o400);
    try {
      try {
        writeFileSync(fd, copy);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        linkSync(temporary, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      unlinkSync(temporary);
    }
    this.checkArtifact(expectedDigest);
    this.syncDirectory();
  }
  private verify(
    plan: ReleasePlan,
    state: State,
    reviewed?: VerificationEvidence,
  ): VerificationEvidence {
    // Parse and copy trusted lookup output; never accept evidence in a plan/request.
    const evidence = evidenceSchema.parse(
      this.options.verification(plan.verificationId),
    );
    if (
      plan.current !== state.current ||
      plan.current === plan.target ||
      plan.compatibility.state !== state.state ||
      plan.compatibility.journal !== state.journal ||
      evidence.currentDigest !== plan.current ||
      evidence.artifactDigest !== plan.target ||
      evidence.verifierDigest !== this.options.verifierDigest ||
      JSON.stringify(evidence.compatibility) !==
        JSON.stringify(plan.compatibility) ||
      (reviewed && JSON.stringify(evidence) !== JSON.stringify(reviewed))
    )
      denied();
    this.checkArtifact(plan.current);
    this.checkArtifact(plan.target);
    const age = this.now() - evidence.completedAt;
    if (age < 0 || age > this.options.verificationMaxAgeMs) denied();
    return evidence;
  }
  private authorized(receipt: StoredReceipt): void {
    const now = this.now();
    if (now < receipt.approvedAt || now >= receipt.expiresAt) denied();
  }
  private active(state: State, receipt: StoredReceipt): StoredReceipt {
    const current = state.receipts[receipt.id];
    if (
      !current ||
      state.active !== receipt.id ||
      current.status !== receipt.status ||
      current.effectGeneration !== receipt.effectGeneration ||
      state.generation !== receipt.effectGeneration
    )
      denied();
    return current;
  }
  private async exclusively<T>(run: () => Promise<T>): Promise<T> {
    if (this.busy) denied();
    this.busy = true;
    try {
      return await run();
    } finally {
      this.busy = false;
    }
  }
  /** Stores and returns the exact plan/evidence for the authenticated human to
   * inspect. This is NOT approval; approve is a separate explicit owner action. */
  review(principal: string, input: ReleasePlan): ReleaseReview {
    this.owner(principal);
    const plan = planSchema.parse(input);
    return this.change((state) => {
      if (state.active) denied();
      const evidence = this.verify(plan, state);
      const review = {
        id: randomUUID(),
        plan,
        evidence,
        generation: state.generation,
        reviewedAt: this.now(),
      };
      state.reviews[review.id] = review;
      return review;
    });
  }
  approve(principal: string, reviewId: string): { id: string; token: string } {
    this.owner(principal);
    z.uuid().parse(reviewId);
    return this.change((state) => {
      const review = state.reviews[reviewId];
      if (
        !review ||
        state.active ||
        review.generation !== state.generation ||
        this.now() < review.reviewedAt
      )
        denied();
      this.verify(review.plan, state, review.evidence);
      const token = randomBytes(32).toString("hex");
      const approvedAt = this.now();
      const expiresAt = timestamp.parse(
        approvedAt + this.options.approvalTtlMs,
      );
      state.receipts[reviewId] = {
        ...review,
        status: "approved",
        approvedAt,
        expiresAt,
        tokenHash: artifactDigest(Buffer.from(token)),
      };
      delete state.reviews[reviewId];
      return { id: reviewId, token };
    });
  }
  receipt(principal: string, id: string): ReleaseReceipt {
    this.owner(principal);
    z.uuid().parse(id);
    const receipt = this.read().receipts[id];
    if (!receipt) denied();
    const { tokenHash: _secret, ...result } = receipt;
    return result;
  }
  cancel(principal: string, id: string): void {
    this.owner(principal);
    z.uuid().parse(id);
    this.change((state) => {
      const r = state.receipts[id];
      if (r?.status !== "approved") denied();
      r.status = "cancelled";
    });
  }
  async deploy(
    principal: string,
    id: string,
    token: string,
  ): Promise<ReleaseReceipt> {
    this.owner(principal);
    z.uuid().parse(id);
    digest.parse(token);
    const adapter = this.options.adapter;
    if (!adapter) throw new Error("release_adapter_not_configured");
    return this.exclusively(async () => {
      const receipt = this.change((state) => {
        const r = state.receipts[id];
        if (
          !r ||
          !timingSafeEqual(
            Buffer.from(r.tokenHash, "hex"),
            Buffer.from(artifactDigest(Buffer.from(token)), "hex"),
          ) ||
          r.status !== "approved" ||
          state.active ||
          r.generation !== state.generation
        )
          denied();
        this.verify(r.plan, state, r.evidence);
        this.authorized(r);
        r.status = "deploy_unknown";
        r.deployStartedAt = this.now();
        r.effectGeneration = ++state.generation;
        state.active = id;
        return r;
      });
      try {
        const before = healthSchema.parse(await adapter.health());
        if (before.digest !== receipt.plan.current || !before.healthy)
          return this.receipt(principal, id);
        // Health may have taken time. Recheck authority immediately before the first effect.
        const state = this.read();
        this.active(state, receipt);
        this.verify(receipt.plan, state, receipt.evidence);
        this.authorized(receipt);
        await adapter.stop(receipt.plan.current);
        this.active(this.read(), receipt);
        await adapter.start({
          digest: receipt.plan.target,
          artifactPath: this.checkArtifact(receipt.plan.target),
        });
        const health = healthSchema.parse(await adapter.health());
        if (health.digest !== receipt.plan.target)
          return this.receipt(principal, id);
        this.change((state) => {
          const r = this.active(state, receipt);
          r.status = health.healthy ? "healthy" : "unhealthy";
          r.observation = { ...health, at: this.now() };
          state.current = receipt.plan.target;
          // Unhealthy release blocks further deployment until rollback/reconciliation.
          if (health.healthy) state.active = null;
        });
      } catch {
        /* Errors may contain credentials; intent remains unknown. */
      }
      return this.receipt(principal, id);
    });
  }
  /** One explicit owner rollback per deployed receipt, including after expiry.
   * Unknown effects must be reconciled first; there is no automatic rollback. */
  async rollback(principal: string, id: string): Promise<ReleaseReceipt> {
    this.owner(principal);
    z.uuid().parse(id);
    const adapter = this.options.adapter;
    if (!adapter) throw new Error("release_adapter_not_configured");
    return this.exclusively(async () => {
      const receipt = this.change((state) => {
        const r = state.receipts[id];
        if (
          !r ||
          !["healthy", "unhealthy"].includes(r.status) ||
          r.rollbackStartedAt !== undefined ||
          r.effectGeneration !== state.generation ||
          (state.active !== null && state.active !== id) ||
          state.current !== r.plan.target
        )
          denied();
        this.checkArtifact(r.plan.current);
        r.status = "rollback_unknown";
        r.rollbackStartedAt = this.now();
        r.effectGeneration = ++state.generation;
        state.active = id;
        return r;
      });
      try {
        const before = healthSchema.parse(await adapter.health());
        if (before.digest !== receipt.plan.target)
          return this.receipt(principal, id);
        this.active(this.read(), receipt);
        await adapter.stop(receipt.plan.target);
        this.active(this.read(), receipt);
        await adapter.start({
          digest: receipt.plan.current,
          artifactPath: this.checkArtifact(receipt.plan.current),
        });
        const health = healthSchema.parse(await adapter.health());
        if (health.digest === receipt.plan.current && health.healthy)
          this.change((state) => {
            const r = this.active(state, receipt);
            r.status = "rolled_back";
            r.observation = { ...health, at: this.now() };
            state.current = receipt.plan.current;
            state.active = null;
          });
      } catch {
        /* Do not retry an ambiguous rollback. */
      }
      return this.receipt(principal, id);
    });
  }
  /** Observe only while the trusted host holds a quiescence fence. Neither this
   * method nor the gate may retry an unknown stop/start. No request boolean. */
  async reconcile(principal: string, id: string): Promise<ReleaseReceipt> {
    this.owner(principal);
    z.uuid().parse(id);
    const adapter = this.options.adapter;
    if (!adapter?.withQuiescence)
      throw new Error("release_quiescence_not_configured");
    return this.exclusively(async () => {
      const receipt = this.read().receipts[id];
      if (
        !receipt ||
        !["deploy_unknown", "rollback_unknown", "unhealthy"].includes(
          receipt.status,
        )
      )
        denied();
      this.active(this.read(), receipt);
      await adapter.withQuiescence(async () => {
        const health = healthSchema.parse(await adapter.health());
        this.checkArtifact(health.digest);
        this.change((state) => {
          const r = this.active(state, receipt);
          if (health.digest === r.plan.current && health.healthy) {
            r.status =
              r.rollbackStartedAt === undefined ? "unchanged" : "rolled_back";
          } else if (health.digest === r.plan.target) {
            r.status = health.healthy ? "healthy" : "unhealthy";
          } else denied();
          r.observation = { ...health, at: this.now() };
          state.current = health.digest;
          if (health.healthy) state.active = null;
        });
      });
      return this.receipt(principal, id);
    });
  }
}
