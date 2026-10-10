import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Identity, Owner } from "../core/contracts.js";
import { isOwner } from "../core/social.js";
import {
  type ArtifactContext,
  type ArtifactRecord,
  artifactCommandSchema,
} from "./contracts.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const derivePin = (value: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(value, salt, 32, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
const same = (a: Identity, b: Identity) =>
  a.channel === b.channel &&
  a.accountId === b.accountId &&
  a.senderId === b.senderId;
export const creatorOf = (context: ArtifactContext): Identity => ({
  channel: context.event.address.channel,
  accountId: context.event.address.accountId,
  senderId: context.event.senderId,
});
interface Stored extends ArtifactRecord {
  verifier?: string;
  secret?: string;
  secretExpires?: number;
}

export class ArtifactStore {
  readonly db: DatabaseSync;
  private key: Buffer;
  constructor(
    private options: {
      file: string;
      owner: Owner;
      encryptionKey: string;
      pepper: string;
      now?: () => number;
    },
  ) {
    if (
      options.encryptionKey.length < 32 ||
      options.pepper.length < 32 ||
      options.encryptionKey === options.pepper
    )
      throw new Error("artifact_keys_required");
    mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(options.file);
    chmodSync(options.file, 0o600);
    this.key = createHash("sha256").update(options.encryptionKey).digest();
    this.db.exec(`CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_operations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, artifact TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_sessions (token TEXT PRIMARY KEY, artifact TEXT NOT NULL, generation INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_attempts (id TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);`);
    this.db.exec("PRAGMA secure_delete = ON");
    // A send interrupted by process loss may already have reached Slack.
    for (const row of this.db.prepare("SELECT value FROM artifacts").all()) {
      const value = JSON.parse(String(row.value)) as Stored;
      if (value.pinDelivery === "sending") value.pinDelivery = "unknown";
      if (
        value.pinDelivery === "unknown" ||
        (value.secretExpires ?? 0) <= this.now()
      ) {
        delete value.secret;
        delete value.secretExpires;
        if (value.pinDelivery === "pending") value.pinDelivery = "rejected";
        this.save(value);
      }
    }
  }
  now() {
    return this.options.now?.() ?? Date.now();
  }
  close() {
    this.db.close();
  }
  private read(id: string): Stored | undefined {
    const row = this.db
      .prepare("SELECT value FROM artifacts WHERE id = ?")
      .get(id);
    return row ? (JSON.parse(String(row.value)) as Stored) : undefined;
  }
  private save(record: Stored) {
    this.db
      .prepare("INSERT OR REPLACE INTO artifacts VALUES (?, ?)")
      .run(record.id, JSON.stringify(record));
  }
  get(id: string): ArtifactRecord | undefined {
    const value = this.read(id);
    if (!value) return undefined;
    const { verifier: _v, secret: _s, secretExpires: _e, ...record } = value;
    return record;
  }
  mayManage(record: ArtifactRecord, context: ArtifactContext) {
    return (
      context.isCurrent() &&
      (same(record.creator, creatorOf(context)) ||
        isOwner(context.event, this.options.owner))
    );
  }
  private protect(
    record: Stored,
    protection: { pin: string; verifier: string },
  ) {
    const { pin, verifier } = protection;
    record.verifier = verifier;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(
      Buffer.from(
        JSON.stringify([record.id, record.generation, record.creator]),
      ),
    );
    const encrypted = Buffer.concat([
      cipher.update(pin, "utf8"),
      cipher.final(),
    ]);
    record.secret = Buffer.concat([
      iv,
      cipher.getAuthTag(),
      encrypted,
    ]).toString("base64");
    record.secretExpires = this.now() + 86_400_000;
    record.pinDelivery = "pending";
    record.visibility = "private";
  }
  async mutate(
    input: unknown,
    context: ArtifactContext,
    deletionRevision: number,
    chosenPin?: string,
  ): Promise<ArtifactRecord> {
    const command = artifactCommandSchema.parse(input);
    const signature = digest(
      JSON.stringify([
        command,
        creatorOf(context),
        chosenPin === undefined
          ? null
          : digest(`${this.options.pepper}:${chosenPin}`),
      ]),
    );
    if (!context.isCurrent()) throw new Error("artifact_context_revoked");
    let protection: { pin: string; verifier: string } | undefined;
    if (
      (command.action === "create" && command.visibility === "private") ||
      command.action === "change_pin"
    ) {
      if (command.action === "change_pin") {
        const existing = command.id ? this.get(command.id) : undefined;
        if (!existing || !this.mayManage(existing, context))
          throw new Error("artifact_denied");
      }
      const pin =
        command.action === "change_pin" && chosenPin !== undefined
          ? chosenPin
          : randomInt(0, 100_000_000).toString().padStart(8, "0");
      if (!/^\d{8}$/.test(pin)) throw new Error("artifact_pin_invalid");
      const salt = randomBytes(16).toString("hex");
      const key = await derivePin(`${this.options.pepper}:${pin}`, salt);
      protection = { pin, verifier: `${salt}:${key.toString("hex")}` };
    }
    // Never hold a SQLite transaction across an await. Re-read authorization,
    // idempotency and the current generation after background key derivation.
    if (!context.isCurrent()) throw new Error("artifact_context_revoked");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare("SELECT * FROM artifact_operations WHERE id = ?")
        .get(context.operationId);
      if (previous) {
        if (previous.digest !== signature)
          throw new Error("artifact_operation_conflict");
        const value = this.get(String(previous.artifact));
        if (!value || !this.mayManage(value, context))
          throw new Error("artifact_denied");
        this.db.exec("COMMIT");
        return value;
      }
      let record: Stored;
      if (command.action === "create") {
        if (
          Number(
            this.db.prepare("SELECT count(*) AS n FROM artifacts").get()?.n,
          ) >= 500
        )
          throw new Error("artifact_capacity");
        if (
          command.id ||
          !command.title ||
          !command.kind ||
          !command.visibility
        )
          throw new Error("artifact_invalid_create");
        if (
          command.kind === "workflow"
            ? !command.runId || command.content !== null
            : command.content === null || command.runId !== null
        )
          throw new Error("artifact_invalid_content");
        record = {
          id: randomBytes(16).toString("hex"),
          title: command.title,
          kind: command.kind,
          visibility: command.visibility,
          creator: creatorOf(context),
          revision: 1,
          generation: 1,
          content: command.content ?? "",
          runId: command.runId,
          deletionRevision,
          pinDelivery: "not_required",
        };
        if (protection) this.protect(record, protection);
      } else {
        const existing = command.id ? this.read(command.id) : undefined;
        if (!existing || !this.mayManage(existing, context))
          throw new Error("artifact_denied");
        record = existing;
        if (command.action === "update") {
          if (
            command.kind ||
            command.visibility ||
            command.runId ||
            record.kind === "workflow"
          )
            throw new Error("artifact_invalid_update");
          if (command.title) record.title = command.title;
          if (command.content !== null) record.content = command.content;
          record.revision++;
        } else if (command.action === "change_pin") {
          if (
            command.content ||
            command.title ||
            command.kind ||
            command.visibility ||
            command.runId
          )
            throw new Error("artifact_invalid_rotation");
          record.generation++;
          if (!protection) throw new Error("artifact_pin_invalid");
          this.protect(record, protection);
          this.db
            .prepare("DELETE FROM artifact_sessions WHERE artifact = ?")
            .run(record.id);
        }
      }
      if (!context.isCurrent()) throw new Error("artifact_context_revoked");
      if (
        Number(
          this.db.prepare("SELECT count(*) AS n FROM artifact_operations").get()
            ?.n,
        ) >= 20_000
      )
        throw new Error("artifact_operation_capacity");
      this.save(record);
      this.db
        .prepare("INSERT INTO artifact_operations VALUES (?, ?, ?)")
        .run(context.operationId, signature, record.id);
      this.db.exec("COMMIT");
      return this.get(record.id) as ArtifactRecord;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  beginSecret(
    id: string,
    generation: number,
  ): { creator: Identity; pin: string } | undefined {
    const record = this.read(id);
    if (
      !record ||
      record.generation !== generation ||
      record.pinDelivery !== "pending" ||
      !record.secret
    )
      return undefined;
    if ((record.secretExpires ?? 0) <= this.now()) {
      this.settleSecret(id, generation, "rejected");
      return undefined;
    }
    const bytes = Buffer.from(record.secret, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    decipher.setAAD(
      Buffer.from(
        JSON.stringify([record.id, record.generation, record.creator]),
      ),
    );
    const pin = Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
    record.pinDelivery = "sending";
    this.save(record);
    return { creator: record.creator, pin };
  }
  settleSecret(
    id: string,
    generation: number,
    outcome: "sent" | "rejected" | "unknown",
  ) {
    const record = this.read(id);
    if (!record || record.generation !== generation) return;
    record.pinDelivery = outcome;
    delete record.secret;
    delete record.secretExpires;
    this.save(record);
  }
  async unlock(
    id: string,
    pin: string,
    client: string,
  ): Promise<string | undefined> {
    const record = this.read(id);
    if (record?.visibility !== "private") return undefined;
    this.db
      .prepare("DELETE FROM artifact_attempts WHERE until < ?")
      .run(this.now());
    const keys = [`artifact:${id}`, `client:${id}:${digest(client)}`];
    for (const key of keys) {
      const count = Number(
        this.db
          .prepare("SELECT count FROM artifact_attempts WHERE id = ?")
          .get(key)?.count ?? 0,
      );
      if (count >= (key.startsWith("artifact:") ? 30 : 10)) return undefined;
    }
    for (const key of keys)
      this.db
        .prepare(
          "INSERT INTO artifact_attempts VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET count = count + 1",
        )
        .run(key, this.now() + 900_000);
    if (!/^\d{8}$/.test(pin) || !record.verifier) return undefined;
    const [salt, expected] = record.verifier.split(":");
    if (
      !salt ||
      !expected ||
      !timingSafeEqual(
        await derivePin(`${this.options.pepper}:${pin}`, salt),
        Buffer.from(expected, "hex"),
      )
    )
      return undefined;
    const latest = this.read(id);
    if (
      latest?.generation !== record.generation ||
      latest.verifier !== record.verifier
    )
      return undefined;
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare("DELETE FROM artifact_sessions WHERE expires < ?")
      .run(this.now());
    this.db
      .prepare("INSERT INTO artifact_sessions VALUES (?, ?, ?, ?)")
      .run(digest(token), id, record.generation, this.now() + 3_600_000);
    return token;
  }
  authorized(id: string, token?: string): boolean {
    const record = this.get(id);
    if (!record) return false;
    if (record.visibility === "public") return true;
    if (!token) return false;
    const session = this.db
      .prepare("SELECT * FROM artifact_sessions WHERE token = ?")
      .get(digest(token));
    return (
      session?.artifact === id &&
      session.generation === record.generation &&
      Number(session.expires) > this.now()
    );
  }
  updateScene(id: string, generation: number, content: string) {
    const record = this.read(id);
    if (record?.kind !== "board" || record.generation !== generation)
      throw new Error("artifact_changed");
    if (record.content !== content) {
      record.content = content;
      record.revision++;
      this.save(record);
    }
    return this.get(id) as ArtifactRecord;
  }
}
