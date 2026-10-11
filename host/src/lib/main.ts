import { Cause, Effect, Exit, Schema } from "effect";

/** A fixed-reason refusal; its reason is safe to log, unlike the input. */
export class Denied extends Schema.TaggedError<Denied>()("Denied", {
  reason: Schema.String,
}) {}

export const deny = (reason: string) => Effect.fail(new Denied({ reason }));

/**
 * Runs a host program the way CPython ran the scripts it replaces: a
 * terminating signal still ends the process *by that signal* (systemd counts
 * SIGTERM as a clean stop, so `OnFailure=` must not fire), finalizers run
 * first, and any other failure exits 1 after printing only `message`.
 */
export function runMain<A, E>(
  program: Effect.Effect<A, E>,
  options: { readonly message?: string } = {},
): void {
  const fiber = Effect.runFork(program);
  let signal: NodeJS.Signals | undefined;
  const onSignal = (received: NodeJS.Signals) => {
    signal ??= received;
    fiber.interruptUnsafe(fiber.id);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  fiber.addObserver((exit) => {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    if (Exit.isSuccess(exit)) return;
    if (options.message !== undefined)
      process.stderr.write(`${options.message}\n`);
    else process.stderr.write(`${Cause.pretty(exit.cause)}\n`);
    process.exitCode = 1;
  });
}
