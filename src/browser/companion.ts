import { createHash, randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  MessageEvent,
  ModelImageInput,
  Owner,
} from "../core/contracts.js";
import { isOwner } from "../core/social.js";
import { deleteBrowserThread, runBrowserTurn } from "./codex.js";
import { type BrowserCommand, browserCommandSchema } from "./contracts.js";
import { type BrowserSession, createBrowserSession } from "./session.js";

interface Task {
  id: string;
  operation: string;
  address: MessageEvent["address"];
  status:
    | "running"
    | "waiting_for_input"
    | "completed"
    | "cancelled"
    | "expired"
    | "needs_review";
  goal: string;
  url: string;
  expiresAt: number;
  revision: number;
  threadId?: string;
  report?: string;
  reconciled?: boolean;
}
interface Live {
  session: BrowserSession;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  busy: boolean;
  pin?: Buffer;
  images: ModelImageInput[];
  operation?: Promise<Task["status"]>;
  terminal?: Task["status"];
  cleanup?: Promise<void>;
}
interface Options {
  directory: string;
  home: string;
  tempDirectory: string;
  codexHome: string;
  navigationOrigins: string[];
  resourceOrigins: string[];
  owner: Owner;
  origin?: string;
  revision?: () => number;
  createSession?: typeof createBrowserSession;
  runTurn?: typeof runBrowserTurn;
  deleteThread?: typeof deleteBrowserThread;
}
interface Context {
  event: MessageEvent;
  operationId: string;
  signal: AbortSignal;
  valid(): boolean;
  review(
    report: string,
    images: ModelImageInput[],
    signal: AbortSignal,
  ): Promise<string>;
}

/** Execution actors own orchestration/notification. This ledger owns browser
 * receipts and live-resource handles, like the existing capability broker.
 * No secret is accepted through an actor action or persisted queue. */
