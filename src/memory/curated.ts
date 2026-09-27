import { execFileSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { type Evidence, freshEvidence } from "../reflection/domain.js";
import {
  GLOBAL_PROPOSAL_MAX_AGE_MS,
  type GlobalPersonalityProposal,
  globalProposalInputSchema,
} from "../reflection/global-proposal.js";
import {
  CHARTER,
  initialPersonality,
  type PersonalityProposal,
  type PersonalityState,
  personalityTraits,
  revertPersonality,
  revisePersonality,
  type Trait,
} from "../reflection/personality.js";
import type { EvidenceStore } from "./store.js";

const format = "june-curated-v1";
const ref = "refs/heads/curated";
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = z.strictObject({
  version: z.literal(1),
  revision: hex,
  payload: hex,
  evidence: z.array(hex),
});
type Provenance = { scope: string; id: string; sources: string[] };
type Snapshot = {
  state: PersonalityState;
  provenance: Provenance[];
  globalProposals?: GlobalPersonalityProposal[];
};

/** Reject symlinks in every existing path component, not just the leaf. */
function safePath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error("Curated store requires a canonical absolute path");
  for (let part = path; ; part = dirname(part)) {
    if (
      existsSync(part) ||
      (() => {
        try {
          lstatSync(part);
          return true;
        } catch {
          return false;
        }
      })()
    ) {
      if (lstatSync(part).isSymbolicLink())
        throw new Error("Curated store forbids symlinks");
    }
    if (dirname(part) === part) break;
  }
}

/** Owner-only directories are required; same-UID hostile filesystem races are
 * outside this boundary. Never open a checkout, nested checkout, or arbitrary
 * preexisting directory, even when empty. */
function inspectTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
    throw new Error("Unsafe curated store entry");
  if (stat.isFile() && stat.nlink !== 1)
    throw new Error("Curated store forbids hardlinks");
  if (stat.isDirectory())
    for (const name of readdirSync(path)) inspectTree(join(path, name));
}

/** Local, metadata-only Git journal. No plaintext export API deliberately:
 * even revision names, scopes, explanations, and source IDs remain encrypted.
 * Git contains only random IDs, ciphertext hashes and keyed provenance hashes.
 *
 * This is NOT authorization. Only call ownerRevise/ownerRollback from the
 * existing authenticated operator review path. Neither model confidence nor
 * possession of an evidence ID grants permission. Audience must likewise come
 * from authenticated routing. The evidence ledger must retain its tombstones.
 *
 * Supply a dedicated, unused absolute directory OUTSIDE all Git repositories.
 * It contains a bare metadata.git and private encrypted snapshots/ sibling.
 * The 32-byte key is injected from a secret manager/environment, never written.
 * Back up both directories and the key separately. Git alone cannot restore
 * personality; snapshots are not cryptographic erasure on source deletion.
 */
export class CuratedPersonalityStore {
  private readonly key: Buffer;
  private readonly root: string;
  private readonly marker: string;
  private closed = false;

  constructor(
    root: string,
    key: Uint8Array,
    private readonly evidence: EvidenceStore,
    options: { initialize?: boolean } = {},
  ) {
    if (!(key instanceof Uint8Array) || key.byteLength !== 32)
      throw new Error("Curated store key must be 32 bytes");
    safePath(root);
    for (let parent = dirname(root); ; parent = dirname(parent)) {
      if (
        existsSync(join(parent, ".git")) ||
        (existsSync(join(parent, "HEAD")) &&
          existsSync(join(parent, "objects")))
      )
        throw new Error("Curated store must be outside existing repositories");
      if (dirname(parent) === parent) break;
    }
    this.root = root;
    this.key = Buffer.from(key);
    this.marker = `${format}\n${this.opaque(["store", root])}\n`;
    if (!existsSync(root)) {
      if (!options.initialize) throw new Error("Curated store not initialized");
      // Exclusive creation: a concurrent initializer cannot adopt our directory.
      mkdirSync(root, { mode: 0o700 });
      mkdirSync(join(root, "snapshots"), { mode: 0o700 });
      this.git(
        [
          "init",
          "--bare",
          "--object-format=sha1",
          "--template=",
          join(root, "metadata.git"),
        ],
        undefined,
        true,
      );
      writeFileSync(join(root, "STORE"), this.marker, {
        flag: "wx",
        mode: 0o600,
      });
    }
    this.check();
    if (this.git(["rev-parse", "--is-bare-repository"]) !== "true")
      throw new Error("Expected dedicated bare repository");
  }

