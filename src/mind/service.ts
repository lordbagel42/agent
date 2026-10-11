import { createHash } from "node:crypto";
import { Effect } from "effect";
import type {
  Address,
  MessageEvent,
  ModelProvider,
  ModelSettlement,
  Owner,
} from "../core/contracts.js";
import { isOwner } from "../core/social.js";
import type { JuneRuntime } from "../effect/runtime.js";
import { beginModelReply } from "../models/invocation.js";
import type { Lifecycle } from "../runtime/lifecycle.js";
import type { MindError, MindUnsettledError } from "./agent.js";
import type { MindQuery } from "./contracts.js";
import { dream } from "./dream.js";
import { type AmpInbox, advanceImprovements } from "./improve.js";
import {
  clip,
  mergeProjectedWrite,
  splitFrontmatter,
  withFrontmatter,
} from "./markdown.js";
import {
  isOwnerDm,
  type Place,
  type PlaceKind,
  personId,
  placeId,
  placeOf,
} from "./places.js";
import { type Participant, reflect } from "./reflect.js";
import {
  type Change,
  type MindRemote,
  MindRepo,
  type SyncState,
  safePath,
} from "./repo.js";
import type { MindReport } from "./reports.js";
import { MindSafety } from "./safety.js";
import { SELF_SEEDS } from "./seed.js";
import { localTime } from "./time.js";
import {
  type Entry,
  MindLock,
  MindStateError,
  Transcripts,
} from "./transcripts.js";
import { search, type Viewer, view, visibleList } from "./visibility.js";

export interface MindSettings {
  directory: string;
  reflectIdleMs: number;
  timezone: string;
  /** Local hour when the nightly dream window opens (three hours long). */
  dreamHour: number;
  remote?: MindRemote;
}

export interface MindOptions {
  /** The process runtime every Mind program runs on. */
  effectRuntime: JuneRuntime;
  lifecycle?: Pick<Lifecycle, "tryEnter">;
  deletionRevision?: () => number;
  /** The DEBUGSHARE amp-task inbox; absent disables self-improvement. */
  selfImprovement?: AmpInbox;
  /** Best-effort event admission; the normal conversation outbox owns delivery. */
  notify?: (report: MindReport, contextToken: string) => Promise<void>;
}

/** What a prompt receives: June's self plus notes projected for the place. */
export interface MindRecall {
  notes: string;
  blocked?: string;
  configuration?: {
    remote: boolean;
    selfImprovement: boolean;
    notifications: boolean;
  };
  identity?: string;
  values?: string;
  curiosities?: string;
}

interface DreamState {
  lastAt?: number;
  lastHead?: string;
  fulfilledRequest?: string;
  retryAt?: number;
  night?: string;
  attempts?: number;
}

const SYNC_MS = 5 * 60_000;

const BATCH_ENTRIES = 80;
const BATCH_CHARACTERS = 40_000;
const ENTRY_CHARACTERS = 4_000;
const READ_CHARACTERS = 16_000;

function noteVersion(path: string, text: string | undefined) {
  return createHash("sha256")
    .update(JSON.stringify([path, text ?? null]))
    .digest("hex");
}

function writeTargets(event: MessageEvent) {
  if (event.address.channel !== "slack" || event.senderId.startsWith("bot:"))
    return null;
  const place = placeOf(event);
  return {
    conversation: `conversations/${place.id}.md`,
    person: `people/${personId(event.address.accountId, event.senderId)}.md`,
    privateHeading: `## Private — ${place.id}`,
  };
}

function writableNote(path: string, event: MessageEvent) {
  const targets = writeTargets(event);
  return path === targets?.conversation || path === targets?.person;
}

