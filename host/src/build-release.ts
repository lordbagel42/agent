/**
 * Prepares a relocatable dependency archive on the Debian 13 x64 Actions runner.
 *
 * No deployment credentials or runtime config. Source is exported from the
 * exact commit, not the working tree. The installed controller independently
 * exports it and checks the source archive digest recorded here.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import tar from "tar-stream";
import { runMain } from "./lib/main.js";
import { run as runProcess } from "./lib/process.js";
import { dumps } from "./lib/pyjson.js";

/**
 * Kept explicit here: the trusted producer must not import candidate app or
 * controller code. The consumer checks the exact exported source digest.
 */
export const SOURCE = [
  "src",
  "tests",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  "biome.json",
  ".gitignore",
  ".npmrc",
  ".node-version",
];

type Entry = Parameters<ReturnType<typeof tar.pack>["entry"]>[0];

export class BuildError extends Schema.TaggedError<BuildError>()("BuildError", {
  reason: Schema.String,
}) {}

const fail = (reason: string) => new BuildError({ reason });

/** Python `sorted(Path.rglob("*"))`: component-wise, not whole-string, order. */
export function walk(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      found.push(path);
      if (lstatSync(path).isDirectory()) visit(path);
    }
  };
  visit(root);
  const parts = (path: string) => relative(root, path).split(sep);
  return found.sort((left, right) => {
    const a = parts(left);
    const b = parts(right);
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      const x = a[index] as string;
      const y = b[index] as string;
      if (x !== y) return x < y ? -1 : 1;
    }
    return a.length - b.length;
  });
}

const inside = (path: string, root: string) =>
  path === root || path.startsWith(`${root}${sep}`);

export const pack = (
  stage: string,
  output: string,
  revision: string,
  sourceDigest: string,
) =>
  Effect.tryPromise({
    try: async () => {
      const manifest = Buffer.from(
        dumps({
          version: 1,
          revision,
          sourceSha256: sourceDigest,
          platform: "debian13-x64",
          node: "24.21.0",
          pnpm: "10.33.0",
        }),
      );
      const archive = tar.pack();
      const done = pipeline(
        archive,
        createGzip({ level: 1 }),
        createWriteStream(output),
      );
      const add = (header: Entry, body?: Buffer | NodeJS.ReadableStream) =>
        new Promise<void>((settle, reject) => {
          const callback = (error?: Error | null) =>
            error ? reject(error) : settle();
          if (body === undefined) {
            archive.entry(header, callback);
            return;
          }
          if (Buffer.isBuffer(body)) {
            archive.entry(header, body, callback);
            return;
          }
          const entry = archive.entry(header, (error) =>
            error ? reject(error) : settle(),
          );
          body.pipe(entry);
        });
      await add(
        {
          name: "build.json",
          size: manifest.length,
          mode: 0o644,
          mtime: new Date(0),
        },
        manifest,
      );
      const dependencies = join(stage, "node_modules");
      const root = realpathSync(dependencies);
      for (const path of [dependencies, ...walk(dependencies)]) {
        const meta = lstatSync(path);
        const common = {
          name: relative(stage, path),
          uid: 0,
          gid: 0,
          uname: "",
          gname: "",
          mtime: new Date(Math.floor(meta.mtimeMs / 1000) * 1000),
        };
        if (meta.isSymbolicLink()) {
          const target = readlinkSync(path);
          if (
            isAbsolute(target) ||
            !inside(resolve(realpathSync(dirname(path)), target), root)
          )
            throw fail("escaping_dependency_link");
          await add({
            ...common,
            type: "symlink",
            linkname: target,
            // A link's own lstat mode always has execute bits.
            mode: 0o755,
          });
        } else if (meta.isDirectory())
          await add({ ...common, type: "directory", mode: 0o755 });
        else if (meta.isFile())
          // pnpm may hardlink package files; ship independent regular bytes.
          await add(
            {
              ...common,
              type: "file",
              size: meta.size,
              mode: meta.mode & 0o111 ? 0o755 : 0o644,
            },
            createReadStream(path),
          );
        else throw fail("unsafe_dependency");
      }
      archive.finalize();
      await done;
    },
    catch: (error) =>
      error instanceof BuildError ? error : fail("package_failed"),
  });

