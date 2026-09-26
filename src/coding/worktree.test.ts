import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
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
    await expect(manager.admit("other-job", 1)).rejects.toThrow("occupied");
    await expect(manager.admit("approved-1", 2)).rejects.toThrow("occupied");
    await expect(manager.admit("other-job", 2, true)).rejects.toThrow(
      "occupied",
    );
    await manager.admit("approved-1", 2, true);
    await expect(manager.release("approved-1", 1)).rejects.toThrow("ownership");
    await manager.release("approved-1", 2);
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
    const first = await manager.verify("verify-1");
    expect(first.status).toBe("passed");
    expect(JSON.stringify(first)).not.toContain("private-output");
    await writeFile(path.join(manifest.cwd, "later-change"), "not checked");
    expect((await manager.verify("verify-1")).replayed).toBe(true);
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
