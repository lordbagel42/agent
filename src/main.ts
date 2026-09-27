import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { createClient } from "rivetkit/client";
import { z } from "zod";
import { createSlackAdapter } from "./channels/slack.js";
import { createSlackIngressDiagnostics } from "./channels/slack-ingress.js";
import { SlackThreads } from "./channels/slack-threads.js";
import { createWhatsAppAdapter } from "./channels/whatsapp.js";
import { createAmpRuntime } from "./coding/amp.js";
import { createClaudeRuntime } from "./coding/claude.js";
import { createCodexRuntime } from "./coding/codex.js";
import { createPiRuntime } from "./coding/pi.js";
import { createWorktreeManager } from "./coding/worktree.js";
import { parseConfig, secret } from "./config.js";
import type {
  Channel,
  ChannelAdapter,
  CodingRuntime,
  ModelProvider,
} from "./core/contracts.js";
import {
  createDeploymentReader,
  createReleaseTool,
} from "./deployment/feed.js";
import { createHttpApp } from "./http/app.js";
import { createImportRoutes } from "./http/imports.js";
import { createMemoryRoutes } from "./http/memory.js";
import {
  createGmailHistoryFetcher,
  createSlackHistoryFetcher,
  HistoryImports,
  slackSource,
} from "./imports/index.js";
import { CuratedPersonalityStore } from "./memory/curated.js";
import { EvidenceStore, extractMemory } from "./memory/store.js";
import { createHotCodexProvider } from "./models/codex-hot.js";
import { createDecisionProvider } from "./models/decision.js";
import { createMemoryExtractor } from "./models/extraction.js";
import { createModelProvider } from "./models/provider.js";
import { UsageLedger } from "./models/usage.js";
import { freshEvidence } from "./reflection/domain.js";
import { createInspectionReader } from "./runtime/inspection.js";
import { createLatencyDiagnostics } from "./runtime/latency.js";
import { createLifecycle } from "./runtime/lifecycle.js";
import {
  createJuneRegistry,
  type Dependencies,
  type JuneClientRegistry,
} from "./runtime/registry.js";
import { SocialPermissions } from "./runtime/social.js";
import { McpConnections } from "./tools/connections.js";
import { createSlackMcpOAuth } from "./tools/slack-mcp-oauth.js";
import { createTavilyWebSearchProvider } from "./tools/web-search.js";

let startupStage = "configuration (JUNE_CONFIG, default config.local.json)";
const hotProviders: ReturnType<typeof createHotCodexProvider>[] = [];

function within(parent: string, child: string) {
  const path = relative(parent, child);
  return (
    !path ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

async function privateDirectory(path: string) {
  const metadata = await stat(path);
  if (
    (await realpath(path)) !== path ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.uid !== process.getuid?.()
  )
    throw new Error("Private canonical directory required");
  for (let parent = path; ; parent = dirname(parent)) {
    if (
      await stat(join(parent, ".git")).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return false;
        },
      )
    )
      throw new Error("Private storage must be outside repositories");
    if (parent === dirname(parent)) break;
  }
}

function memoryKey(name: string) {
  const key = secret(name);
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== key)
    throw new Error("Expected a base64 encoded 32-byte key");
  return bytes;
}

