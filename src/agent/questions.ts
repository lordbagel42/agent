import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmodSync, closeSync, constants, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AGENT_QUESTION_PREFIX } from "../core/agent-question.js";
import type {
  ChannelAdapter,
  Identity,
  MessageEvent,
} from "../core/contracts.js";

export const askQuestionSchema = z.strictObject({
  idempotencyKey: z.uuid(),
  question: z.string().trim().min(1).max(4000),
  threadUrl: z
    .string()
    .regex(
      /^https:\/\/ampcode\.com\/threads\/T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    .optional(),
});

export interface QuestionDelivery {
  recipient: Identity;
  open(): Promise<string>;
  /** Verified root ID, null for a non-relay root, undefined for unavailable. */
  questionAt(
    channel: string,
    thread: string,
  ): Promise<string | null | undefined>;
  send: ChannelAdapter["send"];
}

type Status =
  | "sending"
  | "waiting"
  | "answered"
  | "rejected"
  | "unknown"
  | "cancelled"
  | "expired"
  | "revoked"
  | "forgotten";
type Body = {
  question: string;
  threadUrl?: string;
  answer?: { text: string; messageId: string; at: number };
};
type Row = {
  id: string;
  client: string;
  digest: string;
  recipient: string;
  status: Status;
  created: number;
  expires: number;
  revision: number;
  channel: string | null;
  thread: string | null;
  data: string | null;
};

/** Host-owned DM relay, independent of model turns. A saved send intent is never
 * replayed: Slack may have accepted it even when the response was lost. */
export class AgentQuestions {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private readonly pending = new Set<Promise<unknown>>();
  private recovering?: Promise<void>;
  private closing = false;

  constructor(
    private readonly options: {
      path: string;
      key: Buffer;
      delivery?: QuestionDelivery;
      clientActive(id: string): boolean;
      submit?(event: MessageEvent): Promise<void>;
      deletionRevision?(): number;
    },
  ) {
    if (options.key.length !== 32) throw new Error("question_invalid_key");
    this.key = Buffer.from(options.key);
    closeSync(
      openSync(
        options.path,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      ),
    );
    chmodSync(options.path, 0o600);
    this.db = new DatabaseSync(options.path);
    try {
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS question_meta (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS questions (
          id TEXT PRIMARY KEY, client TEXT NOT NULL, idem TEXT NOT NULL,
          digest TEXT NOT NULL, recipient TEXT NOT NULL, status TEXT NOT NULL,
          created INTEGER NOT NULL, expires INTEGER NOT NULL, revision INTEGER NOT NULL,
          channel TEXT, thread TEXT, data TEXT, UNIQUE(client, idem));
        CREATE INDEX IF NOT EXISTS question_thread ON questions(channel, thread);
        CREATE TABLE IF NOT EXISTS question_replies (
          id TEXT PRIMARY KEY, channel TEXT NOT NULL, thread TEXT NOT NULL,
          recipient TEXT NOT NULL, data TEXT NOT NULL, expires INTEGER NOT NULL,
          revision INTEGER NOT NULL, retry_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS question_reply_receipts (id TEXT PRIMARY KEY);`);
      const sentinel = this.db
        .prepare("SELECT data FROM question_meta WHERE id=1")
        .get() as { data: string } | undefined;
      if (sentinel) {
        if (
          this.decrypt<string>(sentinel.data, "key-check") !==
          "june-questions-v1"
        )
          throw new Error("question_invalid_key");
      } else
        this.db
          .prepare("INSERT INTO question_meta VALUES (1, ?)")
          .run(this.encrypt("june-questions-v1", "key-check"));
      for (const row of this.db
        .prepare("SELECT id,data FROM questions WHERE data IS NOT NULL")
        .all() as Array<{ id: string; data: string }>)
        this.decrypt(row.data, row.id);
      for (const row of this.db
        .prepare("SELECT id,data FROM question_replies")
        .all() as Array<{ id: string; data: string }>)
        this.decrypt(row.data, `reply:${row.id}`);
      this.db.exec(
        "UPDATE questions SET status='unknown' WHERE status='sending'",
      );
      this.retire();
    } catch {
      this.db.close();
      this.key.fill(0);
      throw new Error("question_store_unavailable_or_invalid_key");
    }
  }

  private encrypt(value: unknown, id: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`june-question:${id}`));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString("base64");
  }

  private decrypt<T>(value: string, id: string): T {
    const data = Buffer.from(value, "base64");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      data.subarray(0, 12),
    );
    cipher.setAAD(Buffer.from(`june-question:${id}`));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        cipher.update(data.subarray(28)),
        cipher.final(),
      ]).toString(),
    );
  }

  private retire() {
    const now = Date.now();
    const revision = this.options.deletionRevision?.() ?? 0;
    this.db
      .prepare(
        "DELETE FROM question_replies WHERE expires<=? OR revision<>? OR recipient<>?",
      )
      .run(
        now,
        revision,
        JSON.stringify(this.options.delivery?.recipient) ?? "",
      );
    for (const row of this.db
      .prepare("SELECT * FROM questions WHERE data IS NOT NULL")
      .all() as Row[]) {
      const status =
        row.expires <= now
          ? "expired"
          : row.revision !== revision
            ? "forgotten"
            : !this.options.clientActive(row.client) ||
                row.recipient !==
                  JSON.stringify(this.options.delivery?.recipient)
              ? "revoked"
              : undefined;
      if (status)
        this.db
          .prepare("UPDATE questions SET status=?,data=NULL WHERE id=?")
          .run(status, row.id);
    }
  }

  private row(id: string) {
    this.retire();
    return this.db.prepare("SELECT * FROM questions WHERE id=?").get(id) as
      | Row
      | undefined;
  }

  get(client: string, id: string) {
    const row = this.row(z.uuid().parse(id));
    if (!row || row.client !== client) return null;
    const body = row.data ? this.decrypt<Body>(row.data, id) : undefined;
    return {
      id,
      status: row.status,
      createdAt: row.created,
      expiresAt: row.expires,
      question: body?.question ?? null,
      answer: body?.answer ?? null,
    };
  }

  inspect() {
    this.retire();
    return {
      enabled: !!this.options.delivery,
      heldReplies: (
        this.db.prepare("SELECT count(*) AS n FROM question_replies").get() as {
          n: number;
        }
      ).n,
      replyReceipts: (
        this.db
          .prepare("SELECT count(*) AS n FROM question_reply_receipts")
          .get() as {
          n: number;
        }
      ).n,
      ...(this.options.delivery
        ? {}
        : { reason: "configured_owner_slack_required" }),
      questions: this.db
        .prepare(
          "SELECT id,status,created AS createdAt,expires AS expiresAt FROM questions ORDER BY rowid DESC LIMIT 10",
        )
        .all(),
    };
  }

  withholdContext(channel: string, thread: string) {
    return !!this.db
      .prepare(
        "SELECT id FROM questions WHERE channel=? AND (thread=? OR thread IS NULL) LIMIT 1",
      )
      .get(channel, thread);
  }

  async ask(client: string, input: unknown) {
    if (this.closing || !this.options.clientActive(client))
      throw new Error("agent_inactive");
    const parsed = askQuestionSchema.parse(input);
    const digest = createHmac("sha256", this.key)
      .update(`june-question:${JSON.stringify({ client, ...parsed })}`)
      .digest("hex");
    const existing = this.db
      .prepare("SELECT * FROM questions WHERE client=? AND idem=?")
      .get(client, parsed.idempotencyKey) as Row | undefined;
    if (existing) {
      if (existing.digest !== digest)
        throw new Error("question_idempotency_conflict");
      return this.get(client, existing.id);
    }
    if (!this.options.delivery) throw new Error("question_slack_unavailable");
    this.retire();
    const count = this.db
      .prepare("SELECT count(*) AS n FROM questions")
      .get() as { n: number };
    if (count.n >= 4096) throw new Error("question_admission_limit");
    const id = randomUUID();
    const now = Date.now();
    const body: Body = {
      question: parsed.question,
      ...(parsed.threadUrl ? { threadUrl: parsed.threadUrl } : {}),
    };
    this.db
      .prepare("INSERT INTO questions VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?)")
      .run(
        id,
        client,
        parsed.idempotencyKey,
        digest,
        JSON.stringify(this.options.delivery.recipient),
        "sending",
        now,
        now + 7 * 86_400_000,
        this.options.deletionRevision?.() ?? 0,
        this.encrypt(body, id),
      );
    const pending = this.deliver(id, client, body, this.options.delivery).then(
      () => this.get(client, id),
    );
    this.pending.add(pending);
    try {
      return await pending;
    } finally {
      this.pending.delete(pending);
    }
  }

  private async deliver(
    id: string,
    client: string,
    body: Body,
    delivery: QuestionDelivery,
  ) {
    let channel: string;
    try {
      channel = await delivery.open();
      if (!/^D[A-Z0-9]+$/.test(channel))
        throw new Error("question_dm_unavailable");
    } catch {
      this.db
        .prepare(
          "UPDATE questions SET status='rejected' WHERE id=? AND status='sending'",
        )
        .run(id);
      return;
    }
    if (this.row(id)?.status !== "sending") return;
    this.db
      .prepare("UPDATE questions SET channel=? WHERE id=?")
      .run(channel, id);
    const result = await delivery
      .send({
        id,
        address: {
          channel: "slack",
          accountId: delivery.recipient.accountId,
          conversationId: channel,
        },
        lastInboundAt: Date.now(),
        content: {
          type: "text",
          plainText: true,
          text: `${AGENT_QUESTION_PREFIX}${id}\nQuestion from ${client}${body.threadUrl ? `\n${body.threadUrl}` : ""}\n\n${body.question}\n\nReply in this message's thread to send your answer back to the requesting agent. Your first reply is final; this is not a protected-action approval. Expires in 7 days.`,
        },
      })
      .catch(() => ({
        status: "unknown" as const,
        code: "question_send_unknown",
      }));
    // Retain the thread even if cancellation/revocation raced a successful send,
    // so a late reply is swallowed rather than executed as an unrelated task.
    this.retire();
    if (result.status === "sent")
      this.db
        .prepare("UPDATE questions SET thread=? WHERE id=?")
        .run(result.messageId, id);
    if (result.status === "rejected")
      this.db.prepare("UPDATE questions SET channel=NULL WHERE id=?").run(id);
    this.db
      .prepare("UPDATE questions SET status=? WHERE id=? AND status='sending'")
      .run(
        result.status === "sent"
          ? "waiting"
          : result.status === "rejected"
            ? "rejected"
            : "unknown",
        id,
      );
  }

  cancel(client: string, id: string) {
    const row = this.row(z.uuid().parse(id));
    if (!row || row.client !== client) return null;
    if (["sending", "waiting", "unknown"].includes(row.status))
      this.db
        .prepare("UPDATE questions SET status='cancelled',data=NULL WHERE id=?")
        .run(id);
    return this.get(client, id);
  }

  /** Only call with a fresh event from the signature-verifying Slack adapter. */
  async consume(event: MessageEvent) {
    // Retired inputs remain deduplicated even after correlation or ownership
    // changes. Check before a replay can take the ordinary conversation path.
    if (
      this.db
        .prepare("SELECT id FROM question_reply_receipts WHERE id=?")
        .get(event.id)
    )
      return true;
    const recipient = this.options.delivery?.recipient;
    if (
      !recipient ||
      event.address.channel !== "slack" ||
      event.address.accountId !== recipient.accountId ||
      event.senderId !== recipient.senderId ||
      !event.direct ||
      event.metadata?.channelType !== "im" ||
      !event.address.threadId ||
      event.address.threadId === event.messageId ||
      event.questionAnswered ||
      event.browserPinEligible ||
      event.artifactPinEligible ||
      /!browser-pin\b|!artifact-pin\b/i.test(event.text)
    )
      return false;
    if (
      !this.withholdContext(
        event.address.conversationId,
        event.address.threadId,
      )
    )
      return false;
    this.retire();
    const count = this.db
      .prepare("SELECT count(*) AS n FROM question_replies")
      .get() as { n: number };
    const receipts = this.db
      .prepare("SELECT count(*) AS n FROM question_reply_receipts")
      .get() as { n: number };
    if (
      count.n >= 256 ||
      receipts.n >= 16_384 ||
      Buffer.byteLength(JSON.stringify(event)) > 128 * 1024
    )
      throw new Error("question_reply_capacity");
    // Persist before ACK, never make global Slack FIFO intake wait on a root
    // lookup. Enqueue synchronously so later replies cannot win a lookup race.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO question_reply_receipts VALUES (?)")
        .run(event.id);
      this.db
        .prepare("INSERT INTO question_replies VALUES (?,?,?,?,?,?,?,0)")
        .run(
          event.id,
          event.address.conversationId,
          event.address.threadId,
          JSON.stringify(recipient),
          this.encrypt(event, `reply:${event.id}`),
          Date.now() + 7 * 86_400_000,
          this.options.deletionRevision?.() ?? 0,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return true;
  }

  recover() {
    if (this.closing) return Promise.resolve();
    if (this.recovering) return this.recovering;
    this.recovering = (async () => {
      this.retire();
      // One due thread head per pump tick; unavailable roots back off without
      // preventing other threads from making progress. First admitted reply wins.
      const row = this.db
        .prepare(
          "SELECT r.* FROM question_replies r WHERE retry_at<=? AND NOT EXISTS (SELECT 1 FROM question_replies p WHERE p.channel=r.channel AND p.thread=r.thread AND p.rowid<r.rowid) ORDER BY r.rowid LIMIT 1",
        )
        .get(Date.now()) as
        | { id: string; data: string; revision: number }
        | undefined;
      if (!row) return;
      this.db
        .prepare("UPDATE question_replies SET retry_at=? WHERE id=?")
        .run(Date.now() + 60_000, row.id);
      const event = this.decrypt<MessageEvent>(row.data, `reply:${row.id}`);
      const captured = await this.capture(event);
      this.retire();
      if (
        !this.db
          .prepare("SELECT id FROM question_replies WHERE id=?")
          .get(row.id) ||
        captured === undefined
      )
        return;
      if (!captured) {
        // A verified non-relay root re-enters normal durable admission using
        // the original event ID, never a synthetic replacement message.
        if (!this.options.submit) return;
        await this.options.submit({
          ...event,
          agentQuestionRevision: row.revision,
        });
      }
      this.db.prepare("DELETE FROM question_replies WHERE id=?").run(row.id);
    })().finally(() => {
      this.recovering = undefined;
    });
    return this.recovering;
  }

  private async capture(event: MessageEvent): Promise<boolean | undefined> {
    const recipient = this.options.delivery?.recipient;
    if (!recipient || !event.address.threadId) return true;
    // A foreground send can still be publishing its timestamp. Recovery is
    // distinct from pending sends, so joining them cannot wait on itself.
    await Promise.allSettled(this.pending);
    this.retire();
    let row = this.db
      .prepare(
        "SELECT * FROM questions WHERE channel=? AND thread=? AND recipient=?",
      )
      .get(
        event.address.conversationId,
        event.address.threadId,
        JSON.stringify(recipient),
      ) as Row | undefined;
    if (
      !row &&
      this.withholdContext(event.address.conversationId, event.address.threadId)
    ) {
      const id = await this.options.delivery?.questionAt(
        event.address.conversationId,
        event.address.threadId,
      );
      if (id === undefined) return undefined;
      if (id === null) return false;
      this.retire();
      this.db
        .prepare(
          "UPDATE questions SET thread=?,status=CASE WHEN status='unknown' THEN 'waiting' ELSE status END WHERE id=? AND channel=? AND recipient=? AND thread IS NULL",
        )
        .run(
          event.address.threadId,
          id,
          event.address.conversationId,
          JSON.stringify(recipient),
        );
      row = this.db
        .prepare(
          "SELECT * FROM questions WHERE id=? AND channel=? AND thread=? AND recipient=?",
        )
        .get(
          id,
          event.address.conversationId,
          event.address.threadId,
          JSON.stringify(recipient),
        ) as Row | undefined;
      if (!row) return true;
    }
    if (!row) return false;
    if (
      row.status === "waiting" &&
      row.data &&
      event.agentQuestionAnswerEligible === true &&
      // Slack event_time is whole seconds, unlike our millisecond admission.
      event.occurredAt >= Math.floor(row.created / 1000) * 1000 &&
      event.text.trim() &&
      event.text.length <= 32_000 &&
      !event.metadata?.files?.length
    ) {
      const body = this.decrypt<Body>(row.data, row.id);
      body.answer = {
        text: event.text,
        messageId: event.messageId,
        at: event.occurredAt,
      };
      this.db
        .prepare(
          "UPDATE questions SET status='answered',data=? WHERE id=? AND status='waiting'",
        )
        .run(this.encrypt(body, row.id), row.id);
    }
    return true;
  }

  async close() {
    this.closing = true;
    await Promise.allSettled(this.pending);
    await this.recovering;
    this.db.close();
    this.key.fill(0);
  }
}
