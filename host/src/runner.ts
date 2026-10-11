/** Root-installed SSH forced command. Runs as the authenticated Amp account. */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { userInfo } from "node:os";
import { Effect, Predicate } from "effect";
import { readRootJson } from "./lib/files.js";
import { get } from "./lib/json.js";
import { Denied, deny, runMain } from "./lib/main.js";
import { recoveryPrompt } from "./lib/prompts.js";
import { isReason } from "./lib/reasons.js";
import { split } from "./lib/shlex.js";

export const PROBE =
  "This is an authorized read-only June recovery transport self-test, not a recovery. " +
  "No production incident exists for this test. Do not use tools, read files, " +
  "contact services or other threads, claim ownership, or change anything. " +
  "Reply exactly JUNE_RECOVERY_TRANSPORT_OK and end the turn.";

const isAbsolute = (value: unknown): value is string =>
  Predicate.isString(value) && value.startsWith("/");

/** `[absolute CLI]`, as `config["command"]` must be in every runner policy. */
export const singleCommand = (value: unknown): value is [string] =>
  Array.isArray(value) && value.length === 1 && isAbsolute(value[0]);

export const command = Effect.fnUntraced(function* (
  original: string,
  config: unknown,
) {
  const cli = get(config, "command");
  const directory = get(config, "runnerDirectory");
  if (!singleCommand(cli) || !isAbsolute(directory) || original.length > 16384)
    return yield* deny("invalid_runner_command");
  const prefix = [
    ...cli,
    "--mode",
    "ultra",
    "--features",
    "fast",
    "--executor",
    "runner:homelab-amp",
    "--runner-dir",
    directory,
    "--stream-json",
    "--no-archive-after-execute",
    "--title",
  ];
  if (original === "june-recovery-self-test")
    return [...prefix, "June recovery transport self-test", "--execute", PROBE];
  const argv = yield* Effect.try({
    try: () => split(original),
    catch: () => new Denied({ reason: "invalid_runner_command" }),
  });
  if (
    argv.length !== prefix.length + 3 ||
    prefix.some((value, index) => argv[index] !== value) ||
    argv.at(-2) !== "--execute"
  )
    return yield* deny("invalid_runner_command");
  const prompt = argv.at(-1) as string;
  const match =
    /^June deployment failed\. Incident ([1-9][0-9]{0,18}), revision ([0-9a-f]{40}), reason ([a-z_]+|None)\. /.exec(
      prompt,
    );
  if (!match) return yield* deny("invalid_runner_prompt");
  const [, number = "", commit = "", reason = ""] = match;
  if (reason !== "None" && !isReason(reason))
    return yield* deny("invalid_runner_reason");
  const incident = BigInt(number);
  if (
    argv.at(-3) !== `Recover June deployment incident ${number}` ||
    prompt !==
      recoveryPrompt(incident, commit, reason === "None" ? null : reason)
  )
    return yield* deny("invalid_runner_prompt");
  return argv;
});

/** No SSH-supplied environment reaches Amp. Credentials remain in its own home. */
export function environment(): Record<string, string> {
  const user = userInfo();
  return {
    HOME: user.homedir,
    USER: user.username,
    LOGNAME: user.username,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
  };
}

/**
 * Node cannot `exec`, so the child replaces this process in every observable
 * way instead: it inherits stdout/stderr, receives forwarded signals, and its
 * exit status (or terminating signal) becomes ours. Amp accepts piped input
 * alongside --execute, so SSH stdin is replaced with /dev/null, never prompt data.
 */
export const execute = (argv: readonly string[], directory: string) =>
  Effect.callback<never, Denied>((resume) => {
    const [file = "", ...args] = argv;
    const stdin = openSync("/dev/null", "r");
    const child = spawn(file, args, {
      cwd: directory,
      env: environment(),
      stdio: [stdin, "inherit", "inherit"],
    });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    for (const signal of signals) process.on(signal, forward);
    const settle = () => {
      for (const name of signals) process.removeListener(name, forward);
    };
    child.once("error", () => {
      settle();
      resume(deny("exec_failed"));
    });
    child.once("exit", (code, signal) => {
      settle();
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 1);
    });
    // Like exec, our own termination is the child's: forwarded signals end it.
  }).pipe(Effect.uninterruptible);

export const main = Effect.gen(function* () {
  const config = yield* readRootJson(
    "/etc/june-recovery/runner.json",
    "unsafe_runner_config",
  );
  const argv = yield* command(process.env.SSH_ORIGINAL_COMMAND ?? "", config);
  yield* execute(argv, get(config, "runnerDirectory") as string);
});

// Do not echo untrusted commands or private paths.
export const run = () =>
  runMain(main, { message: "june_recovery_command_denied" });
