/** Two worker slots plus an owner reserve; at most two foreground turns and one
 * guest. Independent workers can progress while June keeps talking. Owners enter first.
 * Running effects are never cancelled to make room for a higher-priority turn. */
export function createPriorityAdmission() {
  let active = 0;
  let guests = 0;
  let background = 0;
  let lastGuestScope: string | undefined;
  let lastGuestCompletion = false;
  const guestScopes: string[] = [];
  const waiting: {
    owner: boolean | "background";
    scope: string;
    completion: boolean;
    wake: () => void;
  }[] = [];
  const recent = new Map<
    string,
    { until: number; count: number; senders: Map<string, number> }
  >();
  let pruneAt = 0;
  const pump = () => {
    while (active < 3) {
      let index = waiting.findIndex(
        (item) => item.owner === true && active - background < 2,
      );
      if (
        guests === 0 &&
        guestScopes.length > 1 &&
        guestScopes[0] === lastGuestScope
      )
        guestScopes.push(guestScopes.shift() as string);
      // A ready result can use the next guest slot, then ordinary round-robin
      // resumes. Never preempt running work or consume the owner's reserve.
      if (
        index < 0 &&
        !lastGuestCompletion &&
        guests === 0 &&
        guests + background < 2 &&
        active - background < 2
      )
        index = waiting.findIndex(
          (item) => item.owner === false && item.completion,
        );
      if (index < 0 && guests + background < 2)
        index = waiting.findIndex(
          (item) =>
            item.owner === "background" ||
            (item.owner === false &&
              guests === 0 &&
              active - background < 2 &&
              item.scope === guestScopes[0]),
        );
      const item = waiting[index];
      if (!item) break;
      waiting.splice(index, 1);
      active++;
      if (item.owner === false) {
        guests++;
        lastGuestScope = item.scope;
        lastGuestCompletion = item.completion;
        guestScopes.splice(guestScopes.indexOf(item.scope), 1);
        if (
          waiting.some(
            (entry) => entry.owner === false && entry.scope === item.scope,
          )
        )
          guestScopes.push(item.scope);
      }
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
          waitingGuestsPerScope: 128,
          waitingGuests: 4096,
          guestTurnsPerSenderPerMinute: 60,
          guestTurnsPerScopePerMinute: 1200,
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
    acceptGuest(sender: string, scope: string): boolean {
      if (
        waiting.filter((item) => item.owner === false).length >= 4096 ||
        waiting.filter((item) => item.owner === false && item.scope === scope)
          .length >= 128
      )
        return false;
      const now = Date.now();
      if (now >= pruneAt) {
        for (const [key, window] of recent)
          if (window.until <= now) recent.delete(key);
        pruneAt = now + 60_000;
      }
      let window = recent.get(scope);
      if (!window || window.until <= now) {
        window = { until: now + 60_000, count: 0, senders: new Map() };
        recent.set(scope, window);
      }
      const count = window.senders.get(sender) ?? 0;
      if (count >= 60 || window.count >= 1200) return false;
      window.senders.set(sender, count + 1);
      window.count++;
      return true;
    },
    async enter(
      owner: boolean | "background",
      signal: AbortSignal,
      scope = "",
      completion = false,
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
          scope,
          completion,
          wake: () => {
            signal.removeEventListener("abort", abort);
            resolve();
          },
        };
        const abort = () => {
          const index = waiting.indexOf(item);
          if (index >= 0) waiting.splice(index, 1);
          if (
            owner === false &&
            !waiting.some(
              (entry) => entry.owner === false && entry.scope === scope,
            )
          ) {
            const index = guestScopes.indexOf(scope);
            if (index >= 0) guestScopes.splice(index, 1);
          }
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        waiting.push(item);
        if (owner === false && !guestScopes.includes(scope))
          guestScopes.push(scope);
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