async function main() {
  process.umask(0o077);
  const config = parseConfig(
    JSON.parse(
      await readFile(process.env.JUNE_CONFIG ?? "config.local.json", "utf8"),
    ),
  );
  startupStage = "immutable release marker";
  // Resolve from this loaded source, never from a later-switched current symlink.
  const releaseRoot = dirname(
    dirname(await realpath(fileURLToPath(import.meta.url))),
  );
  const marker = await readFile(
    join(releaseRoot, ".june-release.json"),
    "utf8",
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && !config.deployment) return undefined;
    throw error;
  });
  const release =
    marker === undefined
      ? undefined
      : z
          .strictObject({
            revision: z.string().regex(/^[a-f0-9]{40}$/),
            compatibility: z.string().regex(/^[a-f0-9]{64}$/),
            binding: z.string().regex(/^[a-f0-9]{64}$/),
            artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(JSON.parse(marker));
  const lifecycle = createLifecycle();
  const readDeployment = config.deployment
    ? createDeploymentReader({
        file: config.deployment.eventsFile,
        ownerId: config.owner.id,
      })
    : undefined;
  let coding: Dependencies["coding"];
  const isolation: NonNullable<Dependencies["coding"]>["isolation"] = {};
  if (config.coding.enabled) {
    startupStage =
      "native coding: requires JUNE_ALLOW_NATIVE_CODING=1 on a dedicated host";
    if (process.env.JUNE_ALLOW_NATIVE_CODING !== "1")
      throw new Error("Native coding not allowed");
    startupStage = "coding workspace paths";
    if (!Object.keys(config.coding.workspaces).length)
      throw new Error("No workspaces configured");
    const roots: string[] = [];
    const repositories = new Set<string>();
    for (const [name, path] of Object.entries(config.coding.workspaces)) {
      const canonical = await realpath(path);
      if (!(await stat(canonical)).isDirectory())
        throw new Error("Workspace is not a directory");
      const policy = config.coding.isolation[name];
      if (!policy) throw new Error("Missing isolation policy");
      const worktreeRoot = await realpath(policy.worktreeRoot);
      if (!(await stat(worktreeRoot)).isDirectory())
        throw new Error("Invalid worktree root");
      const git = async (args: string[]) =>
        (
          await promisify(execFile)(
            "git",
            [
              "-c",
              "core.hooksPath=/dev/null",
              "-c",
              "core.fsmonitor=false",
              ...args,
            ],
            {
              cwd: canonical,
              env: {
                PATH: process.env.PATH,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_TERMINAL_PROMPT: "0",
              },
              timeout: 10000,
            },
          )
        ).stdout.trim();
      if ((await git(["rev-parse", "--show-toplevel"])) !== canonical)
        throw new Error("Repository root required");
      const common = await realpath(
        await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      );
      if (repositories.has(common))
        throw new Error("Repository aliases cannot have independent admission");
      repositories.add(common);
      for (const candidate of [canonical, worktreeRoot]) {
        if (
          roots.some(
            (root) => within(root, candidate) || within(candidate, root),
          )
        )
          throw new Error("Coding roots must not overlap");
        roots.push(candidate);
      }
      config.coding.workspaces[name] = canonical;
      policy.worktreeRoot = worktreeRoot;
      isolation[name] = createWorktreeManager({
        repositoryRoot: canonical,
        worktreeRoot,
        verifier: policy.verifier,
      });
    }
    startupStage = "native coding runtime configuration";
    const selection = config.coding.runtime;
    if (!selection) throw new Error("Explicit coding runtime required");
    let worker: CodingRuntime;
    switch (selection.kind) {
      case "amp":
        worker = createAmpRuntime();
        break;
      case "codex":
        await privateDirectory(selection.home);
        worker = createCodexRuntime({
          ...selection,
          timeoutMs: config.coding.timeoutMs,
        });
        break;
      case "claude":
        await privateDirectory(selection.stateDirectory);
        worker = createClaudeRuntime({
          auth: { type: "api-key", apiKey: secret(selection.apiKeyEnv) },
          stateDirectory: selection.stateDirectory,
          model: selection.model,
          allowedTools: selection.allowedTools,
          maxTurns: selection.maxTurns,
        });
        break;
      case "pi":
        for (const path of [
          selection.home,
          selection.agentDir,
          selection.sessionDir,
        ])
          await privateDirectory(path);
        worker = createPiRuntime({
          ...selection,
          // Credentials must be provisioned in the dedicated Pi auth.json.
          // Never inherit service credentials or copy subscription tokens.
          env: { HOME: selection.home, PATH: selection.path },
          timeoutMs: config.coding.timeoutMs,
        });
    }
    coding = {
      ...config.coding,
      isolation,
      runtime: worker,
      // Config contains references to secrets, not their values. Changing the
      // runtime, session roots or execution policy cannot rebind existing jobs.
      runtimeId: createHash("sha256")
        .update(JSON.stringify(config.coding))
        .digest("hex"),
    };
  }
  startupStage = "operator credential (at least 32 characters)";
  const operatorToken = secret(config.operatorTokenEnv);
  if (operatorToken.length < 32) throw new Error("Short operator token");
  startupStage = "private usage ledger";
  process.env.RIVETKIT_STORAGE_PATH ??= resolve(".data");
  const usage = new UsageLedger(
    join(process.env.RIVETKIT_STORAGE_PATH, "usage.sqlite"),
  );
  startupStage = "model credentials";
  const provider = (selection: typeof config.model): ModelProvider => {
    if (config.setupMode)
      return {
        reply: async () => {
          throw new Error("Inference disabled in setup mode");
        },
      };
    if (selection.protocol === "codex") {
      const hot = createHotCodexProvider({ ...selection, usage });
      hotProviders.push(hot);
      return hot;
    }
    return createModelProvider({
      ...selection,
      usage,
      apiKey: secret(selection.apiKeyEnv),
    });
  };
  const model = provider(config.model);
  const deepModel = config.deepModel && provider(config.deepModel);
  startupStage = "hot Codex initialization";
  await Promise.all(hotProviders.map((provider) => provider.ready()));
  startupStage = "private MCP connections";
  let connections: McpConnections | undefined;
  let slackMcp: ReturnType<typeof createSlackMcpOAuth> | undefined;
  if (config.mcp) {
    if (!config.console) throw new Error("MCP requires the private console");
    await privateDirectory(config.mcp.directory);
    connections = new McpConnections({
      directory: config.mcp.directory,
      key: memoryKey(config.mcp.keyEnv),
      owner: config.owner.id,
      origin: config.console.origin,
    });
    const store = connections;
    if (config.mcp.slack) {
      const slack = config.mcp.slack;
      if (
        !config.owner.identities.some(
          (identity) =>
            identity.channel === "slack" &&
            identity.accountId === slack.teamId &&
            identity.senderId === slack.userId,
        )
      )
        throw new Error("Slack MCP identity must be the configured owner");
      slackMcp = createSlackMcpOAuth({
        clientId: secret(slack.clientIdEnv),
        clientSecret: secret(slack.clientSecretEnv),
        redirectUrl: `${config.console.origin}/console/connections/slack/callback`,
        teamId: slack.teamId,
        userId: slack.userId,
        scopes: slack.scopes,
        generation: () => store.generation("slack"),
        async saveAuthorization(value) {
          store.connectSlack(value);
        },
      });
    }
  }
  const models = {
    current: { provider: config.model.protocol, model: config.model.model },
    fast: { provider: config.model.protocol, model: config.model.model },
    ...(config.deepModel
      ? {
          deep: {
            provider: config.deepModel.protocol,
            model: config.deepModel.model,
          },
        }
      : {}),
  };
  startupStage = "web search configuration";
  const webSearch =
    config.webSearch &&
    createTavilyWebSearchProvider({
      apiKey: process.env[config.webSearch.apiKeyEnv],
      timeoutMs: config.webSearch.timeoutMs,
    });
  const ownerAudience = JSON.stringify(["private", config.owner.id]);
  const audience = (value: unknown) => {
    if (value === undefined || value === ownerAudience) return ownerAudience;
    // Initial retention policy is owner-private in both live and import paths.
    // Public-thread memory would need separately reviewed audience semantics.
    throw new Error("Audience is not configured");
  };
  startupStage = "private memory storage";
  let memory: Dependencies["memory"];
  if (config.memory) {
    startupStage =
      "memory: requires JUNE_ALLOW_MEMORY=1 after privacy/retention review";
    if (process.env.JUNE_ALLOW_MEMORY !== "1")
      throw new Error("Memory not allowed");
    if (config.reflection || config.memory.extraction) {
      startupStage =
        "memory models: requires JUNE_ALLOW_MEMORY_MODELS=1 after provider review";
      if (process.env.JUNE_ALLOW_MEMORY_MODELS !== "1")
        throw new Error("Memory models not allowed");
    }
    if (Object.keys(config.imports).length) {
      startupStage =
        "history imports: requires JUNE_ALLOW_HISTORY_IMPORTS=1 after account/consent review";
      if (process.env.JUNE_ALLOW_HISTORY_IMPORTS !== "1")
        throw new Error("History imports not allowed");
    }
    startupStage = "private memory storage";
    await privateDirectory(config.memory.directory);
    const key = memoryKey(config.memory.keyEnv);
    const store = new EvidenceStore(
      join(config.memory.directory, "evidence.sqlite"),
      key,
    );
    key.fill(0);
    let personality: CuratedPersonalityStore | undefined;
    if (config.memory.curated) {
      await privateDirectory(dirname(config.memory.curated.directory));
      const curatedKey = memoryKey(config.memory.curated.keyEnv);
      personality = new CuratedPersonalityStore(
        config.memory.curated.directory,
        curatedKey,
        store,
        { initialize: true },
      );
      curatedKey.fill(0);
    }
    const extractor =
      config.memory.extraction &&
      createMemoryExtractor({
        ...config.memory.extraction,
        usage,
        apiKey: secret(config.memory.extraction.apiKeyEnv),
      });
    memory = {
      store,
      personality,
      source(event, scope) {
        if (
          event.address.channel !== "slack" ||
          !event.direct ||
          scope !== ownerAudience
        )
          return undefined;
        if (
          !config.slack?.workspaceUrl ||
          event.address.accountId !== config.slack.teamId
        )
          throw new Error("Unconfigured source account");
        return slackSource({
          workspace: event.address.accountId,
          channel: event.address.conversationId,
          ts: event.messageId,
          threadTs: event.address.threadId,
          author: event.senderId,
          text: event.text,
          workspaceUrl: config.slack.workspaceUrl,
          audiences: [audience(scope)],
        });
      },
      ...(extractor
        ? {
            async extract(
              scope: string,
              sourceIds: string[],
              signal: AbortSignal,
            ) {
              await extractMemory(
                store,
                audience(scope),
                sourceIds,
                extractor,
                signal,
              );
            },
          }
        : {}),
    };
  }
  const selections = Object.fromEntries(
    Object.entries(config.imports).map(([id, selection]) => [
      id,
      {
        platform: selection.platform,
        account: selection.account,
        conversations: selection.conversations,
        from: selection.from,
        to: selection.to,
        audiences: [ownerAudience],
      },
    ]),
  );
  const imports =
    memory &&
    new HistoryImports(
      memory.store,
      Object.fromEntries(
        Object.entries(config.imports).map(([id, selection]) => {
          const coverage = selections[id];
          if (!coverage) throw new Error("Missing import coverage");
          const fetchPage = (
            selection.platform === "slack"
              ? createSlackHistoryFetcher
              : createGmailHistoryFetcher
          )({
            coverage,
            async accessToken() {
              return secret(selection.accessTokenEnv);
            },
          });
          return [
            id,
            {
              coverage,
              async fetchPage(request: Parameters<typeof fetchPage>[0]) {
                const page = await fetchPage(request);
                const sources = page.sources.filter(
                  (source) => !memory?.store.isDeleted(source.id),
                );
                return {
                  ...page,
                  sources,
                  gaps: [
                    ...(page.gaps ?? []),
                    ...(sources.length < page.sources.length
                      ? ["Previously deleted source omitted."]
                      : []),
                  ],
                };
              },
            },
          ];
        }),
      ),
    );
  const reflection =
    config.reflection && memory
      ? {
          ...config.reflection,
          ownerId: config.owner.id,
          decide: createDecisionProvider({
            ...config.reflection.model,
            usage,
            auth: "api-key",
            apiKey: secret(config.reflection.model.apiKeyEnv),
          }),
          async retrieve(
            input: { ownerId: string; scope: string; evidenceIds: string[] },
            signal: AbortSignal,
          ) {
            if (input.ownerId !== config.owner.id || signal.aborted)
              return { authorized: false, evidence: [] };
            const scope = audience(input.scope);
            const age = config.reflection?.policy.evidenceMaxAgeMs ?? 0;
            const evidence =
              memory?.store.reflectionEvidence(scope, input.evidenceIds, age) ??
              [];
            return {
              authorized:
                !signal.aborted &&
                evidence.length === input.evidenceIds.length &&
                evidence.every((item) =>
                  freshEvidence(item, scope, Date.now(), age),
                ),
              evidence,
            };
          },
        }
      : undefined;
  const channels: Partial<Record<Channel, ChannelAdapter>> = {};
  const latency = createLatencyDiagnostics();
  const slackIngressDiagnostics = config.slack
    ? createSlackIngressDiagnostics()
    : undefined;
  const slackThreads = config.slack
    ? new SlackThreads(
        join(process.env.RIVETKIT_STORAGE_PATH, "slack-threads.sqlite"),
      )
    : undefined;
  if (config.slack) {
    startupStage = "Slack credentials";
    channels.slack = createSlackAdapter({
      ...config.slack,
      ownerUserIds: config.owner.identities
        .filter(
          (identity) =>
            identity.channel === "slack" &&
            identity.accountId === config.slack?.teamId,
        )
        .map((identity) => identity.senderId),
      signingSecret: secret(config.slack.signingSecretEnv),
      botToken: secret(config.slack.botTokenEnv),
      ingressDiagnostics: slackIngressDiagnostics,
      latency,
      threads: slackThreads,
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
  const social =
    config.slack && channels.slack
      ? new SocialPermissions({
          file: join(process.env.RIVETKIT_STORAGE_PATH, "social.sqlite"),
          owner: config.owner,
          teamId: config.slack.teamId,
          botUserId: config.slack.botUserId,
          slack: channels.slack,
        })
      : undefined;
  process.env.RIVET_INSPECTOR_DISABLE ??= "1";
  const registry = createJuneRegistry({
    owner: config.owner,
    social,
    channels,
    model: connections ? connections.wrap(model) : model,
    deepModel:
      deepModel && (connections ? connections.wrap(deepModel) : deepModel),
    mcpAvailable: !!connections,
    execution:
      config.executionEnabled && !config.setupMode
        ? { model: deepModel ?? model }
        : undefined,
    modelStatus: hotProviders.length
      ? () =>
          `Model runtime snapshot at ${new Date().toISOString()}: ${JSON.stringify(hotProviders.map((provider) => provider.inspect()))}. Idle means unused; upstream prewarm completion is not observable. No restart or configuration change was performed.`
      : undefined,
    models,
    webSearch,
    lifecycle,
    latency,
    analytics: (days) => usage.report(days),
    inspection: createInspectionReader({
      audience: ownerAudience,
      memory,
      imports,
      selections,
      reflection: reflection
        ? () => client.reflection.getOrCreate([config.owner.id]).status()
        : undefined,
    }),
    release: readDeployment
      ? createReleaseTool({
          read: () => readDeployment(config.owner.id),
          runningRevision: release?.revision,
        })
      : undefined,
    runningRevision: release?.revision,
    deploymentStatus: readDeployment
      ? async () => {
          const feed = await readDeployment(config.owner.id).catch(
            () => undefined,
          );
          if (!feed) return undefined;
          return JSON.stringify({
            runningRevision: release?.revision,
            lastHealthyRevision: feed.lastHealthyRevision,
            blocked: feed.blocked,
            recentEvents: feed.events.slice(-5),
          });
        }
      : undefined,
    memory,
    reflection,
    coding,
  });
  Object.assign(registry.config, {
    startEngine: !process.env.RIVET_ENDPOINT && !process.env.RIVET_ENGINE,
    engineHost: "127.0.0.1",
    noWelcome: true,
    shutdown: { disableSignalHandlers: true },
  });
  const runtime = registry.parseConfig();
  const client = createClient<JuneClientRegistry>({
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
    revision: release?.revision,
    lifecycle,
    deployment: config.deployment
      ? {
          token: secret(config.deployment.tokenEnv),
          read: readDeployment,
          // These optional paths can outlive a cancelled actor callback. Do not
          // confuse an idle workflow/status with settled native children/transports.
          supported: !coding && !reflection && !channels.whatsapp,
        }
      : undefined,
    slackIngressDiagnostics,
    latency,
    console: config.console
      ? {
          origin: config.console.origin,
          connections: connections
            ? { store: connections, slack: slackMcp }
            : undefined,
          async usage(_principal, days, model) {
            return usage.snapshot(days, model);
          },
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
                        "Requires a current user request and Slack authorization. This setting covers public Slack search only, not separately permissioned MCP tools.",
                    },
                    {
                      title: "History imports",
                      status:
                        imports && Object.keys(selections).length
                          ? "configured"
                          : "not configured",
                      detail:
                        imports && Object.keys(selections).length
                          ? `${Object.keys(selections).length} configured selection(s). Import progress and provider authorization are not inspected by this overview. Configuration does not mean history has been imported.`
                          : "No import selections are mounted in this host.",
                    },
                    {
                      title: "MCP tools",
                      status: connections ? "configured" : "not configured",
                      detail: connections
                        ? "The connection store and permission broker are mounted. Saved connections, enabled tools and remote availability are not inspected by this overview. Configuration does not grant tool permission."
                        : "No MCP connection store or permission broker is mounted in this host.",
                    },
                    {
                      title: "Deployment inspection",
                      status: readDeployment ? "configured" : "not configured",
                      detail: readDeployment
                        ? "Read-only deployment and release inspection are mounted. The deployment feed and current health are not inspected by this overview. Inspection does not authorize a deployment."
                        : "No deployment feed reader is mounted in this host.",
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
      if (memory && event.type === "message") {
        const source = memory.source(event, JSON.stringify(scope.key));
        if (source) {
          if (memory.store.isDeleted(source.id)) return;
          memory.store.appendSource(source);
        }
      }
      await client.conversation
        .getOrCreate(scope.key)
        .send("inbox", { type: "event", event });
    },
    async ready() {
      return (await registry.routes.health()).ok;
    },
    inspectConversation: () => june.snapshot(),
    async inspectJob(id) {
      const state = await june.snapshot();
      if (!Object.hasOwn(state.jobs, id) || state.forgottenEvents?.includes(id))
        return undefined;
      return client.job.getOrCreate([config.owner.id, id]).snapshot();
    },
    async resumeJob(id, commandId) {
      if (!coding || !(await june.canResumeJob(id))) return false;
      const job = client.job.getOrCreate([config.owner.id, id]);
      const state = await job.snapshot();
      if (state.revoked || state.runtimeId !== coding.runtimeId) return false;
      if (Object.hasOwn(state.commandApprovals, commandId))
        return state.commandApprovals[commandId] !== null;
      if (
        state.status !== "needs_review" ||
        (state.worktree && !state.threadId)
      )
        return false;
      if (!(await june.canResumeJob(id))) return false;
      await job.send("commands", {
        type: "resume",
        commandId,
        confirmedStopped: true,
      });
      return true;
    },
    async cancelJob(id) {
      if (!Object.hasOwn((await june.snapshot()).jobs, id)) return false;
      await client.job.getOrCreate([config.owner.id, id]).cancel();
      return true;
    },
  });
  if (memory) {
    app.route(
      "/operator/memory",
      createMemoryRoutes({
        ...memory,
        audience,
        async forget(scope, sourceId) {
          await client.conversation
            .getOrCreate(JSON.parse(scope))
            .forget(sourceId);
          if (reflection) {
            const actor = client.reflection.getOrCreate([config.owner.id]);
            const status = await actor.status();
            for (const request of status.reflection.requests) {
              if (request.evidenceIds.includes(sourceId))
                await actor.cancel(request.id);
            }
          }
        },
      }),
    );
  }
  if (imports) {
    app.route("/operator/imports", createImportRoutes(imports, selections));
  }
  if (reflection) {
    const actor = client.reflection.getOrCreate([config.owner.id]);
    app.get("/operator/reflection", async (c) => c.json(await actor.status()));
    app.post("/operator/reflection/enqueue", async (c) => {
      const input = z
        .strictObject({
          scope: z.string().optional(),
          evidenceIds: z.array(z.string().min(1).max(2048)).min(1).max(100),
          kind: z.enum(["curiosity", "reflection"]),
          mode: z.enum(["interaction", "idle", "deep"]),
        })
        .parse(await c.req.json());
      return c.json(
        await actor.enqueue({ ...input, scope: audience(input.scope) }),
      );
    });
    app.post("/operator/reflection/cancel", async (c) => {
      const { id } = z
        .strictObject({ id: z.string().min(1).max(250000) })
        .parse(await c.req.json());
      return c.json({ cancelled: await actor.cancel(id) });
    });
    app.post("/operator/reflection/candidate", async (c) => {
      const { id } = z
        .strictObject({ id: z.string().min(1).max(250000) })
        .parse(await c.req.json());
      return c.json(await actor.candidate(id));
    });
    app.post("/operator/reflection/reconcile", async (c) => {
      const input = z
        .strictObject({
          id: z.string().min(1).max(250000),
          confirmedStopped: z.literal(true),
          live: z.boolean().default(false),
        })
        .parse(await c.req.json());
      if (input.live) {
        await actor.occupancy(input.id, false);
        return c.json({ reconciled: true });
      }
      return c.json({ reconciled: await actor.reconcile(input.id, true) });
    });
  }
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
      try {
        await new Promise<void>((done) => server.close(() => done()));
        await client.dispose();
        await registry.shutdown();
      } finally {
        await Promise.all(hotProviders.map((provider) => provider.close()));
      }
      await connections?.close();
      memory?.personality?.close();
      memory?.store.close();
      social?.close();
      slackThreads?.close();
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

await main().catch(async () => {
  await Promise.allSettled(hotProviders.map((provider) => provider.close()));
  // Provider/transport exceptions can contain credentials or message bodies.
  console.error(`June startup failed at ${startupStage}.`);
  process.exitCode = 1;
});
