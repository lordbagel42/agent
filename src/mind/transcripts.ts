import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  appendFile,
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
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

  async readState<T>(name: string): Promise<T | undefined> {
    try {
      return JSON.parse(
        await readFile(join(this.root, "state", `${name}.json`), "utf8"),
      ) as T;
    } catch {
      return undefined;
    }
  }

  async writeState(name: string, value: unknown) {
    const target = join(this.root, "state", `${name}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await mkdir(join(this.root, "state"), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, target);
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

/** Kernel-owned lock using the same inherited-FD flock pattern as standby.ts.
 * No expiry or unlink: a slow owner cannot lose its lock to another slot. */
export class MindLock {
  private file: FileHandle | undefined;
  constructor(private readonly root: string) {}

  private get path() {
    return join(this.root, "state", "mind.lock");
  }

  async acquire() {
    if (this.file) return false;
    await mkdir(join(this.root, "state"), { recursive: true, mode: 0o700 });
    const file = await open(
      this.path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const acquired = await new Promise<boolean>((resolve, reject) => {
        const child = spawn("/usr/bin/flock", ["-n", "3"], {
          stdio: ["ignore", "ignore", "ignore", file.fd],
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolve(true);
          else if (code === 1) resolve(false);
          else reject(new Error("mind_lock_failed"));
        });
      });
      if (acquired) this.file = file;
      else await file.close();
      return acquired;
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async heartbeat() {
    if (!this.file) throw new Error("mind_lock_not_held");
  }

  async release() {
    const file = this.file;
    this.file = undefined;
    await file?.close();
  }
}
