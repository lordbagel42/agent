/**
 * Installs reviewed host bundles outside June's releases. Run as root from a
 * build of the exact reviewed revision, under the operator's installation lock
 * (`flock /run/lock/june-host-install.lock …`). It never starts, stops or
 * enables a unit; switching a unit to an installed bundle is a separate step.
 *
 *   install.mjs node <official node binary>
 *   install.mjs group <name> <build dir> <revision> <file>...
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { syncDirectory } from "./lib/files.js";
import { deny, runMain } from "./lib/main.js";
import { dumps, loads } from "./lib/pyjson.js";

export const ROOT = "/usr/local/lib/june-host";
export const NODE = `${ROOT}/node/bin/node`;
/** Official node-v24.21.0-linux-x64 `bin/node` (tarball SHA-256 fd8e59d5…). */
export const NODE_SHA256 =
  "7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c";

const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** Root-owned, not writable by group/other, for the path and every ancestor. */
function trusted(path: string): void {
  for (let current = path; ; current = dirname(current)) {
    const info = lstatSync(current);
    if (info.uid !== 0 || info.mode & 0o022 || info.isSymbolicLink())
      throw new Error("unsafe_install_path");
    if (current === "/") return;
  }
}

function directory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o755 });
  trusted(path);
}

function atomic(path: string, data: Uint8Array, mode: number): void {
  const temporary = join(dirname(path), `.${path.split("/").pop()}.install`);
  rmSync(temporary, { force: true });
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    mode,
  );
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, mode);
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

export const installNode = (source: string) =>
  Effect.gen(function* () {
    const data = readFileSync(source);
    if (sha256(data) !== NODE_SHA256)
      return yield* deny("node_digest_mismatch");
    directory(dirname(NODE));
    atomic(NODE, data, 0o755);
    if (sha256(readFileSync(NODE)) !== NODE_SHA256)
      return yield* deny("node_install_unverified");
    return NODE;
  });

export const installGroup = (
  name: string,
  build: string,
  revision: string,
  files: readonly string[],
) =>
  Effect.gen(function* () {
    if (
      !/^[a-z][a-z0-9-]{0,31}$/.test(name) ||
      !/^[0-9a-f]{40}$/.test(revision) ||
      files.length === 0 ||
      files.some((file) => !/^[A-Za-z0-9_.-]+\.(mjs|sh)$/.test(file))
    )
      return yield* deny("invalid_install_request");
    const manifest = loads(readFileSync(join(build, "manifest.json"))) as {
      revision: string;
      clean: boolean;
      sha256: Record<string, string>;
    };
    if (manifest.revision !== revision || manifest.clean !== true)
      return yield* deny("build_provenance_mismatch");
    const built = manifest.sha256;
    const payload = files.map((file) => {
      const data = readFileSync(join(build, file));
      if (built[file] !== sha256(data))
        throw new Error("bundle_digest_mismatch");
      return [file, data] as const;
    });
    const target = join(ROOT, name);
    directory(target);
    for (const [file, data] of payload)
      atomic(join(target, file), data, file.endsWith(".sh") ? 0o755 : 0o644);
    const sha = Object.fromEntries(
      [...files]
        .sort()
        .map((file) => [file, sha256(readFileSync(join(target, file)))]),
    );
    for (const file of files)
      if (sha[file] !== built[file]) return yield* deny("install_unverified");
    atomic(
      join(target, "manifest.json"),
      Buffer.from(`${dumps({ revision, sha256: sha }, { indent: 2 })}\n`),
      0o644,
    );
    return { target, revision, sha256: sha };
  });

export const main = Effect.gen(function* () {
  if (process.geteuid?.() !== 0) return yield* deny("install_root_required");
  process.umask(0o022);
  directory(ROOT);
  const [command, ...rest] = process.argv.slice(2);
  const result =
    command === "node" && rest.length === 1
      ? yield* installNode(rest[0] as string)
      : command === "group" && rest.length >= 4
        ? yield* installGroup(
            rest[0] as string,
            rest[1] as string,
            rest[2] as string,
            rest.slice(3),
          )
        : yield* deny(
            "usage: install.mjs node <binary> | group <name> <build> <revision> <file>...",
          );
  process.stdout.write(`${dumps(result)}\n`);
});

export const run = () => runMain(main);
