import { actor } from "rivetkit";
import type {
  Address,
  Channel,
  ChannelAdapter,
  MessageEvent,
} from "../core/contracts.js";

export function typingKey(address: Address): string[] {
  return [
    address.channel,
    address.accountId,
    address.conversationId,
    address.threadId ?? "",
  ];
}

/** One preference/transport owner per surface, shared by otherwise isolated
 * participant actors. Pending targets contain sanitized transport metadata, not
 * message bodies, and survive idle sleep until cleared. Serialized updates
 * prevent a late pulse undoing a disable. */
export function createTypingActor(
  channels: Partial<Record<Channel, ChannelAdapter>>,
) {
  return actor({
    state: { enabled: true, active: {} as Record<string, MessageEvent> },
    createVars: (): {
      serial<T>(work: () => Promise<T>): Promise<T>;
    } => {
      let pending = Promise.resolve();
      return {
        serial<T>(work: () => Promise<T>): Promise<T> {
          const result = pending.then(work);
          pending = result.then(
            () => {},
            () => {},
          );
          return result;
        },
      };
    },
    actions: {
      read: (c) => c.state.enabled,
      set: (c, enabled: boolean) =>
        c.vars.serial(async () => {
          c.state.enabled = enabled;
          await c.saveState({ immediate: true });
          if (!enabled) {
            const events = Object.values(c.state.active);
            await Promise.all(
              events.map((event) =>
                channels[event.address.channel]
                  ?.setTyping?.(event, false)
                  .catch(() => {}),
              ),
            );
            c.state.active = {};
            await c.saveState({ immediate: true });
          }
        }),
      pulse: (c, event: MessageEvent, active: boolean) =>
        c.vars.serial(async () => {
          const key = JSON.stringify([event.address, event.messageId]);
          if (active) {
            c.abortSignal.throwIfAborted();
            if (!c.state.enabled) return true;
            c.state.active[key] = event;
            await c.saveState({ immediate: true });
            c.abortSignal.throwIfAborted();
          } else {
            // Disabling already cleared this transport target.
            if (!c.state.active[key]) return true;
          }
          let accepted = true;
          try {
            await channels[event.address.channel]?.setTyping?.(
              event,
              active,
              active ? c.abortSignal : undefined,
            );
          } catch {
            // A settled transport failure is best-effort, not an ambiguous RPC.
            accepted = false;
          }
          if (!active) {
            delete c.state.active[key];
            await c.saveState({ immediate: true });
          }
          return accepted;
        }),
    },
  });
}

/** Best-effort activity around real work. No message, outbox entry, model tool,
 * or replayable journal operation. Keep all status transports within the turn's
 * lifecycle lease so deployment cannot leave an update in flight. */
export function startTyping(
  adapter: Pick<ChannelAdapter, "setTyping"> | undefined,
  event: MessageEvent,
  signal: AbortSignal,
): () => Promise<void> {
  if (!adapter?.setTyping || signal.aborted) return async () => {};
  let pending: Promise<void> | undefined;
  let unavailable = false;
  const pulse = () => {
    if (pending || unavailable || signal.aborted) return;
    pending = adapter
      .setTyping?.(event, true, signal)
      .catch(() => {
        unavailable = true;
      })
      .finally(() => {
        pending = undefined;
      });
  };
  // In parallel with inference: a typing roundtrip must not delay its start.
  pulse();
  const timer = setInterval(pulse, 30_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    // Wait before clearing: a late start must not resurrect a finished status.
    await pending;
    // Clear uses its own bounded attempt even when the work signal is aborted.
    await adapter.setTyping?.(event, false).catch(() => {});
  };
}

export async function withTyping<T>(
  adapter: Pick<ChannelAdapter, "setTyping"> | undefined,
  event: MessageEvent,
  signal: AbortSignal,
  work: () => Promise<T>,
  // A turn may deliver first, but must await this before its next status call
  // and before releasing lifecycle admission. Omission keeps the legacy order.
  deferCleanup?: (cleanup: Promise<void>) => void,
): Promise<T> {
  const stop = startTyping(adapter, event, signal);
  try {
    return await work();
  } finally {
    const cleanup = stop();
    if (deferCleanup) deferCleanup(cleanup);
    else await cleanup;
  }
}
