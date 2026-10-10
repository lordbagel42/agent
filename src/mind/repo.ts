import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const README = `# June's mind

This repository is June's long-term memory, written by June herself during
background reflection. Every change is a commit; \`git log -p\` shows how her
understanding of people, places and herself changed over time.

- \`people/\` one file per person she has talked with
- \`conversations/\` a briefing per Slack conversation
- \`skills/\` procedures June wrote for classes of tasks (SKILL.md + references/)
- \`self/\` June's values, identity and journal
- \`improvements/\` problems June noticed with her own code or capabilities

Sections titled \`## Private — <place>\` are only shown to June in that place.
\`self/journal/\` is only shown in Raygen's DM. Raw transcripts and scheduler
state live in the gitignored \`transcripts/\` and \`state/\` directories.

Raygen may edit or revert anything here; commit your edits so June's next
reflection does not overwrite uncommitted changes.
`;

export interface Change {
  path: string;
  /** Null deletes the file. */
  content: string | null;
}

export interface Commit {
  sha: string;
  date: string;
  subject: string;
}

/** Repository-relative markdown path, never escaping the root. */
export function safePath(path: string) {
  const clean = normalize(path).replace(/^\/+/, "");
  if (
    !clean ||
    clean.startsWith("..") ||
    clean.split(sep).some((part) => part.startsWith(".")) ||
    !/^[A-Za-z0-9/_.-]+$/.test(clean)
  )
    return undefined;
  return clean;
}

/** Git-versioned markdown store. Callers serialize writers with MindLock. */
export class MindRepo {
  constructor(readonly root: string) {}

  private async git(args: string[]) {
    const { stdout } = await exec(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=June",
        "-c",
        "user.email=june@raygen.dev",
        ...args,
      ],
      {
        cwd: this.root,
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
    return stdout;
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    for (const directory of ["transcripts", "state"])
      await mkdir(join(this.root, directory), { recursive: true, mode: 0o700 });
    if (existsSync(join(this.root, ".git"))) return;
    await this.git(["init", "-q", "-b", "main"]);
    await this.writeFile(".gitignore", "transcripts/\nstate/\n");
    await this.writeFile("README.md", README);
    await this.git(["add", "--", ".gitignore", "README.md"]);
    await this.git(["commit", "-q", "-m", "init: june's mind"]);
  }

  async read(path: string): Promise<string | undefined> {
    const clean = safePath(path);
    if (!clean) return undefined;
    return readFile(join(this.root, clean), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "EISDIR")
          return undefined;
        throw error;
      },
    );
  }

  /** Tracked-area markdown files under an optional prefix, sorted. */
  async list(prefix = ""): Promise<string[]> {
    const results: string[] = [];
    const walk = async (relative: string) => {
      const entries = await readdir(join(this.root, relative), {
        withFileTypes: true,
      }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (!relative && ["transcripts", "state"].includes(entry.name))
          continue;
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.endsWith(".md"))
          results.push(path);
      }
    };
    await walk("");
    return results.filter((path) => path.startsWith(prefix)).sort();
  }

  private async writeFile(path: string, content: string) {
    const target = join(this.root, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, target);
  }

  /** Apply all changes as one commit. On failure, touched paths are restored
   * to HEAD so a half-applied reflection never lingers in the working tree. */
  async commit(
    changes: Change[],
    subject: string,
    body = "",
  ): Promise<string | undefined> {
    const paths = changes.map(({ path }) => {
      const clean = safePath(path);
      if (!clean) throw new Error("mind_unsafe_path");
      return clean;
    });
    const tracked = new Set(
      (await this.git(["ls-files", "--", ...paths]))
        .split("\n")
        .filter(Boolean),
    );
    try {
      for (const [index, change] of changes.entries()) {
        const path = paths[index] as string;
        if (change.content === null)
          await rm(join(this.root, path), { force: true });
        else await this.writeFile(path, change.content);
      }
      await this.git(["add", "-A", "--", ...paths]);
      const staged = await this.git(["diff", "--cached", "--name-only"]);
      if (!staged.trim()) return undefined;
      await this.git([
        "commit",
        "-q",
        "-m",
        subject,
        ...(body.trim() ? ["-m", body.trim()] : []),
      ]);
      return (await this.git(["rev-parse", "HEAD"])).trim();
    } catch (error) {
      await this.git(["reset", "-q", "--", ...paths]).catch(() => undefined);
      for (const path of paths) {
        if (tracked.has(path))
          await this.git(["checkout", "-q", "HEAD", "--", path]).catch(
            () => undefined,
          );
        else await rm(join(this.root, path), { force: true });
      }
      throw error;
    }
  }

  async log(limit: number, path?: string): Promise<Commit[]> {
    const clean = path ? safePath(path) : undefined;
    const output = await this.git([
      "log",
      `-n${Math.max(1, Math.min(limit, 50))}`,
      "--date=iso-strict",
      "--format=%h%x09%ad%x09%s",
      ...(clean ? ["--", clean] : []),
    ]).catch(() => "");
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", date = "", subject = ""] = line.split("\t");
        return { sha, date, subject };
      });
  }

  async commitCount() {
    return Number(
      (await this.git(["rev-list", "--count", "HEAD"]).catch(() => "0")).trim(),
    );
  }

  async mtime(path: string) {
    return (await stat(join(this.root, path)).catch(() => undefined))?.mtimeMs;
  }
}