  private opaque(value: unknown): string {
    return createHmac("sha256", this.key)
      .update(`${format}\0${JSON.stringify(value)}`)
      .digest("hex");
  }

  private check(): void {
    if (this.closed) throw new Error("Curated store closed");
    safePath(this.root);
    if (
      realpathSync(this.root) !== this.root ||
      (lstatSync(this.root).mode & 0o077) !== 0 ||
      lstatSync(this.root).uid !== process.getuid?.()
    )
      throw new Error("Curated store requires an owner-only directory");
    inspectTree(this.root);
    if (readFileSync(join(this.root, "STORE"), "utf8") !== this.marker)
      throw new Error("Unrecognized curated store or key");
    // Alternates could silently read another repository; never support them.
    if (
      existsSync(
        join(this.root, "metadata.git", "objects", "info", "alternates"),
      )
    )
      throw new Error("Git alternates are not allowed");
  }

  private git(args: string[], input?: string, initializing = false): string {
    try {
      return execFileSync(
        "git",
        [
          "--no-replace-objects",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgSign=false",
          "-c",
          "core.fsync=committed",
          ...(initializing
            ? []
            : ["--git-dir", join(this.root, "metadata.git")]),
          ...args,
        ],
        {
          cwd: this.root,
          input,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          timeout: 10_000,
          stdio: ["pipe", "pipe", "pipe"],
          // No inherited GIT_DIR, index, hooks, identity, configuration or secrets.
          env: {
            PATH: process.env.PATH,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_NO_REPLACE_OBJECTS: "1",
            GIT_AUTHOR_NAME: "June curated store",
            GIT_AUTHOR_EMAIL: "curated@localhost",
            GIT_COMMITTER_NAME: "June curated store",
            GIT_COMMITTER_EMAIL: "curated@localhost",
          },
        },
      ).trim();
    } catch {
      // Git errors may contain supplied paths or object contents.
      throw new Error("Curated Git operation failed");
    }
  }

  private head(): string | null {
    const head = this.git(["for-each-ref", "--format=%(objectname)", ref]);
    if (!head) return null;
    if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Invalid curated head");
    return head;
  }

