import type { WorkflowErrorEvent } from "rivetkit/workflow";
import type { MessageEvent } from "../core/contracts.js";

/** Rivet reports retryable step errors before scheduling their retry. Those
 * keep the engine's durable retry policy; latching them would only disable
 * unrelated work. Exhausted/nonretrying steps and workflow/rollback errors
 * remain terminal. A retry never repeats an effect its own markers fence. */
export function terminalWorkflowError(event: WorkflowErrorEvent) {
  return !("step" in event && event.step.willRetry === true);
}

/** Retry checkpoint/alarm errors can escape workflow() without another error
 * notification. Catch only its settled run promise, never scheduler yields
 * inside the workflow callback. Proxy retains Rivet's inspector metadata. */
export function guardWorkflowActor<T extends { config: { run?: unknown } }>(
  definition: T,
  lifecycle: Pick<Lifecycle, "fail"> | undefined,
): T {
  const run = definition.config.run;
  if (typeof run === "function") {
    definition.config.run = new Proxy(run, {
      async apply(fn, receiver, args: [{ abortSignal: AbortSignal }]) {
        try {
          return await Reflect.apply(fn, receiver, args);
        } catch (error) {
          if (!args[0].abortSignal.aborted) lifecycle?.fail();
          throw error;
        }
      },
    });
  }
  return definition;
}

export type ConversationActivity = Pick<
  MessageEvent,
  "address" | "direct" | "senderId"
>;

/** Account for accepted raw work before waiting for its serializer, not just
 * while its RPC caller is waiting. Callers also keepAwake until this settles.
 * An actor abort with a held lease still trips the uncertain-work fence. */
export async function serializeAdmittedWork<T>(
  lifecycle: Pick<Lifecycle, "enter"> | undefined,
  signal: AbortSignal,
  previous: Promise<void>,
  work: () => Promise<T>,
  conversation?: ConversationActivity,
): Promise<T> {
  const release = await lifecycle?.enter(signal, conversation);
  try {
    await previous;
    signal.throwIfAborted();
    return await work();
  } finally {
    release?.();
  }
}

/** Process-local admission only. Durable queues stay intact while fenced; this
 * never cancels an effect, clears an uncertain intent, or stops the registry.
 * isSettled checks durable/native work after process-local work is idle. */
export function createLifecycle(isSettled?: () => Promise<boolean>) {
  let fenced = false;
  let failed = false;
  let failure: "lease_abort" | "explicit_failure" | undefined;
  let active = 0;
  const conversations = new Set<ConversationActivity>();
  const waiting = new Set<() => void>();
  let draining: Promise<boolean> | undefined;
  let finishDrain: ((drained: boolean) => void) | undefined;
  let checkDrain: (() => void) | undefined;

  const resume = () => {
    fenced = false;
    finishDrain?.(false);
    for (const wake of waiting) wake();
  };
  const fail = (admission?: { admittedAt: number; admissionStack: string }) => {
    const first = !failed;
    failed = true;
    failure ??= admission ? "lease_abort" : "explicit_failure";
    resume();
    if (first) {
      // Host-generated frames only: never log a thrown error, signal reason,
      // actor key, message body, or arbitrary workflow metadata.
      try {
        console.error(
          JSON.stringify({
            event: "lifecycle_failed",
            kind: failure,
            at: Date.now(),
            active,
            stack: new Error().stack?.split("\n").slice(1, 9).join("\n"),
            ...admission,
          }),
        );
      } catch {
        // Diagnostics must not undo or interrupt the safety latch.
      }
    }
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
  // Metadata only: callers keep their admission lease through eligibility
  // checks, then register a live surface until that same operation settles.
  const participate = (conversation: ConversationActivity) => {
    const entry = {
      address: { ...conversation.address },
      direct: conversation.direct,
      senderId: conversation.senderId,
    };
    conversations.add(entry);
    return () => {
      conversations.delete(entry);
    };
  };
  return {
    get ready() {
      return !fenced && !failed;
    },
    get failure() {
      return failure;
    },
    get active() {
      return active;
    },
    get conversations() {
      return [...conversations].map((entry) => ({
        ...entry,
        address: { ...entry.address },
      }));
    },
    participate,
    tryEnter,
    async enter(
      signal: AbortSignal,
      conversation?: ConversationActivity,
    ): Promise<() => void> {
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
      // Content-free and process-local: no subscriptions, history, or typing
      // preferences. Only admitted conversation work is a notice destination.
      const stopParticipation = conversation && participate(conversation);
      // A forced workflow abort may release its callback before a raw effect
      // settles. Never certify that process as naturally drained afterwards.
      const admission = {
        admittedAt: Date.now(),
        admissionStack:
          new Error().stack?.split("\n").slice(1, 9).join("\n") ?? "",
      };
      const abort = () => fail(admission);
      signal.addEventListener("abort", abort, { once: true });
      return () => {
        signal.removeEventListener("abort", abort);
        stopParticipation?.();
        release();
      };
    },
    fail: () => fail(),
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
