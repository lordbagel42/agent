import { DurableObject } from "cloudflare:workers";

/**
 * June's Dynamic Apps host. One Worker serves three surfaces:
 *  - `https://<APPS_DOMAIN>/control/*`: June's signed control API.
 *  - `https://<app>.<APPS_DOMAIN>/`: public apps (no login).
 *  - `https://<app>--signed-in.<APPS_DOMAIN>/`: apps for anyone signed in
 *    through the Cloudflare Access application whose AUD is ACCESS_AUD.
 * Apps are static files plus a per-app JSON storage API; generated code never
 * runs on the host. Durable Objects hold receipts, source and app data.
 */
interface Env {
  REGISTRY: DurableObjectNamespace<Registry>;
  APP_DATA: DurableObjectNamespace<AppData>;
  APPS_DOMAIN: string;
  ACCESS_ISSUER: string;
  /** Secret (survives deploys): AUD of the signed-in Access application. */
  ACCESS_AUD: string;
  /** Secret: JSON array of base64url raw Ed25519 public keys June signs with. */
  JUNE_KEYS: string;
  REVISION?: string;
}

type Access = "public" | "signed-in";
type Status =
  | "prepared"
  | "deployed"
  | "superseded"
  | "unpublished"
  | "expired";

const APP_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SIGNED_IN_SUFFIX = "--signed-in";
const DIGEST = /^[a-f0-9]{64}$/;
const SCOPE = /^[a-f0-9]{64}$/;
const PATH_PART = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  xml: "application/xml",
};
const MAX_FILES = 128;
const MAX_FILE_BYTES = 65_536;
const MAX_SOURCE_BYTES = 262_144;
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const SIGNATURE_WINDOW_MS = 120_000;
const MAX_KEYS = 1000;
const MAX_VALUE_BYTES = 65_536;
const MAX_DATA_BYTES = 5 * 1024 * 1024;

const STATUS: Record<string, number> = {
  unauthorized: 401,
  unknown_june_key: 401,
  stale_signature: 401,
  bad_signature: 401,
  replayed_signature: 401,
  receipt_not_found: 404,
  app_not_found: 404,
  not_found: 404,
  receipt_from_other_conversation: 403,
  app_owned_by_other_conversation: 403,
  not_a_number: 409,
  request_too_large: 413,
  storage_quota_exceeded: 413,
};

/** Its message is the code, so it survives Durable Object RPC boundaries. */
class HostError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).byteLength;
const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const sha256 = async (data: string | Uint8Array) =>
  hex(
    await crypto.subtle.digest(
      "SHA-256",
      typeof data === "string" ? encoder.encode(data) : data,
    ),
  );
const fromBase64Url = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
    char.charCodeAt(0),
  );
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

export function appUrl(domain: string, appId: string, access: Access) {
  return `https://${appId}${access === "signed-in" ? SIGNED_IN_SUFFIX : ""}.${domain}/`;
}

