import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

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

/**
 * Command-outcome evidence only, never release authorization. HEAD is captured
 * before execution; no immutable content/artifact or verifier digest is bound.
 */
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

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        // In particular, never inherit GIT_DIR, GIT_WORK_TREE, or GIT_INDEX_FILE.
        env: {
          PATH: process.env.PATH,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return stdout.trim();
  } catch {
    return fail("Git operation failed; inspect locally before retrying");
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

  async function roots() {
    await directory(config.repositoryRoot);
    await directory(config.worktreeRoot);
    if (
      within(config.repositoryRoot, config.worktreeRoot) ||
      within(config.worktreeRoot, config.repositoryRoot)
    )
      fail("repository and worktree roots must be separate");
    if (
      (await git(config.repositoryRoot, ["rev-parse", "--show-toplevel"])) !==
      config.repositoryRoot
    )
      fail("repository root must be the Git checkout root");
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

  async function owned(jobId: string): Promise<WorktreeManifest> {
    await roots();
    const { cwd, record } = locations(jobId);
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
    const gitDir = await git(cwd, ["rev-parse", "--absolute-git-dir"]);
    const common = await git(config.repositoryRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (
      ready?.gitDir !== gitDir ||
      !within(path.join(common, "worktrees"), gitDir) ||
      (await git(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])) !== common ||
      (await git(cwd, ["rev-parse", "--show-toplevel"])) !== cwd
    )
      fail("worktree registration mismatch");
    const entries = (
      await git(config.repositoryRoot, ["worktree", "list", "--porcelain"])
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

  return {
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
          output: "omitted",
        };
      }
      const headCommit = await git(manifest.cwd, [
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ]);
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
      await directory(record);
      await writeNew(resultPath, checked);
      return checked;
    },
  };
}