// Conservative capture exclusions: commands, controls and likely credentials.
const CONTROL = /^(?:##|!|PING(?:MODEL)?\b|CLEARHISTORY\b|DEBUG(?:SHARE)?\b)/;
const SECRET =
  /(?:\b(?:password|passphrase|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|private key)\b\s*[:=]|\b(?:sk-|xox[baprs]-|gh[pousr]_|github_pat_)[\w-]{8,}|https?:\/\/\S*(?:login|token|auth|signin)[?/#=]\S*)/i;

/** Whether an admitted human Slack message should enter June's memory. */
export function capturable(event: MessageEvent) {
  return (
    event.address.channel === "slack" &&
    !event.senderId.startsWith("bot:") &&
    event.text.trim().length > 0 &&
    !CONTROL.test(event.text.trimStart()) &&
    !SECRET.test(event.text)
  );
}

/** Settle a reflection or dream attempt: unknown model settlement still
 * escapes to the pass; every other failure or defect is a failed attempt. */
const attempt = <R>(
  effect: Effect.Effect<void, MindError | MindUnsettledError, R>,
) =>
  effect.pipe(
    Effect.as(false),
    Effect.catch((error) =>
      error._tag === "MindUnsettledError"
        ? Effect.fail(error)
        : Effect.succeed(true),
    ),
    Effect.catchDefect(() => Effect.succeed(true)),
  );

function kindForAddress(address: Address, event: MessageEvent): PlaceKind {
  if (
    address.accountId === event.address.accountId &&
    address.conversationId === event.address.conversationId
  )
    return placeOf(event).kind;
  return address.conversationId.startsWith("D") ? "dm" : "unknown";
}

export interface MindStatus {
  directory: string;
  blocked: string | null;
  remote: {
    url: string;
    sync: SyncState | "not-yet";
    at: string | null;
  } | null;
  dream: {
    last: string | null;
    requested: boolean;
    window: string;
  };
  improvements: Record<string, number>;
  selfImprovement: boolean;
  commits: number;
  lastCommits: { sha: string; date: string; subject: string }[];
  notes: Record<string, number>;
  pendingPlaces: { place: string; unreflectedMessages: number }[];
  reflecting: string | null;
  lastRun: { at: string; outcome: string } | null;
}

/** June's git-backed long-term memory and its background reflection loop.
 * Effect programs inside; Promise methods at the module boundary. */
export class Mind {
  readonly repo: MindRepo;
  private readonly transcripts: Transcripts;
  private readonly lock: MindLock;
  private readonly safety: MindSafety;
  private readonly runtime: JuneRuntime;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private writing: Promise<string> | undefined;
  private reflecting: string | undefined;
  private lastRun: { at: number; outcome: string } | undefined;
  private lastSync: { at: number; state: SyncState } | undefined;
  private readonly controller = new AbortController();

  constructor(
    private readonly settings: MindSettings,
    private readonly owner: Owner,
    private readonly model: ModelProvider,
    private readonly ready: () => boolean,
    private readonly options: MindOptions,
  ) {
    this.runtime = options.effectRuntime;
    this.repo = new MindRepo(settings.directory, settings.remote);
    this.transcripts = new Transcripts(settings.directory, this.runtime);
    this.lock = new MindLock(settings.directory);
    this.safety = new MindSafety(
      this.transcripts,
      options.deletionRevision ?? (() => 0),
    );
  }

  private run<A, E>(effect: Effect.Effect<A, E>) {
    return this.runtime.runPromise(effect);
  }

  /** Run under MindLock; false when another holder has it. */
  private locked<A, E>(
    busy: Effect.Effect<A, E | MindStateError>,
    body: Effect.Effect<A, E | MindError>,
  ) {
    const lock = this.lock;
    return Effect.gen(function* () {
      if (!(yield* lock.acquire())) return yield* busy;
      return yield* body.pipe(
        Effect.ensuring(lock.release().pipe(Effect.orDie)),
      );
    });
  }

  start() {
    return this.run(
      this.locked(
        Effect.fail(new MindStateError({ reason: "mind_busy" })),
        Effect.gen({ self: this }, function* () {
          const fresh = yield* this.transcripts.fresh();
          yield* this.repo.init();
          const empty = fresh
            ? !(yield* this.repo.list()).some((path) => path !== "README.md")
            : false;
          yield* this.safety.load({ fresh: fresh && empty });
          if (!this.safety.readable) return;
          const missing: Change[] = [];
          for (const [path, content] of Object.entries(SELF_SEEDS))
            if ((yield* this.repo.read(path)) === undefined)
              missing.push({ path, content });
          if (missing.length)
            yield* this.repo.commit(missing, "seed(self): who june is today");
        }),
      ).pipe(Effect.withSpan("june.mind.start")),
    );
  }

  /** Call only after host startup/recovery and HTTP readiness. */
  startScheduler() {
    if (this.timer || this.controller.signal.aborted) return;
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref();
  }

  async isSettled() {
    return (
      !this.running &&
      !this.writing &&
      (await this.run(this.safety.isSettled()))
    );
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.running?.catch(() => undefined);
    await this.writing?.catch(() => undefined);
    await this.transcripts.flush();
  }

  private log(event: string, detail: Record<string, unknown> = {}) {
    // Content-free: never log message bodies, notes or model output.
    console.info(JSON.stringify({ event, ...detail }));
  }

  /** Capture an admitted human message. Never throws or blocks the turn. */
  observe(event: MessageEvent) {
    try {
      if (!this.safety.readable || !capturable(event)) return;
      const place = placeOf(event);
      this.transcripts.append(
        {
          id: event.id,
          at: event.occurredAt,
          place: place.id,
          kind: place.kind,
          ...(place.label ? { label: place.label } : {}),
          from: personId(event.address.accountId, event.senderId),
          ...(event.metadata?.senderName
            ? { name: event.metadata.senderName }
            : {}),
          ...(isOwner(event, this.owner) ? { owner: true } : {}),
          ...(event.address.threadId ? { thread: event.address.threadId } : {}),
          text: clip(event.text, ENTRY_CHARACTERS),
        },
        () => this.log("mind_capture_failed"),
      );
    } catch {
      this.log("mind_capture_failed");
    }
  }

  /** Capture a reply the platform accepted. Never throws or blocks delivery. */
  observeReply(
    event: MessageEvent,
    address: Address,
    id: string,
    text: string,
  ) {
    try {
      if (
        !this.safety.readable ||
        address.channel !== "slack" ||
        !text.trim() ||
        SECRET.test(text)
      )
        return;
      const kind = kindForAddress(address, event);
      const label =
        kind === placeOf(event).kind ? event.metadata?.channelName : undefined;
      this.transcripts.append(
        {
          id: `reply:${id}`,
          at: Date.now(),
          place: placeId(address),
          kind,
          ...(label ? { label } : {}),
          from: "june",
          ...(address.threadId ? { thread: address.threadId } : {}),
          text: clip(text, ENTRY_CHARACTERS),
        },
        () => this.log("mind_capture_failed"),
      );
    } catch {
      this.log("mind_capture_failed");
    }
  }

  private viewer(event: MessageEvent): Viewer {
    return { place: placeOf(event), ownerDm: isOwnerDm(event, this.owner) };
  }

  /** June's self and notes for the current turn, projected for its place. */
  recall(event: MessageEvent, people: string[]): Promise<MindRecall> {
    return this.run(this.recallNotes(event, people));
  }

  private readonly recallNotes = Effect.fn("june.mind.recall")(function* (
    this: Mind,
    event: MessageEvent,
    people: string[],
  ) {
    const unavailable = (): MindRecall => ({
      notes: "",
      blocked: this.blocked() ?? "unavailable",
    });
    if (!this.safety.readable) return unavailable();
    const self = {
      identity: yield* this.repo.read("self/identity.md"),
      values: yield* this.repo.read("self/values.md"),
      curiosities: yield* this.repo.read("self/curiosities.md"),
    };
    const recall: MindRecall = {
      notes: "",
      ...(this.blocked() ? { blocked: this.blocked() as string } : {}),
      configuration: {
        remote: !!this.settings.remote,
        selfImprovement: !!this.options.selfImprovement,
        notifications: !!this.options.notify,
      },
      ...(self.identity?.trim()
        ? { identity: clip(self.identity.trim(), 8_000) }
        : {}),
      ...(self.values?.trim()
        ? { values: clip(self.values.trim(), 3_000) }
        : {}),
      ...(self.curiosities?.trim()
        ? { curiosities: clip(self.curiosities.trim(), 2_000) }
        : {}),
    };
    if (event.address.channel !== "slack")
      return this.safety.readable ? recall : unavailable();
    const viewer = this.viewer(event);
    const sections: string[] = [];
    const briefing = yield* view(
      this.repo,
      `conversations/${viewer.place.id}.md`,
      viewer,
    );
    if (briefing)
      sections.push(
        `## This conversation\n${clip(splitFrontmatter(briefing).body, 6_000)}`,
      );
    // The sender first, then the most recent other speakers here.
    const ids = [
      ...new Set([
        personId(event.address.accountId, event.senderId),
        ...[...people].reverse(),
      ]),
    ].slice(0, 5);
    for (const id of ids) {
      const note = yield* view(this.repo, `people/${id}.md`, viewer);
      if (note)
        sections.push(
          `## Person ${id}${id === personId(event.address.accountId, event.senderId) ? " (current sender)" : ""}\n${clip(splitFrontmatter(note).body, 4_000)}`,
        );
    }
    const skills = (yield* visibleList(this.repo, "skills/", viewer)).filter(
      ({ path }) => path.endsWith("/SKILL.md"),
    );
    if (skills.length)
      sections.push(
        `## Your skills (worker reads skills/<name>/SKILL.md before using one)\n${skills
          .slice(0, 60)
          .map(({ path, title }) => `- ${path.split("/")[1]}: ${title}`)
          .join("\n")}`,
      );
    if (viewer.ownerDm) {
      const journals = yield* this.repo.list("self/journal/");
      const latest = journals.at(-1);
      const text = latest ? yield* this.repo.read(latest) : undefined;
      if (latest && text)
        sections.push(
          `## Your latest journal (${latest}; only shown in Raygen's DM)\n${clip(text.slice(-3_000), 3_000)}`,
        );
    }
    recall.notes = sections.join("\n\n");
    return this.safety.readable ? recall : unavailable();
  });

  /** Execution-worker access, scoped to the original authenticated event. */
  query(
    input: MindQuery,
    event: MessageEvent,
    current: () => boolean | Promise<boolean> = () => true,
  ): Promise<string> {
    if (input.action !== "write")
      return this.run(this.answerQuery(input, event));
    if (this.writing)
      return Promise.resolve("Mind write busy; no change made.");
    const release = this.options.lifecycle?.tryEnter();
    if (this.options.lifecycle && !release)
      return Promise.resolve(
        "Mind write blocked by deployment drain; no change made.",
      );
    // Keep admission and the lock through raw Git settlement, even if the
    // worker is cancelled. Its current fence is rechecked before committing.
    this.writing = this.run(
      this.locked(
        Effect.succeed("Mind write busy; no change made."),
        this.writeNote(input, event, current),
      ),
    ).finally(() => {
      this.writing = undefined;
      release?.();
    });
    return this.writing;
  }

  private readonly answerQuery = Effect.fn("june.mind.query")(function* (
    this: Mind,
    input: Exclude<MindQuery, { action: "write" }>,
    event: MessageEvent,
  ) {
    // Recheck after every read as deletion may race any filesystem await.
    const result = yield* this.readQuery(input, event);
    return input.action === "status" || this.safety.readable
      ? result
      : `Mind unavailable: ${this.blocked()}. Retained data is quarantined; request operator reconciliation, never clear the watermark or retry forgotten context.`;
  });

  private readonly readQuery = Effect.fnUntraced(function* (
    this: Mind,
    input: Exclude<MindQuery, { action: "write" }>,
    event: MessageEvent,
  ) {
    const viewer = this.viewer(event);
    if (input.action === "status") {
      const status = yield* this.readStatus();
      const targets = writeTargets(event);
      return JSON.stringify(
        viewer.ownerDm
          ? { ...status, writeTargets: targets }
          : {
              blocked: status.blocked,
              dream: status.dream,
              selfImprovement: status.selfImprovement,
              sync: status.remote?.sync ?? "local-only",
              writeTargets: targets,
            },
      );
    }
    if (!this.safety.readable) return "Mind retained data is quarantined.";
    if (input.action === "dream") {
      if (this.blocked())
        return `Dream blocked: ${this.blocked()}. Check status; a new request cannot clear a safety hold.`;
      // Separate request record prevents an in-flight dream from overwriting
      // a newer request when it records its completion.
      yield* this.transcripts.writeState("dream-request", {
        id: crypto.randomUUID(),
      });
      return "Dream requested. The minute scheduler will pick it up when ready and no reflection or retry backoff is in the way. Check status for blockers and completion; requesting is not proof a dream ran.";
    }
    if (input.action === "log") {
      if (!viewer.ownerDm)
        return "Mind history is only visible in Raygen's DM.";
      const path = input.path ? safePath(input.path) : undefined;
      if (input.path && !path) return "Invalid mind path.";
      return JSON.stringify(yield* this.repo.log(20, path));
    }
    if (input.action === "list")
      return JSON.stringify(yield* visibleList(this.repo, input.path, viewer));
    if (input.action === "search")
      return JSON.stringify(
        yield* search(this.repo, input.query, viewer, input.path),
      );
    const path = safePath(input.path);
    if (!path) return "Invalid mind path.";
    const text = yield* view(this.repo, path, viewer);
    const truncated = (text?.length ?? 0) > READ_CHARACTERS;
    return JSON.stringify({
      path,
      content: text === undefined ? null : clip(text, READ_CHARACTERS),
      version: noteVersion(path, text),
      editable: writableNote(path, event) && !truncated,
      truncated,
      ...(text === undefined
        ? { note: "Missing or not visible from this conversation." }
        : {}),
    });
  });

  private readonly writeNote = Effect.fn("june.mind.write")(function* (
    this: Mind,
    input: Extract<MindQuery, { action: "write" }>,
    event: MessageEvent,
    current: () => boolean | Promise<boolean>,
  ) {
    yield* this.safety.load();
    if (!(yield* Effect.promise(async () => current())) || !this.live())
      return "Mind write blocked or request no longer current; no change made.";
    const path = safePath(input.path);
    if (!path || !writableNote(path, event))
      return "Mind write rejected: only this conversation and the requesting person's note are writable.";
    const body = splitFrontmatter(input.content).body.trim();
    if (!body || SECRET.test(input.content))
      return "Mind write rejected: empty content or likely credentials; no change made.";
    const visible = yield* view(this.repo, path, this.viewer(event));
    if ((visible?.length ?? 0) > READ_CHARACTERS)
      return "Mind write rejected: the read is truncated; no change made.";
    if (noteVersion(path, visible) !== input.expectedVersion)
      return "Mind write conflict: the visible note changed. Read it again and reconsider the edit; no change made.";
    const existing = splitFrontmatter((yield* this.repo.read(path)) ?? "");
    const place = placeOf(event);
    const updated = new Date().toISOString();
    const content = path.startsWith("people/")
      ? withFrontmatter(
          {
            ...existing.meta,
            person: personId(event.address.accountId, event.senderId),
            updated,
          },
          mergeProjectedWrite(existing.body, body, place.id),
        )
      : withFrontmatter(
          {
            ...existing.meta,
            place: place.id,
            kind: place.kind,
            ...(place.label ? { label: place.label } : {}),
            updated,
          },
          body,
        );
    if (!(yield* Effect.promise(async () => current())) || !this.live())
      return "Mind write blocked or request no longer current; no change made.";
    const revision = yield* this.repo.commit(
      [{ path, content }],
      "remember: update a conversation note",
    );
    return JSON.stringify({
      status: revision ? "committed" : "unchanged",
      path,
      revision: revision ?? null,
      sync: this.settings.remote ? "pending-scheduler" : "local-only",
    });
  });

  status(): Promise<MindStatus> {
    return this.run(this.readStatus());
  }

  private readonly readStatus = Effect.fn("june.mind.status")(function* (
    this: Mind,
  ) {
    const cursors = yield* this.transcripts.cursors();
    const pendingPlaces: MindStatus["pendingPlaces"] = [];
    for (const place of yield* this.transcripts.places()) {
      const entries = yield* this.transcripts.read(place);
      const pending = entries.length - (cursors[place]?.offset ?? 0);
      if (pending > 0)
        pendingPlaces.push({ place, unreflectedMessages: pending });
    }
    const notes: Record<string, number> = {};
    for (const path of yield* this.repo.list()) {
      const top = path.split("/")[0] ?? path;
      notes[top] = (notes[top] ?? 0) + 1;
    }
    const improvements: Record<string, number> = {};
    for (const path of yield* this.repo.list("improvements/")) {
      const status =
        splitFrontmatter((yield* this.repo.read(path)) ?? "").meta.status ??
        "unknown";
      improvements[status] = (improvements[status] ?? 0) + 1;
    }
    const dreamState = yield* this.dreamState();
    const request = yield* this.transcripts.readState<{ id: string }>(
      "dream-request",
    );
    const commits = yield* this.repo.commitCount();
    const lastCommits = yield* this.repo.log(5);
    const readable = this.safety.readable;
    const status: MindStatus = {
      directory: this.settings.directory,
      blocked: this.blocked(),
      remote: this.settings.remote
        ? {
            url: this.settings.remote.url,
            sync: this.lastSync?.state ?? "not-yet",
            at: this.lastSync ? new Date(this.lastSync.at).toISOString() : null,
          }
        : null,
      dream: {
        last: dreamState.lastAt
          ? new Date(dreamState.lastAt).toISOString()
          : null,
        requested: !!request && request.id !== dreamState.fulfilledRequest,
        window: `${this.settings.dreamHour}:00–${(this.settings.dreamHour + 3) % 24}:00 ${this.settings.timezone}`,
      },
      improvements: readable ? improvements : {},
      selfImprovement: !!this.options.selfImprovement,
      commits,
      lastCommits: readable ? lastCommits : [],
      notes: readable ? notes : {},
      pendingPlaces: readable ? pendingPlaces : [],
      reflecting: this.reflecting ?? null,
      lastRun: this.lastRun
        ? {
            at: new Date(this.lastRun.at).toISOString(),
            outcome: this.lastRun.outcome,
          }
        : null,
    };
    return status;
  });

  /** Run one scheduler pass now (also used by manual verification). */
  tick(): Promise<void> {
    if (this.running || !this.ready() || this.controller.signal.aborted)
      return this.running ?? Promise.resolve();
    const release = this.options.lifecycle?.tryEnter();
    if (this.options.lifecycle && !release) return Promise.resolve();
    this.running = this.run(this.pass())
      .catch(() => this.log("mind_pass_failed"))
      .finally(() => {
        this.running = undefined;
        release?.();
      });
    return this.running;
  }

  private live() {
    return this.ready() && !this.controller.signal.aborted && !this.blocked();
  }

  private blocked() {
    return this.safety.blocked;
  }

  /** Host ancestry, separate from untrusted report data and archive markers. */
  get contextToken() {
    return `volatile-context:mind:${this.options.deletionRevision?.() ?? 0}`;
  }

  contextCurrent(token: string) {
    return this.safety.readable && token === this.contextToken;
  }

  /** Persist intent before dispatch; only a provider receipt can clear it.
   * A process death between dispatch and receipt therefore never causes replay. */
  private trackedModel(): ModelProvider {
    const beginReply = (...args: Parameters<ModelProvider["reply"]>) => {
      const receipt = Promise.withResolvers<ModelSettlement>();
      const answer = (async () => {
        if (!this.live() || args[1]?.aborted) {
          receipt.resolve("not_started");
          throw new Error("mind_not_current");
        }
        await this.run(this.safety.begin());
        if (!this.live() || args[1]?.aborted) {
          await this.run(this.safety.settle("not_started"));
          receipt.resolve("not_started");
          throw new Error("mind_not_current");
        }
        const invocation = beginModelReply(this.model, ...args);
        const result = await invocation.answer.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        const settlement = await invocation.settlement;
        await this.run(this.safety.settle(settlement));
        receipt.resolve(settlement);
        if ("error" in result) throw result.error;
        return result.value;
      })().catch((error) => {
        // A journal write/receipt failure is not evidence the dispatch stopped.
        receipt.resolve("unknown");
        throw error;
      });
      return { answer, settlement: receipt.promise };
    };
    return { beginReply, reply: (...args) => beginReply(...args).answer };
  }

  private readonly sync = Effect.fn("june.mind.sync")(function* (
    this: Mind,
    force = false,
  ) {
    if (!this.settings.remote) return;
    if (!force && this.lastSync && Date.now() - this.lastSync.at < SYNC_MS)
      return;
    yield* this.safety.syncStarted();
    const state = yield* this.repo.sync(() => this.safety.readable);
    if (state === "synced" || state === "merged" || state === "conflict")
      yield* this.safety.syncFinished(state);
    if (state !== this.lastSync?.state) this.log("mind_sync", { state });
    this.lastSync = { at: Date.now(), state };
  });

  /** Commit, then push so GitHub stays current. */
  private readonly save = Effect.fnUntraced(function* (
    this: Mind,
    changes: Change[],
    subject: string,
    body = "",
  ) {
    if (!this.live()) return undefined;
    const sha = yield* this.repo.commit(changes, subject, body);
    if (sha && this.safety.readable) yield* this.sync(true);
    return sha;
  });

  private readonly notify = Effect.fnUntraced(function* (
    this: Mind,
    notices: MindReport[],
  ) {
    for (const report of notices) {
      if (!this.live()) return;
      const notify = this.options.notify;
      const token = this.contextToken;
      if (notify)
        yield* Effect.promise(() =>
          notify(report, token).catch(() => this.log("mind_notify_failed")),
        );
    }
  });

  private readonly pass = Effect.fn("june.mind.pass")(function* (this: Mind) {
    const body = Effect.gen({ self: this }, function* () {
      yield* this.safety.load();
      if (!this.safety.readable) return;
      yield* this.sync();
      if (!this.live()) return;
      for (const place of yield* this.transcripts.places()) {
        if (!this.live()) return;
        yield* this.reflectPlace(place);
      }
      if (this.live()) yield* this.maybeDream();
      const inbox = this.options.selfImprovement;
      if (this.live() && inbox) {
        const update = yield* advanceImprovements(this.repo, inbox, () =>
          this.live(),
        ).pipe(
          Effect.catchCause(() =>
            Effect.sync(() => {
              this.log("mind_improvements_failed");
              return undefined;
            }),
          ),
        );
        if (update) {
          const sha = yield* this.save(update.changes, update.subject);
          if (sha) yield* this.notify(update.notices);
        }
      }
    }).pipe(
      Effect.catchTag("MindUnsettledError", () =>
        Effect.gen({ self: this }, function* () {
          yield* this.safety.block("model_settlement_unknown");
          this.log("mind_model_settlement_unknown");
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          this.reflecting = undefined;
        }),
      ),
    );
    yield* this.locked(Effect.void, body);
  });

  private dreamState() {
    return this.transcripts
      .readState<DreamState>("dream")
      .pipe(Effect.map((state) => state ?? {}));
  }

  private saveDreamState(state: DreamState) {
    return this.transcripts.writeState("dream", state);
  }

  private readonly maybeDream = Effect.fnUntraced(function* (this: Mind) {
    const now = Date.now();
    const state = yield* this.dreamState();
    const request = yield* this.transcripts.readState<{ id: string }>(
      "dream-request",
    );
    const requested = !!request && request.id !== state.fulfilledRequest;
    const local = localTime(now, this.settings.timezone);
    const inWindow = (local.hour - this.settings.dreamHour + 24) % 24 < 3;
    const head = yield* this.repo.revision();
    if (state.retryAt && state.retryAt > now) return;
    if (!requested) {
      if (!inWindow || head === state.lastHead) return;
      if (state.lastAt && now - state.lastAt < 18 * 3_600_000) return;
      if (state.night === local.date && (state.attempts ?? 0) >= 3) return;
    }
    // Dreams rewrite whole files: start from Raygen's latest edits.
    yield* this.sync(true);
    if (this.lastSync?.state === "conflict") return;
    this.reflecting = "dream";
    const started = Date.now();
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(60 * 60_000),
    ]);
    const current = () => !signal.aborted && this.live();
    let outcome = "unfinished";
    let selfChanged = false;
    const failed = yield* attempt(
      Effect.gen({ self: this }, function* () {
        const result = yield* dream({
          repo: this.repo,
          model: this.trackedModel(),
          now,
          timezone: this.settings.timezone,
          ...(state.lastHead ? { since: state.lastHead } : {}),
          signal,
          current,
          heartbeat: () => this.lock.heartbeat(),
        });
        if (result.outcome === "finished" && current()) {
          const sha = yield* this.save(
            result.changes,
            `dream(${local.date}): ${result.changes.length} notes`,
            result.summary,
          );
          selfChanged = !!sha && result.selfChanged;
          yield* this.saveDreamState({
            lastAt: now,
            lastHead: (yield* this.repo.revision()) ?? head,
            ...(request ? { fulfilledRequest: request.id } : {}),
          });
          outcome = sha ? "committed" : "nothing_to_change";
          if (selfChanged && sha) {
            const diff = yield* this.repo.diff(
              `${sha}~1`,
              ["self/identity.md", "self/values.md"],
              sha,
            );
            yield* this.notify([
              {
                id: `${sha}:self-changed`,
                source: "mind",
                type: "self-changed",
                occurredAt: Date.now(),
                data: {
                  revision: sha,
                  diff: clip(diff, 1_500),
                  truncated: diff.length > 1_500,
                },
              },
            ]);
          }
        }
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          this.reflecting = undefined;
        }),
      ),
    );
    if (failed) outcome = "failed";
    if (outcome === "unfinished" || outcome === "failed") {
      if (!current() && outcome === "unfinished") {
        this.log("mind_dream_interrupted");
        return;
      }
      const attempts =
        state.night === local.date ? (state.attempts ?? 0) + 1 : 1;
      yield* this.saveDreamState({
        ...state,
        ...(request ? { fulfilledRequest: request.id } : {}),
        night: local.date,
        attempts,
        retryAt: now + 30 * 60_000,
      });
    }
    this.lastRun = { at: Date.now(), outcome: `dream ${outcome}` };
    this.log("mind_dream", {
      outcome,
      selfChanged,
      ms: Date.now() - started,
    });
  });

  private readonly reflectPlace = Effect.fnUntraced(function* (
    this: Mind,
    id: string,
  ) {
    const now = Date.now();
    const cursor = (yield* this.transcripts.cursors())[id] ?? {
      offset: 0,
      ids: [],
    };
    if (cursor.retryAt && cursor.retryAt > now) return;
    const entries = yield* this.transcripts.read(id);
    if (entries.length <= cursor.offset) return;
    const seen = new Set(cursor.ids);
    const pending: { entry: Entry; index: number }[] = [];
    for (let index = cursor.offset; index < entries.length; index++) {
      const entry = entries[index] as Entry;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      pending.push({ entry, index });
    }
    const quietFor = now - ((yield* this.transcripts.lastWrite(id)) ?? now);
    if (
      pending.length > 0 &&
      pending.length < BATCH_ENTRIES &&
      quietFor < this.settings.reflectIdleMs
    )
      return;
    const batch: typeof pending = [];
    let characters = 0;
    for (const item of pending) {
      if (
        batch.length >= BATCH_ENTRIES ||
        (batch.length > 0 &&
          characters + item.entry.text.length > BATCH_CHARACTERS)
      )
        break;
      batch.push(item);
      characters += item.entry.text.length;
    }
    const end = batch.at(-1)?.index ?? entries.length - 1;
    const advance = (failures?: number, retryAt?: number) =>
      this.transcripts.saveCursor(id, {
        offset: failures === undefined ? end + 1 : cursor.offset,
        ids:
          failures === undefined
            ? [...cursor.ids, ...batch.map(({ entry }) => entry.id)]
            : cursor.ids,
        ...(failures !== undefined ? { failures, retryAt } : {}),
      });
    const humans = batch.filter(({ entry }) => entry.from !== "june");
    if (humans.length === 0) {
      yield* advance();
      return;
    }
    const latest = batch.at(-1)?.entry as Entry;
    const place: Place = {
      id,
      kind: latest.kind,
      ...(batch.findLast(({ entry }) => entry.label)?.entry.label
        ? { label: batch.findLast(({ entry }) => entry.label)?.entry.label }
        : {}),
    };
    const participants = new Map<string, Participant>();
    for (const { entry } of humans)
      participants.set(entry.from, {
        id: entry.from,
        ...(entry.name ? { name: entry.name } : {}),
        owner: entry.owner === true,
      });
    this.reflecting = id;
    const started = Date.now();
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(20 * 60_000),
    ]);
    const current = () => !signal.aborted && this.live();
    let outcome = "unfinished";
    const failed = yield* attempt(
      Effect.gen({ self: this }, function* () {
        const result = yield* reflect({
          repo: this.repo,
          model: this.trackedModel(),
          place,
          entries: batch.map(({ entry }) => entry),
          participants: [...participants.values()],
          now,
          timezone: this.settings.timezone,
          signal,
          current,
          heartbeat: () => this.lock.heartbeat(),
        });
        if (result.outcome === "finished" && current()) {
          const date = localTime(now, this.settings.timezone).date;
          const sha = yield* this.save(
            result.changes,
            `reflect(${place.label ?? id}): ${date}, ${batch.length} messages`,
            result.summary,
          );
          yield* advance();
          outcome = sha ? "committed" : "nothing_to_save";
        }
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          this.reflecting = undefined;
        }),
      ),
    );
    if (failed) outcome = "failed";
    if (outcome === "unfinished" || outcome === "failed") {
      if (!current() && outcome === "unfinished") {
        // Interrupted by drain/shutdown: retry on a later tick, not a failure.
        this.log("mind_reflection_interrupted", { place: id });
        return;
      }
      const failures = (cursor.failures ?? 0) + 1;
      // A failure must not silently forget this batch. Back off at most 12h.
      yield* advance(
        failures,
        now + Math.min(12 * 3_600_000, 5 * 60_000 * 2 ** Math.min(failures, 8)),
      );
    }
    this.lastRun = { at: Date.now(), outcome };
    this.log("mind_reflection", {
      place: id,
      outcome,
      messages: batch.length,
      ms: Date.now() - started,
    });
  });
}
