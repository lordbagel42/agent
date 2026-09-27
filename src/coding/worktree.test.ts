import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createWorktreeManager } from "./worktree.js";

test("worktree ownership rejects escapes and preserves the shared dirty checkout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "june-worktree-"));
  try {
    const repositoryRoot = path.join(root, "repo");
    const worktreeRoot = path.join(root, "worktrees");
    await mkdir(repositoryRoot);
    await mkdir(worktreeRoot);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repositoryRoot, stdio: "pipe" })
        .toString()
        .trim();
    git("init");
    const manager = createWorktreeManager({ repositoryRoot, worktreeRoot });
    expect(await manager.isSettled()).toBe(true);
    await expect(
      readFile(path.join(worktreeRoot, ".june-jobs")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(manager.prepare("unborn")).rejects.toThrow("unborn");
    await writeFile(path.join(repositoryRoot, "tracked"), "base");
    git("add", "tracked");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    const base = git("rev-parse", "HEAD");
    await writeFile(path.join(repositoryRoot, "tracked"), "dirty");
    await writeFile(path.join(repositoryRoot, "untracked"), "private");
    const before = git("status", "--porcelain");
    await expect(manager.prepare("../escape")).rejects.toThrow(
      "invalid job ID",
    );
    const occupied = path.join(
      worktreeRoot,
      `job-${createHash("sha256").update("occupied").digest("hex")}`,
    );
    await symlink(repositoryRoot, occupied);
    await expect(manager.prepare("occupied")).rejects.toThrow("unowned");
    const link = path.join(root, "link");
    await symlink(worktreeRoot, link);
    await expect(
      createWorktreeManager({ repositoryRoot, worktreeRoot: link }).prepare(
        "escape",
      ),
    ).rejects.toThrow("symlinks");
    const created = await manager.prepare("approved-1");
    await manager.admit("approved-1", 1);
    // A fresh supervisor must see the durable blocker without a local process.
    const restarted = createWorktreeManager({ repositoryRoot, worktreeRoot });
    expect(await restarted.isSettled()).toBe(false);
    await expect(manager.admit("other-job", 1)).rejects.toThrow("occupied");
    await expect(manager.admit("approved-1", 2)).rejects.toThrow("occupied");
    await expect(manager.admit("other-job", 2, true)).rejects.toThrow(
      "occupied",
    );
    await manager.admit("approved-1", 2, true);
    await expect(manager.release("approved-1", 1)).rejects.toThrow("ownership");
    await manager.release("approved-1", 2);
    expect(await restarted.isSettled()).toBe(true);
    const lock = path.join(worktreeRoot, ".june-jobs", "admission-lock");
    await mkdir(lock);
    expect(await restarted.isSettled()).toBe(false);
    await rm(lock, { recursive: true });
    // Even an incomplete/invalid owner record blocks drain; never repair it.
    const active = path.join(worktreeRoot, ".june-jobs", "active");
    await mkdir(active);
    expect(await restarted.isSettled()).toBe(false);
    await rm(active, { recursive: true });
    expect(created.manifest.baseCommit).toBe(base);
    expect(
      await readFile(path.join(created.manifest.cwd, "tracked"), "utf8"),
    ).toBe("base");
    expect((await manager.prepare("approved-1")).disposition).toBe("resumed");
    expect(git("status", "--porcelain")).toBe(before);
    expect(await readFile(path.join(repositoryRoot, "tracked"), "utf8")).toBe(
      "dirty",
    );
    await rm(path.join(created.manifest.cwd, ".git"));
    await symlink(
      path.join(repositoryRoot, ".git"),
      path.join(created.manifest.cwd, ".git"),
    );
    await expect(manager.prepare("approved-1")).rejects.toThrow("Git marker");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diff inspection is bound, bounded, read-only and never follows workspace symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "june-diff-"));
  try {
    const repositoryRoot = path.join(root, "repo");
    const worktreeRoot = path.join(root, "worktrees");
    await mkdir(repositoryRoot);
    await mkdir(worktreeRoot);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
    git(repositoryRoot, "init");
    await writeFile(path.join(repositoryRoot, "tracked"), "original");
    git(repositoryRoot, "add", "tracked");
    git(
      repositoryRoot,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    const manager = createWorktreeManager({ repositoryRoot, worktreeRoot });
    const { manifest } = await manager.prepare("approved");
    await manager.admit("approved", 1);
    const inspect = () => manager.diffSummary("approved", manifest, 1);
    expect((await inspect()).files).toEqual([]);
    const index = git(manifest.cwd, "rev-parse", "--git-path", "index");
    const untouchedIndex = await readFile(index);
    const untouchedTime = (await stat(index)).mtimeMs;
    await utimes(path.join(manifest.cwd, "tracked"), new Date(0), new Date(0));
    expect(await inspect()).toMatchObject({
      accuracy: "candidate_statuses_not_content_verified",
    });
    expect(await readFile(index)).toEqual(untouchedIndex);
    expect((await stat(index)).mtimeMs).toBe(untouchedTime);
    await writeFile(
      path.join(manifest.cwd, "tracked"),
      "PRIVATE WORKER CONTENT",
    );
    git(manifest.cwd, "add", "tracked");
    // Committed changes still differ from the approved base, even with clean HEAD.
    git(
      manifest.cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "worker",
    );
    await writeFile(path.join(repositoryRoot, "outside-secret"), "HOST SECRET");
    await symlink(repositoryRoot, path.join(manifest.cwd, "outside-link"));
    await writeFile(path.join(manifest.cwd, "odd\nfilename "), "PRIVATE");
    const beforeIndex = await readFile(index);
    const metadata = path.join(
      worktreeRoot,
      ".june-jobs",
      path.basename(manifest.cwd),
    );
    const beforeManifest = await readFile(path.join(metadata, "manifest.json"));
    const summary = await inspect();
    expect(summary.files).toEqual([
      { status: "M", path: "tracked", pathTruncated: false },
      { status: "?", path: "odd\nfilename ", pathTruncated: false },
      { status: "?", path: "outside-link", pathTruncated: false },
    ]);
    expect(summary.truncated).toBe(false);
    expect(summary.baseCommit).toBe(manifest.baseCommit);
    expect(JSON.stringify(summary)).not.toMatch(
      /PRIVATE|HOST SECRET|outside-secret/,
    );
    expect(await readFile(index)).toEqual(beforeIndex);
    expect(await readFile(path.join(metadata, "manifest.json"))).toEqual(
      beforeManifest,
    );
    for (let i = 0; i < 42; i++)
      await writeFile(
        path.join(manifest.cwd, `untracked-${i}`),
        "ignored content",
      );
    expect(await inspect()).toMatchObject({
      files: expect.any(Array),
      truncated: true,
    });
    expect((await inspect()).files).toHaveLength(40);
    await expect(
      manager.diffSummary("../approved", manifest, 1),
    ).rejects.toThrow("invalid job ID");
    await expect(
      manager.diffSummary("approved", { ...manifest, cwd: repositoryRoot }, 1),
    ).rejects.toThrow("binding changed");
    await expect(manager.diffSummary("approved", manifest, 2)).rejects.toThrow(
      "lease ownership",
    );
    git(manifest.cwd, "config", "filter.fixture.clean", "touch FILTER-RAN");
    await expect(inspect()).rejects.toThrow("executable Git filters");
    await expect(
      readFile(path.join(manifest.cwd, "FILTER-RAN")),
    ).rejects.toThrow();
    git(manifest.cwd, "config", "--unset", "filter.fixture.clean");
    git(manifest.cwd, "update-index", "--split-index");
    const shared = path.resolve(
      manifest.cwd,
      git(manifest.cwd, "rev-parse", "--shared-index-path"),
    );
    await utimes(shared, new Date(0), new Date(0));
    await expect(inspect()).rejects.toThrow("unsupported index extension");
    expect((await stat(shared)).mtimeMs).toBe(0);
    git(manifest.cwd, "update-index", "--no-split-index");
    // Reject symlinks at the checkout, metadata directory, and Git marker.
    for (const target of [
      manifest.cwd,
      metadata,
      path.join(manifest.cwd, ".git"),
    ]) {
      await rename(target, `${target}-saved`);
      await symlink(`${target}-saved`, target);
      await expect(inspect()).rejects.toThrow();
      await rm(target);
      await rename(`${target}-saved`, target);
    }
    await manager.release("approved", 1);
    await rm(path.join(worktreeRoot, ".june-jobs"), { recursive: true });
    await expect(inspect()).rejects.toThrow();
    await expect(
      readFile(path.join(metadata, "manifest.json")),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification never repeats a command on replay and omits private output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "june-verifier-"));
  try {
    const repositoryRoot = path.join(root, "repo");
    const worktreeRoot = path.join(root, "worktrees");
    await mkdir(repositoryRoot);
    await mkdir(worktreeRoot);
    execFileSync("git", ["init"], { cwd: repositoryRoot, stdio: "pipe" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { cwd: repositoryRoot, stdio: "pipe" },
    );
    const manager = createWorktreeManager({
      repositoryRoot,
      worktreeRoot,
      verifier: {
        argv: [
          process.execPath,
          "-e",
          "require('node:fs').appendFileSync('runs', '1'); console.log('private-output');",
        ],
        timeoutMs: 5000,
      },
    });
    const { manifest } = await manager.prepare("verify-1");
    // The fixture's invocation counter is not part of the source artifact.
    await writeFile(path.join(manifest.cwd, ".gitignore"), "runs\n");
    const first = await manager.verify("verify-1");
    expect(first.status).toBe("passed");
    expect(first.artifact?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.artifactMatches).toBe(true);
    expect(await manager.checkArtifact("verify-1", first)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("private-output");
    await writeFile(path.join(manifest.cwd, "later-change"), "not checked");
    expect(await manager.checkArtifact("verify-1", first)).toBe(false);
    expect(await manager.verify("verify-1")).toMatchObject({
      replayed: true,
      artifact: first.artifact,
      artifactMatches: false,
    });
    expect(await readFile(path.join(manifest.cwd, "runs"), "utf8")).toBe("1");
    const metadata = path.join(
      worktreeRoot,
      ".june-jobs",
      path.basename(manifest.cwd),
    );
    await rm(path.join(metadata, "verification.json"));
    expect((await manager.verify("verify-1")).status).toBe("needs_review");
    expect(await readFile(path.join(manifest.cwd, "runs"), "utf8")).toBe("1");
    const nextAttempt = await manager.verify("verify-1", undefined, 2);
    expect(nextAttempt).toMatchObject({ status: "passed", replayed: false });
    expect(await readFile(path.join(manifest.cwd, "runs"), "utf8")).toBe("11");
    const controller = new AbortController();
    // Abort during the awaited intent write, after the first preflight check.
    vi.spyOn(controller.signal, "aborted", "get").mockImplementationOnce(() => {
      queueMicrotask(() => controller.abort());
      return false;
    });
    expect(
      await manager.verify("verify-1", controller.signal, 3),
    ).toMatchObject({
      status: "aborted",
      exitCode: null,
      signal: null,
    });
    expect(await readFile(path.join(manifest.cwd, "runs"), "utf8")).toBe("11");
    expect(await manager.verify("verify-1", undefined, 3)).toMatchObject({
      status: "aborted",
      replayed: true,
    });
    expect(await readFile(path.join(manifest.cwd, "runs"), "utf8")).toBe("11");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
