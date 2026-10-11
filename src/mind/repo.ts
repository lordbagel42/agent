import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { promisify } from "node:util";
import { Effect, Schema } from "effect";

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
    clean !== path ||
    clean.startsWith("..") ||
    clean.split(sep).some((part) => part.startsWith(".")) ||
    !/^[A-Za-z0-9/_.-]+$/.test(clean)
  )
    return undefined;
  return clean;
}

/** Model-readable and versioned content, never raw transcripts or host state. */
export function notePath(path: string) {
  return (
    safePath(path) !== undefined &&
    (path === "README.md" ||
      /^(people|conversations|skills|self|improvements)\/.+\.md$/.test(path))
  );
}

export interface MindRemote {
  /** e.g. git@github.com:lordbagel42/june-mind.git (private). */
  url: string;
  /** Deploy key with write access to that repository only. */
  sshKey?: string;
  /** Pinned host keys for the remote; required with sshKey. */
  knownHosts?: string;
}

export type SyncState =
  | "local-only"
  | "synced"
  | "merged"
  | "conflict"
  | "unpushed"
  | "error";

/** A failed repository operation; the reason is fixed host text. */
export class MindRepoError extends Schema.TaggedError<MindRepoError>()(
  "MindRepoError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return this.reason;
  }
}

const io = <A>(reason: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new MindRepoError({ reason, cause }),
  });
const code = (error: MindRepoError) =>
  (error.cause as NodeJS.ErrnoException | undefined)?.code;
const parseLog = (output: string): Commit[] =>
  output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", date = "", subject = ""] = line.split("\t");
      return { sha, date, subject };
    });
const orEmpty = <R>(effect: Effect.Effect<string, MindRepoError, R>) =>
  effect.pipe(Effect.catch(() => Effect.succeed("")));

/** Git-versioned markdown store. Callers serialize writers with MindLock. */
export class MindRepo {
  constructor(
    readonly root: string,
    readonly remote?: MindRemote,
  ) {}

