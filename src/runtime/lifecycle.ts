/** Process-local admission only. Durable queues stay intact while fenced; this
 * never cancels an effect, clears an uncertain intent, or stops the registry.
 * isSettled checks durable/native work after process-local work is idle. */
export function createLifecycle(isSettled?: () => Promise<boolean>) {
  let fenced = false;
  let failed = false;
  let active = 0;
  const waiting = new Set<() => void>();
  let draining: Promise<boolean> | undefined;
  let finishDrain: ((drained: boolean) => void) | undefined;
  let checkDrain: (() => void) | undefined;

  const resume = () => {
    fenced = false;
    finishDrain?.(false);
    for (const wake of waiting) wake();
  };
  const fail = () => {
    failed = true;
    resume();
  };
  const tryEnter = (): (() => void) | undefined => {
    if (fenced || failed) return undefined;
    active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      if (active === 0) checkDrain?.();
    };
  };
  return {
    get ready() {
      return !fenced && !failed;
    },
    get active() {
      return active;
    },
    tryEnter,
    async enter(signal: AbortSignal): Promise<() => void> {
      while (fenced) {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            waiting.delete(wake);
            signal.removeEventListener("abort", abort);
          };
          const wake = () => {
            done();
            resolve();
          };
          const abort = () => {
            done();
            reject(signal.reason);
          };
          waiting.add(wake);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      signal.throwIfAborted();
      const release = tryEnter();
      if (!release) throw new Error("workflow_unavailable");
      // A forced workflow abort may release its callback before a raw effect
      // settles. Never certify that process as naturally drained afterwards.
      signal.addEventListener("abort", fail, { once: true });
      return () => {
        signal.removeEventListener("abort", fail);
        release();
      };
    },
    fail,
    drain(timeoutMs = 4_000): Promise<boolean> {
      if (failed) return Promise.resolve(false);
      if (draining) return draining;
      fenced = true;
      if (active === 0 && !isSettled) return Promise.resolve(true);
      draining = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          // Timeout releases admission, never the outstanding work itself.
          resume();
        }, timeoutMs);
        const finish = (drained: boolean) => {
          // A late durable check cannot complete a resumed or newer drain.
          if (finishDrain !== finish) return;
          clearTimeout(timer);
          finishDrain = undefined;
          checkDrain = undefined;
          draining = undefined;
          resolve(drained);
        };
        finishDrain = finish;
        checkDrain = () => {
          if (!isSettled) {
            finish(!failed);
            return;
          }
          void Promise.resolve()
            .then(isSettled)
            .catch(() => false)
            .then((settled) => {
              if (finishDrain !== finish) return;
              if (settled && !failed) finish(true);
              else resume();
            });
        };
      });
      if (active === 0) checkDrain?.();
      return draining;
    },
    resume,
  };
}

export type Lifecycle = ReturnType<typeof createLifecycle>;
