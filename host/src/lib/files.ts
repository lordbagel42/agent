import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { Denied } from "./main.js";
import { loads } from "./pyjson.js";

/**
 * Reads JSON from a root-owned regular file that no group/other can write,
 * without following a final symlink (`os.open(..., O_NOFOLLOW)` + `fstat`).
 */
export const readRootJson = Effect.fnUntraced(function* (
  path: string,
  reason: string,
) {
  return yield* Effect.try({
    try: () => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const metadata = fstatSync(fd);
        if (metadata.uid !== 0 || metadata.mode & 0o022 || !metadata.isFile())
          throw new Error(reason);
        return loads(readFileSync(fd));
      } finally {
        closeSync(fd);
      }
    },
    catch: () => new Denied({ reason }),
  });
});

export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** `mkstemp` in `directory`, write, fsync, rename over `name`, fsync the directory. */
export function atomicWrite(
  directory: string,
  name: string,
  data: string | Uint8Array,
  prefix = ".tmp-",
): void {
  const temporary = join(
    directory,
    `${prefix}${randomBytes(6).toString("base64url")}`,
  );
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      if (typeof data === "string") writeSync(fd, data);
      else writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, join(directory, name));
    syncDirectory(directory);
  } finally {
    rmSync(temporary, { force: true });
  }
}