/** Extracts a `git archive` tar after validating every member, like `filter="data"`. */
export const extractSource = (archive: Buffer, stage: string) =>
  Effect.tryPromise({
    try: async () => {
      const members: Array<{ header: Entry; body: Buffer }> = [];
      const extract = tar.extract();
      const finished = new Promise<void>((settle, reject) => {
        extract.on("entry", (header, stream, next) => {
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: unknown) => {
            chunks.push(chunk as Buffer);
          });
          stream.on("end", () => {
            members.push({ header, body: Buffer.concat(chunks) });
            if (members.length > 10_000) reject(fail("too_many_files"));
            next();
          });
          stream.on("error", reject);
        });
        extract.on("finish", settle);
        extract.on("error", reject);
      });
      extract.end(archive);
      await finished;
      // tar-stream consumes git's global pax header (the commit id) itself.
      const entries = members;
      for (const { header } of entries) {
        const parts = header.name
          .split("/")
          .filter((part) => part && part !== ".");
        if (
          parts.length === 0 ||
          header.name.startsWith("/") ||
          parts.includes("..") ||
          header.name.includes("\\") ||
          !SOURCE.includes(parts[0] as string) ||
          (header.type !== "file" && header.type !== "directory") ||
          parts.some(
            (part: string) =>
              part.startsWith(".env") ||
              [".git", "node_modules", ".data", ".codex"].includes(part),
          )
        )
          throw fail("unsafe_source");
      }
      for (const { header, body } of entries) {
        const target = join(stage, header.name);
        if (header.type === "directory")
          mkdirSync(target, { recursive: true, mode: 0o755 });
        else {
          mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
          writeFileSync(target, body, { mode: (header.mode ?? 0o644) & 0o755 });
        }
      }
    },
    catch: (error) =>
      error instanceof BuildError ? error : fail("unsafe_source"),
  });

const git = (args: readonly string[], limit = 64 * 1024 * 1024) =>
  runProcess(["git", ...args], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/",
    },
    cwd: process.cwd(),
    timeoutMs: 600_000,
    limit,
  });

export const prepare = Effect.fn("june.host.build_release.prepare")(function* (
  revision: string,
  output: string,
  checkOnly: boolean,
) {
  const release = readFileSync("/etc/os-release", "utf8");
  const field = (key: string) =>
    new RegExp(`^${key}="?([^"\\n]*)"?$`, "m").exec(release)?.[1];
  if (
    process.arch !== "x64" ||
    field("ID") !== "debian" ||
    field("VERSION_ID") !== "13"
  )
    return yield* fail("unsupported_build_platform");
  const commit = (yield* git(["rev-parse", "HEAD"])).toString().trim();
  if (revision !== commit) return yield* fail("checkout_revision_mismatch");
  const names = (yield* git([
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    commit,
    "--",
    ...SOURCE,
  ]))
    .toString()
    .split("\0");
  const tops = [
    ...new Set(
      names.filter(Boolean).map((name) => name.split("/")[0] as string),
    ),
  ].sort();
  const archive = yield* git([
    "archive",
    "--format=tar",
    commit,
    "--",
    ...tops,
  ]).pipe(Effect.mapError(() => fail("source_too_large")));
  const preflight = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../scripts/deploy/preflight.sh",
  );
  const stage = mkdtempSync(join(tmpdir(), "june-build-"));
  yield* Effect.gen(function* () {
    yield* extractSource(archive, stage);
    yield* Effect.callback<void, BuildError>((resume) => {
      const child = spawn("sh", [preflight], {
        cwd: stage,
        stdio: "inherit",
      });
      child.once("error", () => resume(Effect.fail(fail("preflight_failed"))));
      child.once("exit", (code: number | null) =>
        resume(
          code === 0 ? Effect.void : Effect.fail(fail("preflight_failed")),
        ),
      );
    });
    if (!checkOnly)
      yield* pack(
        stage,
        output,
        commit,
        createHash("sha256").update(archive).digest("hex"),
      );
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => rmSync(stage, { recursive: true, force: true })),
    ),
  );
});

export const command = Command.make(
  "build_release",
  {
    revision: Argument.String("revision"),
    output: Argument.String("output"),
    checkOnly: Flag.Boolean("check-only").pipe(
      Flag.withDescription(
        "Run all preflight checks without packaging dependencies",
      ),
      Flag.withDefault(false),
    ),
  },
  ({ revision, output, checkOnly }) => prepare(revision, output, checkOnly),
);

export const run = () =>
  runMain(
    Command.run(command, { version: "1" }).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