  private load(commit: string | null): Snapshot {
    if (!commit) return { state: initialPersonality(), provenance: [] };
    if (!/^[a-f0-9]{40}$/.test(commit))
      throw new Error("Invalid curated commit");
    try {
      const record = recordSchema.parse(
        JSON.parse(this.git(["show", `${commit}:record.json`])),
      );
      const bytes = readFileSync(join(this.root, "snapshots", record.revision));
      if (createHash("sha256").update(bytes).digest("hex") !== record.payload)
        throw new Error();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        bytes.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(`${this.marker}${record.revision}`));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const snapshot = JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString("utf8"),
      ) as Snapshot;
      // Authenticated snapshots are written exclusively by this module. Never
      // accept charter data from disk, even from an authenticated old revision.
      snapshot.state.charter = CHARTER;
      if (
        JSON.stringify(this.references(snapshot)) !==
        JSON.stringify(record.evidence)
      )
        throw new Error();
      return snapshot;
    } catch {
      throw new Error("Curated snapshot authentication failed");
    }
  }

  private references(snapshot: Snapshot): string[] {
    return [
      ...new Set(
        snapshot.provenance.flatMap((p) =>
          [p.id, ...p.sources].map((id) =>
            this.opaque(["evidence", p.scope, id]),
          ),
        ),
      ),
    ].sort();
  }

  private persist(snapshot: Snapshot, parent: string | null): string {
    const revision = randomBytes(32).toString("hex");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`${this.marker}${revision}`));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(snapshot), "utf8"),
      cipher.final(),
    ]);
    const bytes = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    writeFileSync(join(this.root, "snapshots", revision), bytes, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    const record = JSON.stringify({
      version: 1,
      revision,
      payload: createHash("sha256").update(bytes).digest("hex"),
      evidence: this.references(snapshot),
    });
    const blob = this.git(["hash-object", "-w", "--stdin"], record);
    const tree = this.git(["mktree"], `100644 blob ${blob}\trecord.json\n`);
    const commit = this.git(
      ["commit-tree", tree, ...(parent ? ["-p", parent] : [])],
      "feat(memory): record curated revision\n",
    );
    // CAS: concurrent writers never silently overwrite a revision. Failure can
    // leave unreachable encrypted snapshots/objects, safe for operator cleanup.
    this.git(["update-ref", ref, commit, parent ?? "0".repeat(40)]);
    return commit;
  }

  private provenance(scope: string, id: string): Provenance {
    const visible = this.evidence.search(scope, "");
    if (
      !visible.sources.some((s) => s.id === id) &&
      !visible.claims.some((c) => c.id === id && c.kind !== "dream")
    )
      throw new Error("Missing or unauthorized personality evidence");
    const sources = this.evidence.independentEvidence(id, scope);
    if (
      !sources.length ||
      sources.some((id) =>
        visible.sources.some(
          (source) =>
            source.id === id &&
            source.platform === "slack" &&
            source.text.startsWith("##"),
        ),
      )
    )
      throw new Error("Personality requires original sources");
    return { scope, id, sources };
  }

  /** Explicit operator curation, not an autonomous model tool. Evidence objects
   * must come from the trusted reflection adapter, not from model output. */
  ownerRevise(
    proposal: PersonalityProposal,
    supporting: Evidence[],
    now: number,
    maxAgeMs: number,
  ): string {
    this.check();
    const parent = this.head();
    const snapshot = this.load(parent);
    const grounded = this.evidence.reflectionEvidence(
      proposal.scope,
      proposal.evidenceIds,
      maxAgeMs,
    );
    if (grounded.some((e) => !supporting.some((s) => isDeepStrictEqual(s, e))))
      throw new Error("Personality evidence must match the current ledger");
    const state = revisePersonality(
      snapshot.state,
      proposal,
      grounded,
      now,
      maxAgeMs,
    );
    const provenance = [...snapshot.provenance];
    for (const id of [...new Set(proposal.evidenceIds)].sort()) {
      const current = this.provenance(proposal.scope, id);
      const previous = provenance.find(
        (p) => p.scope === current.scope && p.id === id,
      );
      if (previous && JSON.stringify(previous) !== JSON.stringify(current))
        throw new Error("Personality provenance changed");
      if (!previous) provenance.push(current);
    }
    return this.persist({ ...snapshot, state, provenance }, parent);
  }

  /** Host-only private staging. Scope comes from authenticated owner routing;
   * input comes from the model. This never touches effective personality.
   * Source IDs, rationale and changes stay in the encrypted snapshot. */
  stageGlobalProposal(
    scope: string,
    input: unknown,
    now = Date.now(),
  ): GlobalPersonalityProposal {
    this.check();
    const parsed = globalProposalInputSchema.safeParse(input);
    if (
      !parsed.success ||
      !scope.trim() ||
      scope.length > 2048 ||
      !Number.isSafeInteger(now) ||
      now < 0
    )
      throw new Error("Invalid global personality suggestion");
    const value = {
      ...parsed.data,
      evidenceIds: [...parsed.data.evidenceIds].sort(),
    };
    const grounded = this.evidence.reflectionEvidence(
      scope,
      value.evidenceIds,
      GLOBAL_PROPOSAL_MAX_AGE_MS,
    );
    if (
      !grounded.every((e) =>
        freshEvidence(e, scope, now, GLOBAL_PROPOSAL_MAX_AGE_MS),
      )
    )
      throw new Error("Global suggestion requires fresh original evidence");
    const parent = this.head();
    const snapshot = this.load(parent);
    const id = `personality:${this.opaque(["global-proposal", scope, value])}`;
    const previous = snapshot.globalProposals?.find((p) => p.id === id);
    if (previous) {
      if (!this.validGlobalProposal(snapshot, previous, scope, now))
        throw new Error("Global suggestion is no longer valid");
      return structuredClone(previous);
    }
    const provenance = value.evidenceIds.map((id) =>
      this.provenance(scope, id),
    );
    for (const current of provenance) {
      const saved = snapshot.provenance.find(
        (p) => p.scope === scope && p.id === current.id,
      );
      if (saved && !isDeepStrictEqual(saved, current))
        throw new Error("Personality provenance changed");
      if (!saved) snapshot.provenance.push(current);
    }
    const proposal: GlobalPersonalityProposal = {
      ...value,
      id,
      scope,
      sourceIds: [...new Set(provenance.flatMap((p) => p.sources))].sort(),
      createdAt: now,
      expiresAt: Math.min(...grounded.map((e) => e.expiresAt)),
      status: "pending",
    };
    snapshot.globalProposals ??= [];
    if (
      snapshot.globalProposals.filter(
        (p) => p.scope === scope && p.expiresAt > now,
      ).length >= 20
    )
      throw new Error("Global suggestion staging capacity reached");
    snapshot.globalProposals.push(proposal);
    this.persist(snapshot, parent);
    return structuredClone(proposal);
  }

  private validGlobalProposal(
    snapshot: Snapshot,
    proposal: GlobalPersonalityProposal,
    scope: string,
    now: number,
  ): boolean {
    if (
      proposal.scope !== scope ||
      !Number.isSafeInteger(now) ||
      now < proposal.createdAt ||
      now >= proposal.expiresAt
    )
      return false;
    try {
      const grounded = this.evidence.reflectionEvidence(
        scope,
        proposal.evidenceIds,
        GLOBAL_PROPOSAL_MAX_AGE_MS,
      );
      return grounded.every(
        (e) =>
          freshEvidence(e, scope, now, GLOBAL_PROPOSAL_MAX_AGE_MS) &&
          isDeepStrictEqual(
            snapshot.provenance.find((p) => p.scope === scope && p.id === e.id),
            this.provenance(scope, e.id),
          ),
      );
    } catch {
      return false;
    }
  }

  /** Private payload lookup, not approval status: callers must also consult the
   * global actor's terminal decision ledger and compare expectedVersion. */
  pendingGlobalProposal(
    scope: string,
    id: string,
    now = Date.now(),
  ): GlobalPersonalityProposal | undefined {
    this.check();
    const snapshot = this.load(this.head());
    const proposal = snapshot.globalProposals?.find((p) => p.id === id);
    return proposal && this.validGlobalProposal(snapshot, proposal, scope, now)
      ? structuredClone(proposal)
      : undefined;
  }

  pendingGlobalProposals(
    scope: string,
    limit = 10,
    now = Date.now(),
    excludedIds: readonly string[] = [],
  ): GlobalPersonalityProposal[] {
    this.check();
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new Error("Invalid suggestion limit");
    const snapshot = this.load(this.head());
    const excluded = new Set(excludedIds);
    return structuredClone(
      (snapshot.globalProposals ?? [])
        .filter(
          (p) =>
            !excluded.has(p.id) &&
            this.validGlobalProposal(snapshot, p, scope, now),
        )
        .slice(-limit),
    );
  }

  /** Uses the existing append-only rollback semantics (revert current head).
   * target/id are private personality revision IDs, NOT Git revision syntax. */
  ownerRollback(
    id: string,
    target: string,
    explanation: string,
    now: number,
  ): string {
    this.check();
    const parent = this.head();
    const snapshot = this.load(parent);
    snapshot.state = revertPersonality(
      snapshot.state,
      id,
      target,
      explanation,
      now,
    );
    return this.persist(snapshot, parent);
  }

  /** Operator-only metadata, deliberately omitting explanations/values that may
   * refer to forgotten sources. Use these IDs to append a rollback. */
  ownerHistory(): {
    commit: string | null;
    revisions: {
      id: string;
      parent: string | null;
      createdAt: number;
      reverts?: string;
    }[];
  } {
    this.check();
    const commit = this.head();
    return {
      commit,
      revisions: this.load(commit).state.revisions.map(
        ({ id, parent, createdAt, reverts }) => ({
          id,
          parent,
          createdAt,
          ...(reverts ? { reverts } : {}),
        }),
      ),
    };
  }

  /** The ONLY model projection. Historical reads
   * and rollbacks check today's ledger, so deleting one supporting source hides
   * the whole trait; never fall back to an older trait on validation failure. */
  effectiveTraits(
    audience: string,
    commit?: string,
  ): Partial<Record<Trait, string>> {
    this.check();
    if (!audience.trim()) throw new Error("Audience required");
    const head = this.head();
    if (commit) {
      if (!head || !/^[a-f0-9]{40}$/.test(commit))
        throw new Error("Invalid curated commit");
      this.git(["merge-base", "--is-ancestor", commit, head]);
    }
    const snapshot = this.load(commit ?? head);
    const scoped = personalityTraits(snapshot.state, audience);
    const result: Partial<Record<Trait, string>> = {};
    for (const trait of ["verbosity", "tone", "humor", "interests"] as const) {
      const value = scoped[trait];
      if (!value || value.scope !== audience || !value.evidenceIds.length)
        continue;
      const valid = value.evidenceIds.every((id) => {
        const saved = snapshot.provenance.find(
          (p) => p.id === id && p.scope === audience,
        );
        if (!saved) return false;
        try {
          return (
            JSON.stringify(saved) ===
            JSON.stringify(this.provenance(audience, id))
          );
        } catch {
          return false;
        }
      });
      if (valid) result[trait] = value.value;
    }
    return result;
  }

  close(): void {
    this.key.fill(0);
    this.closed = true;
  }
}
