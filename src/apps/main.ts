import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { secret } from "../config.js";
import { createAppsHost } from "./host.js";

/** Separate entrypoint; importing June never imports or starts Dynamic Apps. */
async function main() {
  process.umask(0o077);
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
  process.env.RIVETKIT_STORAGE_PATH = config.directory;
  process.env.RIVET_INSPECTOR_DISABLE = "1";
  const { deployApp, appsRouter } = await import("@rivet-dev/dynamic-apps");
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
  });
  serve({ fetch: host.app.fetch, hostname: "127.0.0.1", port: config.port });
  // Use a service manager to stop the whole dedicated cgroup. An interrupted
  // deployment is intentionally left unknown; startup will not replay it.
}

main().catch(() => {
  console.error(
    "Dynamic Apps host failed to start; check dedicated configuration and storage permissions.",
  );
  process.exitCode = 1;
});