  private readonly git = Effect.fn("june.mind.git")(function* (
    this: MindRepo,
    args: string[],
  ) {
    const remote = this.remote;
    const { stdout } = yield* io("mind_git_failed", () =>
      exec(
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
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            ...(remote?.sshKey
              ? {
                  GIT_SSH_COMMAND: [
                    "ssh",
                    "-i",
                    `'${remote.sshKey.replaceAll("'", "'\\''")}'`,
                    "-o",
                    "IdentitiesOnly=yes",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    ...(remote.knownHosts
                      ? [
                          "-o",
                          `'UserKnownHostsFile=${remote.knownHosts.replaceAll("'", "'\\''")}'`,
                        ]
                      : []),
                  ].join(" "),
                }
              : {}),
          },
        },
      ),
    );
    return stdout;
  });

  readonly init = Effect.fn("june.mind.repo.init")(function* (this: MindRepo) {
    yield* io("mind_init_failed", () =>
      mkdir(this.root, { recursive: true, mode: 0o700 }),
    );
    if (
      (yield* io("mind_init_failed", () => realpath(this.root))) !== this.root
    )
      return yield* new MindRepoError({
        reason: "mind_canonical_directory_required",
      });
    yield* io("mind_init_failed", () => chmod(this.root, 0o700));
    for (const directory of ["transcripts", "state"])
      yield* io("mind_init_failed", () =>
        mkdir(join(this.root, directory), { recursive: true, mode: 0o700 }),
      );
    if (existsSync(join(this.root, ".git"))) {
      if (this.remote) {
        const remotes = (yield* this.git(["remote"])).split("\n");
        yield* this.git(
          remotes.includes("origin")
            ? ["remote", "set-url", "origin", this.remote.url]
            : ["remote", "add", "origin", this.remote.url],
        );
      }
      return;
    }
    yield* this.git(["init", "-q", "-b", "main"]);
    if (this.remote) {
      // A new host restores the mind from GitHub instead of starting over.
      yield* this.git(["remote", "add", "origin", this.remote.url]);
      yield* this.git(["fetch", "-q", "origin"]);
      if (yield* this.revision("origin/main")) {
        yield* this.git(["checkout", "-q", "-B", "main", "origin/main"]);
        return;
      }
    }
    yield* this.writeFile(".gitignore", "transcripts/\nstate/\n");
    yield* this.writeFile("README.md", README);
    yield* this.git(["add", "--", ".gitignore", "README.md"]);
    yield* this.git(["commit", "-q", "-m", "init: june's mind"]);
  });

  /** Reject symlinks at every component, including nonexistent write parents. */
  private readonly regularPath = Effect.fnUntraced(function* (
    this: MindRepo,
    path: string,
  ) {
    let target = this.root;
    for (const part of path.split("/")) {
      target = join(target, part);
      const current = target;
      const metadata = yield* io("mind_read_failed", () => lstat(current)).pipe(
        Effect.catchIf(
          (error) => code(error) === "ENOENT",
          () => Effect.succeed(undefined),
        ),
      );
      if (metadata?.isSymbolicLink()) return false;
    }
    return true;
  });

  readonly read = Effect.fnUntraced(function* (this: MindRepo, path: string) {
    if (!notePath(path) || !(yield* this.regularPath(path))) return undefined;
    return yield* io("mind_read_failed", () =>
      readFile(join(this.root, path), "utf8"),
    ).pipe(
      Effect.catchIf(
        (error) => code(error) === "ENOENT" || code(error) === "EISDIR",
        () => Effect.succeed(undefined),
      ),
    );
  });

  /** Tracked-area markdown files under an optional prefix, sorted. */
  readonly list = Effect.fnUntraced(function* (this: MindRepo, prefix = "") {
    const results: string[] = [];
    const walk = (relative: string): Effect.Effect<void> =>
      Effect.gen({ self: this }, function* () {
        const entries = yield* Effect.promise(() =>
          readdir(join(this.root, relative), { withFileTypes: true }).catch(
            () => [],
          ),
        );
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          const path = relative ? `${relative}/${entry.name}` : entry.name;
          if (!relative && ["transcripts", "state"].includes(entry.name))
            continue;
          if (entry.isDirectory()) yield* walk(path);
          else if (entry.isFile() && entry.name.endsWith(".md"))
            results.push(path);
        }
      });
    yield* walk("");
    return results.filter((path) => path.startsWith(prefix)).sort();
  });

  private readonly writeFile = Effect.fnUntraced(function* (
    this: MindRepo,
    path: string,
    content: string,
  ) {
    const target = join(this.root, path);
    const temporary = `${target}.${process.pid}.tmp`;
    yield* io("mind_write_failed", async () => {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, target);
    });
  });

  /** Apply all changes as one commit. On failure, touched paths are restored
   * to HEAD so a half-applied reflection never lingers in the working tree. */
  readonly commit = Effect.fn("june.mind.repo.commit")(function* (
    this: MindRepo,
    changes: Change[],
    subject: string,
    body = "",
  ) {
    if (!changes.length) return undefined;
    // Never absorb somebody's index or overwrite uncommitted edits. This repo
    // is written only under MindLock; operators must stop June for local edits.
    if (
      (yield* this.git([
        "status",
        "--porcelain",
        "--untracked-files=all",
      ])).trim()
    )
      return yield* new MindRepoError({ reason: "mind_dirty_worktree" });
    const paths: string[] = [];
    for (const { path } of changes) {
      if (!notePath(path))
        return yield* new MindRepoError({ reason: "mind_unsafe_path" });
      paths.push(path);
    }
    for (const path of paths)
      if (!(yield* this.regularPath(path)))
        return yield* new MindRepoError({ reason: "mind_symlink_path" });
    const tracked = new Set(
      (yield* this.git(["ls-files", "--", ...paths]))
        .split("\n")
        .filter(Boolean),
    );
    const apply = Effect.gen({ self: this }, function* () {
      for (const [index, change] of changes.entries()) {
        const path = paths[index] as string;
        if (change.content === null)
          yield* io("mind_write_failed", () =>
            rm(join(this.root, path), { force: true }),
          );
        else yield* this.writeFile(path, change.content);
      }
      yield* this.git(["add", "-A", "--", ...paths]);
      const staged = yield* this.git(["diff", "--cached", "--name-only"]);
      if (!staged.trim()) return undefined;
      yield* this.git([
        "commit",
        "-q",
        "-m",
        subject,
        ...(body.trim() ? ["-m", body.trim()] : []),
      ]);
      return (yield* this.git(["rev-parse", "HEAD"])).trim();
    });
    const restore = Effect.gen({ self: this }, function* () {
      yield* this.git(["reset", "-q", "--", ...paths]).pipe(Effect.ignore);
      for (const path of paths) {
        if (tracked.has(path))
          yield* this.git(["checkout", "-q", "HEAD", "--", path]).pipe(
            Effect.ignore,
          );
        else
          yield* io("mind_write_failed", () =>
            rm(join(this.root, path), { force: true }),
          );
      }
    });
    // Restore on any failure, including defects, then fail as before.
    return yield* apply.pipe(Effect.onError(() => restore.pipe(Effect.orDie)));
  });

  readonly log = Effect.fn("june.mind.repo.log")(function* (
    this: MindRepo,
    limit: number,
    path?: string,
  ) {
    const clean = path ? safePath(path) : undefined;
    return parseLog(
      yield* orEmpty(
        this.git([
          "log",
          `-n${Math.max(1, Math.min(limit, 50))}`,
          "--date=iso-strict",
          "--format=%h%x09%ad%x09%s",
          ...(clean ? ["--", clean] : []),
        ]),
      ),
    );
  });

  readonly revision = Effect.fnUntraced(function* (
    this: MindRepo,
    ref = "HEAD",
  ) {
    return (
      (yield* orEmpty(
        this.git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]),
      )).trim() || undefined
    );
  });

  /** Commits after `since` (exclusive), newest first. */
  readonly logSince = Effect.fn("june.mind.repo.log")(function* (
    this: MindRepo,
    since: string,
  ) {
    return parseLog(
      yield* orEmpty(
        this.git([
          "log",
          "-n200",
          "--date=iso-strict",
          "--format=%h%x09%ad%x09%s",
          `${since}..HEAD`,
        ]),
      ),
    );
  });

  readonly diff = (since: string, paths: string[], until = "HEAD") =>
    orEmpty(this.git(["diff", `${since}..${until}`, "--", ...paths]));

  /** git log -p for one month (YYYY-MM) under a path. */
  readonly monthLog = (month: string, path: string) => {
    const [year, number] = month.split("-").map(Number) as [number, number];
    const next =
      number === 12
        ? `${year + 1}-01`
        : `${year}-${String(number + 1).padStart(2, "0")}`;
    return orEmpty(
      this.git([
        "log",
        "-p",
        "--date=short",
        "--format=commit %h %ad %s",
        `--since=${month}-01T00:00:00Z`,
        `--until=${next}-01T00:00:00Z`,
        "--",
        path,
      ]),
    );
  };

  /** Preserve commit IDs (dream checkpoints refer to them). Conflicting edits
   * block sync, rather than guessing which memory to discard. Never force push. */
  readonly sync = Effect.fn("june.mind.repo.sync")(function* (
    this: MindRepo,
    current: () => boolean = () => true,
  ) {
    if (!this.remote) return "local-only" as SyncState;
    return yield* Effect.gen({ self: this }, function* () {
      if (!current()) return "error" as SyncState;
      if (
        (yield* this.git([
          "status",
          "--porcelain",
          "--untracked-files=all",
        ])).trim()
      )
        return "error";
      yield* this.git(["fetch", "-q", "origin"]);
      const remote = yield* this.revision("origin/main");
      let state: SyncState = "synced";
      const local = yield* this.revision();
      if (!current()) return "error";
      if (remote && local && remote !== local) {
        const base = (yield* this.git(["merge-base", local, remote])).trim();
        if (!current()) return "error";
        if (base === local) {
          yield* this.git(["merge", "-q", "--ff-only", "origin/main"]);
        } else if (base !== remote) {
          const merged = yield* this.git([
            "merge",
            "-q",
            "--no-edit",
            "origin/main",
          ]).pipe(
            Effect.as(true),
            Effect.catch(() =>
              this.git(["merge", "--abort"]).pipe(Effect.as(false)),
            ),
          );
          if (!merged) return "conflict";
          state = "merged";
        }
      }
      const unpushed =
        (yield* this.revision()) !== (yield* this.revision("origin/main"));
      if (!current()) return "error";
      if (unpushed) yield* this.git(["push", "-q", "origin", "HEAD:main"]);
      return state;
    }).pipe(Effect.catchCause(() => Effect.succeed<SyncState>("error")));
  });

  readonly commitCount = Effect.fnUntraced(function* (this: MindRepo) {
    return Number(
      (yield* this.git(["rev-list", "--count", "HEAD"]).pipe(
        Effect.catch(() => Effect.succeed("0")),
      )).trim(),
    );
  });

  readonly mtime = (path: string) =>
    Effect.promise(() =>
      stat(join(this.root, path)).then(
        (metadata) => metadata.mtimeMs,
        () => undefined,
      ),
    );
}
