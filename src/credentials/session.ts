import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { BitwardenOptions } from "./bitwarden.js";

/** Owner-provisioned lease only; never logs in, unlocks, renews, or caches it.
 * The host must protect the canonical parent directory against model writes.
 */
export function createBitwardenFileSession(
  path: string,
): BitwardenOptions["session"] {
  if (!isAbsolute(path)) throw new Error("invalid_credential_configuration");
  return async () => {
    try {
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const buffer = Buffer.alloc(4097);
      try {
        const metadata = await file.stat();
        if (
          !metadata.isFile() ||
          metadata.uid !== process.getuid?.() ||
          (metadata.mode & 0o077) !== 0 ||
          metadata.nlink !== 1 ||
          metadata.size > 4096
        )
          throw new Error();
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            size,
            buffer.length - size,
            size,
          );
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > 4096) throw new Error();
        const value: unknown = JSON.parse(buffer.toString("utf8", 0, size));
        if (
          !value ||
          typeof value !== "object" ||
          !("key" in value) ||
          typeof value.key !== "string" ||
          !value.key ||
          !("expiresAt" in value) ||
          typeof value.expiresAt !== "number" ||
          !Number.isSafeInteger(value.expiresAt)
        )
          throw new Error();
        // Remaining lifetime is checked immediately before and after CLI access.
        return { key: value.key, expiresAt: value.expiresAt };
      } finally {
        buffer.fill(0);
        await file.close();
      }
    } catch {
      throw new Error("credential_unavailable");
    }
  };
}
