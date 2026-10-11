/**
 * Root-only GitHub App renewal on June's host, separate from source metadata.
 *
 * Uses the existing App key in place; never copy it to the debug host or Amp.
 * Only agent Issues-write/Contents-read tokens cross the reviewed HTTPS route.
 * Refresh credentials, tokens, grants and provider responses never enter logs,
 * argv, persistent state, source receipts or agent tools. See docs/debug-site.md.
 */
import { Clock, Duration, Effect } from "effect";
import {
  absolute,
  IssueError,
  parseJson,
  positive,
  readPrivate,
  validateOrigin,
} from "./issues.js";
import { GitHubApp, GitHubError } from "./lib/github.js";
import { exchange, layer as httpLayer } from "./lib/http.js";
import { asRecord } from "./lib/json.js";
import { runMain } from "./lib/main.js";
import { dumps } from "./lib/pyjson.js";

export const CONFIG = "/etc/june-issues/credentials.json";
export const POLL_SECONDS = 60;

const invalid = () => new IssueError({ reason: "invalid_renewal_config" });

export function validateConfig(config: unknown) {
  const record = asRecord(config);
  if (
    !record ||
    Object.keys(record).sort().join() !== "githubApp,origin,tokenFile"
  )
    throw invalid();
  const origin = validateOrigin(record.origin);
  if (!origin.startsWith("https://") || !absolute(record.tokenFile))
    throw invalid();
  const app = asRecord(record.githubApp);
  if (
    !app ||
    Object.keys(app).sort().join() !== "appId,installationId,privateKeyFile" ||
    !positive(app.appId) ||
    !positive(app.installationId) ||
    !absolute(app.privateKeyFile)
  )
    throw invalid();
  return { ...record, origin } as {
    origin: string;
    tokenFile: string;
    githubApp: Record<string, unknown>;
  };
}

/** `datetime.fromtimestamp(value, timezone.utc).isoformat()` */
export function isoformat(seconds: number): string {
  const date = new Date(Math.floor(seconds * 1000));
  const micros = Math.round((seconds - Math.floor(seconds)) * 1e6) % 1e6;
  const base = date.toISOString().slice(0, 19);
  return `${base}${micros ? `.${String(micros).padStart(6, "0")}` : ""}+00:00`;
}

const monotonic = () => performance.now() / 1000;

export class Renewer {
  readonly config: ReturnType<typeof validateConfig>;
  readonly github: GitHubApp;
  deadline = 0;

  constructor(config: unknown) {
    this.config = validateConfig(config);
    this.github = new GitHubApp(this.config.githubApp, {
      issues: "write",
      contents: "read",
    });
  }

  pollOnce() {
    const self = this;
    return Effect.gen(function* () {
      const github = self.github;
      // Rotate with ten minutes remaining on either clock, leaving ample room
      // for transient delivery failures and the site's early-expiry budget.
      const now = (yield* Clock.currentTimeMillis) / 1000;
      if (now >= github.appTokenExpiry - 600 || monotonic() >= self.deadline)
        github.appToken = null;
      const cached = github.appToken !== null;
      const token = yield* github.token(); // Validates exact repository and permissions.
      const remaining =
        github.appTokenExpiry - (yield* Clock.currentTimeMillis) / 1000;
      if (
        !(300 < remaining && remaining <= 3660) ||
        !/^[A-Za-z0-9._~-]{1,4096}$/.test(token)
      ) {
        github.appToken = null;
        return yield* new GitHubError({ reason: "invalid_issue_grant" });
      }
      if (!cached) self.deadline = monotonic() + remaining - 600;
      const refresh = readPrivate(self.config.tokenFile, { limit: 4096 })
        .toString("utf8")
        .trim();
      if (!/^[A-Za-z0-9._~+/-]{32,4096}=*$/.test(refresh))
        return yield* new GitHubError({ reason: "invalid_renewal_credential" });
      const reply = yield* exchange({
        method: "POST",
        url: `${self.config.origin}/api/issue-github-token`,
        headers: {
          Authorization: `Bearer ${refresh}`,
          "Content-Type": "application/json",
          "User-Agent": "june-issue-renewer",
        },
        body: dumps({
          version: 1,
          token,
          expiresAt: isoformat(github.appTokenExpiry),
        }),
        timeout: Duration.seconds(10),
        limit: 65_536,
      });
      // Never read or log a proxy/provider response body.
      if (reply.status !== 204)
        return yield* new GitHubError({
          reason: "issue_credential_delivery_failed",
        });
    });
  }
}

export const main = Effect.gen(function* () {
  if (process.geteuid?.() !== 0)
    return yield* new IssueError({ reason: "renewal_root_required" });
  process.umask(0o077);
  const renewer = new Renewer(parseJson(readPrivate(CONFIG, { limit: 4096 })));
  for (;;) {
    // Re-delivery restores an empty site cache after restart; accepting
    // the same grant never extends its expiry or repeats an issue write.
    yield* renewer
      .pollOnce()
      .pipe(
        Effect.catchCause(() =>
          Effect.sync(() =>
            process.stderr.write("june_issue_credential_unavailable\n"),
          ),
        ),
      );
    yield* Effect.sleep(Duration.seconds(POLL_SECONDS));
  }
}).pipe(Effect.provide(httpLayer));

// No config, key or subprocess errors in logs.
export const run = () =>
  runMain(main, { message: "june_issue_credential_configuration_invalid" });
