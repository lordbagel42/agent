import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
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
const app = createDebugSite({
  origin,
  viewerToken,
  ingestToken,
  store,
  assets: fileURLToPath(new URL("./public", import.meta.url)),
  revision: process.env.JUNE_DEBUG_BUILD_REVISION,
});
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () =>
  console.info("june_debug_ready"),
);
const stop = () =>
  server.close(() => {
    store.close();
    process.exit(0);
  });
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
