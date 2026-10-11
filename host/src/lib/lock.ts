/**
 * `flock(2)` for Node, which has none: the service opens the lock file itself
 * and `/usr/bin/flock` locks that same open file description (passed as its
 * FD 9). The lock is held until this process closes the descriptor, and it
 * interoperates with existing operator locks taken by Python or flock(1).
 */
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { Effect, Schema, type Scope } from "effect";

export class LockBusy extends Schema.TaggedError<LockBusy>()("LockBusy", {
  path: Schema.String,
}) {}

export class LockFailed extends Schema.TaggedError<LockFailed>()("LockFailed", {
  path: Schema.String,
}) {}

export const flockFd = (
  fd: number,
  options: { readonly shared?: boolean; readonly wait?: boolean } = {},
) =>
  Effect.callback<boolean, LockFailed>((resume) => {
    const args = [
      ...(options.shared ? ["-s"] : ["-x"]),
      ...(options.wait ? [] : ["-n"]),
      "9",
    ];
    const stdio: Array<"ignore" | number> = Array(9).fill("ignore");
    stdio.push(fd);
    const child = spawn("/usr/bin/flock", args, { stdio });
    child.once("error", () =>
      resume(Effect.fail(new LockFailed({ path: `fd:${fd}` }))),
    );
    child.once("exit", (code) =>
      resume(
        code === 0
          ? Effect.succeed(true)
          : code === 1
            ? Effect.succeed(false)
            : Effect.fail(new LockFailed({ path: `fd:${fd}` })),
      ),
    );
  });

export interface LockOptions {
  readonly shared?: boolean;
  readonly wait?: boolean;
  /** `open(path, "a")`-style creation mode; omit to require an existing file. */
  readonly create?: number;
  readonly noFollow?: boolean;
  /** Reject anything but a single-link regular file owned by this uid. */
  readonly private?: boolean;
}

/** Holds `path` for the enclosing scope; fails with `LockBusy` if non-blocking and held. */
export const lockFile = (
  path: string,
  options: LockOptions = {},
): Effect.Effect<number, LockBusy | LockFailed, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const fd = yield* Effect.try({
        try: () =>
          openSync(
            path,
            (options.create === undefined ? 0 : constants.O_CREAT) |
              constants.O_RDWR |
              (options.noFollow ? constants.O_NOFOLLOW : 0) |
              constants.O_APPEND,
            options.create ?? 0o600,
          ),
        catch: () => new LockFailed({ path }),
      });
      const release = Effect.sync(() => closeSync(fd));
      if (options.private) {
        const info = fstatSync(fd);
        if (
          !info.isFile() ||
          info.uid !== process.getuid?.() ||
          info.mode & 0o077 ||
          info.nlink !== 1
        ) {
          yield* release;
          return yield* new LockFailed({ path });
        }
      }
      const acquired = yield* flockFd(fd, options).pipe(
        Effect.onError(() => release),
      );
      if (!acquired) {
        yield* release;
        return yield* new LockBusy({ path });
      }
      return fd;
    }),
    (fd) => Effect.sync(() => closeSync(fd)),
  );
