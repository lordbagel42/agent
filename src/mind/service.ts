import type {
  Address,
  MessageEvent,
  ModelProvider,
  Owner,
} from "../core/contracts.js";
import { isOwner } from "../core/social.js";
import { MindUnsettledError } from "./agent.js";
import type { MindQuery } from "./contracts.js";
import { dream } from "./dream.js";
import { type AmpInbox, advanceImprovements } from "./improve.js";
import { clip, splitFrontmatter } from "./markdown.js";
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
import { SELF_SEEDS } from "./seed.js";
import { localTime } from "./time.js";
import { type Entry, MindLock, Transcripts } from "./transcripts.js";
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
  /** The DEBUGSHARE amp-task inbox; absent disables self-improvement. */
  selfImprovement?: AmpInbox;
  /** Best-effort DM to Raygen; failures are logged, never retried. */
  notify?: (text: string) => Promise<void>;
}

/** What a prompt receives: June's self plus notes projected for the place. */
export interface MindRecall {
  notes: string;
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

/** June's git-backed long-term memory and its background reflection loop. */
export class Mind {
  readonly repo: MindRepo;
  private readonly transcripts: Transcripts;
  private readonly lock: MindLock;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private reflecting: string | undefined;
  private lastRun: { at: number; outcome: string } | undefined;
  private lastSync: { at: number; state: SyncState } | undefined;
  private readonly controller = new AbortController();

  constructor(
    private readonly settings: MindSettings,
    private readonly owner: Owner,
    private readonly model: ModelProvider,
    private readonly ready: () => boolean,
    private readonly options: MindOptions = {},
  ) {
    this.repo = new MindRepo(settings.directory, settings.remote);
    this.transcripts = new Transcripts(settings.directory);
    this.lock = new MindLock(settings.directory);
  }

  async start() {
    if (!(await this.lock.acquire())) throw new Error("mind_busy");
    try {
      await this.repo.init();
      const missing: Change[] = [];
      for (const [path, content] of Object.entries(SELF_SEEDS))
        if ((await this.repo.read(path)) === undefined)
          missing.push({ path, content });
      if (missing.length)
        await this.repo.commit(missing, "seed(self): who june is today");
    } finally {
      await this.lock.release();
    }
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref();
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.running?.catch(() => undefined);
    await this.transcripts.flush();
  }

  private log(event: string, detail: Record<string, unknown> = {}) {
    // Content-free: never log message bodies, notes or model output.
    console.info(JSON.stringify({ event, ...detail }));
  }