export class BrowserCompanion {
  private readonly db: DatabaseSync;
  private readonly live = new Map<string, Live>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly launches = new Map<
    string,
    { controller: AbortController; operation: Promise<BrowserSession> }
  >();
  private readonly maintenance: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private readonly options: Options) {
    const path = join(options.directory, "browser.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, operation TEXT UNIQUE NOT NULL, value TEXT NOT NULL)",
    );
    this.db.exec(
      "PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS pin_receipts (challenge TEXT PRIMARY KEY, message TEXT UNIQUE NOT NULL)",
    );
    // Never reconstruct a browser, replay a submission, or reuse orphaned cookies.
    for (const task of this.list()) {
      if (task.status === "running" || task.status === "waiting_for_input") {
        task.status = "needs_review";
        task.goal = "";
        task.url = "";
        task.report = "Browser session was lost; no operation was replayed.";
        this.save(task);
      }
    }
    this.maintenance = setInterval(() => {
      for (const task of this.list()) {
        if (
          task.expiresAt <= Date.now() ||
          task.revision !== (this.options.revision?.() ?? 0)
        ) {
          task.goal = "";
          task.url = "";
          task.report = "Browser evidence expired or was revoked.";
          this.save(task);
          if (this.live.has(task.id) || this.launches.has(task.id))
            void this.stop(task, "expired").catch(() => {});
        }
      }
    }, 1000);
    this.maintenance.unref();
  }
  private save(task: Task) {
    this.db
      .prepare(
        "INSERT INTO tasks VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(task.id, task.operation, JSON.stringify(task));
  }
  private get(id: string): Task | undefined {
    const row = this.db.prepare("SELECT value FROM tasks WHERE id=?").get(id);
    return row ? (JSON.parse(String(row.value)) as Task) : undefined;
  }
  list(): Task[] {
    return this.db
      .prepare("SELECT value FROM tasks")
      .all()
      .map((row) => JSON.parse(String(row.value)) as Task);
  }
  private sameAddress(a: MessageEvent["address"], b: MessageEvent["address"]) {
    return (
      a.channel === b.channel &&
      a.accountId === b.accountId &&
      a.conversationId === b.conversationId &&
      a.threadId === b.threadId
    );
  }
  private authorized(event: MessageEvent) {
    return (
      isOwner(event, this.options.owner) &&
      event.direct &&
      (event.address.channel !== "slack" ||
        event.metadata?.channelType === undefined ||
        event.metadata.channelType === "im")
    );
  }
  session(id: string, principal: string): BrowserSession | undefined {
    if (this.closed) return undefined;
    const task = this.get(id);
    return !this.closed &&
      principal === this.options.owner.id &&
      task &&
      task.revision === (this.options.revision?.() ?? 0) &&
      task.expiresAt > Date.now()
      ? this.live.get(id)?.session
      : undefined;
  }
  status(id: string, principal: string) {
    if (principal !== this.options.owner.id || this.closed) return undefined;
    const task = this.get(id);
    return task ? this.view(task) : undefined;
  }
  private view(task: Task) {
    if (
      task.revision !== (this.options.revision?.() ?? 0) ||
      task.expiresAt <= Date.now()
    )
      return {
        id: task.id,
        status: "needs_review" as const,
        report: "Browser evidence was revoked.",
        liveView: { available: false as const, reason: "Evidence revoked" },
      };
    const live = this.live.get(task.id);
    const pending = live?.session.pendingInput();
    return {
      id: task.id,
      status: task.status,
      report: task.report,
      ...(pending
        ? {
            question: `${pending.question} Reply with !browser-pin ${task.id} ${pending.challengeId} <PIN>. This authorizes the single login submission to ${pending.origin}; the chat platform may retain your reply.`,
          }
        : {}),
      liveView: this.options.origin
        ? {
            available: true as const,
            url: `${this.options.origin}/console/browser/${task.id}`,
            state: live?.session.state ?? "ended",
            expiresAt: task.expiresAt,
            generation: live?.session.generation ?? null,
          }
        : {
            available: false as const,
            reason: "Private console hosting unavailable",
          },
    };
  }
  /** Call before ALL memory/conversation ingestion. Always redact a recognized
   * owner command, including duplicates and stale tasks, not just accepted PINs. */
  consumePin(event: MessageEvent): MessageEvent | undefined {
    if (!/!browser-pin\b/i.test(event.text)) return undefined;
    const match =
      /^!browser-pin ([\da-f-]{36}) ([\da-f-]{36}) (\d{1,32})$/.exec(
        event.text,
      );
    const task = match?.[1] ? this.get(match[1]) : undefined;
    const live = task ? this.live.get(task.id) : undefined;
    let accepted =
      !this.closed &&
      this.authorized(event) &&
      event.browserPinEligible === true &&
      !!match &&
      !!task &&
      !!live &&
      !live.busy &&
      !live.pin &&
      task.status === "waiting_for_input" &&
      task.revision === (this.options.revision?.() ?? 0) &&
      task.expiresAt > Date.now() &&
      this.sameAddress(task.address, event.address) &&
      live.session.pendingInput()?.challengeId === match[2];
    if (accepted && match?.[2]) {
      // Commit nonsecret receipts before buffering any secret. Redelivery must
      // not authorize a second attempt, even if the page issues a new challenge.
      const message = createHash("sha256")
        .update(JSON.stringify([event.address, event.id, event.messageId]))
        .digest("hex");
      accepted =
        this.db
          .prepare("INSERT OR IGNORE INTO pin_receipts VALUES (?, ?)")
          .run(match[2], message).changes === 1;
    }
    if (accepted && live && match?.[3]) live.pin = Buffer.from(match[3]);
    return {
      ...event,
      text:
        accepted && task
          ? `Host browser PIN reply accepted for task ${task.id}. The secret was removed before history. Resume this existing task with browserTask status; do not start another browser.`
          : "Host browser PIN reply was not accepted (stale, duplicate, invalid, or wrong conversation). Its contents were removed before history. Inspect the existing task; do not replay a login.",
    };
  }
  private async stop(task: Task, status: Task["status"]) {
    const launch = this.launches.get(task.id);
    if (launch) {
      task.status = status;
      this.save(task);
      launch.controller.abort();
      await launch.operation.catch(() => undefined);
    }
    const live = this.live.get(task.id);
    if (live) {
      live.terminal ??= status;
      live.pin?.fill(0);
      delete live.pin;
      clearTimeout(live.timer);
      live.controller.abort();
      await live.operation?.catch(() => undefined);
      if (live.cleanup) return live.cleanup;
    }
    const cleanup = async () => {
      task = this.get(task.id) ?? task;
      task.status = "needs_review";
      task.goal = "";
      task.url = "";
      if ((live?.terminal ?? status) !== "completed")
        task.report = "Browser stopped; no automatic replay was attempted.";
      this.save(task);
      try {
        await live?.session.close();
        if (live) live.images = [];
        if (task.threadId) {
          await (this.options.deleteThread ?? deleteBrowserThread)({
            home: this.options.codexHome,
            cwd: this.options.tempDirectory,
            threadId: task.threadId,
            signal: AbortSignal.timeout(30_000),
          });
          delete task.threadId;
        }
        this.live.delete(task.id);
        task.status = live?.terminal ?? status;
        this.save(task);
      } catch {
        task.report =
          "Browser cleanup is uncertain; no replacement was launched.";
        this.save(task);
      }
    };
    const operation = cleanup();
    if (live) live.cleanup = operation;
    await operation;
  }
  /** Bearer-only operator route, never a model action. The operator must first
   * verify the orphaned browser/Codex processes have stopped. No task is replayed. */
  async reconcile(id: string, confirmedStopped: boolean) {
    const task = this.get(id);
    if (
      !confirmedStopped ||
      !task ||
      task.status !== "needs_review" ||
      this.active.size ||
      this.launches.size
    )
      return false;
    const live = this.live.get(id);
    if (live) delete live.cleanup;
    await this.stop(task, "needs_review");
    const saved = this.get(id);
    if (!saved || this.live.has(id) || saved.threadId) return false;
    saved.reconciled = true;
    this.save(saved);
    return true;
  }
  isSettled() {
    return (
      this.live.size === 0 && this.active.size === 0 && this.launches.size === 0
    );
  }
  async run(raw: BrowserCommand, context: Context) {
    const operation = this.execute(raw, context);
    this.active.add(operation);
    try {
      return await operation;
    } finally {
      this.active.delete(operation);
    }
  }
  private async execute(raw: BrowserCommand, context: Context) {
    const command = browserCommandSchema.parse(raw);
    let task: Task | undefined;
    const usable = () =>
      !this.closed &&
      !context.signal.aborted &&
      context.valid() &&
      (!task ||
        (task.expiresAt > Date.now() &&
          task.revision === (this.options.revision?.() ?? 0))) &&
      this.authorized(context.event);
    if (!usable()) throw new Error("Browser request unavailable");
    if (command.action === "start") {
      if (!this.options.navigationOrigins.includes(new URL(command.url).origin))
        throw new Error("Browser origin not configured");
      const operation = createHash("sha256")
        .update(JSON.stringify([context.event.address, context.operationId]))
        .digest("hex");
      const existing = this.db
        .prepare("SELECT value FROM tasks WHERE operation=?")
        .get(operation);
      if (existing)
        return this.view(JSON.parse(String(existing.value)) as Task);
      if (
        this.live.size > 0 ||
        this.active.size > 0 ||
        this.launches.size > 0 ||
        this.list().some(
          (entry) =>
            !entry.reconciled &&
            ["running", "waiting_for_input", "needs_review"].includes(
              entry.status,
            ),
        )
      )
        throw new Error(
          "Existing browser work must settle or be reconciled by the operator first",
        );
      task = {
        id: randomUUID(),
        operation,
        address: context.event.address,
        url: command.url,
        goal: command.goal,
        status: "running",
        expiresAt: Date.now() + 60 * 60_000,
        revision: this.options.revision?.() ?? 0,
      };
      this.save(task); // unknown marker before launching anything
      const controller = new AbortController();
      const abort = () => controller.abort();
      context.signal.addEventListener("abort", abort, { once: true });
      try {
        const operation = (this.options.createSession ?? createBrowserSession)({
          url: task.url,
          navigationOrigins: this.options.navigationOrigins,
          resourceOrigins: this.options.resourceOrigins,
          home: this.options.home,
          tempDirectory: this.options.tempDirectory,
          signal: controller.signal,
        });
        this.launches.set(task.id, { controller, operation });
        const session = await operation;
        if (
          !usable() ||
          controller.signal.aborted ||
          this.get(task.id)?.status !== "running"
        ) {
          controller.abort();
          await session.close();
          throw new Error("Browser launch revoked");
        }
        const id = task.id;
        const timer = setTimeout(() => {
          const saved = this.get(id);
          if (saved) void this.stop(saved, "expired").catch(() => {});
        }, 60 * 60_000);
        timer.unref();
        this.live.set(id, {
          session,
          controller,
          timer,
          busy: false,
          images: [],
        });
      } catch {
        task.status = "needs_review";
        task.report = "Browser launch unavailable; no automatic retry.";
        this.save(task);
        return this.view(task);
      } finally {
        this.launches.delete(task.id);
        context.signal.removeEventListener("abort", abort);
      }
    } else {
      task = this.get(command.taskId);
      if (!task || !this.sameAddress(task.address, context.event.address))
        throw new Error("Browser task unavailable");
      if (command.action === "cancel") {
        if (task.status === "needs_review" && !this.live.has(task.id))
          return this.view(task);
        if (["completed", "cancelled", "expired"].includes(task.status))
          return this.view(task);
        await this.stop(task, "cancelled");
        return this.view(this.get(task.id) ?? task);
      }
      if (!this.live.get(task.id)?.pin) return this.view(task);
    }
    const live = this.live.get(task.id);
    if (!live || live.busy || !usable()) return this.view(task);
    live.busy = true;
    live.operation = this.perform(task, live, context, usable);
    let status: Task["status"];
    try {
      status = await live.operation;
    } catch {
      status = "needs_review";
    }
    live.busy = false;
    if (status !== "waiting_for_input" || live.terminal)
      await this.stop(task, status);
    return this.view(this.get(task.id) ?? task);
  }
  private async perform(
    task: Task,
    live: Live,
    context: Context,
    usable: () => boolean,
  ): Promise<Task["status"]> {
    const abort = () => live.controller.abort();
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      task.status = "running";
      this.save(task);
      if (live.pin) {
        const pin = live.pin;
        delete live.pin;
        try {
          await live.session.enterPin(
            pin.toString(),
            () => usable() && !live.controller.signal.aborted,
          );
        } finally {
          pin.fill(0);
        }
      }
      if (!usable() || live.controller.signal.aborted)
        throw new Error("Browser revoked");
      const result = await (this.options.runTurn ?? runBrowserTurn)({
        home: this.options.codexHome,
        cwd: this.options.tempDirectory,
        goal: `${task.goal}\nStart URL: ${task.url}. Inspect with observe first. Review video using discover_media and video_frame at multiple timestamps, at most eight evidence images.`,
        threadId: task.threadId,
        signal: live.controller.signal,
        valid: usable,
        onThread: async (id) => {
          task.threadId = id;
          this.save(task);
        },
        tool: async (name, args) => {
          if (!usable() || live.controller.signal.aborted)
            throw new Error("Browser revoked");
          const observation = await live.session.tool(name, args);
          if (!usable() || live.controller.signal.aborted)
            throw new Error("Browser revoked");
          if (name === "request_pin" && !live.session.pendingInput())
            throw new Error("PIN form is unsupported");
          if (observation.image && name !== "request_pin") {
            if (live.images.length === 8) live.images.shift();
            let mediaTimeSeconds: number | undefined;
            try {
              mediaTimeSeconds = (
                JSON.parse(observation.text) as { timeSeconds?: number }
              ).timeSeconds;
            } catch {
              /* page text */
            }
            live.images.push({
              evidenceId: randomUUID(),
              ...observation.image,
              mediaTimeSeconds,
            });
          }
          return observation;
        },
      });
      if (!usable() || live.controller.signal.aborted)
        throw new Error("Browser revoked");
      if (result.waitingForInput && live.session.pendingInput()) {
        task.status = "waiting_for_input";
        task.expiresAt = Math.min(task.expiresAt, Date.now() + 30 * 60_000);
        clearTimeout(live.timer);
        const id = task.id;
        live.timer = setTimeout(() => {
          const saved = this.get(id);
          if (saved) void this.stop(saved, "expired").catch(() => {});
        }, task.expiresAt - Date.now());
        live.timer.unref();
        this.save(task);
      } else {
        task.report = live.images.length
          ? (
              await context.review(
                result.report,
                live.images,
                AbortSignal.any([context.signal, live.controller.signal]),
              )
            ).slice(0, 16000)
          : "No visual evidence was captured. I cannot claim to have reviewed the page or video.";
        if (!usable() || live.controller.signal.aborted)
          throw new Error("Browser revoked");
        live.images = [];
        task.status = "completed";
        this.save(task);
      }
      return task.status;
    } finally {
      context.signal.removeEventListener("abort", abort);
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.maintenance);
    for (const task of this.list())
      if (this.live.has(task.id) || this.launches.has(task.id))
        await this.stop(task, "needs_review");
    await Promise.allSettled([...this.active]);
    this.db.close();
  }
}
