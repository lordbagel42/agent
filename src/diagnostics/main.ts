import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createDebugSiteDeploymentReader } from "./deployment.js";
import { createIssueGitHub } from "./github-issues.js";
import { IssueCredentials } from "./issue-credentials.js";
import { IssueTracker } from "./issue-tracker.js";
import { createDebugSite } from "./server.js";
import { DiagnosticStore } from "./store.js";

// This entry point is bundled and installed separately from June's releases.
// No .env/config from June, provider clients, Rivet engine or deployment hooks.
process.umask(0o077);
const file = process.env.JUNE_DEBUG_DATABASE;
const origin = process.env.JUNE_DEBUG_ORIGIN;
const viewerToken = process.env.JUNE_DEBUG_VIEWER_TOKEN;
const ingestToken = process.env.JUNE_DEBUG_INGEST_TOKEN;
const port = Number(process.env.PORT ?? 3092);
if (
  !file ||
  !isAbsolute(file) ||
  !origin ||
  !viewerToken ||
  !ingestToken ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    "Debug site requires its own database, origin, credentials and valid port",
  );
const store = new DiagnosticStore(file);
const issueToken = process.env.JUNE_DEBUG_ISSUE_TOKEN;
const githubToken = process.env.JUNE_DEBUG_GITHUB_TOKEN;
const refreshToken = process.env.JUNE_DEBUG_GITHUB_REFRESH_TOKEN;
const creatorId = Number(process.env.JUNE_DEBUG_GITHUB_ACTOR_ID);
const issueEnabled = process.env.JUNE_DEBUG_ISSUES_ENABLED === "1";
if (
  issueEnabled &&
  (!issueToken ||
    Boolean(githubToken) === Boolean(refreshToken) ||
    !Number.isSafeInteger(creatorId) ||
    creatorId < 1)
)
  throw new Error(
    "Issue tracking requires automation credentials, exactly one static or refresh GitHub credential, and a verified GitHub actor ID",
  );
const credentials =
  issueEnabled && refreshToken ? new IssueCredentials() : undefined;
const issues =
  issueEnabled && issueToken && (githubToken || credentials)
    ? {
        token: issueToken,
        operatorToken: process.env.JUNE_DEBUG_ISSUE_OPERATOR_TOKEN,
        tracker: new IssueTracker({
          store,
          origin,
          creatorId,
          github: createIssueGitHub({
            token: credentials ? () => credentials.get() : (githubToken ?? ""),
          }),
          credentialStatus: credentials
            ? () => credentials.status()
            : undefined,
        }),
      }
    : undefined;
const app = createDebugSite({
  origin,
  viewerToken,
  ingestToken,
  operationsToken: process.env.JUNE_DEBUG_OPERATIONS_TOKEN,
  store,
  assets: fileURLToPath(new URL("./public", import.meta.url)),
  revision: process.env.JUNE_DEBUG_BUILD_REVISION,
  deployment: createDebugSiteDeploymentReader({
    file: "/var/lib/june-debug-deploy/public/status.json",
  }),
  issues,
  issueCredentials:
    credentials && refreshToken
      ? { token: refreshToken, value: credentials }
      : undefined,
});
let timer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
let syncing: Promise<void> = Promise.resolve();
const poll = () => {
  if (!issues || stopping) return;
  syncing = issues.tracker
    .sync()
    .catch(() => {
      console.error("issue_sync_unavailable");
    })
    .finally(() => {
      if (!stopping) timer = setTimeout(poll, 30_000);
    });
};
poll();
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () =>
  console.info("june_debug_ready"),
);
const stop = () => {
  stopping = true;
  clearTimeout(timer);
  server.close(async () => {
    await syncing;
    store.close();
    process.exit(0);
  });
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
