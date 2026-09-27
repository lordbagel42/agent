import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

const exec = promisify(execFile);

export interface WorktreeConfig {
  /** Existing, absolute, canonical repository and separate worktree roots. */
  repositoryRoot: string;
  worktreeRoot: string;
  /** Operator-owned configuration only; never populate from model output. */
  verifier?: {
    /** Absolute executable followed by literal arguments. No implicit shell. */
    argv: readonly [string, ...string[]];
    timeoutMs: number;
    /** Explicit environment allowlist; the host environment is NOT inherited. */
    env?: Readonly<Record<string, string>>;
  };
}

export interface WorktreeManifest {
  version: 1;
  jobId: string;
  repositoryRoot: string;
  worktreeRoot: string;
  cwd: string;
  baseCommit: string;
}

/** Fixed admission reason only; never include the occupying job's metadata. */
export class WorkspaceOccupiedError extends Error {
  constructor() {
    super(
      "Coding worktree: workspace occupied; reconcile its existing execution first",
    );
  }
}

export interface VerificationArtifact {
  version: 1;
  scope: "tracked-and-untracked-nonignored";
  headCommit: string;
  /** SHA-256 of HEAD, paths, file modes, bytes and symlink targets. */
  digest: string;
}

export interface WorktreeDiffSummary {
  baseCommit: string;
  observedAt: string;
  comparison: "approved_base_to_worktree";
  accuracy: "candidate_statuses_not_content_verified";
  files: { status: string; path: string; pathTruncated: boolean }[];
  truncated: boolean;
  contents: "omitted";
  submodules: "omitted";
}

/** Command-outcome evidence for a local source artifact, never deployment proof. */
export interface VerificationResult {
  status:
    | "passed"
    | "failed"
    | "timed_out"
    | "aborted"
    | "error"
    | "not_configured"
    | "needs_review";
  /** Null means no definitive check outcome, not a pass. */
  passed: boolean | null;
  exitCode: number | null;
  signal: string | null;
  baseCommit: string;
  headCommit: string;
  finishedAt: string;
  /** A replay is historical evidence, NOT verification of current file contents. */
  replayed: boolean;
  /** Absent on legacy receipts. Ignored files and external dependencies are excluded. */
  artifact?: VerificationArtifact;
  /** False invalidates this evidence; null/absent means identity is unknown. */
  artifactMatches?: boolean | null;
  /** Untrusted command output is deliberately neither retained nor returned. */
  output: "omitted";
}

