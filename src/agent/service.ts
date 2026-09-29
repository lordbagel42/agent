import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, closeSync, constants, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ChannelAdapter, MessageEvent } from "../core/contracts.js";
import type { ConversationState } from "../runtime/registry.js";
import type { ActivityReadProjection } from "../sessions/runtime.js";
import type {
  WebhookDestination,
  WebhookTransport,
} from "./webhook-transport.js";
import { WebhookService } from "./webhooks.js";

export const sendMessageSchema = z.strictObject({
  idempotencyKey: z.uuid(),
  conversationId: z.string().min(1).max(200),
  text: z.string().min(1).max(32_000),
});
export type AgentClient = { id: string; token: string; expiresAt: number };
type Admission = {
  id: string;
  digest: string;
  body: string | null;
  client: string;
};

/** Host-owned administrative identities, not model-controlled routing claims. */
export class AgentService {
  readonly webhooks: WebhookService;
  readonly adapter: ChannelAdapter;
  private readonly db: DatabaseSync;
  private readonly credentials: Array<{
    id: string;
    digest: Buffer;
    expiresAt: number;
  }>;
  private readonly key: Buffer;
  private recovery?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly options: {
      directory: string;
      key: Buffer;
      ownerId: string;
      clients: AgentClient[];
      destinations: WebhookDestination[];
      deletionRevision?(): number;
      submit(event: MessageEvent): Promise<void>;
      snapshot(): Promise<ConversationState>;
      /** Use the coordinator's assigned session for polling an event, or its
       * current session for shared history. Null means no visible activity,
       * never permission to read legacy text after session cutover. */
      activityProjection?(
        state: ConversationState,
        eventId?: string,
      ): Promise<ActivityReadProjection | null>;
    },
    transport?: WebhookTransport,
  ) {
    if (options.key.length !== 32) throw new Error("invalid_agent_key");
    this.key = Buffer.from(options.key);
    const tokens = new Set<string>();
    const ids = new Set<string>();
    this.credentials = options.clients.map(({ id, token, expiresAt }) => {
      if (
        !/^[a-zA-Z0-9_-]{1,80}$/.test(id) ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(token) ||
        !Number.isSafeInteger(expiresAt) ||
        tokens.has(token) ||
        ids.has(id)
      )
        throw new Error("invalid_agent_credentials");
      ids.add(id);
      tokens.add(token);
      return {
        id,
        expiresAt,
        digest: createHash("sha256").update(`Bearer ${token}`).digest(),
      };
    });
    const path = `${options.directory}/agents.sqlite`;
    closeSync(
      openSync(
        path,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      ),
    );
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS admissions (
        id TEXT PRIMARY KEY, client TEXT NOT NULL, idem TEXT NOT NULL,
        digest TEXT NOT NULL, body TEXT, UNIQUE(client, idem));
      CREATE TABLE IF NOT EXISTS revoked_clients (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER, client TEXT,
        operation TEXT, outcome TEXT);`);
    this.webhooks = new WebhookService(
      {
        path: `${options.directory}/webhooks.sqlite`,
        key: options.key,
        destinations: options.destinations,
        deletionRevision: options.deletionRevision,
        clientActive: (id) => this.clientActive(id),
      },
      transport,
    );
    this.adapter = {
      channel: "agent",
      capabilities: { text: true, reactions: false, threads: false },
      // There is deliberately no generic /webhooks/agent ingress.
      receive: async () => ({
        response: new Response(null, { status: 404 }),
        events: [],
      }),
      send: async (message) => {
        if (message.content.type !== "text")
          return { status: "rejected", code: "text_only", retryable: false };
        if (!this.clientActive(message.address.threadId ?? ""))
          return {
            status: "rejected",
            code: "agent_revoked",
            retryable: false,
          };
        for (const hook of this.targets(
          "reply",
          message.address.conversationId,
        )) {
          this.webhooks.enqueue(message.address.threadId ?? "", {
            idempotencyKey: `reply:${message.id}:${hook.id}`,
            webhookId: hook.id,
            type: "reply",
            payload: {
              messageId: message.content.replyTo ?? null,
              conversationId: message.address.conversationId,
              text: message.content.text,
            },
          });
        }
        // Acceptance into the durable local outbox, not HTTP receiver acceptance.
        return { status: "sent", messageId: message.id };
      },
    };
  }

  clientActive(id: string): boolean {
    return (
      !this.stopped &&
      this.credentials.some(
        (client) => client.id === id && client.expiresAt > Date.now(),
      ) &&
      !this.db.prepare("SELECT id FROM revoked_clients WHERE id=?").get(id)
    );
  }

  authenticate(authorization: string): string | undefined {
    const digest = createHash("sha256").update(authorization).digest();
    const client = this.credentials.find((entry) =>
      timingSafeEqual(entry.digest, digest),
    );
    return client && this.clientActive(client.id) ? client.id : undefined;
  }

  clients() {
    return this.credentials.map(({ id, expiresAt }) => ({
      id,
      expiresAt,
      active: this.clientActive(id),
    }));
  }

  revokeClient(id: string) {
    if (!this.credentials.some((client) => client.id === id))
      throw new Error("client_not_found");
    this.db.prepare("INSERT OR IGNORE INTO revoked_clients VALUES (?)").run(id);
    return { id, revoked: true };
  }

  audit(client: string, operation: string, outcome: string) {
    this.db
      .prepare(
        "INSERT INTO audit(time,client,operation,outcome) VALUES (?,?,?,?)",
      )
      .run(Date.now(), client, operation, outcome);
    this.db.exec(
      "DELETE FROM audit WHERE seq < (SELECT COALESCE(MAX(seq),0)-10000 FROM audit)",
    );
  }

  readAudit(after = 0) {
    return this.db
      .prepare("SELECT * FROM audit WHERE seq>? ORDER BY seq LIMIT 100")
      .all(after);
  }

  async sendMessage(clientId: string, input: unknown) {
    if (!this.clientActive(clientId)) throw new Error("agent_inactive");
    const parsed = sendMessageSchema.parse(input);
    const digest = createHmac("sha256", this.key)
      .update(JSON.stringify(parsed))
      .digest("hex");
    let row = this.db
      .prepare("SELECT * FROM admissions WHERE client=? AND idem=?")
      .get(clientId, parsed.idempotencyKey) as Admission | undefined;
    if (row && row.digest !== digest)
      throw new Error("message_idempotency_conflict");
    if (!row) {
      const count = this.db
        .prepare("SELECT count(*) AS n FROM admissions")
        .get() as { n: number };
      if (count.n >= 4096) throw new Error("message_admission_limit");
      const id = randomUUID();
      const event: MessageEvent = {
        id,
        messageId: id,
        type: "message",
        occurredAt: Date.now(),
        senderId: clientId,
        direct: true,
        address: {
          channel: "agent",
          accountId: this.options.ownerId,
          conversationId: parsed.conversationId,
          threadId: clientId,
        },
        text: parsed.text,
      };
      row = { id, client: clientId, digest, body: JSON.stringify(event) };
      this.db
        .prepare("INSERT INTO admissions VALUES (?,?,?,?,?)")
        .run(id, clientId, parsed.idempotencyKey, digest, row.body);
    }
    await this.submit(row);
    return { id: row.id, accepted: true };
  }

  private async submit(row: Admission) {
    if (!row.body) return;
    if (!this.clientActive(row.client)) {
      this.db.prepare("UPDATE admissions SET body=NULL WHERE id=?").run(row.id);
      return;
    }
    await this.options.submit(JSON.parse(row.body) as MessageEvent);
    // The actor now owns the text and its forgetting lifecycle. A crash before
    // this cleanup can safely requeue the same immutable event, never a new ID.
    this.db.prepare("UPDATE admissions SET body=NULL WHERE id=?").run(row.id);
  }

  recover(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.recovery ??= (async () => {
      for (const row of this.db
        .prepare(
          "SELECT * FROM admissions WHERE body IS NOT NULL ORDER BY rowid LIMIT 100",
        )
        .all() as Admission[])
        await this.submit(row);
    })().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }

  targets(type: "reply" | "message", conversationId?: string) {
    return this.webhooks
      .list()
      .filter(
        (hook) =>
          !hook.revoked &&
          hook.expiresAt > Date.now() &&
          this.clientActive(hook.clientId) &&
          hook.events.includes(type) &&
          (type === "message" ||
            !hook.conversationId ||
            hook.conversationId === conversationId),
      );
  }

  async getMessage(id: string) {
    const row = this.db
      .prepare("SELECT id,body,client FROM admissions WHERE id=?")
      .get(z.uuid().parse(id)) as
      | { id: string; body: string | null; client: string }
      | undefined;
    if (!row) return null;
    const revision = this.options.deletionRevision?.();
    const state = await this.options.snapshot();
    if (revision !== this.options.deletionRevision?.())
      return { id, status: "forgotten" };
    const eventId = createHash("sha256")
      .update(JSON.stringify(["agent", this.options.ownerId, id]))
      .digest("hex");
    const event = state.events[eventId];
    if (state.forgottenEvents?.includes(eventId))
      return { id, status: "forgotten" };
    if (state.migration?.phase === "sessions") {
      const projection = await this.options.activityProjection?.(
        state,
        eventId,
      );
      if (revision !== this.options.deletionRevision?.())
        return { id, status: "forgotten" };
      if (!this.clientActive(row.client)) return { id, status: "revoked" };
      const turn = projection?.turns.find((entry) => entry.eventId === eventId);
      if (turn?.status === "forgotten" || turn?.status === "revoked")
        return { id, status: turn.status };
      const deliveries = turn?.deliveries ?? [];
      const callbacks = this.webhooks.list().flatMap((hook) =>
        deliveries.flatMap((delivery) => {
          const receipt = this.webhooks.deliveryFor(
            row.client,
            `reply:${delivery.id}:${hook.id}`,
          );
          return receipt?.webhookId === hook.id ? [receipt] : [];
        }),
      );
      return {
        id,
        status:
          turn?.status ??
          (row.body ? "pending_submission" : "processing_or_interrupted"),
        response: turn?.response ?? null,
        callbacks,
        deliveries,
      };
    }
    const uncertain = Object.entries(state.modelInvocations ?? {}).some(
      ([key, value]) => key.includes(eventId) && value !== "settled",
    );
    const deliveries = Object.entries(state.deliveries).filter(([key]) =>
      key.startsWith(`${eventId}:`),
    );
    const callbacks = this.webhooks
      .list()
      .flatMap((hook) =>
        [
          this.webhooks.deliveryFor(row.client, `june:${eventId}`),
          ...deliveries.map(([, delivery]) =>
            this.webhooks.deliveryFor(
              row.client,
              `reply:${delivery.message.id}:${hook.id}`,
            ),
          ),
        ].filter(
          (receipt) => receipt !== undefined && receipt.webhookId === hook.id,
        ),
      );
    return {
      id,
      status: event?.done
        ? uncertain
          ? "uncertain"
          : "completed"
        : !this.clientActive(row.client)
          ? "revoked"
          : row.body
            ? "pending_submission"
            : "processing_or_interrupted",
      response:
        state.history.find((entry) => entry.id === `${eventId}:reply`)
          ?.content ?? null,
      callbacks,
      deliveries: deliveries.map(([, delivery]) => ({
        id: delivery.message.id,
        phase: delivery.phase,
        result: delivery.result ?? null,
      })),
    };
  }

  async readMessages(after?: string, limit = 30) {
    const revision = this.options.deletionRevision?.();
    const state = await this.options.snapshot();
    const projection =
      state.migration?.phase === "sessions"
        ? await this.options.activityProjection?.(state)
        : undefined;
    if (revision !== this.options.deletionRevision?.())
      throw new Error("context_forgotten");
    const history =
      state.migration?.phase === "sessions"
        ? (projection?.history ?? [])
        : state.history;
    const start = after
      ? history.findIndex((entry) => entry.id === after) + 1
      : 0;
    if (after && start === 0) throw new Error("cursor_expired");
    const messages = history
      .slice(start, start + z.number().int().min(1).max(50).parse(limit))
      .map(({ id, role, content }) => ({ id, role, content }));
    return {
      messages,
      nextCursor: messages.at(-1)?.id ?? after ?? null,
      hasMore: start + messages.length < history.length,
    };
  }

  async close() {
    this.stopped = true;
    await this.recovery;
    await this.webhooks.close();
    this.db.close();
    this.key.fill(0);
  }
}
