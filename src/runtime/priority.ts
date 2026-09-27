/** Two slots, at most one guest or background execution. Owners enter first.
 * Running effects are never cancelled to make room for a higher-priority turn. */
export function createPriorityAdmission() {
  let active = 0;
  let guests = 0;
  let background = 0;
  const waiting: { owner: boolean | "background"; wake: () => void }[] = [];
  const recent = new Map<string, number[]>();
  const pump = () => {
    while (active < 2) {
      let index = waiting.findIndex((item) => item.owner === true);
      if (index < 0 && guests + background === 0) index = 0;
      const item = waiting[index];
      if (!item) break;
      waiting.splice(index, 1);
      active++;
      if (item.owner === false) guests++;
      if (item.owner === "background") background++;
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
    async enter(
      owner: boolean | "background",
      signal: AbortSignal,
    ): Promise<(() => void) | undefined> {
      signal.throwIfAborted();
      if (
        owner === "background" &&
        waiting.filter((item) => item.owner === "background").length >= 32
      )
        return undefined;
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
        if (owner === false) guests--;
        if (owner === "background") background--;
        pump();
      };
    },
  };
}
