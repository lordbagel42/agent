import type { ChannelAdapter, MessageEvent } from "../core/contracts.js";

/** Best-effort activity around real work. No message, outbox entry, model tool,
 * or replayable journal operation. Keep all status transports within the turn's
 * lifecycle lease so deployment cannot leave an update in flight. */
export async function withTyping<T>(
  adapter: ChannelAdapter | undefined,
  event: MessageEvent,
  signal: AbortSignal,
  work: () => Promise<T>,
  // A turn may deliver first, but must await this before its next status call
  // and before releasing lifecycle admission. Omission keeps the legacy order.
  deferCleanup?: (cleanup: Promise<void>) => void,
): Promise<T> {
  if (!adapter?.setTyping || signal.aborted) return work();
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
  try {
    return await work();
  } finally {
    clearInterval(timer);
    const cleanup = (async () => {
      // Wait before clearing: a late start must not resurrect a finished status.
      await pending;
      // Clear uses its own bounded attempt even when the work signal is aborted.
      await adapter.setTyping?.(event, false).catch(() => {});
    })();
    if (deferCleanup) deferCleanup(cleanup);
    else await cleanup;
  }
}