function fail(message: string): never {
  // Do not include subprocess output: it may contain credentials or source text.
  throw new Error(`Coding worktree: ${message}`);
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function directory(directoryPath: string): Promise<void> {
  if (
    !path.isAbsolute(directoryPath) ||
    path.resolve(directoryPath) !== directoryPath ||
    (await realpath(directoryPath)) !== directoryPath ||
    !(await lstat(directoryPath)).isDirectory()
  ) {
    fail("paths must be canonical directories without symlinks");
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeNew(file: string, value: unknown): Promise<void> {
  const handle = await open(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32_768) fail("invalid metadata file");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function git(
  cwd: string,
  args: string[],
  inspection = false,
): Promise<string> {
  try {
    const { stdout } = await exec(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        ...(inspection
          ? [
              "-c",
              "diff.autoRefreshIndex=false",
              "-c",
              "core.sparseCheckout=false",
              "-c",
              "core.splitIndex=false",
            ]
          : []),
        ...args,
      ],
      {
        cwd,
        // In particular, never inherit GIT_DIR, GIT_WORK_TREE, or GIT_INDEX_FILE.
        env: {
          PATH: process.env.PATH,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          ...(inspection
            ? {
                GIT_OPTIONAL_LOCKS: "0",
                GIT_NO_LAZY_FETCH: "1",
                GIT_NO_REPLACE_OBJECTS: "1",
              }
            : {}),
        },
        timeout: inspection ? 5_000 : 60_000,
        maxBuffer: inspection ? 65_536 : 1024 * 1024,
      },
    );
    return args.includes("-z") ? stdout : stdout.trim();
  } catch {
    return fail("Git operation failed; inspect locally before retrying");
  }
}

export function verificationArtifact(
  value: unknown,
): VerificationArtifact | undefined {
  if (!value || typeof value !== "object") return undefined;
  const artifact = value as VerificationArtifact;
  if (
    artifact.version !== 1 ||
    artifact.scope !== "tracked-and-untracked-nonignored" ||
    typeof artifact.headCommit !== "string" ||
    typeof artifact.digest !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(artifact.headCommit) ||
    !/^[a-f0-9]{64}$/.test(artifact.digest)
  )
    return undefined;
  return {
    version: 1,
    scope: artifact.scope,
    headCommit: artifact.headCommit,
    digest: artifact.digest,
  };
}

async function identifyArtifact(cwd: string): Promise<VerificationArtifact> {
  const headCommit = await git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const names = await git(
    cwd,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    false,
  );
  if (names.includes("\uFFFD")) fail("unsupported artifact filename encoding");
  const digest = createHash("sha256").update(`june-source-v1\0${headCommit}\0`);
  for (const name of [...new Set(names.split("\0").filter(Boolean))].sort()) {
    const file = path.join(cwd, name);
    if (!within(cwd, file) || file === cwd) fail("invalid artifact path");
    const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) {
      digest.update(JSON.stringify([name, "deleted"]));
      continue;
    }
    if ((await realpath(path.dirname(file))) !== path.dirname(file))
      fail("artifact parent must not be a symlink");
    if (stat.isSymbolicLink()) {
      const target = await readlink(file, { encoding: "buffer" });
      digest.update(JSON.stringify([name, "symlink", target.toString("hex")]));
    } else if (stat.isFile()) {
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const content = createHash("sha256");
      try {
        for await (const chunk of handle.createReadStream({ autoClose: false }))
          content.update(chunk);
      } finally {
        await handle.close();
      }
      digest.update(
        JSON.stringify([name, stat.mode & 0o7777, content.digest("hex")]),
      );
    } else {
      // In particular, do not silently certify unchecked submodule contents.
      fail("unsupported artifact entry");
    }
  }
  return {
    version: 1,
    scope: "tracked-and-untracked-nonignored",
    headCommit,
    digest: digest.digest("hex"),
  };
}

/** Git's index reader freshens split-index files even with optional locks off.
 * Parse the bounded v2/v3 envelope before any index-reading Git operation.
 * Unsupported indexes and executable clean/process filters fail closed.
 */
async function assertReadOnlyIndex(cwd: string) {
  const configuration = await git(cwd, ["config", "--null", "--list"], true);
  if (
    configuration
      .split("\0")
      .some((entry) => /^filter\..*\.(clean|process)\n/.test(entry))
  )
    fail("diff unavailable with executable Git filters");
  const algorithm = await git(
    cwd,
    ["rev-parse", "--show-object-format=storage"],
    true,
  );
  if (algorithm !== "sha1" && algorithm !== "sha256")
    fail("unsupported object format");
  const hashSize = algorithm === "sha1" ? 20 : 32;
  const gitDir = await git(cwd, ["rev-parse", "--absolute-git-dir"], true);
  await directory(gitDir);
  const handle = await open(
    path.join(gitDir, "index"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      fail("unsupported index");
    const data = await handle.readFile();
    const end = data.length - hashSize;
    if (
      end < 12 ||
      data.toString("ascii", 0, 4) !== "DIRC" ||
      ![2, 3].includes(data.readUInt32BE(4)) ||
      !createHash(algorithm)
        .update(data.subarray(0, end))
        .digest()
        .equals(data.subarray(end))
    )
      fail("unsupported index");
    const count = data.readUInt32BE(8);
    let offset = 12;
    for (let i = 0; i < count; i++) {
      const start = offset;
      const flagsAt = start + 40 + hashSize;
      if (flagsAt + 2 > end) fail("invalid index entry");
      offset = flagsAt + 2 + (data.readUInt16BE(flagsAt) & 0x4000 ? 2 : 0);
      const nul = data.indexOf(0, offset);
      if (nul < 0 || nul >= end) fail("invalid index entry");
      offset = start + Math.ceil((nul + 1 - start) / 8) * 8;
    }
    while (offset < end) {
      if (offset + 8 > end) fail("invalid index extension");
      const signature = data.toString("ascii", offset, offset + 4);
      // Lowercase signatures are mandatory extensions, including link/sdir.
      if (!/^[A-Z]/.test(signature)) fail("unsupported index extension");
      offset += 8 + data.readUInt32BE(offset + 4);
    }
    if (offset !== end) fail("invalid index length");
  } finally {
    await handle.close();
  }
}

/**
 * Call prepare only after the supervisor durably records approval. This helper
 * never launches a coding worker, resumes one, pushes, merges, or deploys.
 * Metadata is a sibling of worktrees, not inside the model's checkout. This is
 * NOT isolation against the same UID, malicious Git config, or filesystem races.
 * The supervisor must keep operator config/credentials out of model control and
 * prevent concurrent workers while checking. A passing command is evidence for
 * that command only, not proof of correctness or permission to deliver/deploy.
 */
export function createWorktreeManager(input: WorktreeConfig) {
  // Snapshot operator configuration so later caller mutation cannot change argv.
  const config = {
    ...input,
    verifier: input.verifier && {
      ...input.verifier,
      argv: [...input.verifier.argv],
      env: { ...input.verifier.env },
    },
  };
  const metadataRoot = path.join(config.worktreeRoot, ".june-jobs");

  async function roots(createMetadata = true) {
    await directory(config.repositoryRoot);
    await directory(config.worktreeRoot);
    if (
      within(config.repositoryRoot, config.worktreeRoot) ||
      within(config.worktreeRoot, config.repositoryRoot)
    )
      fail("repository and worktree roots must be separate");
    if (
      (await git(
        config.repositoryRoot,
        ["rev-parse", "--show-toplevel"],
        !createMetadata,
      )) !== config.repositoryRoot
    )
      fail("repository root must be the Git checkout root");
    if (createMetadata)
      await mkdir(metadataRoot, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
    await directory(metadataRoot);
  }

  function locations(jobId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(jobId))
      fail("invalid job ID");
    const name = `job-${createHash("sha256").update(jobId).digest("hex")}`;
    return {
      cwd: path.join(config.worktreeRoot, name),
      record: path.join(metadataRoot, name),
    };
  }

  async function owned(
    jobId: string,
    createMetadata = true,
  ): Promise<WorktreeManifest> {
    const { cwd, record } = locations(jobId);
    await roots(createMetadata);
    await directory(record);
    const raw = await readJson(path.join(record, "manifest.json"));
    if (!raw || typeof raw !== "object") fail("invalid manifest");
    const m = raw as WorktreeManifest;
    if (
      m.version !== 1 ||
      m.jobId !== jobId ||
      m.repositoryRoot !== config.repositoryRoot ||
      m.worktreeRoot !== config.worktreeRoot ||
      m.cwd !== cwd ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(m.baseCommit)
    )
      fail("manifest ownership mismatch");
    const ready = (await readJson(path.join(record, "ready.json"))) as {
      gitDir?: unknown;
    };
    await directory(cwd);
    const dotGit = await lstat(path.join(cwd, ".git"));
    if (!dotGit.isFile() || dotGit.isSymbolicLink())
      fail("invalid worktree Git marker");
    const readGit = (root: string, args: string[]) =>
      git(root, args, !createMetadata);
    const gitDir = await readGit(cwd, ["rev-parse", "--absolute-git-dir"]);
    const common = await readGit(config.repositoryRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    await directory(gitDir);
    await directory(common);
    if (
      ready?.gitDir !== gitDir ||
      !within(path.join(common, "worktrees"), gitDir) ||
      (await readGit(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])) !== common ||
      (await readGit(cwd, ["rev-parse", "--show-toplevel"])) !== cwd
    )
      fail("worktree registration mismatch");
    const entries = (
      await readGit(config.repositoryRoot, ["worktree", "list", "--porcelain"])
    ).split("\n");
    if (!entries.includes(`worktree ${cwd}`))
      fail("worktree is not registered");
    return m;
  }

  async function changeLease(change: (lease: string) => Promise<void>) {
    await roots();
    const lock = path.join(metadataRoot, "admission-lock");
    // A crash in this short critical section fails closed for operator review.
    await mkdir(lock, { mode: 0o700 });
    try {
      await change(path.join(metadataRoot, "active"));
    } finally {
      await rm(lock, { recursive: true });
    }
  }

  async function checkArtifact(
    jobId: string,
    receipt: VerificationResult,
  ): Promise<boolean | null> {
    const artifact = verificationArtifact(receipt.artifact);
    if (
      !artifact ||
      artifact.headCommit !== receipt.headCommit ||
      typeof receipt.artifactMatches !== "boolean"
    )
      return null;
    // A command that changed its own input never checked a stable artifact.
    if (!receipt.artifactMatches) return false;
    try {
      const manifest = await owned(jobId);
      const current = await identifyArtifact(manifest.cwd);
      return (
        receipt.baseCommit === manifest.baseCommit &&
        artifact.headCommit === current.headCommit &&
        artifact.digest === current.digest
      );
    } catch {
      return null;
    }
  }

  return {
    /** Read-only freshness check; never launches or replays a verifier command. */
    checkArtifact,
    /** Read only after fencing launches. Absence of a lease covers this root
     * only, not legacy sessions or workspaces removed from configuration. */
    async isSettled(): Promise<boolean> {
      await directory(config.worktreeRoot);
      if (!(await exists(metadataRoot))) return true;
      await directory(metadataRoot);
      return (
        !(await exists(path.join(metadataRoot, "admission-lock"))) &&
        !(await exists(path.join(metadataRoot, "active")))
      );
    },

    /** Fixed metadata-only Git reads. No caller paths, patches, or commands.
     * A running checkout can change between reads; this is not verification or
     * a sandbox against a same-UID worker changing Git config/filesystem state.
     */
    async diffSummary(
      jobId: string,
      approved: WorktreeManifest,
      attempt: number,
    ): Promise<WorktreeDiffSummary> {
      const manifest = await owned(jobId, false);
      if (!isDeepStrictEqual(manifest, approved))
        fail("approved worktree binding changed");
      const lease = path.join(metadataRoot, "active");
      await directory(lease);
      const owner = (await readJson(path.join(lease, "owner.json"))) as {
        jobId: string;
        attempt: number;
      };
      if (owner.jobId !== jobId || owner.attempt !== attempt)
        fail("execution lease ownership mismatch");
      await assertReadOnlyIndex(manifest.cwd);
      const changed = await git(
        manifest.cwd,
        [
          "diff",
          "--name-status",
          "-z",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          "--ignore-submodules=all",
          manifest.baseCommit,
          "--",
        ],
        true,
      );
      const untracked = await git(
        manifest.cwd,
        [
          "ls-files",
          "--others",
          "--exclude-standard",
          "--directory",
          "--no-empty-directory",
          "-z",
        ],
        true,
      );
      const files: WorktreeDiffSummary["files"] = [];
      let count = 0;
      let encodedSize = 0;
      const add = (status: string | undefined, file: string | undefined) => {
        // Never reinterpret Git output as a filesystem path or command.
        if (
          !status ||
          !/^[AMDTUXB?]$/.test(status) ||
          !file ||
          path.isAbsolute(file) ||
          file.split("/").some((part) => part === ".." || part === ".")
        )
          fail("invalid diff metadata");
        count++;
        const entry = {
          status,
          path: file.slice(0, 200),
          pathTruncated: file.length > 200,
        };
        const size = JSON.stringify(entry).length + 1;
        if (
          files.length < 40 &&
          count === files.length + 1 &&
          encodedSize + size <= 2600
        ) {
          files.push(entry);
          encodedSize += size;
        }
      };
      const parts = changed.split("\0");
      if (parts.pop() !== "" || parts.length % 2 !== 0)
        fail("invalid diff metadata");
      for (let index = 0; index < parts.length; index += 2)
        add(parts[index], parts[index + 1]);
      const others = untracked.split("\0");
      if (others.pop() !== "") fail("invalid diff metadata");
      for (const file of others) add("?", file);
      return {
        baseCommit: manifest.baseCommit,
        observedAt: new Date().toISOString(),
        comparison: "approved_base_to_worktree",
        accuracy: "candidate_statuses_not_content_verified",
        files,
        truncated: count > files.length,
        contents: "omitted",
        submodules: "omitted",
      };
    },

    /** Passive lease inspection: never creates roots, takes a lock or reads job IDs.
     * A held lease does not prove that its worker/verifier is still running.
     */
    async capacity() {
      await directory(config.repositoryRoot);
      await directory(config.worktreeRoot);
      if (!(await exists(metadataRoot)))
        return { occupied: false, admissionLocked: false };
      await directory(metadataRoot);
      return {
        occupied: await exists(path.join(metadataRoot, "active")),
        admissionLocked: await exists(
          path.join(metadataRoot, "admission-lock"),
        ),
      };
    },
    /** Exclusive per-workspace admission. Unknown execution keeps this lease.
     * Configuration must assign one stable worktree root per repository.
     */
    async admit(jobId: string, attempt: number, confirmedStopped = false) {
      locations(jobId);
      if (!Number.isSafeInteger(attempt) || attempt < 1)
        fail("invalid attempt");
      await changeLease(async (lease) => {
        if (await exists(lease)) {
          const owner = (await readJson(path.join(lease, "owner.json"))) as {
            jobId: string;
            attempt: number;
          };
          if (
            !confirmedStopped ||
            owner.jobId !== jobId ||
            owner.attempt >= attempt
          )
            throw new WorkspaceOccupiedError();
          // Only an explicit operator confirmation can release uncertain execution.
          await rm(lease, { recursive: true });
        }
        await mkdir(lease, { mode: 0o700 });
        await writeNew(path.join(lease, "owner.json"), { jobId, attempt });
      });
    },

    async release(jobId: string, attempt: number) {
      await changeLease(async (lease) => {
        const owner = (await readJson(path.join(lease, "owner.json"))) as {
          jobId: string;
          attempt: number;
        };
        if (owner.jobId !== jobId || owner.attempt !== attempt)
          fail("execution lease ownership mismatch");
        await rm(lease, { recursive: true });
      });
    },

    async prepare(jobId: string): Promise<{
      manifest: WorktreeManifest;
      disposition: "created" | "resumed";
    }> {
      const { cwd, record } = locations(jobId);
      await roots();
      if (await exists(record)) {
        // An incomplete creation is deliberately not repaired/replayed silently.
        return { manifest: await owned(jobId), disposition: "resumed" };
      }
      if (await exists(cwd))
        fail("refusing to overwrite an unowned worktree path");
      let baseCommit: string;
      try {
        baseCommit = await git(config.repositoryRoot, [
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        ]);
      } catch {
        return fail(
          "repository has no resolvable HEAD commit (unborn repositories are unsupported)",
        );
      }
      const manifest: WorktreeManifest = {
        version: 1,
        jobId,
        repositoryRoot: config.repositoryRoot,
        worktreeRoot: config.worktreeRoot,
        cwd,
        baseCommit,
      };
      // Exclusive directory reservation prevents duplicate creation by supervisors.
      await mkdir(record, { mode: 0o700 });
      await writeNew(path.join(record, "manifest.json"), manifest);
      await git(config.repositoryRoot, [
        "worktree",
        "add",
        "--detach",
        cwd,
        baseCommit,
      ]);
      await directory(cwd);
      await writeNew(path.join(record, "ready.json"), {
        gitDir: await git(cwd, ["rev-parse", "--absolute-git-dir"]),
      });
      return { manifest: await owned(jobId), disposition: "created" };
    },

    /** One check per attempt. Replays are historical, never current evidence. */
    async verify(
      jobId: string,
      signal?: AbortSignal,
      attempt?: number,
    ): Promise<VerificationResult> {
      const manifest = await owned(jobId);
      const { record } = locations(jobId);
      if (
        attempt !== undefined &&
        (!Number.isSafeInteger(attempt) || attempt < 1)
      )
        fail("invalid attempt");
      const suffix = attempt === undefined ? "" : `-${attempt}`;
      const resultPath = path.join(record, `verification${suffix}.json`);
      if (await exists(resultPath)) {
        const saved = (await readJson(resultPath)) as VerificationResult;
        if (
          !saved ||
          ![
            "passed",
            "failed",
            "timed_out",
            "aborted",
            "error",
            "not_configured",
            "needs_review",
          ].includes(saved.status) ||
          saved.baseCommit !== manifest.baseCommit ||
          saved.output !== "omitted" ||
          saved.passed !==
            (saved.status === "passed"
              ? true
              : saved.status === "failed"
                ? false
                : null)
        )
          fail("invalid verification receipt");
        // Return only explicitly selected fields, never arbitrary persisted output.
        return {
          status: saved.status,
          passed: saved.passed,
          exitCode: typeof saved.exitCode === "number" ? saved.exitCode : null,
          signal: null,
          baseCommit: manifest.baseCommit,
          headCommit:
            typeof saved.headCommit === "string" &&
            /^[a-f0-9]{40,64}$/.test(saved.headCommit)
              ? saved.headCommit
              : "",
          finishedAt:
            typeof saved.finishedAt === "string" &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
              saved.finishedAt,
            )
              ? saved.finishedAt
              : "",
          replayed: true,
          artifact: verificationArtifact(saved.artifact),
          artifactMatches: await checkArtifact(jobId, saved),
          output: "omitted",
        };
      }
      const artifact = await identifyArtifact(manifest.cwd);
      const headCommit = artifact.headCommit;
      const result = (
        status: VerificationResult["status"],
        exitCode: number | null = null,
        exitSignal: string | null = null,
      ): VerificationResult => ({
        status,
        passed: status === "passed" ? true : status === "failed" ? false : null,
        exitCode,
        signal: exitSignal,
        baseCommit: manifest.baseCommit,
        headCommit,
        finishedAt: new Date().toISOString(),
        replayed: false,
        artifact,
        artifactMatches: null,
        output: "omitted",
      });
      const verifier = config.verifier;
      if (!verifier) return result("not_configured");
      if (
        !path.isAbsolute(verifier.argv[0] ?? "") ||
        verifier.argv.some(
          (arg) => typeof arg !== "string" || arg.includes("\0"),
        ) ||
        !Number.isSafeInteger(verifier.timeoutMs) ||
        verifier.timeoutMs < 1 ||
        verifier.timeoutMs > 2_147_483_647
      )
        fail("invalid operator verifier configuration");
      if (signal?.aborted) return result("aborted");
      try {
        await writeNew(
          path.join(record, `verification-started${suffix}.json`),
          {
            startedAt: new Date().toISOString(),
            headCommit,
            artifact,
          },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          return result("needs_review");
        throw error;
      }
      const checked = await new Promise<VerificationResult>((resolve) => {
        // Cancellation may arrive while the durable intent is being written.
        // Do not start a process merely to kill it after it can cause effects.
        if (signal?.aborted) {
          resolve(result("aborted"));
          return;
        }
        let stopped: "aborted" | "timed_out" | undefined;
        const child = spawn(
          verifier.argv[0] as string,
          verifier.argv.slice(1),
          {
            cwd: manifest.cwd,
            env: verifier.env,
            shell: false,
            stdio: "ignore",
            detached: process.platform !== "win32",
          },
        );
        const stop = (reason: "aborted" | "timed_out") => {
          stopped ??= reason;
          try {
            if (process.platform !== "win32" && child.pid)
              process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            /* Already exited. */
          }
        };
        const abort = () => stop("aborted");
        const timer = setTimeout(() => stop("timed_out"), verifier.timeoutMs);
        const finish = (value: VerificationResult) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve(value);
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        child.once("error", () => finish(result(stopped ?? "error")));
        child.once("close", (code, exitSignal) =>
          finish(
            result(
              stopped ?? (code === 0 ? "passed" : "failed"),
              code,
              exitSignal,
            ),
          ),
        );
      });
      checked.artifactMatches = await checkArtifact(jobId, {
        ...checked,
        artifactMatches: true,
      });
      await directory(record);
      await writeNew(resultPath, checked);
      return checked;
    },
  };
}
