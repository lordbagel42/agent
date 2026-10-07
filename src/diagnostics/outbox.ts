import type { DebugSnapshot } from "../runtime/session-controls.js";
import type { DebugSitePublisher } from "./contracts.js";
import { DebugSitePublishError } from "./publisher.js";

export interface DebugSiteOutbox {
  url: string;
  status: "pending" | "saved" | "rejected";
  attempts: number;
  retryAt?: number;
  savedAt?: number;
  error?: string;
}

/** Called by the actor's serialized, keep-awake publication lane. A lost HTTP
 * acknowledgment can repeat only this immutable upload, never an investigation. */
export async function publishDebugSite(
  state: DebugSiteOutbox,
  snapshot: DebugSnapshot,
  publisher: DebugSitePublisher,
  persist: () => Promise<void>,
  now = Date.now(),
  investigation?: Parameters<DebugSitePublisher["publish"]>[1],
) {
  if (state.status !== "pending" || (state.retryAt ?? 0) > now) return;
  if (state.url !== publisher.url(snapshot.id)) {
    state.status = "rejected";
    state.error = "destination_changed";
    delete state.retryAt;
    await persist();
    return;
  }
  state.attempts++;
  // Save the recovery time before starting I/O. Restart resumes the same outbox.
  state.retryAt =
    now + Math.min(3_600_000, 15_000 * 2 ** Math.min(state.attempts - 1, 8));
  await persist();
  try {
    await publisher.publish(snapshot, investigation);
    state.status = "saved";
    state.savedAt = now;
    delete state.retryAt;
    delete state.error;
  } catch (error) {
    state.error =
      error instanceof DebugSitePublishError ? error.code : "transport";
    if (error instanceof DebugSitePublishError && !error.retryable) {
      state.status = "rejected";
      delete state.retryAt;
    }
  }
  await persist();
}
