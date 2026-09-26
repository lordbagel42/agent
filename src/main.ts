import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createClient } from "rivetkit/client";
import { createSlackAdapter } from "./channels/slack.js";
import { createSlackIngressDiagnostics } from "./channels/slack-ingress.js";
import { createWhatsAppAdapter } from "./channels/whatsapp.js";
import { createAmpRuntime } from "./coding/amp.js";
import { parseConfig, secret } from "./config.js";
import type { Channel, ChannelAdapter } from "./core/contracts.js";
import { createHttpApp } from "./http/app.js";
import { createCodexProvider } from "./models/codex.js";
import { createModelProvider } from "./models/provider.js";
import { createJuneRegistry, type JuneRegistry } from "./runtime/registry.js";

let startupStage = "configuration (JUNE_CONFIG, default config.local.json)";

async function main() {
  const config = parseConfig(
    JSON.parse(
      await readFile(process.env.JUNE_CONFIG ?? "config.local.json", "utf8"),
    ),
  );
  if (config.coding.enabled) {
    startupStage =
      "native coding: requires JUNE_ALLOW_NATIVE_CODING=1 on a dedicated host";
    if (process.env.JUNE_ALLOW_NATIVE_CODING !== "1")
      throw new Error("Native coding not allowed");
    startupStage = "coding workspace paths";
    if (!Object.keys(config.coding.workspaces).length)
      throw new Error("No workspaces configured");
    for (const [name, path] of Object.entries(config.coding.workspaces)) {
      const canonical = await realpath(path);
      if (!(await stat(canonical)).isDirectory())
        throw new Error("Workspace is not a directory");
      config.coding.workspaces[name] = canonical;
    }
  }
  startupStage = "operator credential (at least 32 characters)";
  const operatorToken = secret(config.operatorTokenEnv);
  if (operatorToken.length < 32) throw new Error("Short operator token");
  startupStage = "model credentials";
  const model =
    config.model.protocol === "codex"
      ? createCodexProvider(config.model)
      : createModelProvider({
          ...config.model,
          apiKey: secret(config.model.apiKeyEnv),
        });
  const channels: Partial<Record<Channel, ChannelAdapter>> = {};
  const slackIngressDiagnostics = config.slack
    ? createSlackIngressDiagnostics()
    : undefined;
  if (config.slack) {
    startupStage = "Slack credentials";
    channels.slack = createSlackAdapter({
      ...config.slack,
      signingSecret: secret(config.slack.signingSecretEnv),
      botToken: secret(config.slack.botTokenEnv),
      ingressDiagnostics: slackIngressDiagnostics,
    });
  }
  if (config.whatsapp) {
    startupStage = "WhatsApp credentials";
    channels.whatsapp = createWhatsAppAdapter({
      ...config.whatsapp,
      appSecret: secret(config.whatsapp.appSecretEnv),
      verifyToken: secret(config.whatsapp.verifyTokenEnv),
      accessToken: secret(config.whatsapp.accessTokenEnv),
    });
  }
  startupStage = "Rivet configuration/startup";
  process.env.RIVETKIT_STORAGE_PATH ??= resolve(".data");
  process.env.RIVET_INSPECTOR_DISABLE ??= "1";
  const registry = createJuneRegistry({
    owner: config.owner,
    channels,
    model,
    coding: config.coding.enabled
      ? { ...config.coding, runtime: createAmpRuntime() }
      : undefined,
  });
  Object.assign(registry.config, {
    startEngine: !process.env.RIVET_ENDPOINT && !process.env.RIVET_ENGINE,
    engineHost: "127.0.0.1",
    noWelcome: true,
    shutdown: { disableSignalHandlers: true },
  });
  const runtime = registry.parseConfig();
  const client = createClient<JuneRegistry>({
    endpoint: runtime.endpoint,
    namespace: runtime.namespace,
    token: runtime.token,
    poolName: runtime.envoy.poolName,
  });
  const june = client.conversation.getOrCreate(["private", config.owner.id]);
  const app = createHttpApp({
    owner: config.owner,
    channels,
    operatorToken,
    slackIngressDiagnostics,
    console: config.console
      ? {
          origin: config.console.origin,
          async inspect() {
            // Project only allowlisted facts. Never serialize config, messages,
            // job goals/reports, provider paths or arbitrary actor state to HTML.
            const state = await june.snapshot().catch(() => undefined);
            const ingress = slackIngressDiagnostics?.snapshot();
            return {
              observedAt: new Date().toISOString(),
              sections: {
                configuration: {
                  status: "available",
                  detail:
                    "Read-only host configuration. Credentials are never shown.",
                  records: [
                    {
                      title: "Companion model",
                      status: "configured",
                      detail: `${config.model.protocol} · ${config.model.model}. Configuration is not proof of provider authentication or availability.`,
                    },
                    {
                      title: "Messaging",
                      status: config.setupMode ? "setup mode" : "configured",
                      detail: `${Object.keys(channels).join(", ") || "No channels"} · ${config.owner.identities.length} allowed owner identities.`,
                    },
                    {
                      title: "Private conversation",
                      status: state ? "observed" : "unavailable",
                      detail: state
                        ? `${Object.keys(state.events).length} durable events · ${Object.values(state.events).filter((event) => !event.done).length} not finished. Message content is not displayed.`
                        : "The runtime snapshot could not be read. No state is confirmed.",
                    },
                    {
                      title: "Slack ingress",
                      status: ingress ? "observed" : "not configured",
                      detail: ingress
                        ? `Since ${new Date(ingress.startedAt).toISOString()}: ${ingress.counts.arrival ?? 0} arrivals · ${ingress.counts.signature_verified ?? 0} verified · ${ingress.counts.submission_succeeded ?? 0} submitted. Process-local counts do not prove a reply.`
                        : "No Slack adapter is mounted.",
                    },
                  ],
                },
                capabilities: {
                  status: "available",
                  detail:
                    "Availability follows host configuration, not model claims.",
                  records: [
                    {
                      title: "Native coding",
                      status: config.coding.enabled ? "configured" : "disabled",
                      detail:
                        "Separate approval and host isolation are required. This console cannot start, resume or cancel jobs.",
                    },
                    {
                      title: "Public Slack search",
                      status: config.slack?.searchEnabled
                        ? "configured"
                        : "disabled",
                      detail:
                        "Requires a current user request and Slack authorization. Private search is not connected.",
                    },
                    {
                      title: "Imports, tools and deployment",
                      status: "not connected",
                      detail:
                        "No import, tool broker, browser or release authority is mounted in this host.",
                    },
                  ],
                },
                jobs: {
                  status: state ? "available" : "unavailable",
                  detail:
                    "Only the owner's saved proposal count is inspected. Worker execution and settlement are not inferred.",
                  records: state
                    ? [
                        {
                          title: "Coding proposals",
                          status: "recorded",
                          detail: `${Object.keys(state.jobs).length} proposals in the private conversation. Detailed job inspection remains in the authenticated operator API.`,
                        },
                      ]
                    : [],
                },
              },
            };
          },
        }
      : undefined,
    async submit(scope, event) {
      await client.conversation
        .getOrCreate(scope.key)
        .send("inbox", { type: "event", event });
    },
    async ready() {
      return (await registry.routes.health()).ok;
    },
    inspectConversation: () => june.snapshot(),
    async inspectJob(id) {
      if (!Object.hasOwn((await june.snapshot()).jobs, id)) return undefined;
      return client.job.getOrCreate([config.owner.id, id]).snapshot();
    },
    async resumeJob(id, commandId) {
      if (
        !config.coding.enabled ||
        !Object.hasOwn((await june.snapshot()).jobs, id)
      )
        return false;
      const job = client.job.getOrCreate([config.owner.id, id]);
      const state = await job.snapshot();
      if (Object.hasOwn(state.commandApprovals, commandId))
        return state.commandApprovals[commandId] !== null;
      if (state.status !== "needs_review" || !state.threadId) return false;
      await job.send("commands", {
        type: "resume",
        commandId,
        confirmedStopped: true,
      });
      return true;
    },
  });
  registry.start();
  startupStage = "HTTP listener";
  const server = serve(
    { fetch: app.fetch, hostname: config.host, port: config.port },
    () => {
      console.info(
        `June listening on ${config.host}:${config.port}. Coding ${config.coding.enabled ? "enabled (native, not sandboxed)" : "disabled"}.`,
      );
      if (config.setupMode)
        console.info(
          "June is in setup mode; no messaging channels are active.",
        );
    },
  );
  let stopping: Promise<void> | undefined;
  const shutdown = () =>
    (stopping ??= (async () => {
      await new Promise<void>((done) => server.close(() => done()));
      await client.dispose();
      await registry.shutdown();
      // Rivet's own signal handler terminates after draining. With custom signal
      // handling we own that final step too; native runtime handles may remain.
    })().then(
      () => {
        process.exit(process.exitCode ?? 0);
      },
      () => {
        console.error("June could not finish a graceful shutdown.");
        process.exit(1);
      },
    ));
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void shutdown();
    });
  server.once("error", () => {
    console.error("June HTTP listener failed; check host and port.");
    process.exitCode = 1;
    void shutdown();
  });
}

await main().catch(() => {
  // Provider/transport exceptions can contain credentials or message bodies.
  console.error(`June startup failed at ${startupStage}.`);
  process.exitCode = 1;
});
