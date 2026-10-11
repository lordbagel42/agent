import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { atomicWrite } from "./files.js";
import { purePath } from "./py.js";
import { dumps } from "./pyjson.js";

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const THREAD = /^T-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const LIMIT = 64 * 1024 * 1024;

export class UnsafeFile extends Error {}

/** Reads at most `limit + 1` bytes from an open descriptor. */
export function readBounded(fd: number, limit: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= limit) {
    const chunk = Buffer.allocUnsafe(Math.min(1 << 20, limit + 1 - total));
    let count: number;
    try {
      count = readSync(fd, chunk, 0, chunk.length, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") continue;
      throw error;
    }
    if (count === 0) break;
    chunks.push(chunk.subarray(0, count));
    total += count;
  }
  return Buffer.concat(chunks, total);
}

/**
 * Owner-private regular file, opened without following a final link. With
 * `owner: 0` it must be root-owned and not group/other writable instead.
 */
export function readPrivate(
  path: string,
  options: { readonly limit?: number; readonly owner?: number } = {},
): Buffer {
  const limit = options.limit ?? LIMIT;
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.mode & (options.owner === 0 ? 0o022 : 0o077) ||
      info.uid !== (options.owner ?? process.getuid?.()) ||
      info.size > limit
    )
      throw new UnsafeFile("unsafe_debug_file");
    const data = readBounded(fd, limit);
    if (data.length > limit) throw new UnsafeFile("debug_file_too_large");
    return data;
  } finally {
    closeSync(fd);
  }
}

export function privateDirectory(value: string): string {
  const directory = purePath(value);
  const info = lstatSync(directory);
  if (
    !directory.startsWith("/") ||
    realpathSync(directory) !== directory ||
    !info.isDirectory() ||
    info.mode & 0o077 ||
    info.uid !== process.getuid?.()
  )
    throw new UnsafeFile("unsafe_debug_directory");
  return directory;
}

/** Atomic `json.dump` receipt named `<id>.<suffix>.json`. */
export function saveReceipt(
  directory: string,
  receipt: { readonly id: string } & Record<string, unknown>,
  suffix = "receipt",
): void {
  atomicWrite(
    directory,
    `${receipt.id}.${suffix}.json`,
    dumps(receipt),
    ".receipt-",
  );
}