  /** Capture an admitted human message. Never throws or blocks the turn. */
  observe(event: MessageEvent) {
    try {
      if (!capturable(event)) return;
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
      if (address.channel !== "slack" || !text.trim() || SECRET.test(text))
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
  async recall(event: MessageEvent, people: string[]): Promise<MindRecall> {
    const self = {
      identity: await this.repo.read("self/identity.md"),
      values: await this.repo.read("self/values.md"),
      curiosities: await this.repo.read("self/curiosities.md"),
    };
    const recall: MindRecall = {
      notes: "",
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
    if (event.address.channel !== "slack") return recall;
    const viewer = this.viewer(event);
    const sections: string[] = [];
    const briefing = await view(
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
      const note = await view(this.repo, `people/${id}.md`, viewer);
      if (note)
        sections.push(
          `## Person ${id}${id === personId(event.address.accountId, event.senderId) ? " (current sender)" : ""}\n${clip(splitFrontmatter(note).body, 4_000)}`,
        );
    }
    const skills = (await visibleList(this.repo, "skills/", viewer)).filter(
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
      const journals = await this.repo.list("self/journal/");
      const latest = journals.at(-1);
      const text = latest ? await this.repo.read(latest) : undefined;
      if (latest && text)
        sections.push(
          `## Your latest journal (${latest}; only shown in Raygen's DM)\n${clip(text.slice(-3_000), 3_000)}`,
        );
    }
    recall.notes = sections.join("\n\n");
    return recall;
  }

  /** Execution-worker read access, projected for the worker's origin. */
  async query(input: MindQuery, event: MessageEvent): Promise<string> {
    const viewer = this.viewer(event);
    if (input.action === "status") {
      const status = await this.status();
      return JSON.stringify(
        viewer.ownerDm
          ? status
          : {
              blocked: status.blocked,
              dream: status.dream,
              selfImprovement: status.selfImprovement,
              sync: status.remote?.sync ?? "local-only",
            },
      );
    }
    if (input.action === "dream") {
      // Separate request record prevents an in-flight dream from overwriting
      // a newer request when it records its completion.
      await this.transcripts.writeState("dream-request", {
        id: crypto.randomUUID(),
      });
      return "Dream requested. The minute scheduler will pick it up when ready and no reflection or retry backoff is in the way. Check status for blockers and completion; requesting is not proof a dream ran.";
    }
    if (input.action === "log") {
      if (!viewer.ownerDm)
        return "Mind history is only visible in Raygen's DM.";
      const path = input.path ? safePath(input.path) : undefined;
      if (input.path && !path) return "Invalid mind path.";
      return JSON.stringify(await this.repo.log(20, path));
    }
    if (input.action === "list")
      return JSON.stringify(await visibleList(this.repo, input.path, viewer));
    if (input.action === "search")
      return JSON.stringify(
        await search(this.repo, input.query, viewer, input.path),
      );
    const path = safePath(input.path);
    if (!path) return "Invalid mind path.";
    const text = await view(this.repo, path, viewer);
    return text === undefined
      ? `${path} does not exist or is not visible from this conversation.`
      : clip(text, 16_000);
  }

  async status(): Promise<MindStatus> {
    const cursors = await this.transcripts.cursors();
    const pendingPlaces: MindStatus["pendingPlaces"] = [];
    for (const place of await this.transcripts.places()) {
      const entries = await this.transcripts.read(place);
      const pending = entries.length - (cursors[place]?.offset ?? 0);
      if (pending > 0)
        pendingPlaces.push({ place, unreflectedMessages: pending });
    }
    const notes: Record<string, number> = {};
    for (const path of await this.repo.list()) {
      const top = path.split("/")[0] ?? path;
      notes[top] = (notes[top] ?? 0) + 1;
    }
    const improvements: Record<string, number> = {};
    for (const path of await this.repo.list("improvements/")) {
      const status =
        splitFrontmatter((await this.repo.read(path)) ?? "").meta.status ??
        "unknown";
      improvements[status] = (improvements[status] ?? 0) + 1;
    }
    const dreamState = await this.dreamState();
    const request = await this.transcripts.readState<{ id: string }>(
      "dream-request",
    );
    return {
      directory: this.settings.directory,
      blocked:
        (await this.transcripts.readState<{ reason: string }>("blocked"))
          ?.reason ?? null,
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
      improvements,
      selfImprovement: !!this.options.selfImprovement,
      commits: await this.repo.commitCount(),
      lastCommits: await this.repo.log(5),
      notes,
      pendingPlaces,
      reflecting: this.reflecting ?? null,
      lastRun: this.lastRun
        ? {
            at: new Date(this.lastRun.at).toISOString(),
            outcome: this.lastRun.outcome,
          }
        : null,
    };
  }

  /** Run one scheduler pass now (also used by manual verification). */
  tick(): Promise<void> {
    if (this.running || !this.ready() || this.controller.signal.aborted)
      return this.running ?? Promise.resolve();
    this.running = this.pass()
      .catch(() => this.log("mind_pass_failed"))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private live() {
    return this.ready() && !this.controller.signal.aborted;
  }

  private async sync(force = false) {
    if (!this.settings.remote) return;
    if (!force && this.lastSync && Date.now() - this.lastSync.at < SYNC_MS)
      return;
    const state = await this.repo.sync();
    if (state !== this.lastSync?.state) this.log("mind_sync", { state });
    this.lastSync = { at: Date.now(), state };
  }

  /** Commit, then push so GitHub stays current. */
  private async save(changes: Change[], subject: string, body = "") {
    const sha = await this.repo.commit(changes, subject, body);
    if (sha) await this.sync(true);
    return sha;
  }

  private async notify(notices: string[]) {
    for (const text of notices)
      await this.options
        .notify?.(text)
        .catch(() => this.log("mind_notify_failed"));
  }

  private async pass() {
    if (!(await this.lock.acquire())) return;
    try {
      await this.sync();
      if (
        this.lastSync?.state === "conflict" ||
        (await this.transcripts.readState("blocked"))
      )
        return;
      for (const place of await this.transcripts.places()) {
        if (!this.live()) return;
        await this.reflectPlace(place);
      }
      if (this.live()) await this.maybeDream();
      if (this.live() && this.options.selfImprovement) {
        const update = await advanceImprovements(
          this.repo,
          this.options.selfImprovement,
          () => this.live(),
        ).catch(() => {
          this.log("mind_improvements_failed");
          return undefined;
        });
        if (update) {
          await this.save(update.changes, update.subject);
          await this.notify(update.notices);
        }
      }
    } catch (error) {
      if (error instanceof MindUnsettledError) {
        await this.transcripts.writeState("blocked", {
          reason: "model_settlement_unknown",
          at: new Date().toISOString(),
        });
        this.log("mind_model_settlement_unknown");
      } else throw error;
    } finally {
      this.reflecting = undefined;
      await this.lock.release();
    }
  }

  private async dreamState(): Promise<DreamState> {
    return (await this.transcripts.readState<DreamState>("dream")) ?? {};
  }

  private saveDreamState(state: DreamState) {
    return this.transcripts.writeState("dream", state);
  }

  private async maybeDream() {
    const now = Date.now();
    const state = await this.dreamState();
    const request = await this.transcripts.readState<{ id: string }>(
      "dream-request",
    );
    const requested = !!request && request.id !== state.fulfilledRequest;
    const local = localTime(now, this.settings.timezone);
    const inWindow = (local.hour - this.settings.dreamHour + 24) % 24 < 3;
    const head = await this.repo.revision();
    if (state.retryAt && state.retryAt > now) return;
    if (!requested) {
      if (!inWindow || head === state.lastHead) return;
      if (state.lastAt && now - state.lastAt < 18 * 3_600_000) return;
      if (state.night === local.date && (state.attempts ?? 0) >= 3) return;
    }
    // Dreams rewrite whole files: start from Raygen's latest edits.
    await this.sync(true);
    if (this.lastSync?.state === "conflict") return;
    this.reflecting = "dream";
    const started = Date.now();
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(60 * 60_000),
    ]);
    const current = () => !signal.aborted && this.ready();
    let outcome = "unfinished";
    let selfChanged = false;
    try {
      const result = await dream({
        repo: this.repo,
        model: this.model,
        now,
        timezone: this.settings.timezone,
        ...(state.lastHead ? { since: state.lastHead } : {}),
        signal,
        current,
        heartbeat: () => this.lock.heartbeat(),
      });
      if (result.outcome === "finished" && current()) {
        const sha = await this.save(
          result.changes,
          `dream(${local.date}): ${result.changes.length} notes`,
          result.summary,
        );
        selfChanged = !!sha && result.selfChanged;
        await this.saveDreamState({
          lastAt: now,
          lastHead: (await this.repo.revision()) ?? head,
          ...(request ? { fulfilledRequest: request.id } : {}),
        });
        outcome = sha ? "committed" : "nothing_to_change";
        if (selfChanged && sha)
          await this.notify([
            `i revised how i see myself. here's the diff to my identity and values (commit ${sha.slice(0, 7)}):\n\n${clip(await this.repo.diff(`${sha}~1`, ["self/identity.md", "self/values.md"], sha), 3_000)}`,
          ]);
      }
    } catch (error) {
      if (error instanceof MindUnsettledError) throw error;
      outcome = "failed";
    } finally {
      this.reflecting = undefined;
    }
    if (outcome === "unfinished" || outcome === "failed") {
      if (!current() && outcome === "unfinished") {
        this.log("mind_dream_interrupted");
        return;
      }
      const attempts =
        state.night === local.date ? (state.attempts ?? 0) + 1 : 1;
      await this.saveDreamState({
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
  }

  private async reflectPlace(id: string) {
    const now = Date.now();
    const cursor = (await this.transcripts.cursors())[id] ?? {
      offset: 0,
      ids: [],
    };
    if (cursor.retryAt && cursor.retryAt > now) return;
    const entries = await this.transcripts.read(id);
    if (entries.length <= cursor.offset) return;
    const seen = new Set(cursor.ids);
    const pending: { entry: Entry; index: number }[] = [];
    for (let index = cursor.offset; index < entries.length; index++) {
      const entry = entries[index] as Entry;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      pending.push({ entry, index });
    }
    const quietFor = now - ((await this.transcripts.lastWrite(id)) ?? now);
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
      await advance();
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
    const current = () => !signal.aborted && this.ready();
    let outcome = "unfinished";
    try {
      const result = await reflect({
        repo: this.repo,
        model: this.model,
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
        const sha = await this.save(
          result.changes,
          `reflect(${place.label ?? id}): ${date}, ${batch.length} messages`,
          result.summary,
        );
        await advance();
        outcome = sha ? "committed" : "nothing_to_save";
      }
    } catch (error) {
      if (error instanceof MindUnsettledError) throw error;
      outcome = "failed";
    } finally {
      this.reflecting = undefined;
    }
    if (outcome === "unfinished" || outcome === "failed") {
      if (!current() && outcome === "unfinished") {
        // Interrupted by drain/shutdown: retry on a later tick, not a failure.
        this.log("mind_reflection_interrupted", { place: id });
        return;
      }
      const failures = (cursor.failures ?? 0) + 1;
      // A failure must not silently forget this batch. Back off at most 12h.
      await advance(
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
  }
}
