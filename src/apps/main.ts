import { createHash } from "node:crypto";
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { secret } from "../config.js";
import { createAppsHost } from "./host.js";

/** Separate entrypoint; importing June never imports or starts Dynamic Apps. */
async function main() {
  process.umask(0o077);
  if (!process.send) throw new Error("supervised_entrypoint_required");
  if (process.env.JUNE_ALLOW_DYNAMIC_APPS !== "1")
    throw new Error("dedicated_app_host_required");
  const config = z
    .strictObject({
      port: z.number().int().min(1024).max(65535),
      directory: z.string().refine(isAbsolute),
      origin: z
        .url()
        .refine(
          (value) =>
            new URL(value).origin === value &&
            (value.startsWith("https://") ||
              /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(value)),
        ),
      controlTokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
      viewerTokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    })
    .parse(
      JSON.parse(
        await readFile(
          process.env.JUNE_APPS_CONFIG ?? "apps.local.json",
          "utf8",
        ),
      ),
    );
  const metadata = await stat(config.directory);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0 ||
    (await realpath(config.directory)) !== config.directory
  )
    throw new Error("private_app_storage_required");
  // Require an explicitly provisioned, dedicated engine. Never discover June's
  // embedded engine or silently use Rivet Cloud credentials from the environment.
  if (
    !process.env.RIVET_ENDPOINT ||
    !process.env.RIVET_NAMESPACE ||
    !process.env.RIVET_POOL ||
    !process.env.RIVET_TOKEN ||
    process.env.RIVET_CLOUD_TOKEN ||
    process.env.RIVET_ENGINE ||
    process.env.RIVET_PUBLIC_ENDPOINT ||
    process.env.DYNAMIC_APPS_CALLBACK_URL
  )
    throw new Error("dedicated_rivet_configuration_required");
  const auditPath = join(config.directory, "audit.ndjson");
  let auditHealthy = true;
  let lastAuditProbe = 0;
  const log = (event: Record<string, string | number>) => {
    const line = JSON.stringify({ time: new Date().toISOString(), ...event });
    console.info(line);
    try {
      // Two bounded files survive pod replacement with the private state PVC.
      if (existsSync(auditPath) && statSync(auditPath).size >= 5 * 1024 * 1024)
        renameSync(auditPath, `${auditPath}.1`);
      appendFileSync(auditPath, `${line}\n`, { mode: 0o600 });
      auditHealthy = true;
    } catch {
      auditHealthy = false;
      console.error('{"event":"audit_write_failed"}');
    }
  };
  log({ event: "starting" });
  process.env.RIVETKIT_STORAGE_PATH = config.directory;
  process.env.RIVET_INSPECTOR_DISABLE = "1";
  const { deployApp, appsRouter, setDynamicAppsLogHandler } = await import(
    "@rivet-dev/dynamic-apps"
  );
  setDynamicAppsLogHandler((entry) => {
    // SDK messages/metadata can contain generated console output or source.
    // Keep only its operational classifications and content-addressed release.
    log({
      event: "sdk",
      level: entry.level,
      source: entry.source,
      ...(entry.release && /^[a-f0-9]{64}$/.test(entry.release)
        ? { release: entry.release }
        : {}),
    });
  });
  const routes = new Hono();
  routes.route("/apps", appsRouter);
  const host = createAppsHost({
    database: join(config.directory, "deployments.sqlite"),
    controlToken: secret(config.controlTokenEnv),
    viewerToken: secret(config.viewerTokenEnv),
    origin: config.origin,
    binding: createHash("sha256")
      .update(
        JSON.stringify([
          config.origin,
          process.env.RIVET_ENDPOINT,
          process.env.RIVET_NAMESPACE,
          process.env.RIVET_POOL,
        ]),
      )
      .digest("hex"),
    // Secondary SDK guard: app actors require a namespace. Source validation
    // rejects rivetkit first; never pass the host's engine token to guest actors.
    deploy: (artifact) => deployApp({ ...artifact, createNamespace: false }),
    serve: (request) => Promise.resolve(routes.fetch(request)),
    log,
    ready: () => {
      if (!auditHealthy || Date.now() - lastAuditProbe >= 30_000) {
        log({ event: "audit_probe" });
        lastAuditProbe = Date.now();
      }
      if (!auditHealthy) return Promise.resolve(false);
      // Listener readiness is deliberately not an end-to-end engine check.
      // Commissioning must also exercise deployment and serving with real state.
      const engine = new URL(process.env.RIVET_ENDPOINT as string);
      return new Promise<boolean>((resolve) => {
        const socket = createConnection({
          host: engine.hostname,
          port: Number(
            engine.port || (engine.protocol === "https:" ? 443 : 80),
          ),
        });
        const finish = (ready: boolean) => {
          socket.destroy();
          resolve(ready);
        };
        socket.setTimeout(2000, () => finish(false));
        socket.once("error", () => finish(false));
        socket.once("connect", () => finish(true));
      });
    },
  });
  const server = serve({
    fetch: host.app.fetch,
    hostname: "127.0.0.1",
    port: config.port,
  });
  log({ event: "listening" });
  const shutdown = async () => {
    log({ event: "draining" });
    const closed = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    await host.close();
    await closed;
    log({ event: "receipts_flushed" });
    // Only now may the supervisor signal the SDK's independent registry drain.
    process.send?.("drained");
  };
  process.once("message", (message) => {
    if (message === "drain") void shutdown();
  });
  process.send("ready");
  // The container manager must stop the whole process tree. Interrupted
  // deployments remain unknown; neither startup nor shutdown retries them.
}

main().catch(() => {
  console.error(
    "Dynamic Apps host failed to start; check dedicated configuration and storage permissions.",
  );
  process.exitCode = 1;
});
