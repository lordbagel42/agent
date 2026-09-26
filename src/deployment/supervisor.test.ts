import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import {
  artifactDigest,
  type ReleaseAdapter,
  type ReleaseOptions,
  type ReleasePlan,
  ReleaseSupervisor,
  type VerificationEvidence,
} from "./supervisor.js";

const owner = "authenticated-owner";
const currentBytes = Buffer.from("previous approved application");
const targetBytes = Buffer.from("reviewed candidate, including dependencies");
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const current = hash(currentBytes);
const target = hash(targetBytes);
const verifierDigest = hash(Buffer.from("independent verifier and policy v1"));
const compatibility = {
  state: "state-v1",
  journal: "journal-v3",
  migrations: "none",
  rollbackSafe: true,
} as const;
const plan: ReleasePlan = {
  current,
  target,
  verificationId: "immutable-attestation-1",
  compatibility,
  review: "Owner reviewed exact artifact and rollback to current",
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "june-release-"));
  const root = path.join(directory, "supervisor");
  mkdirSync(root, { mode: 0o700 });
  const running = path.join(directory, "running-artifact");
  writeFileSync(running, currentBytes);
  const f = {
    now: 10_000,
    healthy: true,
    quiescent: true,
    evidence: {
      currentDigest: current,
      artifactDigest: target,
      verifierDigest,
      compatibility,
      passed: true,
      completedAt: 10_000,
    } as VerificationEvidence,
    effects: [] as string[],
  };
  const adapter: ReleaseAdapter = {
    async health() {
      return { digest: hash(readFileSync(running)), healthy: f.healthy };
    },
    async stop(expected) {
      expect(hash(readFileSync(running))).toBe(expected);
      f.effects.push(`stop:${expected}`);
      unlinkSync(running);
    },
    async start(release) {
      const bytes = readFileSync(release.artifactPath);
      expect(hash(bytes)).toBe(release.digest);
      writeFileSync(running, bytes);
      f.effects.push(`start:${release.digest}`);
    },
    async withQuiescence(observe) {
      if (!f.quiescent) throw new Error("old operation can still complete");
      await observe();
    },
  };
  const options: ReleaseOptions = {
    root,
    owner,
    initial: {
      digest: current,
      state: compatibility.state,
      journal: compatibility.journal,
    },
    verifierDigest,
    verificationMaxAgeMs: 1_000,
    approvalTtlMs: 500,
    verification: (id) => {
      if (id !== plan.verificationId) throw new Error("unknown attestation");
      return f.evidence;
    },
    adapter,
    now: () => f.now,
  };
  const instances = new Set<ReleaseSupervisor>();
  const open = () => {
    const supervisor = new ReleaseSupervisor(options);
    instances.add(supervisor);
    return supervisor;
  };
  const close = (supervisor: ReleaseSupervisor) => {
    supervisor.close();
    instances.delete(supervisor);
  };
  cleanup.push(() => {
    for (const s of instances) s.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const supervisor = open();
  supervisor.stage(currentBytes, current);
  supervisor.stage(targetBytes, target);
  const approve = () =>
    supervisor.approve(owner, supervisor.review(owner, plan).id);
  return {
    f,
    root,
    running,
    adapter,
    options,
    supervisor,
    open,
    close,
    approve,
  };
}

test("only explicit owner approval of a stored exact review authorizes a one-use release", async () => {
  const { supervisor: s, f, root, adapter, approve } = fixture();
  expect(() => s.review("model", plan)).toThrow();
  const reviewed = s.review(owner, plan);
  await expect(s.deploy(owner, reviewed.id, "0".repeat(64))).rejects.toThrow();
  expect(() => s.approve("model", reviewed.id)).toThrow();
  // Mutating a returned display object must not change the reviewed plan.
  reviewed.plan.target = current;
  const grant = s.approve(owner, reviewed.id);
  expect(() => s.approve(owner, reviewed.id)).toThrow();
  expect(s.receipt(owner, grant.id).plan.target).toBe(target);
  expect(() => s.receipt("model", grant.id)).toThrow();
  expect(() => s.cancel("model", grant.id)).toThrow();
  await expect(s.deploy("model", grant.id, grant.token)).rejects.toThrow();
  await expect(s.deploy(owner, grant.id, "0".repeat(64))).rejects.toThrow();
  const receipt = s.receipt(owner, grant.id);
  expect(receipt).not.toHaveProperty("tokenHash");
  const db = new DatabaseSync(path.join(root, "release.sqlite"), {
    readOnly: true,
  });
  try {
    expect(
      JSON.stringify(db.prepare("SELECT value FROM state").get()),
    ).not.toContain(grant.token);
  } finally {
    db.close();
  }
  const revoked = approve();
  s.cancel(owner, revoked.id);
  await expect(s.deploy(owner, revoked.id, revoked.token)).rejects.toThrow();
  f.now += 500;
  await expect(s.deploy(owner, grant.id, grant.token)).rejects.toThrow();
  const delayed = approve();
  const health = adapter.health;
  adapter.health = async () => {
    f.now += 500;
    return health();
  };
  expect((await s.deploy(owner, delayed.id, delayed.token)).status).toBe(
    "deploy_unknown",
  );
  adapter.health = health;
  expect((await s.reconcile(owner, delayed.id)).status).toBe("unchanged");
  await expect(s.deploy(owner, delayed.id, delayed.token)).rejects.toThrow();
  expect(f.effects).toEqual([]);
});

test("requires fresh immutable artifact/verifier/current/compatibility evidence, never a command result", async () => {
  const { supervisor: s, f, approve } = fixture();
  const good = f.evidence;
  const commandReceipt = {
    status: "passed",
    passed: true,
    exitCode: 0,
    signal: null,
    baseCommit: "abc",
    headCommit: "abc",
    finishedAt: new Date(f.now).toISOString(),
    replayed: false,
    output: "omitted",
  };
  const invalid = [
    commandReceipt,
    { ...good, artifactDigest: current },
    { ...good, currentDigest: target },
    { ...good, verifierDigest: current },
    { ...good, completedAt: f.now + 1 },
    { ...good, completedAt: f.now - 1_001 },
    { ...good, compatibility: { ...compatibility, journal: "journal-v4" } },
    { ...good, compatibility: { ...compatibility, migrations: "reversible" } },
  ];
  for (const evidence of invalid) {
    f.evidence = evidence as VerificationEvidence;
    expect(() => s.review(owner, plan)).toThrow();
  }
  f.evidence = good;
  const review = s.review(owner, plan);
  f.evidence = { ...good, completedAt: good.completedAt - 1 };
  expect(() => s.approve(owner, review.id)).toThrow();
  f.evidence = good;
  const grant = approve();
  f.evidence = { ...good, completedAt: good.completedAt - 1 };
  await expect(s.deploy(owner, grant.id, grant.token)).rejects.toThrow();
  // Freshness must be checked again at deployment, even if approval is unexpired.
  f.evidence = { ...good, completedAt: f.now - 1_000 };
  const boundary = approve();
  f.now += 1;
  await expect(s.deploy(owner, boundary.id, boundary.token)).rejects.toThrow();
  expect(f.effects).toEqual([]);
});

test("staging and deployment reject changed bytes and symlinks without overwriting existing artifacts", async () => {
  const { supervisor: s, f, root, options, approve } = fixture();
  expect(artifactDigest(Buffer.from("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(() => s.stage(targetBytes, current)).toThrow();
  s.stage(targetBytes, target);
  const file = path.join(root, `${target}.artifact`);
  expect(statSync(file).mode & 0o777).toBe(0o400);
  const grant = approve();
  chmodSync(file, 0o600);
  writeFileSync(file, "changed after review");
  chmodSync(file, 0o400);
  await expect(s.deploy(owner, grant.id, grant.token)).rejects.toThrow();
  expect(() => s.stage(targetBytes, target)).toThrow();
  expect(readFileSync(file, "utf8")).toBe("changed after review");
  unlinkSync(file);
  symlinkSync(path.join(root, `${current}.artifact`), file);
  await expect(s.deploy(owner, grant.id, grant.token)).rejects.toThrow();
  chmodSync(root, 0o755);
  expect(() => new ReleaseSupervisor(options)).toThrow();
  chmodSync(root, 0o700);
  expect(f.effects).toEqual([]);
});

test("durable unknown intents survive reopen and never repeat deployment or rollback", async () => {
  const { supervisor: s, f, adapter, open, close, approve } = fixture();
  const grant = approve();
  const peer = open();
  const start = adapter.start;
  adapter.start = async (release) => {
    expect(peer.receipt(owner, grant.id).status).toBe("deploy_unknown");
    await start(release);
    throw new Error("private adapter output must not enter receipt");
  };
  expect((await s.deploy(owner, grant.id, grant.token)).status).toBe(
    "deploy_unknown",
  );
  close(s);
  close(peer);
  const recovered = open();
  await expect(
    recovered.deploy(owner, grant.id, grant.token),
  ).rejects.toThrow();
  await expect(recovered.rollback(owner, grant.id)).rejects.toThrow();
  f.quiescent = false;
  await expect(recovered.reconcile(owner, grant.id)).rejects.toThrow();
  expect(recovered.receipt(owner, grant.id).status).toBe("deploy_unknown");
  expect(JSON.stringify(recovered.receipt(owner, grant.id))).not.toContain(
    "private adapter output",
  );
  f.quiescent = true;
  expect((await recovered.reconcile(owner, grant.id)).status).toBe("healthy");
  adapter.stop = async () => {
    expect(recovered.receipt(owner, grant.id).status).toBe("rollback_unknown");
    f.effects.push("ambiguous-stop");
    throw new Error("unknown stop outcome");
  };
  expect((await recovered.rollback(owner, grant.id)).status).toBe(
    "rollback_unknown",
  );
  await expect(recovered.rollback(owner, grant.id)).rejects.toThrow();
  expect((await recovered.reconcile(owner, grant.id)).status).toBe("healthy");
  // Reconciliation cannot reset the one-attempt rollback guard.
  await expect(recovered.rollback(owner, grant.id)).rejects.toThrow();
  expect(f.effects).toEqual([
    `stop:${current}`,
    `start:${target}`,
    "ambiguous-stop",
  ]);
});

test("rollback restores exact retained bytes and invalidates earlier approvals even when current returns", async () => {
  const { supervisor: s, f, running, approve } = fixture();
  const staleReview = s.review(owner, plan);
  const staleGrant = approve();
  const grant = approve();
  expect((await s.deploy(owner, grant.id, grant.token)).status).toBe("healthy");
  expect(readFileSync(running)).toEqual(targetBytes);
  await expect(s.deploy(owner, grant.id, grant.token)).rejects.toThrow();
  f.now += 5_000; // Rollback is a new explicit owner action, not an expired token replay.
  expect((await s.rollback(owner, grant.id)).status).toBe("rolled_back");
  expect(readFileSync(running)).toEqual(currentBytes);
  // Make time/evidence fresh again to isolate the generation (ABA) guard.
  f.now = 10_000;
  expect(() => s.approve(owner, staleReview.id)).toThrow();
  await expect(
    s.deploy(owner, staleGrant.id, staleGrant.token),
  ).rejects.toThrow();
  await expect(s.rollback(owner, grant.id)).rejects.toThrow();
  expect(f.effects).toEqual([
    `stop:${current}`,
    `start:${target}`,
    `stop:${target}`,
    `start:${current}`,
  ]);
});

test("in-flight operations block reconciliation/replay and health must identify the running release", async () => {
  const { supervisor: s, f, adapter, open, approve } = fixture();
  const grant = approve();
  const peer = open();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const start = adapter.start;
  adapter.start = async (candidate) => {
    started.resolve();
    await release.promise;
    await start(candidate);
  };
  const pending = s.deploy(owner, grant.id, grant.token);
  await started.promise;
  await expect(s.reconcile(owner, grant.id)).rejects.toThrow();
  await expect(peer.deploy(owner, grant.id, grant.token)).rejects.toThrow();
  f.quiescent = false;
  await expect(peer.reconcile(owner, grant.id)).rejects.toThrow();
  // A generic ready=true or old-release identity cannot settle this target.
  adapter.health = async () => ({ digest: current, healthy: true });
  release.resolve();
  expect((await pending).status).toBe("deploy_unknown");
  await expect(s.deploy(owner, grant.id, grant.token)).rejects.toThrow();
  f.quiescent = true;
  adapter.health = async () => ({ digest: target, healthy: false });
  expect((await s.reconcile(owner, grant.id)).status).toBe("unhealthy");
  expect(() => s.review(owner, plan)).toThrow();
  expect(f.effects).toEqual([`stop:${current}`, `start:${target}`]);
});
