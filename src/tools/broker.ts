import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SpanStatusCode } from "@opentelemetry/api";
import { correlationId, withSpan } from "../telemetry/index.js";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export interface ToolAction {
  tool: string;
  account: string;
  item: string;
  /** Exact canonical HTTPS origin; no paths, userinfo, or redirects. */
  origin: string;
  arguments: Json;
}
export interface Receipt {
  id: string;
  grantId: string;
  status: "unknown" | "succeeded" | "failed";
  startedAt: number;
}
export const MAX_GRANT_TTL_MS = 5 * 60_000;
export interface CapabilityAuditEvent {
  sequence: number;
  grantId: string;
  event: string;
  at: number;
}
/** Trusted code, not model-provided code. Enforce destination/redirect policy here.
 * Never return or log credentials, including errors. Results are intentionally discarded.
 * Resolve only on confirmed success; throw on rejection or ambiguous outcomes.
 * Cancellation requests cleanup; do not settle until owned work and cleanup settle.
 * Do not internally retry side effects. Revocation cannot recall a started operation.
 * This is an authorization boundary, NOT a process/network sandbox. */
export interface ToolAdapter {
  execute(
    action: ToolAction,
    credential: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
  /** Used instead of execute when present, never as a retry/fallback on error. */
  executeAuthorized?(
    action: ToolAction,
    credential: unknown,
    /** Recheck immediately before dispatch after adapter-internal awaits. */
    authorized: () => boolean,
    signal?: AbortSignal,
  ): Promise<unknown>;
  /** Optional deferred path: validate the exact operation before requesting its
   * credential. Await the one-use callback before any external effect; never
   * retain it or return its result. The broker rechecks authorization on release. */
  executeWithCredentialResolver?(
    action: ToolAction,
    resolveCredential: () => Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
export interface BrokerOptions {
  owner: string;
  tools: Record<string, ToolAdapter>;
  resolveCredential(
    scope: Readonly<Pick<ToolAction, "account" | "item" | "origin">>,
    /** Exact broker-validated action for host recipe selection; never model authority. */
    action?: Readonly<ToolAction>,
  ): Promise<unknown>;
  now?: () => number;
}

function deny(): never {
  throw new Error("capability_denied");
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 512 ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    deny();
  return value;
}
/** Strict JSON only; reject lossy encodings, prototypes, getters, and oversized input. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) deny();
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      Object.is(value, -0) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    )
      deny();
    return JSON.stringify(value);
  }
  if (typeof value !== "object") deny();
  if (Object.getOwnPropertySymbols(value).length) deny();
  if (Array.isArray(value)) {
    if (
      value.length > 10000 ||
      Object.getOwnPropertyNames(value).length !== value.length + 1 ||
      Object.keys(value).length !== value.length
    )
      deny();
    return `[${Array.from({ length: value.length }, (_, i) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !("value" in descriptor)) deny();
      return canonical(descriptor.value, depth + 1);
    }).join(",")}]`;
  }
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    deny();
  const keys = Object.getOwnPropertyNames(value).sort();
  if (keys.length > 10000) deny();
  return `{${keys
    .map((key) => {
      if (["__proto__", "constructor", "prototype"].includes(key)) deny();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) deny();
      return `${JSON.stringify(key)}:${canonical(descriptor.value, depth + 1)}`;
    })
    .join(",")}}`;
}
function object(value: unknown): Record<string, unknown> {
  const encoded = canonical(value);
  if (encoded.length > 65536) deny();
  const result: unknown = JSON.parse(encoded);
  if (!result || typeof result !== "object" || Array.isArray(result)) deny();
  return result as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).sort().join(",") !== expected.sort().join(",")) deny();
}
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
/** Only canonical JSON reaches here; freeze the private snapshot, not caller data. */
function freezeJson(value: Json): Json {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
interface GrantRow {
  id: string;
  audience: string;
  fingerprint: string;
  expires: number;
  revoked: number;
}
interface LinkRow {
  grant_id: string;
  expires: number;
  revoked: number;
}

/** Caller identity must come from trusted authentication, NEVER request JSON/model output.
 * Give models only propose/execute wrappers, not the broker or owner routes.
 * Persist on a private local filesystem; SQLite contains identifiers and digests, not payloads.
 */
export class CapabilityBroker {
  readonly #db: DatabaseSync;
  readonly #options: Readonly<BrokerOptions>;
  readonly #active = new Map<string, AbortController>();
  constructor(path: string, options: BrokerOptions) {
    text(options.owner);
    // Capture method identity without cloning class instances or freezing their
    // lifecycle state. Adapter-internal destination settings remain trusted.
    const tools = Object.fromEntries(
      Object.entries(options.tools).map(([name, adapter]) => [
        name,
        Object.freeze({
          execute: adapter.execute.bind(adapter),
          executeAuthorized: adapter.executeAuthorized?.bind(adapter),
          executeWithCredentialResolver:
            adapter.executeWithCredentialResolver?.bind(adapter),
        }),
      ]),
    );
    this.#options = Object.freeze({ ...options, tools: Object.freeze(tools) });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS capability_grants(id TEXT PRIMARY KEY, audience TEXT NOT NULL, fingerprint TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS capability_receipts(id TEXT PRIMARY KEY, grantId TEXT NOT NULL UNIQUE, status TEXT NOT NULL, startedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS capability_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, grantId TEXT NOT NULL, event TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS capability_links(digest TEXT PRIMARY KEY, grant_id TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);`);
  }
  close(): void {
    this.#db.close();
  }
  /** Registration is not a grant or a live adapter health check. */
  get registeredToolCount(): number {
    return Object.keys(this.#options.tools).length;
  }
  #now() {
    return (this.#options.now ?? Date.now)();
  }
  #owner(principal: string) {
    if (text(principal) !== this.#options.owner) deny();
  }
  #event(grantId: string, event: string) {
    this.#db
      .prepare("INSERT INTO capability_audit(grantId,event,at) VALUES(?,?,?)")
      .run(grantId, event, this.#now());
  }
  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  #expiry(value: unknown): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= this.#now() ||
      value > this.#now() + MAX_GRANT_TTL_MS
    )
      deny();
    return value;
  }
  propose(input: unknown): ToolAction {
    const value = object(input);
    keys(value, ["tool", "account", "item", "origin", "arguments"]);
    const origin = text(value.origin);
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return deny();
    }
    if (url.protocol !== "https:" || url.origin !== origin) deny();
    const tool = text(value.tool);
    if (!Object.hasOwn(this.#options.tools, tool)) deny();
    // Credential resolution and adapters must use the same bytes that were
    // fingerprinted, including nested arguments across asynchronous boundaries.
    return Object.freeze({
      tool,
      account: text(value.account),
      item: text(value.item),
      origin,
      arguments: freezeJson(value.arguments as Json),
    });
  }
  grant(principal: string, input: unknown): string {
    this.#owner(principal);
    const value = object(input);
    keys(value, ["audience", "action", "expiresAt"]);
    const action = this.propose(value.action);
    const id = randomUUID();
    return this.#transaction(() => {
      this.#db
        .prepare(
          "INSERT INTO capability_grants(id,audience,fingerprint,expires) VALUES(?,?,?,?)",
        )
        .run(
          id,
          text(value.audience),
          digest(canonical(action)),
          this.#expiry(value.expiresAt),
        );
      this.#event(id, "granted");
      return id;
    });
  }
  revoke(principal: string, grantId: string): void {
    this.#owner(principal);
    this.#transaction(() => {
      const changed = this.#db
        .prepare(
          "UPDATE capability_grants SET revoked=1 WHERE id=? AND revoked=0",
        )
        .run(text(grantId));
      if (changed.changes) this.#event(grantId, "revoked");
    });
  }
  /** Revokes future admission and requests local cleanup. Not proof of stoppage;
   * execution stays active until the adapter actually settles. Cannot undo an effect. */
  cancel(principal: string, grantId: string): Receipt | undefined {
    this.revoke(principal, grantId);
    this.#active.get(grantId)?.abort();
    return this.audit(principal, grantId);
  }
  /** Owner must independently verify the previous worker stopped and the external outcome.
   * This only annotates a consumed intent; it never authorizes another execution. */
  reconcile(principal: string, grantId: string, input: unknown): Receipt {
    this.#owner(principal);
    const value = object(input);
    keys(value, ["confirmedStopped", "outcome"]);
    if (
      value.confirmedStopped !== true ||
      (value.outcome !== "succeeded" && value.outcome !== "failed") ||
      this.#active.has(grantId)
    )
      deny();
    return this.#transaction(() => {
      const receipt = this.#receipt(text(grantId));
      if (receipt?.status !== "unknown") deny();
      this.#db
        .prepare("UPDATE capability_receipts SET status=? WHERE grantId=?")
        .run(value.outcome as string, grantId);
      this.#db
        .prepare("UPDATE capability_grants SET revoked=1 WHERE id=?")
        .run(grantId);
      this.#event(grantId, `reconciled_${value.outcome}`);
      return { ...receipt, status: value.outcome as "succeeded" | "failed" };
    });
  }
  /** Paginated metadata only: no action arguments, credential values, or error text. */
  auditEvents(principal: string, after = 0): CapabilityAuditEvent[] {
    this.#owner(principal);
    if (!Number.isSafeInteger(after) || after < 0) deny();
    return this.#db
      .prepare(
        "SELECT * FROM capability_audit WHERE sequence>? ORDER BY sequence LIMIT 100",
      )
      .all(after) as unknown as CapabilityAuditEvent[];
  }
  #grant(principal: string, id: string): GrantRow {
    const row = this.#db
      .prepare("SELECT * FROM capability_grants WHERE id=?")
      .get(text(id)) as unknown as GrantRow | undefined;
    if (
      !row ||
      row.audience !== text(principal) ||
      row.revoked ||
      row.expires <= this.#now()
    )
      deny();
    return row;
  }
  #receipt(id: string): Receipt | undefined {
    return this.#db
      .prepare("SELECT * FROM capability_receipts WHERE grantId=?")
      .get(id) as unknown as Receipt | undefined;
  }
  /** Owner-only read, including expired/revoked grants; never reopens execution. */
  audit(principal: string, grantId: string): Receipt | undefined {
    this.#owner(principal);
    return this.#receipt(text(grantId));
  }
  /** Trusted named-action lookup only, not authorization. Includes revoked/expired
   * grants so operators can reconcile them without persisting action payloads. */
  matchesGrant(principal: string, grantId: string, input: unknown): boolean {
    this.#owner(principal);
    const action = this.propose(input);
    const row = this.#db
      .prepare("SELECT fingerprint FROM capability_grants WHERE id=?")
      .get(text(grantId));
    return row?.fingerprint === digest(canonical(action));
  }
  async execute(
    principal: string,
    grantId: string,
    input: unknown,
    linkToken?: string,
    /** Trusted host-only sink for a fresh successful result. Never persisted or
     * called for receipt replay; current grant authority must still hold. */
    onResult?: (result: unknown) => void,
    /** Optional live task ceiling, checked across credential lookup and adapter
     * awaits. Losing it never reopens the durable receipt for another attempt. */
    canExecute?: () => boolean,
  ): Promise<Receipt> {
    const action = this.propose(input);
    const adapter = this.#options.tools[action.tool];
    if (!adapter) deny();
    return withSpan(
      "june.broker.execute",
      {
        "june.operation.id": correlationId(grantId),
        "june.capability": /^[A-Za-z0-9_.-]{1,64}$/.test(action.tool)
          ? action.tool
          : "other",
        "june.outcome": "rejected",
        "june.replayed": false,
      },
      async (span) => {
        let receipt: Receipt;
        this.#db.exec("BEGIN IMMEDIATE");
        try {
          if (
            linkToken !== undefined &&
            this.#link(principal, linkToken).grant_id !== grantId
          )
            deny();
          const grant = this.#grant(principal, grantId);
          if (grant.fingerprint !== digest(canonical(action))) deny();
          const existing = this.#receipt(grantId);
          if (existing) {
            this.#db.exec("COMMIT");
            span.setAttribute("june.replayed", true);
            span.setAttribute("june.outcome", existing.status);
            if (existing.status !== "succeeded")
              span.setStatus({ code: SpanStatusCode.ERROR });
            return existing;
          }
          // Unknown is the durable intent: a crash at ANY later point is never retried.
          receipt = {
            id: randomUUID(),
            grantId,
            status: "unknown",
            startedAt: this.#now(),
          };
          this.#db
            .prepare(
              "INSERT INTO capability_receipts(id,grantId,status,startedAt) VALUES(?,?,?,?)",
            )
            .run(receipt.id, grantId, receipt.status, receipt.startedAt);
          this.#event(grantId, "execution_claimed");
          this.#db.exec("COMMIT");
        } catch (error) {
          this.#db.exec("ROLLBACK");
          throw error;
        }
        const controller = new AbortController();
        span.setAttribute("june.outcome", "unknown");
        this.#active.set(grantId, controller);
        try {
          const scope = Object.freeze({
            account: action.account,
            item: action.item,
            origin: action.origin,
          });
          let requested = false;
          let admitted = false;
          const authorize = () => {
            if (canExecute?.() === false) deny();
            if (!this.#active.has(grantId)) deny();
            this.#grant(principal, grantId);
            if (linkToken !== undefined) this.#link(principal, linkToken);
            if (this.#receipt(grantId)?.status !== "unknown") deny();
          };
          const authorized = () => {
            try {
              authorize();
              return true;
            } catch {
              return false;
            }
          };
          const resolveCredential = async () => {
            if (requested) deny();
            requested = true;
            authorize();
            const credential = await this.#options.resolveCredential(
              scope,
              action,
            );
            // Cancellation/expiry during lookup prevents releasing the secret to
            // the adapter. A retained callback cannot resolve outside this execution.
            this.#transaction(() => {
              authorize();
              this.#event(grantId, "adapter_admitted");
              admitted = true;
            });
            return credential;
          };
          let result: unknown;
          if (adapter.executeWithCredentialResolver)
            result = await adapter.executeWithCredentialResolver(
              action,
              resolveCredential,
              controller.signal,
            );
          else {
            const credential = await resolveCredential();
            if (adapter.executeAuthorized)
              result = await adapter.executeAuthorized(
                action,
                credential,
                authorized,
                controller.signal,
              );
            else
              result = await adapter.execute(
                action,
                credential,
                controller.signal,
              );
          }
          if (!admitted) deny();
          const releaseResult = authorized();
          // Await without a race. The adapter owns confirmation: a cancellation
          // request cannot erase an independently confirmed external outcome.
          this.#transaction(() => {
            this.#db
              .prepare(
                "UPDATE capability_receipts SET status='succeeded' WHERE grantId=? AND status='unknown'",
              )
              .run(grantId);
            this.#event(grantId, "adapter_succeeded");
          });
          receipt.status = "succeeded";
          if (releaseResult) onResult?.(result);
        } catch {
          /* Never expose errors, credentials, or ambiguous transport payloads. */
        } finally {
          this.#active.delete(grantId);
        }
        span.setAttribute("june.outcome", receipt.status);
        if (receipt.status !== "succeeded")
          span.setStatus({ code: SpanStatusCode.ERROR });
        return receipt;
      },
    );
  }
  issueLink(principal: string, grantId: string, expiresAt: number): string {
    this.#owner(principal);
    const row = this.#db
      .prepare("SELECT * FROM capability_grants WHERE id=?")
      .get(text(grantId)) as unknown as GrantRow | undefined;
    const expires = this.#expiry(expiresAt);
    if (!row || row.revoked || expires > row.expires) deny();
    const token = randomBytes(32).toString("base64url");
    this.#db
      .prepare(
        "INSERT INTO capability_links(digest,grant_id,expires) VALUES(?,?,?)",
      )
      .run(digest(token), grantId, expires);
    return token;
  }
  #token(token: string) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(token))
      deny();
    return digest(token);
  }
  #link(principal: string, token: string): LinkRow {
    const row = this.#db
      .prepare("SELECT * FROM capability_links WHERE digest=?")
      .get(this.#token(token)) as unknown as LinkRow | undefined;
    if (!row || row.revoked || row.expires <= this.#now()) deny();
    this.#grant(principal, row.grant_id);
    return row;
  }
  inspectLink(
    principal: string,
    token: string,
  ): {
    grantId: string;
    expiresAt: number;
    status: "ready" | Receipt["status"];
  } {
    const row = this.#link(principal, token);
    return {
      grantId: row.grant_id,
      expiresAt: row.expires,
      status: this.#receipt(row.grant_id)?.status ?? "ready",
    };
  }
  revokeLink(principal: string, token: string): void {
    this.#owner(principal);
    this.#db
      .prepare("UPDATE capability_links SET revoked=1 WHERE digest=?")
      .run(this.#token(token));
  }
}
