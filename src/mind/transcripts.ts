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
import { Effect, Schema } from "effect";
import type { JuneRuntime } from "../effect/runtime.js";
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

/** A failed transcript, state or lock operation; the reason is fixed text. */
export class MindStateError extends Schema.TaggedError<MindStateError>()(
  "MindStateError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return this.reason;
  }
}

const io = <A>(reason: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new MindStateError({ reason, cause }),
  });
const missing = (error: MindStateError) =>
  (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** Append-only per-place transcripts plus reflection cursors (all gitignored). */
export class Transcripts {
  private queues = new Map<string, Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly runtime: JuneRuntime,
  ) {}

  /** Called under MindLock, before initialization creates anything else. */
  readonly fresh = Effect.fnUntraced(function* (this: Transcripts) {
    const entries = yield* io("mind_state_failed", () => readdir(this.root));
    if (entries.some((name) => name !== "state")) return false;
    const state = yield* io("mind_state_failed", () =>
      readdir(join(this.root, "state")),
    );
    return state.every((name) => name === "mind.lock");
  });

  private file(place: string) {
    return join(this.root, "transcripts", `${place}.jsonl`);
  }

  private cursorFile() {
    return join(this.root, "state", "cursors.json");
  }

  private readonly write = Effect.fn("june.mind.transcript.append")(function* (
    this: Transcripts,
    entry: Entry,
  ) {
    yield* io("mind_capture_failed", async () => {
      await mkdir(join(this.root, "transcripts"), {
        recursive: true,
        mode: 0o700,
      });
      await appendFile(this.file(entry.place), `${JSON.stringify(entry)}\n`, {
        mode: 0o600,
      });
    });
  });

  /** Fire-and-forget append, ordered per place. Errors are reported, not thrown. */
  append(entry: Entry, onError: (error: unknown) => void) {
    const previous = this.queues.get(entry.place) ?? Promise.resolve();
    const next = previous
      .then(() => this.runtime.runPromise(this.write(entry)))
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

  readonly places = Effect.fnUntraced(function* (this: Transcripts) {
    const names = yield* Effect.promise(() =>
      readdir(join(this.root, "transcripts")).catch(() => [] as string[]),
    );
    return names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length));
  });

  readonly read = Effect.fnUntraced(function* (
    this: Transcripts,
    place: string,
  ) {
    const text = yield* Effect.promise(() =>
      readFile(this.file(place), "utf8").catch(() => ""),
    );
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
  });

  readonly lastWrite = (place: string) =>
    Effect.promise(() =>
      stat(this.file(place)).then(
        (metadata) => metadata.mtimeMs,
        () => undefined,
      ),
    );

  /** Missing is empty; unreadable or corrupt state fails. */
  readonly cursors = Effect.fnUntraced(function* (this: Transcripts) {
    return yield* io("mind_state_failed", async () =>
      JSON.parse(await readFile(this.cursorFile(), "utf8")),
    ).pipe(
      Effect.map((value): Record<string, Cursor> => value),
      Effect.catchIf(missing, () => Effect.succeed<Record<string, Cursor>>({})),
    );
  });

  readState<T>(name: string): Effect.Effect<T | undefined, MindStateError> {
    return io(
      "mind_state_failed",
      async () =>
        JSON.parse(
          await readFile(join(this.root, "state", `${name}.json`), "utf8"),
        ) as T,
    ).pipe(Effect.catchIf(missing, () => Effect.succeed(undefined)));
  }

  readonly writeState = Effect.fn("june.mind.state.write")(function* (
    this: Transcripts,
    name: string,
    value: unknown,
  ) {
    yield* io("mind_state_failed", async () => {
      const target = join(this.root, "state", `${name}.json`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await mkdir(join(this.root, "state"), { recursive: true, mode: 0o700 });
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(value));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, target);
      const directory = await open(join(this.root, "state"), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
  });

  readonly saveCursor = Effect.fnUntraced(function* (
    this: Transcripts,
    place: string,
    cursor: Cursor,
  ) {
    const all = yield* this.cursors();
    all[place] = { ...cursor, ids: cursor.ids.slice(-300) };
    yield* io("mind_state_failed", async () => {
      const temporary = `${this.cursorFile()}.${process.pid}.tmp`;
      await mkdir(join(this.root, "state"), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(all), { mode: 0o600 });
      await rename(temporary, this.cursorFile());
    });
  });
}

/** Kernel-owned lock using the same inherited-FD flock pattern as standby.ts.
 * No expiry or unlink: a slow owner cannot lose its lock to another slot. */
export class MindLock {
  private file: FileHandle | undefined;
  constructor(private readonly root: string) {}

  private get path() {
    return join(this.root, "state", "mind.lock");
  }

  readonly acquire = Effect.fn("june.mind.lock.acquire")(function* (
    this: MindLock,
  ) {
    if (this.file) return false;
    return yield* io("mind_lock_failed", async () => {
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
    });
  });

  readonly heartbeat = Effect.fnUntraced(function* (this: MindLock) {
    if (!this.file)
      return yield* new MindStateError({ reason: "mind_lock_not_held" });
  });

  readonly release = Effect.fnUntraced(function* (this: MindLock) {
    const file = this.file;
    this.file = undefined;
    if (file) yield* io("mind_lock_failed", () => file.close());
  });
}
