import { fork } from "node:child_process";

// Keep the SDK's process-wide signal handler behind our admission/receipt drain.
// Run this as the container entrypoint, not main.ts directly.
const child = fork(new URL("./main.ts", import.meta.url), {
  execArgv: ["--import", "tsx"],
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
let ready = false;
let stopping = false;
let drained = false;
let deadline;
const stop = () => {
  if (stopping) return;
  stopping = true;
  deadline = setTimeout(() => {
    console.error('{"event":"shutdown_deadline_exceeded"}');
    child.kill("SIGKILL");
  }, 85_000);
  if (ready) child.send("drain");
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
child.on("message", (message) => {
  if (message === "ready") {
    ready = true;
    if (stopping) child.send("drain");
  } else if (message === "drained" && stopping && !drained) {
    drained = true;
    child.kill("SIGTERM");
  }
});
child.on("error", () => {
  console.error('{"event":"host_process_failed"}');
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  clearTimeout(deadline);
  process.exit(code === 0 || (drained && signal === "SIGTERM") ? 0 : 1);
});
