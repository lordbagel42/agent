/** Repository-scoped GitHub App installation credentials; never a person's token. */
import { createSign } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { Clock, Duration, Effect, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { exchange, type HttpFailure } from "./http.js";
import { asRecord, get } from "./json.js";
import { dumps, isInt, loads } from "./pyjson.js";

export class GitHubError extends Schema.TaggedError<GitHubError>()(
  "GitHubError",
  { reason: Schema.String },
) {}

const fail = (reason: string) => Effect.fail(new GitHubError({ reason }));

/** Root-owned, owner-only, single-link regular file read without following links. */
export function privateFile(path: string): string {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = fstatSync(fd);
    if (
      metadata.uid !== 0 ||
      metadata.mode & 0o077 ||
      metadata.nlink !== 1 ||
      !metadata.isFile()
    )
      throw new Error("private_root_file_required");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

const encode = (value: string | Uint8Array) =>
  Buffer.from(value).toString("base64url");

/** Python `datetime.fromisoformat(value.replace("Z", "+00:00"))` with a zone. */
function zonedTimestamp(value: unknown): number | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    return undefined;
  const millis = Date.parse(value.replace(" ", "T"));
  return Number.isNaN(millis) ? undefined : millis / 1000;
}

export interface AppConfig {
  readonly appId: number;
  readonly installationId: number;
  readonly privateKeyFile: string;
}

export const validApp = (app: unknown): app is AppConfig => {
  const record = asRecord(app);
  return (
    !!record &&
    Object.keys(record).sort().join() ===
      "appId,installationId,privateKeyFile" &&
    ["appId", "installationId"].every(
      (key) => isInt(record[key]) && (record[key] as number) > 0,
    ) &&
    typeof record.privateKeyFile === "string" &&
    record.privateKeyFile.startsWith("/")
  );
};

export class GitHubApp {
  appToken: string | null = null;
  appTokenExpiry = 0;
  /** Test seam; production reads the root-only App key. */
  readKey: (path: string) => string = privateFile;

  constructor(
    readonly app: unknown,
    readonly permissions: Readonly<Record<string, string>>,
  ) {}

  token(): Effect.Effect<
    string,
    GitHubError | HttpFailure,
    HttpClient.HttpClient
  > {
    const self = this;
    return Effect.gen(function* () {
      const app = self.app;
      if (!validApp(app)) return yield* fail("invalid_github_app");
      const now = (yield* Clock.currentTimeMillis) / 1000;
      if (self.appToken && now < self.appTokenExpiry - 60) return self.appToken;
      self.appToken = null;
      const issued = Math.floor(now);
      const message = [
        { alg: "RS256", typ: "JWT" },
        { iss: String(app.appId), iat: issued - 60, exp: issued + 540 },
      ]
        .map((value) => encode(dumps(value)))
        .join(".");
      const pem = yield* Effect.try({
        try: () => self.readKey(app.privateKeyFile),
        catch: () => new GitHubError({ reason: "private_root_file_required" }),
      });
      const signature = yield* Effect.try({
        try: () => createSign("sha256").update(message).sign(pem),
        catch: () => new GitHubError({ reason: "github_signing_failed" }),
      });
      const jwt = `${message}.${encode(signature)}`;
      const installation = yield* self.request(
        jwt,
        "GET",
        "repos/lordbagel42/agent/installation",
      );
      if (
        get(installation, "id") !== app.installationId ||
        get(installation, "app_id") !== app.appId ||
        get(get(installation, "account"), "login") !== "lordbagel42"
      )
        return yield* fail("wrong_github_installation");
      const grant = yield* self.request(
        jwt,
        "POST",
        `app/installations/${app.installationId}/access_tokens`,
        { repositories: ["agent"], permissions: self.permissions },
      );
      const permissions = { ...(asRecord(get(grant, "permissions")) ?? {}) };
      if (permissions.metadata === "read") delete permissions.metadata;
      const expires = zonedTimestamp(get(grant, "expires_at"));
      const repositories = get(grant, "repositories");
      const token = get(grant, "token");
      const later = (yield* Clock.currentTimeMillis) / 1000;
      if (
        !sameGrant(permissions, self.permissions) ||
        !Array.isArray(repositories) ||
        repositories.length !== 1 ||
        get(repositories[0], "full_name") !== "lordbagel42/agent" ||
        expires === undefined ||
        expires <= later + 60 ||
        typeof token !== "string" ||
        !/^[\x21-\x7e]+$/.test(token)
      )
        return yield* fail("invalid_github_grant");
      self.appToken = token;
      self.appTokenExpiry = expires;
      return token;
    });
  }

  request(
    token: string,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Effect.Effect<unknown, GitHubError | HttpFailure, HttpClient.HttpClient> {
    const self = this;
    return Effect.gen(function* () {
      const reply = yield* exchange({
        method,
        url: `https://api.github.com/${path}`,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "june-deploy",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        ...(body === undefined ? {} : { body: dumps(body) }),
        timeout: Duration.seconds(5),
        limit: 1024 * 1024,
      }).pipe(
        Effect.mapError((error) =>
          error.reason === "response_too_large"
            ? new GitHubError({ reason: "github_response_too_large" })
            : error,
        ),
      );
      if (isRedirect(reply.status)) return yield* fail("redirect_denied");
      if (reply.status < 200 || reply.status >= 300) {
        // Never read a provider error body; a rejected token is discarded.
        self.appToken = null;
        return yield* fail("github_status_failed");
      }
      if (reply.status !== (method === "POST" ? 201 : 200))
        return yield* fail("github_status_failed");
      return yield* Effect.try({
        try: () => loads(reply.body),
        catch: () => new GitHubError({ reason: "github_invalid_json" }),
      });
    });
  }
}

/** urllib hands these to its redirect handler; every other non-2xx is an HTTPError. */
export const isRedirect = (status: number) =>
  [301, 302, 303, 307, 308].includes(status);

const sameGrant = (
  actual: Record<string, unknown>,
  expected: Readonly<Record<string, string>>,
) =>
  Object.keys(actual).length === Object.keys(expected).length &&
  Object.entries(expected).every(([key, value]) => actual[key] === value);
