import type { Entry } from "./transcripts.js";

export function localTime(ms: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    })
      .formatToParts(ms)
      .map(({ type, value }) => [type, value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    hour: Number(parts.hour),
    zone: parts.timeZoneName ?? timeZone,
  };
}

/** Transcript entries as the model sees them: local times, names, no IDs. */
export function formatEntries(entries: Entry[], timezone: string) {
  return entries.map((entry) => {
    const time = localTime(entry.at, timezone);
    return {
      time: `${time.date} ${time.time} ${time.zone}`,
      from:
        entry.from === "june"
          ? "June"
          : `${entry.name ?? "unknown name"} (${entry.from}${entry.owner ? ", owner Raygen" : ""})`,
      ...(entry.thread ? { inThread: true } : {}),
      text: entry.text,
    };
  });
}
