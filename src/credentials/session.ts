import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Effect, Schema } from "effect";
import { type BitwardenSession, CredentialUnavailable } from "./bitwarden.js";

const Lease = Schema.fromJsonString(
  Schema.Struct({
    key: Schema.NonEmptyString,
    expiresAt: Schema.Number.check(Schema.isInt()),
  }),
);
const decodeLease = Schema.decodeUnknownEffect(Lease);

/** Owner-provisioned lease only; never logs in, unlocks, renews, or caches it.
 * The host must protect the canonical parent directory against model writes.
 */
export function createBitwardenFileSession(
  path: string,
): Effect.Effect<BitwardenSession, CredentialUnavailable> {
  if (!isAbsolute(path)) throw new Error("invalid_credential_configuration");
  const read = Effect.acquireUseRelease(
    Effect.tryPromise(() =>
      open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ),
    ),
    (file) =>
      Effect.acquireUseRelease(
        Effect.sync(() => Buffer.alloc(4097)),
        (buffer) =>
          Effect.gen(function* () {
            const metadata = yield* Effect.tryPromise(() => file.stat());
            if (
              !metadata.isFile() ||
              metadata.uid !== process.getuid?.() ||
              (metadata.mode & 0o077) !== 0 ||
              metadata.nlink !== 1 ||
              metadata.size > 4096
            )
              return yield* new CredentialUnavailable();
            let size = 0;
            while (size < buffer.length) {
              const offset = size;
              const { bytesRead } = yield* Effect.tryPromise(() =>
                file.read(buffer, offset, buffer.length - offset, offset),
              );
              if (!bytesRead) break;
              size += bytesRead;
            }
            if (size > 4096) return yield* new CredentialUnavailable();
            // Remaining lifetime is checked immediately before and after CLI access.
            const { key, expiresAt } = yield* decodeLease(
              buffer.toString("utf8", 0, size),
            );
            return { key, expiresAt };
          }),
        (buffer) => Effect.sync(() => buffer.fill(0)),
      ),
    // A failed close is a defect, which collapses to credential_unavailable below.
    (file) => Effect.promise(() => file.close()),
  );
  return read.pipe(
    Effect.catchCause(() => Effect.fail(new CredentialUnavailable())),
  );
}
