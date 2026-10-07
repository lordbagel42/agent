import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { GitHubIssue, IssueGitHub } from "./github-issues.js";
import type { DiagnosticStore } from "./store.js";

const number = z.number().int().positive().safe();
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const source = z
  .string()
  .regex(
    /^(debug:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|recovery:[1-9][0-9]{0,18})$/,
  );
const thread = z
  .string()
  .regex(/^T-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const commentFields = {
  number,
  key: z.uuid(),
  threadId: thread.optional(),
  body: z
    .string()
    .trim()
    .min(1)
    .max(12000)
    .refine((text) => !text.includes("\0")),
};
export const issueActions = {
  track: z.strictObject({
    action: z.literal("track"),
    source,
    snapshotOnly: z.boolean().optional(),
    revision: sha.optional(),
  }),
  inspect: z.strictObject({
    action: z.literal("inspect"),
    number: number.optional(),
    source: source.optional(),
  }),
  comment: z.strictObject({ action: z.literal("comment"), ...commentFields }),
  complete: z.strictObject({
    action: z.literal("complete"),
    ...commentFields,
    commit: sha,
  }),
};
export const issueActionSchema = z.discriminatedUnion("action", [
  issueActions.track,
  issueActions.inspect,
  issueActions.comment,
  issueActions.complete,
]);
export type IssueAction = z.infer<typeof issueActionSchema>;
export const issueReceiptSchema = z.strictObject({
  claimId: z.uuid(),
  phase: z.enum(["running", "returned", "unknown"]),
  threadId: thread.optional(),
});
const sourcePhases = [
  "unavailable",
  "queued",
  "running",
  "unknown",
  "returned",
] as const;
export const issueSourceSchema = z.strictObject({
  source,
  phase: z.enum(sourcePhases),
  threadId: thread.optional(),
  revision: sha.optional(),
});
export const issueReconciliationSchema = z.strictObject({
  claimId: z.uuid(),
  resolution: z.enum(["no_launch", "settled"]),
  evidence: z.string().trim().min(1).max(1000),
  threadId: thread.optional(),
});

interface SourceRecord {
  source: string;
  status: "pending" | "unknown" | "linked";
  marker: string;
  requestedAt: number;
  creatorId?: number;
  snapshotOnly: boolean;
  phase?: (typeof sourcePhases)[number];
  threadId?: string;
  revision?: string;
  number?: number;
  url?: string;
}
interface Job {
  phase:
    | "pending"
    | "claimed"
    | "running"
    | "returned"
    | "unknown"
    | "skipped"
    | "reconciled";
  ownerRequest: boolean;
  claimId?: string;
  threadId?: string;
  reconciliation?: z.infer<typeof issueReconciliationSchema> & { at: number };
}
interface IssueRecord extends GitHubIssue {
  sources: string[];
  captureOnly: boolean;
  observedAt: number;
  phase?: SourceRecord["phase"];
  threadId?: string;
  commit?: string;
  job?: Job;
}
interface Settings {
  enabledAt: number;
  cursor: string;
  checkedAt?: number;
  error?: "github_unavailable";
}
interface Effect {
  input: Extract<IssueAction, { action: "comment" | "complete" }>;
  marker: string;
  phase: "commenting" | "commented" | "closing" | "done";
  commentId?: number;
}
export interface IssueIndex {
  enabled: boolean;
  checkedAt?: number;
  error?: string;
  items: Omit<IssueRecord, "body" | "authorId">[];
  total: number;
  pending: Pick<SourceRecord, "source" | "status">[];
}

/** The independent debug site owns this issue journal. GitHub owns issue state.
 * Every remote write has a durable intent; unknown POSTs only reconcile by reads.
 * Serialized transitions cover async network gaps without holding SQLite locks.
 */
export class IssueTracker {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly options: {
      store: DiagnosticStore;
      github: IssueGitHub;
      origin: string;
      creatorId: number;
      now?: () => number;
    },
  ) {
    number.parse(options.creatorId);
    this.now = options.now ?? Date.now;
    if (!options.store.issueRecord<Settings>("settings"))
      options.store.saveIssueRecord("settings", {
        // GitHub issue creation timestamps have whole-second precision.
        enabledAt: Math.floor(this.now() / 1000) * 1000,
        cursor: new Date(this.now()).toISOString(),
      } satisfies Settings);
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run);
    this.tail = result.catch(() => {});
    return result;
  }

  private sources() {
    return this.options.store.issueRecords<SourceRecord>("source:");
  }
  private issues() {
    return this.options.store.issueRecords<IssueRecord>("issue:");
  }
  private settings() {
    return this.options.store.issueRecord<Settings>("settings") as Settings;
  }
  private save(issue: IssueRecord) {
    // A local host receipt can arrive while a GitHub write is awaiting I/O.
    // Never let the older remote operation overwrite that newer observation.
    const observed = this.sources().find(
      (item) => item.number === issue.number,
    );
    if (observed?.phase) issue.phase = observed.phase;
    if (observed?.threadId) issue.threadId = observed.threadId;
    this.options.store.saveIssueRecord(`issue:${issue.number}`, issue);
  }
  private saveSource(record: SourceRecord) {
    this.options.store.saveIssueRecord(`source:${record.source}`, record);
  }

  /** Local metadata only: viewing never launches, syncs or mutates GitHub. */
  index(source?: string): IssueIndex {
    const all = this.issues()
      .filter((issue) => !source || issue.sources.includes(source))
      .sort(
        (a, b) =>
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
          b.number - a.number,
      );
    const settings = this.settings();
    return {
      enabled: true,
      checkedAt: settings.checkedAt,
      error: settings.error,
      items: all
        .slice(0, 100)
        .map(({ body: _body, authorId: _author, ...issue }) => issue),
      total: all.length,
      pending: this.sources()
        .filter(
          (item) =>
            item.status !== "linked" && (!source || item.source === source),
        )
        .slice(0, 100)
        .map(({ source, status }) => ({ source, status })),
    };
  }

  private observe(remote: GitHubIssue, ownerId?: number): IssueRecord {
    const previous = this.options.store.issueRecord<IssueRecord>(
      `issue:${remote.number}`,
    );
    const sources = this.sources().filter(
      (item) =>
        item.number === remote.number ||
        (item.number === undefined &&
          item.status === "unknown" &&
          item.creatorId === remote.authorId &&
          Date.parse(remote.createdAt) >=
            Math.floor(item.requestedAt / 1000) * 1000 &&
          remote.body.includes(item.marker)),
    );
    for (const item of sources) {
      item.number = remote.number;
      item.url = remote.url;
      item.status = "linked";
      this.saveSource(item);
    }
    const issue: IssueRecord = {
      ...previous,
      ...remote,
      sources: sources.map((item) => item.source),
      captureOnly:
        sources.length > 0 && sources.every((item) => item.snapshotOnly),
      observedAt: this.now(),
    };
    if (
      !issue.job &&
      !sources.length &&
      remote.state === "open" &&
      ownerId !== undefined &&
      Date.parse(remote.createdAt) >= this.settings().enabledAt
    )
      issue.job = {
        phase: "pending",
        ownerRequest: remote.authorId === ownerId,
      };
    if (issue.job?.phase === "pending" && remote.state === "closed")
      issue.job.phase = "skipped";
    this.save(issue);
    return issue;
  }

  /** Idempotent registration stores ONLY a public-safe identifier and revision. */
  track(input: z.infer<typeof issueActions.track>) {
    const parsed = issueActions.track.parse(input);
    const previous = this.options.store.issueRecord<SourceRecord>(
      `source:${parsed.source}`,
    );
    if (previous) return previous;
    const record: SourceRecord = {
      source: parsed.source,
      status: "pending",
      marker: `<!-- june-source:${randomUUID()} -->`,
      requestedAt: this.now(),
      snapshotOnly: parsed.snapshotOnly === true,
      revision: parsed.revision,
    };
    this.saveSource(record);
    return record;
  }

  /** Synchronous local writes: capture uploads never wait for GitHub I/O. */
  async sourceReceipt(value: z.infer<typeof issueSourceSchema>) {
    const input = issueSourceSchema.parse(value);
    if (input.phase === "returned" && !input.threadId)
      throw new Error("issue_thread_required");
    const record = this.track({
      action: "track",
      source: input.source,
      revision: input.revision,
    });
    if (record.snapshotOnly) throw new Error("issue_capture_only");
    if (record.threadId && input.threadId && record.threadId !== input.threadId)
      throw new Error("issue_thread_conflict");
    if (
      !record.phase ||
      sourcePhases.indexOf(input.phase) > sourcePhases.indexOf(record.phase)
    )
      record.phase = input.phase;
    if (input.threadId) record.threadId = input.threadId;
    record.revision ??= input.revision;
    this.saveSource(record);
    if (record.number) {
      const issue = this.options.store.issueRecord<IssueRecord>(
        `issue:${record.number}`,
      );
      if (issue) this.observe(issue);
    }
    return { ok: true };
  }

  sync(): Promise<void> {
    return this.serial(async () => {
      const settings = this.settings();
      const began = this.now();
      try {
        const ownerId = await this.options.github.ownerId();
        // Unknown creations must be searched from their original intent time,
        // not a later cursor. Never retry a POST merely because its marker is absent.
        const since = Math.min(
          Date.parse(settings.cursor),
          ...this.sources()
            .filter((s) => s.status === "unknown")
            .map((s) => s.requestedAt),
        );
        const remote = await this.options.github.list(
          new Date(Math.max(0, since - 60_000)).toISOString(),
        );
        for (const issue of remote.sort((a, b) => a.number - b.number))
          this.observe(issue, ownerId);
        for (const pending of this.sources()
          .filter((item) => item.status === "pending")
          .slice(0, 10)) {
          const record = this.options.store.issueRecord<SourceRecord>(
            `source:${pending.source}`,
          ) as SourceRecord;
          const debug = record.source.startsWith("debug:");
          const id = record.source.slice(record.source.indexOf(":") + 1);
          const title = debug
            ? `June ${record.snapshotOnly ? "DEBUG" : "DEBUGSHARE"} ${id}`
            : `June deployment incident ${id}`;
          const body = [
            debug
              ? `Private evidence: ${this.options.origin}/s/${id}`
              : `Deployment recovery incident ${id}. Private status: ${this.options.origin}/issues`,
            record.snapshotOnly
              ? "Capture only — no Amp investigation was requested."
              : "The existing diagnostic/recovery investigator owns this report. Do not launch a second investigator.",
            record.revision
              ? `Captured revision: https://github.com/lordbagel42/agent/commit/${record.revision}`
              : "",
            "Progress belongs in this issue; diagnostic bodies, private messages and credentials stay private. Closing after source publication does not prove deployment.",
            record.marker,
          ]
            .filter(Boolean)
            .join("\n\n");
          record.status = "unknown";
          record.creatorId = this.options.creatorId;
          this.saveSource(record);
          try {
            this.observe(await this.options.github.create(title, body));
          } catch {
            /* Intent remains unknown even when no response was received. */
          }
        }
        settings.cursor = new Date(began).toISOString();
        settings.checkedAt = this.now();
        delete settings.error;
      } catch {
        settings.error = "github_unavailable";
      }
      this.options.store.saveIssueRecord("settings", settings);
    });
  }

  run(value: IssueAction): Promise<unknown> {
    const input = issueActionSchema.parse(value);
    return this.serial(async () => {
      if (input.action === "track") {
        const { marker: _marker, ...record } = this.track(input);
        return record;
      }
      if (input.action === "inspect") {
        if (input.source) {
          const record = this.options.store.issueRecord<SourceRecord>(
            `source:${input.source}`,
          );
          if (!record) return { source: input.source, status: "not_found" };
          const { marker: _marker, ...metadata } = record;
          return {
            ...metadata,
            issue: record.number
              ? this.options.store.issueRecord<IssueRecord>(
                  `issue:${record.number}`,
                )
              : undefined,
          };
        }
        if (!input.number) return this.index();
        const issue = this.observe(await this.options.github.get(input.number));
        return {
          ...issue,
          effects: this.options.store
            .issueRecords<Effect>("effect:")
            .filter((effect) => effect.input.number === input.number)
            .slice(-20)
            .map((effect) => ({
              key: effect.input.key,
              action: effect.input.action,
              phase: effect.phase,
            })),
        };
      }
      return this.mutate(input);
    });
  }

  private async mutate(
    input: Extract<IssueAction, { action: "comment" | "complete" }>,
  ) {
    const store = this.options.store;
    let effect = store.issueRecord<Effect>(`effect:${input.key}`);
    if (effect && JSON.stringify(effect.input) !== JSON.stringify(input))
      throw new Error("issue_key_conflict");
    if (effect?.phase === "done")
      return { number: input.number, key: input.key, status: "done" };
    const issue = this.observe(await this.options.github.get(input.number));
    if (input.threadId && issue.threadId && issue.threadId !== input.threadId)
      throw new Error("issue_thread_conflict");
    if (input.action === "complete") {
      if (
        !issue.sources.length &&
        issue.authorId !== (await this.options.github.ownerId())
      )
        throw new Error("issue_triage_only");
      if (!(await this.options.github.shipped(input.commit)))
        throw new Error("issue_commit_not_shipped");
    }
    const save = () => store.saveIssueRecord(`effect:${input.key}`, effect);
    const result = () => ({
      number: input.number,
      key: input.key,
      status: effect?.phase === "done" ? "done" : "unknown",
      phase: effect?.phase,
    });
    if (!effect) {
      effect = {
        input,
        marker: `<!-- june-effect:${randomUUID()} -->`,
        phase: "commenting",
      };
      save();
      const body = [
        input.body,
        input.threadId
          ? `Amp thread: https://ampcode.com/threads/${input.threadId}`
          : "",
        input.action === "complete"
          ? `Shipped code: https://github.com/lordbagel42/agent/commit/${input.commit}\nSource publication verified on main; deployment is separate.`
          : "",
        effect.marker,
      ]
        .filter(Boolean)
        .join("\n\n");
      try {
        effect.commentId = (
          await this.options.github.comment(input.number, body)
        ).id;
        effect.phase = "commented";
        save();
      } catch {
        return result();
      }
    } else if (effect.phase === "commenting") {
      const marker = effect.marker;
      const comment = (await this.options.github.comments(input.number)).find(
        (item) => item.body.includes(marker),
      );
      if (!comment) return result();
      effect.commentId = comment.id;
      effect.phase = "commented";
      save();
    }
    if (input.threadId) issue.threadId = input.threadId;
    if (input.action === "complete") {
      if (effect.phase === "closing") {
        if (issue.state !== "closed") return result();
      } else if (issue.state !== "closed") {
        effect.phase = "closing";
        save();
        try {
          Object.assign(issue, await this.options.github.close(input.number));
        } catch {
          return result();
        }
      }
      issue.commit = input.commit;
    }
    this.save(issue);
    effect.phase = "done";
    save();
    return result();
  }

  claim(claimId: string) {
    z.uuid().parse(claimId);
    return this.serial(async () => {
      const existing = this.issues().find(
        (issue) => issue.job?.claimId === claimId,
      );
      const response = (issue: IssueRecord) => ({
        job: {
          number: issue.number,
          title: issue.title,
          body:
            Buffer.byteLength(issue.body) > 60000
              ? `${Buffer.from(issue.body).subarray(0, 60000).toString("utf8")}\n[Truncated; inspect the issue for the full request.]`
              : issue.body,
          url: issue.url,
          ...issue.job,
          claimId,
        },
      });
      if (existing) return response(existing);
      for (const candidate of this.issues()
        .filter((issue) => issue.job?.phase === "pending")
        .sort((a, b) => a.number - b.number)) {
        const issue = this.observe(
          await this.options.github.get(candidate.number),
        );
        if (issue.state !== "open") continue;
        issue.job = {
          phase: "claimed",
          claimId,
          ownerRequest:
            issue.authorId === (await this.options.github.ownerId()),
        };
        this.save(issue);
        return response(issue);
      }
      return { job: null };
    });
  }

  receipt(number: number, value: z.infer<typeof issueReceiptSchema>) {
    const input = issueReceiptSchema.parse(value);
    return this.serial(async () => {
      const issue = this.options.store.issueRecord<IssueRecord>(
        `issue:${number}`,
      );
      if (!issue?.job || issue.job.claimId !== input.claimId)
        throw new Error("issue_claim_conflict");
      if (issue.job.phase === "reconciled")
        throw new Error("issue_claim_reconciled");
      if (input.threadId && issue.threadId && input.threadId !== issue.threadId)
        throw new Error("issue_thread_conflict");
      if (
        (input.phase === "running" || input.phase === "returned") &&
        !input.threadId
      )
        throw new Error("issue_thread_required");
      // A late running callback cannot undo an unknown fence or a final receipt.
      if (
        issue.job.phase !== "returned" &&
        !(issue.job.phase === "unknown" && input.phase === "running")
      )
        issue.job.phase = input.phase;
      if (input.threadId) {
        issue.job.threadId = input.threadId;
        issue.threadId = input.threadId;
      }
      this.save(issue);
      return { ok: true };
    });
  }

  /** Operator-only settlement, never exposed as an automation tool. */
  reconcile(number: number, value: z.infer<typeof issueReconciliationSchema>) {
    return this.serial(async () => {
      const input = issueReconciliationSchema.parse(value);
      const issue = this.options.store.issueRecord<IssueRecord>(
        `issue:${number}`,
      );
      if (!issue?.job || issue.job.claimId !== input.claimId)
        throw new Error("issue_claim_conflict");
      if (
        input.resolution === "no_launch" &&
        (input.threadId || issue.threadId)
      )
        throw new Error("issue_thread_conflict");
      if (input.resolution === "settled" && !input.threadId)
        throw new Error("issue_thread_required");
      if (input.threadId && issue.threadId && input.threadId !== issue.threadId)
        throw new Error("issue_thread_conflict");
      if (issue.job.reconciliation) {
        const { at: _at, ...prior } = issue.job.reconciliation;
        if (JSON.stringify(prior) !== JSON.stringify(input))
          throw new Error("issue_reconciliation_conflict");
        return { ok: true };
      }
      issue.job.phase = "reconciled";
      issue.job.reconciliation = { ...input, at: this.now() };
      if (input.threadId) issue.job.threadId = issue.threadId = input.threadId;
      this.save(issue);
      return { ok: true };
    });
  }
}
