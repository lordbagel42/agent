import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmodSync, closeSync, constants, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SpanStatusCode } from "@opentelemetry/api";
import { z } from "zod";
import { correlationId, withSpan } from "../telemetry/index.js";
import {
  httpsWebhookTransport,
  type WebhookDestination,
  type WebhookTransport,
  webhookUrl,
} from "./webhook-transport.js";

const eventSchema = z.enum(["reply", "message"]);
const principalSchema = z.string().min(1).max(200);
const MAX_REGISTRATIONS = 256;
const MAX_DELIVERIES = 4096;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const DEADLINE_MS = 10_000;

// Validate iteratively before Zod traverses any caller-supplied recursive input.
// Only ordinary JSON data is allowed, not getters, prototypes, cycles or toJSON.
function boundedJsonObject(value: unknown): value is Record<string, unknown> {
  const pending = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  while (pending.length) {
    const entry = pending.pop();
    if (!entry || ++nodes > 4096 || entry.depth > 16) return false;
    const item = entry.value;
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return false;
    } else if (typeof item === "string") {
      bytes += Buffer.byteLength(item);
    } else if (typeof item === "object") {
      if (seen.has(item)) return false;
      seen.add(item);
      if (
        Array.isArray(item) &&
        (item.length > 4096 ||
          Object.keys(item).length !== item.length ||
          Object.getPrototypeOf(item) !== Array.prototype)
      )
        return false;
      if (
        !Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      )
        return false;
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Reflect.ownKeys(item).length > 4096) return false;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        // Zod records omit this key; reject rather than silently change the
        // request before its full-input idempotency binding is computed.
        if (key === "__proto__") return false;
        if (Array.isArray(item) && key === "length") continue;
        if (
          Array.isArray(item) &&
          (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)
        )
          return false;
        if (!descriptor.enumerable || !("value" in descriptor)) return false;
        bytes += Buffer.byteLength(key);
        pending.push({ value: descriptor.value, depth: entry.depth + 1 });
      }
      if (Object.getOwnPropertySymbols(item).length) return false;
    } else return false;
    if (bytes > MAX_PAYLOAD_BYTES) return false;
  }
  return Buffer.byteLength(JSON.stringify(value)) <= MAX_PAYLOAD_BYTES;
}

export const registerWebhookSchema = z.strictObject({
  idempotencyKey: z.uuid(),
  name: z.string().min(1).max(120),
  url: z.string().min(1).max(2048),
  // Milliseconds since Unix epoch, matching Date.now().
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  events: z
    .array(eventSchema)
    .min(1)
    .max(2)
    .refine((events) => new Set(events).size === events.length),
  conversationId: z.string().min(1).max(200).optional(),
});

export const sendWebhookSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(200),
  webhookId: z.uuid(),
  type: eventSchema,
  payload: z
    .unknown()
    .refine(boundedJsonObject, "Expected bounded JSON object")
    .pipe(z.record(z.string(), z.unknown())),
});

export type WebhookRegistration = {
  id: string;
  name: string;
  clientId: string;
  expiresAt: number;
  events: Array<"reply" | "message">;
  conversationId?: string;
  revoked: boolean;
};
export type WebhookReceipt = {
  id: string;
  webhookId: string;
  status: "queued" | "dispatching" | "accepted" | "rejected" | "unknown";
  code?: string;
};
export type WebhookServiceOptions = {
  path: string;
  key: Buffer;
  destinations: WebhookDestination[];
  clientActive: (id: string) => boolean;
  deletionRevision?: () => number;
};
type Registration = z.infer<typeof registerWebhookSchema> & {
  clientId: string;
  signingKey: string;
};
type Delivery = z.infer<typeof sendWebhookSchema> & {
  clientId: string;
  time: number;
  revision?: number;
};
type Row = { id: string; digest: string; data: string; revoked: number };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** One host instance per database. The host validates the owner-only parent.
 * Registrations and outbox are lifetime-bounded (including tombstones): on
 * exhaustion reject admission; never evict deduplication records and resend.
 */
export class WebhookService {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private readonly destinations: WebhookDestination[];
  private readonly clientActive: (id: string) => boolean;
  private readonly deletionRevision: () => number;
  private readonly transport: WebhookTransport;
  private pump?: Promise<void>;
  private closing = false;
  private closed = false;
  private closingPromise?: Promise<void>;