/** Same canonical digest June computes: sorted paths, UTF-8 JSON. */
export async function sourceDigest(
  appId: string,
  files: Record<string, string>,
) {
  return sha256(
    JSON.stringify({
      appId,
      files: Object.fromEntries(
        Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    }),
  );
}

export function validateSource(appId: unknown, files: unknown) {
  if (typeof appId !== "string" || appId.length > 48 || !APP_ID.test(appId))
    throw new HostError("invalid_app_id");
  if (!files || typeof files !== "object" || Array.isArray(files))
    throw new HostError("invalid_files");
  const entries = Object.entries(files as Record<string, unknown>);
  if (!entries.length || entries.length > MAX_FILES)
    throw new HostError("too_many_files");
  let total = 0;
  for (const [path, content] of entries) {
    const extension = path.split(".").pop()?.toLowerCase() ?? "";
    if (
      path.length > 200 ||
      !path
        .split("/")
        .every(
          (part) =>
            PATH_PART.test(part) &&
            !["node_modules", "credentials", "secrets"].includes(
              part.toLowerCase(),
            ),
        ) ||
      !TYPES[extension] ||
      typeof content !== "string" ||
      bytes(content) > MAX_FILE_BYTES
    )
      throw new HostError("invalid_file");
    total += bytes(path) + bytes(content);
  }
  if (total > MAX_SOURCE_BYTES) throw new HostError("source_too_large");
  if (!Object.hasOwn(files, "index.html"))
    throw new HostError("index_html_required");
  return files as Record<string, string>;
}

interface ReceiptRow extends Record<string, SqlStorageValue> {
  id: string;
  app_id: string;
  digest: string;
  access: Access;
  scope: string;
  title: string | null;
  status: Status;
  created_at: number;
  expires_at: number;
  deployed_at: number | null;
  ended_at: number | null;
  files: number;
  bytes: number;
}

/** Singleton registry: the only writer of receipts and publications. */
export class Registry extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sources (digest TEXT PRIMARY KEY, app_id TEXT NOT NULL, files INTEGER NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS files (digest TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (digest, path));
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, digest TEXT NOT NULL, access TEXT NOT NULL, scope TEXT NOT NULL, title TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, deployed_at INTEGER, ended_at INTEGER);
      CREATE INDEX IF NOT EXISTS receipts_by_app ON receipts (app_id, created_at);
      CREATE TABLE IF NOT EXISTS apps (app_id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, receipt_id TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS nonces (signature TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `);
  }

  private row(id: string) {
    return this.sql
      .exec<ReceiptRow>(
        "SELECT r.*, s.files, s.bytes FROM receipts r JOIN sources s ON s.digest = r.digest WHERE r.id = ?",
        id,
      )
      .toArray()[0];
  }

  private view(row: ReceiptRow) {
    return {
      id: row.id,
      appId: row.app_id,
      digest: row.digest,
      access: row.access,
      title: row.title,
      status:
        row.status === "prepared" && row.expires_at <= Date.now()
          ? "expired"
          : row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      deployedAt: row.deployed_at,
      endedAt: row.ended_at,
      files: row.files,
      bytes: row.bytes,
      url: appUrl(this.env.APPS_DOMAIN, row.app_id, row.access),
    };
  }

  /** Reject replayed control signatures; all control calls pass here first. */
  nonce(signature: string, at: number) {
    this.sql.exec(
      "DELETE FROM nonces WHERE at < ?",
      Date.now() - 2 * SIGNATURE_WINDOW_MS,
    );
    if (
      this.sql
        .exec("SELECT 1 FROM nonces WHERE signature = ?", signature)
        .toArray().length
    )
      return false;
    this.sql.exec("INSERT INTO nonces VALUES (?, ?)", signature, at);
    return true;
  }

  async prepare(input: {
    appId: string;
    files: Record<string, string>;
    access: Access;
    scope: string;
    requestId: string;
    title: string | null;
  }) {
    const files = validateSource(input.appId, input.files);
    if (input.access !== "public" && input.access !== "signed-in")
      throw new HostError("invalid_access");
    if (!SCOPE.test(input.scope) || !DIGEST.test(input.requestId))
      throw new HostError("invalid_request");
    const title =
      typeof input.title === "string" ? input.title.slice(0, 120) : null;
    const digest = await sourceDigest(input.appId, files);
    const id = await sha256(
      JSON.stringify([
        input.requestId,
        input.appId,
        digest,
        input.access,
        input.scope,
      ]),
    );
    const existing = this.row(id);
    if (existing) return this.view(existing);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      if (
        !this.sql
          .exec("SELECT 1 FROM sources WHERE digest = ?", digest)
          .toArray().length
      ) {
        let total = 0;
        for (const [path, content] of Object.entries(files)) {
          this.sql.exec(
            "INSERT INTO files VALUES (?, ?, ?)",
            digest,
            path,
            content,
          );
          total += bytes(content);
        }
        this.sql.exec(
          "INSERT INTO sources VALUES (?, ?, ?, ?, ?)",
          digest,
          input.appId,
          Object.keys(files).length,
          total,
          now,
        );
      }
      this.sql.exec(
        "INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, NULL, NULL)",
        id,
        input.appId,
        digest,
        input.access,
        input.scope,
        title,
        now,
        now + RECEIPT_TTL_MS,
      );
      // Abandoned preparations and their unreferenced source expire after a week.
      this.sql.exec(
        "DELETE FROM receipts WHERE status = 'prepared' AND expires_at < ?",
        now - 7 * RECEIPT_TTL_MS,
      );
      this.sql.exec(
        "DELETE FROM files WHERE digest NOT IN (SELECT digest FROM receipts)",
      );
      this.sql.exec(
        "DELETE FROM sources WHERE digest NOT IN (SELECT digest FROM receipts)",
      );
    });
    return this.view(this.row(id) as ReceiptRow);
  }

  /** Consume exactly one prepared receipt: its source AND audience go live. */
  deploy(input: {
    receiptId: string;
    appId: string;
    scope: string;
    privileged: boolean;
  }) {
    const row = this.row(input.receiptId);
    if (!row) throw new HostError("receipt_not_found");
    if (row.app_id !== input.appId) throw new HostError("app_receipt_mismatch");
    if (row.scope !== input.scope && !input.privileged)
      throw new HostError("receipt_from_other_conversation");
    if (row.status !== "prepared" || row.expires_at <= Date.now())
      return this.view(row);
    const app = this.sql
      .exec<{ owner_scope: string; receipt_id: string | null }>(
        "SELECT owner_scope, receipt_id FROM apps WHERE app_id = ?",
        row.app_id,
      )
      .toArray()[0];
    if (app && app.owner_scope !== input.scope && !input.privileged)
      throw new HostError("app_owned_by_other_conversation");
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      if (app?.receipt_id)
        this.sql.exec(
          "UPDATE receipts SET status = 'superseded', ended_at = ? WHERE id = ? AND status = 'deployed'",
          now,
          app.receipt_id,
        );
      this.sql.exec(
        "UPDATE receipts SET status = 'deployed', deployed_at = ? WHERE id = ?",
        now,
        row.id,
      );
      this.sql.exec(
        "INSERT INTO apps VALUES (?, ?, ?, ?) ON CONFLICT (app_id) DO UPDATE SET receipt_id = excluded.receipt_id, updated_at = excluded.updated_at",
        row.app_id,
        app?.owner_scope ?? row.scope,
        row.id,
        now,
      );
    });
    return this.view(this.row(row.id) as ReceiptRow);
  }

  unpublish(input: { appId: string; scope: string; privileged: boolean }) {
    const app = this.sql
      .exec<{ owner_scope: string; receipt_id: string | null }>(
        "SELECT owner_scope, receipt_id FROM apps WHERE app_id = ?",
        input.appId,
      )
      .toArray()[0];
    if (!app) throw new HostError("app_not_found");
    if (app.owner_scope !== input.scope && !input.privileged)
      throw new HostError("app_owned_by_other_conversation");
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      if (app.receipt_id)
        this.sql.exec(
          "UPDATE receipts SET status = 'unpublished', ended_at = ? WHERE id = ? AND status = 'deployed'",
          now,
          app.receipt_id,
        );
      this.sql.exec(
        "UPDATE apps SET receipt_id = NULL, updated_at = ? WHERE app_id = ?",
        now,
        input.appId,
      );
    });
    return this.app(input.appId, input.scope, input.privileged);
  }

  receipt(id: string) {
    const row = this.row(id);
    return row ? this.view(row) : null;
  }

  /** Live state is public; other conversations' preparations are not. */
  app(appId: string, scope: string, privileged: boolean) {
    const app = this.sql
      .exec<{ receipt_id: string | null; updated_at: number }>(
        "SELECT receipt_id, updated_at FROM apps WHERE app_id = ?",
        appId,
      )
      .toArray()[0];
    const latest = this.sql
      .exec<{ id: string }>(
        "SELECT id FROM receipts WHERE app_id = ? AND (scope = ? OR ?) ORDER BY created_at DESC LIMIT 1",
        appId,
        scope,
        privileged ? 1 : 0,
      )
      .toArray()[0];
    const live = app?.receipt_id ? this.receipt(app.receipt_id) : null;
    return {
      appId,
      live,
      latest: latest ? this.receipt(latest.id) : null,
      updatedAt: app?.updated_at ?? null,
    };
  }

  /** The caller's apps, or every app for the owner's private conversation. */
  list(scope: string, privileged: boolean) {
    const mine = privileged ? 1 : 0;
    return this.sql
      .exec<{ app_id: string }>(
        "SELECT app_id FROM apps WHERE owner_scope = ? OR ? UNION SELECT app_id FROM receipts WHERE scope = ? OR ? ORDER BY app_id LIMIT 200",
        scope,
        mine,
        scope,
        mine,
      )
      .toArray()
      .map(({ app_id }) => {
        const { live, latest, updatedAt } = this.app(app_id, scope, privileged);
        return {
          appId: app_id,
          live: live && {
            url: live.url,
            access: live.access,
            receiptId: live.id,
            title: live.title,
            deployedAt: live.deployedAt,
          },
          latestStatus: latest?.status ?? null,
          updatedAt,
        };
      });
  }

  /** Viewer lookup: content only when the hostname's audience is the live one. */
  resolve(appId: string, access: Access, candidates: string[]) {
    const live = this.sql
      .exec<{ digest: string; access: Access }>(
        "SELECT r.digest, r.access FROM apps a JOIN receipts r ON r.id = a.receipt_id WHERE a.app_id = ? AND r.status = 'deployed'",
        appId,
      )
      .toArray()[0];
    if (!live || live.access !== access) return null;
    for (const path of candidates) {
      const file = this.sql
        .exec<{ content: string }>(
          "SELECT content FROM files WHERE digest = ? AND path = ?",
          live.digest,
          path,
        )
        .toArray()[0];
      if (file) return { path, content: file.content };
    }
    return { path: null, content: null };
  }
}

/** JSON key/value storage; one object per app ID and audience, never shared. */
export class AppData extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
  }

  get(key: string) {
    return (
      this.sql
        .exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)
        .toArray()[0]?.value ?? null
    );
  }

  list(prefix: string, limit: number) {
    return this.sql
      .exec<{ key: string; value: string; updated_at: number }>(
        "SELECT key, value, updated_at FROM kv WHERE substr(key, 1, length(?)) = ? ORDER BY key LIMIT ?",
        prefix,
        prefix,
        limit,
      )
      .toArray()
      .map((row) => ({
        key: row.key,
        value: JSON.parse(row.value),
        updatedAt: row.updated_at,
      }));
  }

  put(key: string, value: string) {
    const usage = this.sql
      .exec<{ keys: number; size: number }>(
        "SELECT count(*) AS keys, coalesce(sum(length(CAST(value AS BLOB))), 0) AS size FROM kv WHERE key != ?",
        key,
      )
      .toArray()[0] ?? { keys: 0, size: 0 };
    if (usage.keys >= MAX_KEYS || usage.size + bytes(value) > MAX_DATA_BYTES)
      throw new HostError("storage_quota_exceeded");
    this.sql.exec(
      "INSERT INTO kv VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      key,
      value,
      Date.now(),
    );
  }

  increment(key: string, by: number) {
    const current = this.get(key);
    const parsed = current === null ? 0 : JSON.parse(current);
    if (typeof parsed !== "number") throw new HostError("not_a_number");
    const next = parsed + by;
    this.put(key, JSON.stringify(next));
    return next;
  }

  delete(key: string) {
    this.sql.exec("DELETE FROM kv WHERE key = ?", key);
  }
}

let keyCache: { source: string; keys: Map<string, CryptoKey> } | undefined;
async function juneKeys(env: Env) {
  if (keyCache?.source === env.JUNE_KEYS) return keyCache.keys;
  const keys = new Map<string, CryptoKey>();
  for (const value of JSON.parse(env.JUNE_KEYS || "[]") as string[]) {
    const raw = fromBase64Url(value);
    keys.set(
      (await sha256(raw)).slice(0, 16),
      await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, [
        "verify",
      ]),
    );
  }
  keyCache = { source: env.JUNE_KEYS, keys };
  return keys;
}

/** June signs `june-apps-v1\nMETHOD\npath?query\ntimestamp\nsha256(body)`. */
async function authorizeControl(request: Request, body: string, env: Env) {
  const match = (request.headers.get("authorization") ?? "").match(
    /^June-Ed25519 key=([a-f0-9]{16}), ts=(\d{13}), sig=([A-Za-z0-9_-]{86})$/,
  );
  if (!match) throw new HostError("unauthorized");
  const [, keyId = "", timestamp = "", signature = ""] = match;
  const key = (await juneKeys(env)).get(keyId);
  if (!key) throw new HostError("unknown_june_key");
  const at = Number(timestamp);
  if (Math.abs(Date.now() - at) > SIGNATURE_WINDOW_MS)
    throw new HostError("stale_signature");
  const url = new URL(request.url);
  const signed = `june-apps-v1\n${request.method}\n${url.pathname}${url.search}\n${timestamp}\n${await sha256(body)}`;
  if (
    !(await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      fromBase64Url(signature),
      encoder.encode(signed),
    ))
  )
    throw new HostError("bad_signature");
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  if (!(await registry.nonce(await sha256(signature), at)))
    throw new HostError("replayed_signature");
  return registry;
}

async function control(request: Request, env: Env) {
  const body = request.method === "GET" ? "" : await request.text();
  if (bytes(body) > MAX_SOURCE_BYTES * 2)
    throw new HostError("request_too_large");
  const registry = await authorizeControl(request, body, env);
  const path = new URL(request.url).pathname;
  const input = body ? (JSON.parse(body) as Record<string, unknown>) : {};
  const text = (value: unknown, pattern: RegExp, code: string) => {
    if (typeof value !== "string" || !pattern.test(value))
      throw new HostError(code);
    return value;
  };
  const appId = () => text(input.appId, APP_ID, "invalid_app_id");
  const scope = () => text(input.scope, SCOPE, "invalid_scope");
  const query = new URL(request.url).searchParams;
  const reader = () => ({
    scope: text(query.get("scope"), SCOPE, "invalid_scope"),
    privileged: query.get("privileged") === "1",
  });
  if (request.method === "GET" && path === "/control/apps") {
    const { scope, privileged } = reader();
    return json({ apps: await registry.list(scope, privileged) });
  }
  let match = path.match(/^\/control\/apps\/([a-z0-9-]{1,48})$/);
  if (request.method === "GET" && match?.[1] && APP_ID.test(match[1])) {
    const { scope, privileged } = reader();
    return json(await registry.app(match[1], scope, privileged));
  }
  match = path.match(/^\/control\/receipts\/([a-f0-9]{64})$/);
  if (request.method === "GET" && match?.[1])
    return json(await registry.receipt(match[1]));
  if (request.method !== "POST") throw new HostError("not_found");
  if (path === "/control/prepare")
    return json(
      await registry.prepare({
        appId: appId(),
        files: input.files as Record<string, string>,
        access: input.access as Access,
        scope: scope(),
        requestId: text(input.requestId, DIGEST, "invalid_request"),
        title: typeof input.title === "string" ? input.title : null,
      }),
    );
  if (path === "/control/deploy")
    return json(
      await registry.deploy({
        receiptId: text(input.receiptId, DIGEST, "invalid_receipt"),
        appId: appId(),
        scope: scope(),
        privileged: input.privileged === true,
      }),
    );
  if (path === "/control/unpublish")
    return json(
      await registry.unpublish({
        appId: appId(),
        scope: scope(),
        privileged: input.privileged === true,
      }),
    );
  throw new HostError("not_found");
}

let accessKeys: { at: number; keys: Map<string, CryptoKey> } | undefined;
async function accessKey(env: Env, kid: string) {
  if (!accessKeys?.keys.has(kid) || Date.now() - accessKeys.at > 600_000) {
    const response = await fetch(`${env.ACCESS_ISSUER}/cdn-cgi/access/certs`);
    const { keys } = (await response.json()) as {
      keys: (JsonWebKey & { kid?: string })[];
    };
    const imported = new Map<string, CryptoKey>();
    for (const jwk of keys)
      if (jwk.kty === "RSA" && jwk.kid)
        imported.set(
          jwk.kid,
          await crypto.subtle.importKey(
            "jwk",
            jwk,
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          ),
        );
    accessKeys = { at: Date.now(), keys: imported };
  }
  return accessKeys.keys.get(kid);
}

/** Verify Cloudflare Access's signed assertion; never trust email headers. */
async function signedInEmail(request: Request, env: Env) {
  const token = request.headers.get("cf-access-jwt-assertion");
  const parts = token && token.length <= 16_384 ? token.split(".") : [];
  if (parts.length !== 3 || !env.ACCESS_AUD) return null;
  try {
    const decode = (part: string) =>
      JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
    const header = decode(parts[0] as string);
    const claims = decode(parts[1] as string);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    const key = await accessKey(env, header.kid);
    if (
      !key ||
      !(await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        fromBase64Url(parts[2] as string),
        encoder.encode(`${parts[0]}.${parts[1]}`),
      ))
    )
      return null;
    const now = Date.now() / 1000;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    // A signed human identity, not a service token or a bare email header.
    return claims.iss === env.ACCESS_ISSUER &&
      audience.includes(env.ACCESS_AUD) &&
      typeof claims.exp === "number" &&
      claims.exp > now &&
      typeof claims.iat === "number" &&
      claims.iat <= now + 60 &&
      typeof claims.sub === "string" &&
      claims.sub &&
      claims.type === "app" &&
      typeof claims.email === "string" &&
      claims.email.includes("@")
      ? claims.email
      : null;
  } catch {
    return null;
  }
}

function securityHeaders(headers: Headers) {
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("origin-agent-cluster", "?1");
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set(
    "content-security-policy",
    "frame-ancestors 'none'; worker-src 'none'; base-uri 'self'; form-action 'self'",
  );
  return headers;
}

function notFound(message = "No app is published here.") {
  return new Response(message, {
    status: 404,
    headers: securityHeaders(
      new Headers({ "content-type": "text/plain; charset=utf-8" }),
    ),
  });
}

async function storage(
  request: Request,
  env: Env,
  appId: string,
  access: Access,
  origin: string,
  rest: string,
) {
  // Separate per audience: going public never exposes data that signed-in
  // viewers wrote, and vice versa.
  const data = env.APP_DATA.get(env.APP_DATA.idFromName(`${appId}/${access}`));
  const method = request.method;
  // Every app shares a registrable domain; only the app's own pages may write.
  if (
    method !== "GET" &&
    request.headers.get("origin") !== origin &&
    request.headers.get("sec-fetch-site") !== "same-origin"
  )
    return json({ error: "cross_origin_write" }, 403);
  if (!rest) {
    if (method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const url = new URL(request.url);
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") ?? 100) || 100, 1),
      100,
    );
    return json({
      entries: await data.list(url.searchParams.get("prefix") ?? "", limit),
    });
  }
  let key: string;
  try {
    key = decodeURIComponent(rest);
  } catch {
    return json({ error: "invalid_key" }, 400);
  }
  if (!key || key.length > 256) return json({ error: "invalid_key" }, 400);
  if (method === "GET") {
    const value = await data.get(key);
    return value === null
      ? json({ error: "not_found" }, 404)
      : new Response(value, {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        });
  }
  if (method === "DELETE") {
    await data.delete(key);
    return json({ deleted: true });
  }
  const body = await request.text();
  if (bytes(body) > MAX_VALUE_BYTES)
    return json({ error: "value_too_large" }, 413);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (method === "PUT") {
    await data.put(key, JSON.stringify(value));
    return json({ key, value });
  }
  if (
    method === "POST" &&
    value &&
    typeof value === "object" &&
    "increment" in value &&
    typeof value.increment === "number" &&
    Number.isFinite(value.increment)
  )
    return json({ key, value: await data.increment(key, value.increment) });
  return json({ error: "method_not_allowed" }, 405);
}

async function view(request: Request, env: Env, label: string) {
  const access: Access = label.endsWith(SIGNED_IN_SUFFIX)
    ? "signed-in"
    : "public";
  const appId =
    access === "signed-in" ? label.slice(0, -SIGNED_IN_SUFFIX.length) : label;
  if (appId.length > 48 || !APP_ID.test(appId)) return notFound();
  const url = new URL(request.url);
  // The hostname fixes the audience; authenticate before reading anything.
  let email: string | null = null;
  if (access === "signed-in") {
    email = await signedInEmail(request, env);
    if (!email) return json({ error: "sign_in_required" }, 401);
  }
  if (url.pathname === "/_june/me")
    return json(access === "signed-in" ? { email } : { email: null });
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  if (url.pathname.startsWith("/_june/storage")) {
    const rest = url.pathname.slice("/_june/storage".length);
    if (rest && !rest.startsWith("/")) return notFound();
    // Storage exists only while the app is live for this exact audience.
    if (!(await registry.resolve(appId, access, []))) return notFound();
    return storage(request, env, appId, access, url.origin, rest.slice(1));
  }
  if (!["GET", "HEAD"].includes(request.method))
    return new Response("Method not allowed", { status: 405 });
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    return notFound();
  }
  const extension = path.includes(".") ? (path.split(".").pop() ?? "") : "";
  const candidates =
    !path || path.endsWith("/")
      ? [`${path}index.html`]
      : extension
        ? [path]
        : [`${path}/index.html`, `${path}.html`, "index.html"];
  const file = await registry.resolve(appId, access, candidates);
  if (!file) return notFound();
  if (!file.path || file.content === null)
    return notFound("Not found in this app.");
  const type =
    TYPES[file.path.split(".").pop()?.toLowerCase() ?? ""] ?? "text/plain";
  return new Response(request.method === "HEAD" ? null : file.content, {
    headers: securityHeaders(
      new Headers({ "content-type": `${type}; charset=utf-8` }),
    ),
  });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    try {
      if (host === env.APPS_DOMAIN) {
        if (url.pathname === "/health")
          return json({ ok: true, revision: env.REVISION ?? null });
        if (url.pathname.startsWith("/control/"))
          return await control(request, env);
        return new Response("June apps live on subdomains of this host.", {
          headers: securityHeaders(
            new Headers({ "content-type": "text/plain" }),
          ),
        });
      }
      const suffix = `.${env.APPS_DOMAIN}`;
      const label = host.endsWith(suffix) ? host.slice(0, -suffix.length) : "";
      if (!label || label.includes(".")) return notFound();
      return await view(request, env, label);
    } catch (error) {
      if (error instanceof SyntaxError)
        return json({ error: "invalid_json" }, 400);
      // Durable Object RPC errors keep only the HostError code as message.
      const code =
        error instanceof Error && /^[a-z_]{3,64}$/.test(error.message)
          ? error.message
          : "apps_host_error";
      return json(
        { error: code },
        code === "apps_host_error" ? 500 : (STATUS[code] ?? 400),
      );
    }
  },
} satisfies ExportedHandler<Env>;
