/** Two turn slots, at most one guest. Owner waiters always get first admission.
 * Running effects are never cancelled to make room for a higher-priority turn. */
export function createPriorityAdmission() {
  let active = 0;
  let guests = 0;
  const waiting: { owner: boolean; wake: () => void }[] = [];
  const recent = new Map<string, number[]>();
  const pump = () => {
    while (active < 2) {
      let index = waiting.findIndex((item) => item.owner);
      if (index < 0 && guests === 0) index = 0;
      const item = waiting[index];
      if (!item) break;
      waiting.splice(index, 1);
      active++;
      if (!item.owner) guests++;
      item.wake();
    }
  };
  return {
    /** Journal this decision once per turn. Replay must never re-charge or
     * reject a turn whose effects/journal already exist. */
    acceptGuest(sender: string): boolean {
      const now = Date.now();
      for (const [id, times] of recent)
        if ((times.at(-1) ?? 0) < now - 60_000) recent.delete(id);
      const times = (recent.get(sender) ?? []).filter(
        (at) => at > now - 60_000,
      );
      if (times.length >= 4 || waiting.length >= 32 || recent.size >= 256)
        return false;
      recent.set(sender, [...times, now]);
      return true;
    },
    async enter(owner: boolean, signal: AbortSignal): Promise<() => void> {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const item = {
          owner,
          wake: () => {
            signal.removeEventListener("abort", abort);
            resolve();
          },
        };
        const abort = () => {
          const index = waiting.indexOf(item);
          if (index >= 0) waiting.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        waiting.push(item);
        pump();
      });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
        if (!owner) guests--;
        pump();
      };
    },
  };
}
