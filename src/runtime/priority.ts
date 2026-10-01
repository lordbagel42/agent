/** Two worker slots plus an owner reserve; at most two foreground turns and one
 * guest. Independent workers can progress while June keeps talking. Owners enter first.
 * Running effects are never cancelled to make room for a higher-priority turn. */
export function createPriorityAdmission() {
  let active = 0;
  let guests = 0;
  let background = 0;
  const waiting: { owner: boolean | "background"; wake: () => void }[] = [];
  const recent = new Map<string, number[]>();
  const pump = () => {
    while (active < 3) {
      let index = waiting.findIndex(
        (item) => item.owner === true && active - background < 2,
      );
      if (index < 0 && guests + background < 2)
        index = waiting.findIndex(
          (item) =>
            item.owner === "background" ||
            (item.owner === false && guests === 0 && active - background < 2),
        );
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
    /** Process-local admission only; neither provider liveness nor durable holds. */
    snapshot() {
      return {
        limits: {
          total: 3,
          guests: 1,
          background: 2,
          nonOwner: 2,
          waitingBackground: 32,
        },
        current: {
          active,
          owners: active - guests - background,
          guests,
          background,
          waitingOwners: waiting.filter((item) => item.owner === true).length,
          waitingGuests: waiting.filter((item) => item.owner === false).length,
          waitingBackground: waiting.filter(
            (item) => item.owner === "background",
          ).length,
        },
      };
    },
    /** Journal this decision once per turn. Replay must never re-charge or
     * reject a turn whose effects/journal already exist. */
    acceptGuest(sender: string, botMessage = false): boolean {
      const now = Date.now();
      for (const [id, times] of recent)
        if ((times.at(-1) ?? 0) < now - 60_000) recent.delete(id);
      const times = (recent.get(sender) ?? []).filter(
        (at) => at > now - 60_000,
      );
      if (
        (!botMessage && times.length >= 4) ||
        waiting.length >= 32 ||
        recent.size >= 256
      )
        return false;
      // Bot loop decisions belong to June, not a turn counter. Track only
      // last activity for bots so capacity accounting stays bounded.
      recent.set(sender, botMessage ? [now] : [...times, now]);
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
