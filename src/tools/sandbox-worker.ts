import { Worker } from "node:worker_threads";

type Kind = "javascript" | "workflow";
// Separate lanes keep durable host waits from occupying computation capacity.
const lanes = {
  javascript: { active: 0, waiting: new Set<() => void>() },
  workflow: { active: 0, waiting: new Set<() => void>() },
};

async function acquire(kind: Kind, signal: AbortSignal) {
  signal.throwIfAborted();
  const lane = lanes[kind];
  if (lane.active >= 4) {
    if (lane.waiting.size >= 1024) throw new Error("sandbox_queue_full");
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        lane.waiting.delete(wake);
        reject(signal.reason);
      };
      lane.waiting.add(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
  } else lane.active++;
  return () => {
    const next = lane.waiting.values().next().value;
    if (next) {
      lane.waiting.delete(next);
      next();
    } else lane.active--;
  };
}

/** Host exceptions never cross the guest bridge, including Rivet suspension.
 * Termination is awaited before releasing capacity; dispatched effects settle
 * independently and are never retried or declared cancelled by worker exit. */
export async function runSandboxWorker<T>(
  kind: Kind,
  input: unknown,
  signal: AbortSignal,
  dispatch?: (operation: unknown) => Promise<unknown>,
): Promise<T> {
  const release = await acquire(kind, signal);
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let dispatchFailure: { error: unknown } | undefined;
  let failure: { error: unknown } | undefined;
  let result: T | undefined;
  let stopped = false;
  const outcome = Promise.withResolvers<T>();
  const fail = (error: unknown) => {
    stopped = true;
    outcome.reject(error);
  };
  const failDispatch = (error: unknown) => {
    dispatchFailure = { error };
    fail(error);
  };
  const abort = () => fail(signal.reason);
  const watchdog = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => fail(new Error("sandbox_worker_timeout")), ms);
  };
  try {
    signal.throwIfAborted();
    worker = new Worker(new URL("./sandbox-worker.mjs", import.meta.url), {
      workerData: { kind, input },
      resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
    });
    const running = worker;
    signal.addEventListener("abort", abort, { once: true });
    watchdog(15_000);
    worker.on("error", fail);
    worker.on("exit", () => fail(new Error("sandbox_worker_exited")));
    worker.on("message", (message) => {
      if (stopped) return;
      if (message.kind === "ready") watchdog(5_000);
      else if (message.kind === "result") outcome.resolve(message.value);
      else if (message.kind === "error") fail(new Error(message.error));
      else if (message.kind === "dispatch") {
        if (!dispatch || active) {
          fail(new Error("sandbox_invalid_dispatch"));
          return;
        }
        // Worker is awaiting this JSON reply, not executing guest code.
        clearTimeout(timer);
        active = Promise.resolve()
          .then(() => {
            signal.throwIfAborted();
            return dispatch(message.operation);
          })
          .then((value) => {
            if (!stopped) {
              watchdog(5_000);
              running.postMessage({ value });
            }
          }, failDispatch)
          .catch(fail)
          .finally(() => {
            active = undefined;
          });
      } else fail(new Error("sandbox_invalid_message"));
    });
    result = await outcome.promise;
  } catch (error) {
    failure = { error };
  } finally {
    stopped = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    await worker?.terminate();
    release();
    await active;
  }
  // Rivet suspension is a native control-flow exception, even when a timeout
  // or cancellation beat it to the result. Never turn it into an abort error.
  if (dispatchFailure) throw dispatchFailure.error;
  if (failure) throw failure.error;
  return result as T;
}
