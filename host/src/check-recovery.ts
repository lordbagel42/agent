/**
 * Offline acceptance check for the recovery SSH forced command. Reads one
 * `SSH_ORIGINAL_COMMAND` value on stdin and reports whether the runner's
 * `command` validation accepts it, using `/etc/june-recovery/runner.json`
 * (or the config path given as the only argument). It never executes Amp.
 */
import { readFileSync } from "node:fs";
import { Effect, Exit } from "effect";
import { readRootJson } from "./lib/files.js";
import { readBounded } from "./lib/private.js";
import { command } from "./runner.js";

export const main = Effect.gen(function* () {
  const path = process.argv[2] ?? "/etc/june-recovery/runner.json";
  const config =
    process.argv[2] === undefined
      ? yield* readRootJson(path, "unsafe_runner_config")
      : JSON.parse(readFileSync(path, "utf8"));
  const original = readBounded(0, 1 << 20)
    .toString("utf8")
    .replace(/\n$/, "");
  const exit = yield* Effect.exit(command(original, config));
  const result = Exit.isSuccess(exit)
    ? { accepted: true, argc: exit.value.length }
    : {
        accepted: false,
        reason:
          exit.cause.reasons[0]?._tag === "Fail"
            ? (exit.cause.reasons[0].error as { reason?: string }).reason
            : "defect",
      };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.accepted) process.exitCode = 1;
});

export const run = () => Effect.runFork(main);