  constructor(
    options: WebhookServiceOptions,
    trustedTransport: WebhookTransport = httpsWebhookTransport,
  ) {
    if (options.key.length !== 32)
      throw new Error("webhook_key_must_be_32_bytes");
    this.key = Buffer.from(options.key);
    this.destinations = options.destinations.map(({ origin, pathPrefix }) => {
      const parsed = new URL(origin);
      if (
        parsed.origin !== origin ||
        parsed.protocol !== "https:" ||
        !pathPrefix.startsWith("/") ||
        /[%?#\\\s]/.test(pathPrefix) ||
        new URL(pathPrefix, origin).pathname !== pathPrefix
      ) {
        throw new Error("webhook_policy_invalid");
      }
      return { origin, pathPrefix };
    });
    this.clientActive = options.clientActive;
    this.deletionRevision = options.deletionRevision ?? (() => 0);
    this.transport = trustedTransport;
    const fd = openSync(
      options.path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(fd);
    chmodSync(options.path, 0o600);
    this.db = new DatabaseSync(options.path);
    try {
      // DELETE journal inherits the 0600 database mode; no persistent WAL files.
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS webhook_meta (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS webhook_registrations (
          id TEXT PRIMARY KEY, client TEXT NOT NULL, idem TEXT NOT NULL,
          digest TEXT NOT NULL, data TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
          UNIQUE(client, idem));
        CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id TEXT PRIMARY KEY, client TEXT NOT NULL, idem TEXT NOT NULL,
          digest TEXT NOT NULL, data TEXT NOT NULL, webhookId TEXT NOT NULL,
          status TEXT NOT NULL, code TEXT, UNIQUE(client, idem));`);
      const sentinel = this.db
        .prepare("SELECT data FROM webhook_meta WHERE id=1")
        .get() as { data: string } | undefined;
      if (sentinel) {
        if (
          this.decrypt<string>(sentinel.data, "key-check") !==
          "june-webhooks-v1"
        )
          throw new Error("invalid key");
      } else {
        this.db
          .prepare("INSERT INTO webhook_meta VALUES (1, ?)")
          .run(this.encrypt("june-webhooks-v1", "key-check"));
      }
      // Authenticate existing records at startup, not after a callback is queued.
      for (const table of ["webhook_registrations", "webhook_deliveries"]) {
        for (const row of this.db
          .prepare(`SELECT id, data FROM ${table}`)
          .all() as Array<{ id: string; data: string }>)
          this.decrypt(row.data, row.id);
      }
      this.db.exec(
        "UPDATE webhook_deliveries SET status='unknown', code='interrupted' WHERE status='dispatching'",
      );
    } catch {
      this.db.close();
      this.key.fill(0);
      throw new Error("webhook_store_unavailable_or_invalid_key");
    }
  }

  private encrypt(value: unknown, context: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString(
      "base64",
    );
  }

  private decrypt<T>(value: string, context: string): T {
    const buffer = Buffer.from(value, "base64");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      buffer.subarray(0, 12),
    );
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(buffer.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        cipher.update(buffer.subarray(28)),
        cipher.final(),
      ]).toString(),
    );
  }

  private digest(clientId: string, input: unknown): string {
    return createHmac("sha256", this.key)
      .update(canonical({ clientId, input }))
      .digest("hex");
  }

  private open(): void {
    if (this.closing || this.closed) throw new Error("webhook_service_closed");
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private checkClient(clientId: string): void {
    principalSchema.parse(clientId);
    if (!this.clientActive(clientId))
      throw new Error("webhook_client_inactive");
  }

  private registration(row: Row): WebhookRegistration {
    const data = this.decrypt<Registration>(row.data, row.id);
    return {
      id: row.id,
      name: data.name,
      clientId: data.clientId,
      expiresAt: data.expiresAt,
      events: data.events,
      ...(data.conversationId ? { conversationId: data.conversationId } : {}),
      revoked: Boolean(row.revoked),
    };
  }

  register(
    clientId: string,
    input: unknown,
  ): WebhookRegistration & { signingKey?: string } {
    this.open();
    this.checkClient(clientId);
    const parsed = registerWebhookSchema.parse(input);
    const digest = this.digest(clientId, parsed);
    return this.transaction(() => {
      const previous = this.db
        .prepare(
          "SELECT * FROM webhook_registrations WHERE client=? AND idem=?",
        )
        .get(clientId, parsed.idempotencyKey) as Row | undefined;
      if (previous) {
        if (previous.digest !== digest)
          throw new Error("webhook_idempotency_conflict");
        return this.registration(previous);
      }
      webhookUrl(parsed.url, this.destinations);
      if (
        parsed.expiresAt <= Date.now() ||
        parsed.expiresAt > Date.now() + 90 * 86400_000
      )
        throw new Error("webhook_expiry_invalid");
      const count = this.db
        .prepare("SELECT count(*) AS n FROM webhook_registrations")
        .get() as { n: number };
      if (count.n >= MAX_REGISTRATIONS)
        throw new Error("webhook_registration_limit");
      const id = randomUUID();
      const signingKey = randomBytes(32).toString("base64url");
      const data = this.encrypt({ ...parsed, clientId, signingKey }, id);
      this.db
        .prepare(
          "INSERT INTO webhook_registrations (id,client,idem,digest,data) VALUES (?,?,?,?,?)",
        )
        .run(id, clientId, parsed.idempotencyKey, digest, data);
      return {
        ...this.registration({ id, digest, data, revoked: 0 }),
        signingKey,
      };
    });
  }

  list(): WebhookRegistration[] {
    this.open();
    return (
      this.db
        .prepare("SELECT * FROM webhook_registrations ORDER BY rowid")
        .all() as Row[]
    ).map((row) => this.registration(row));
  }

  get(id: string): WebhookRegistration | undefined {
    this.open();
    const row = this.db
      .prepare("SELECT * FROM webhook_registrations WHERE id=?")
      .get(z.uuid().parse(id)) as Row | undefined;
    return row ? this.registration(row) : undefined;
  }

  revoke(id: string): WebhookRegistration | undefined {
    this.open();
    this.db
      .prepare("UPDATE webhook_registrations SET revoked=1 WHERE id=?")
      .run(z.uuid().parse(id));
    return this.get(id);
  }

  /** Host privacy boundary: forgetting cancels all not-yet-dispatched callbacks.
   * Conservatively include unrelated queued events rather than risk sending
   * derived private context. Already dispatched effects cannot be recalled.
   */
  invalidatePending(): void {
    this.open();
    this.db.exec(
      "UPDATE webhook_deliveries SET status='rejected',code='context_forgotten' WHERE status='queued'",
    );
  }

  deliveryFor(
    clientId: string,
    idempotencyKey: string,
  ): WebhookReceipt | undefined {
    this.open();
    const row = this.db
      .prepare("SELECT id FROM webhook_deliveries WHERE client=? AND idem=?")
      .get(clientId, idempotencyKey) as { id: string } | undefined;
    return row ? this.receipt(row.id) : undefined;
  }

  enqueue(clientId: string, input: unknown): WebhookReceipt {
    this.open();
    this.checkClient(clientId);
    const parsed = sendWebhookSchema.parse(input);
    const digest = this.digest(clientId, parsed);
    return this.transaction(() => {
      const previous = this.db
        .prepare(
          "SELECT id,digest FROM webhook_deliveries WHERE client=? AND idem=?",
        )
        .get(clientId, parsed.idempotencyKey) as
        | { id: string; digest: string }
        | undefined;
      if (previous) {
        if (previous.digest !== digest)
          throw new Error("webhook_idempotency_conflict");
        return this.receipt(previous.id);
      }
      if (!this.get(parsed.webhookId)) throw new Error("webhook_not_found");
      const count = this.db
        .prepare("SELECT count(*) AS n FROM webhook_deliveries")
        .get() as { n: number };
      if (count.n >= MAX_DELIVERIES) throw new Error("webhook_outbox_limit");
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO webhook_deliveries (id,client,idem,digest,data,webhookId,status) VALUES (?,?,?,?,?,?,'queued')",
        )
        .run(
          id,
          clientId,
          parsed.idempotencyKey,
          digest,
          this.encrypt(
            {
              ...parsed,
              clientId,
              time: Date.now(),
              revision: this.deletionRevision(),
            },
            id,
          ),
          parsed.webhookId,
        );
      return this.receipt(id);
    });
  }

  async send(clientId: string, input: unknown): Promise<WebhookReceipt> {
    const receipt = this.enqueue(clientId, input);
    await this.drain();
    return this.receipt(receipt.id);
  }

  private receipt(id: string): WebhookReceipt {
    const row = this.db
      .prepare(
        "SELECT id,webhookId,status,code FROM webhook_deliveries WHERE id=?",
      )
      .get(id) as WebhookReceipt | undefined;
    if (!row) throw new Error("webhook_delivery_not_found");
    return {
      id: row.id,
      webhookId: row.webhookId,
      status: row.status,
      ...(row.code ? { code: row.code } : {}),
    };
  }

  delivery(id: string): WebhookReceipt | undefined {
    this.open();
    const exists = this.db
      .prepare("SELECT id FROM webhook_deliveries WHERE id=?")
      .get(z.uuid().parse(id));
    return exists ? this.receipt(id) : undefined;
  }

  drain(limit = Number.POSITIVE_INFINITY): Promise<void> {
    this.open();
    if (!this.pump) {
      this.pump = Promise.resolve()
        .then(async () => {
          for (let count = 0; !this.closing && count < limit; count++) {
            const row = this.db
              .prepare(
                "SELECT id,data FROM webhook_deliveries WHERE status='queued' ORDER BY rowid LIMIT 1",
              )
              .get() as { id: string; data: string } | undefined;
            if (!row) break;
            await this.dispatch(row);
          }
        })
        .finally(() => {
          this.pump = undefined;
        });
    }
    return this.pump;
  }

  private async dispatch(row: { id: string; data: string }): Promise<void> {
    return withSpan(
      "june.webhook.dispatch",
      {
        "june.operation.id": correlationId(row.id),
      },
      async (span) => {
        let marked = false;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DEADLINE_MS);
        try {
          const delivery = this.decrypt<Delivery>(row.data, row.id);
          const current = () => {
            if ((delivery.revision ?? 0) !== this.deletionRevision())
              throw new Error("webhook_context_forgotten");
            const registration = this.db
              .prepare("SELECT * FROM webhook_registrations WHERE id=?")
              .get(delivery.webhookId) as Row | undefined;
            if (!registration) throw new Error("webhook_not_found");
            const data = this.decrypt<Registration>(
              registration.data,
              registration.id,
            );
            if (
              registration.revoked ||
              data.expiresAt <= Date.now() ||
              !data.events.includes(delivery.type)
            )
              throw new Error("webhook_inactive");
            this.checkClient(data.clientId);
            this.checkClient(delivery.clientId);
            return { data, url: webhookUrl(data.url, this.destinations) };
          };
          const { data, url } = current();
          const timestamp = String(Math.floor(Date.now() / 1000));
          const body = Buffer.from(
            JSON.stringify({
              version: 1,
              id: row.id,
              time: delivery.time,
              type: delivery.type,
              ...(data.conversationId
                ? { conversationId: data.conversationId }
                : {}),
              payload: delivery.payload,
            }),
          );
          // Receiver contract: X-June-Timestamp is decimal Unix seconds;
          // X-June-Signature is "v1=" + lowercase hex HMAC-SHA256 using the
          // base64url-decoded signingKey over UTF-8 timestamp + "." + RAW body.
          // X-June-Event-Id equals envelope.id. Verify signature and timestamp window,
          // then durably deduplicate event IDs BEFORE performing receiver effects.
          const signature = createHmac(
            "sha256",
            Buffer.from(data.signingKey, "base64url"),
          )
            .update(`${timestamp}.`)
            .update(body)
            .digest("hex");
          const status = await this.transport({
            url,
            body,
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(body.length),
              "X-June-Timestamp": timestamp,
              "X-June-Event-Id": row.id,
              "X-June-Signature": `v1=${signature}`,
            },
            beforeDispatch: () => {
              controller.signal.throwIfAborted();
              current(); // Recheck after DNS, immediately before the actual request.
              if (marked) throw new Error("webhook_already_dispatching");
              const result = this.db
                .prepare(
                  "UPDATE webhook_deliveries SET status='dispatching' WHERE id=? AND status='queued'",
                )
                .run(row.id);
              if (result.changes !== 1)
                throw new Error("webhook_already_dispatching");
              marked = true;
            },
          });
          if (!marked) throw new Error("webhook_transport_contract");
          span.setAttribute("http.response.status_code", status);
          span.setAttribute(
            "june.outcome",
            status >= 200 && status < 300 ? "accepted" : "unknown",
          );
          if (status < 200 || status >= 300)
            span.setStatus({ code: SpanStatusCode.ERROR });
          this.db
            .prepare("UPDATE webhook_deliveries SET status=?,code=? WHERE id=?")
            .run(
              status >= 200 && status < 300 ? "accepted" : "unknown",
              status >= 200 && status < 300
                ? "http_accepted"
                : "http_non_success",
              row.id,
            );
        } catch {
          // Never return exception messages (they can contain URLs or response data).
          span.setAttribute("june.outcome", marked ? "unknown" : "rejected");
          span.setStatus({ code: SpanStatusCode.ERROR });
          this.db
            .prepare("UPDATE webhook_deliveries SET status=?,code=? WHERE id=?")
            .run(
              marked ? "unknown" : "rejected",
              marked ? "dispatch_uncertain" : "dispatch_prevented",
              row.id,
            );
        } finally {
          clearTimeout(timeout);
        }
      },
    );
  }

  close(): Promise<void> {
    if (!this.closingPromise) {
      this.closing = true;
      this.closingPromise = (async () => {
        try {
          await this.pump;
        } finally {
          this.db.close();
          this.key.fill(0);
          this.closed = true;
        }
      })();
    }
    return this.closingPromise;
  }
}
