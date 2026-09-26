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
