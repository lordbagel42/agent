import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { PlaceKind } from "./places.js";

/** One captured line. Human text only; never tool output or quoted context. */
export interface Entry {
  id: string;
  at: number;
  place: string;
  kind: PlaceKind;
  label?: string;
  /** Person ID, or "june" for June's own sent replies. */
  from: string;
  name?: string;
  owner?: boolean;
  thread?: string;
  text: string;
}

interface Cursor {
  offset: number;
  /** Recent entry IDs, so replayed captures are not reflected twice. */
  ids: string[];
  failures?: number;
  retryAt?: number;
}

/** Append-only per-place transcripts plus reflection cursors (all gitignored). */
export class Transcripts {
  private queues = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  private file(place: string) {
    return join(this.root, "transcripts", `${place}.jsonl`);
  }

  private cursorFile() {
    return join(this.root, "state", "cursors.json");
  }

  /** Fire-and-forget append, ordered per place. Errors are reported, not thrown. */
  append(entry: Entry, onError: (error: unknown) => void) {
    const previous = this.queues.get(entry.place) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        await mkdir(join(this.root, "transcripts"), {
          recursive: true,
          mode: 0o700,
        });
        await appendFile(this.file(entry.place), `${JSON.stringify(entry)}\n`, {
          mode: 0o600,
        });
      })
      .catch(onError);
    this.queues.set(entry.place, next);
    void next.finally(() => {
      if (this.queues.get(entry.place) === next)
        this.queues.delete(entry.place);
    });
  }

  async flush() {
    await Promise.all(this.queues.values());
  }

  async places() {
    const names = await readdir(join(this.root, "transcripts")).catch(
      () => [] as string[],
    );
    return names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length));
  }

  async read(place: string): Promise<Entry[]> {
    const text = await readFile(this.file(place), "utf8").catch(() => "");
    const entries: Entry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as Entry);
      } catch {
        // A torn final line from a crash is skipped, never fatal.
      }
    }
    return entries;
  }

  async lastWrite(place: string) {
    return (await stat(this.file(place)).catch(() => undefined))?.mtimeMs;
  }

  async cursors(): Promise<Record<string, Cursor>> {
    try {
      return JSON.parse(await readFile(this.cursorFile(), "utf8"));
    } catch {
      return {};
    }
  }

  async saveCursor(place: string, cursor: Cursor) {
    const all = await this.cursors();
    all[place] = { ...cursor, ids: cursor.ids.slice(-300) };
    const temporary = `${this.cursorFile()}.${process.pid}.tmp`;
    await mkdir(join(this.root, "state"), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(all), { mode: 0o600 });
    await rename(temporary, this.cursorFile());
  }
}

/** Cross-process lease so overlapping blue/green slots never reflect at once. */
export class MindLock {
  private held = false;
  constructor(
    private readonly root: string,
    private readonly staleMs = 20 * 60_000,
  ) {}

  private get path() {
    return join(this.root, "state", "lock");
  }

  async acquire() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await mkdir(this.path, { mode: 0o700 });
        await writeFile(
          join(this.path, "lease"),
          JSON.stringify({ pid: process.pid, slot: process.env.JUNE_SLOT }),
          { mode: 0o600 },
        );
        this.held = true;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age =
          Date.now() -
          ((await stat(join(this.path, "lease")).catch(() => undefined))
            ?.mtimeMs ??
            (await stat(this.path).catch(() => undefined))?.mtimeMs ??
            Date.now());
        if (age < this.staleMs) return false;
        await rm(this.path, { recursive: true, force: true });
      }
    }
    return false;
  }

  async heartbeat() {
    if (!this.held) return;
    const now = new Date();
    await utimes(join(this.path, "lease"), now, now).catch(() => undefined);
  }

  async release() {
    if (!this.held) return;
    this.held = false;
    await rm(this.path, { recursive: true, force: true });
  }
}
