import { isAbsolute } from "node:path";
import { z } from "zod";
import { ampJobsSchema } from "./coding/remote-amp.js";
import { webEmbedUrlSchema } from "./core/web-embed.js";
import { jevQuestionSchema } from "./models/jev.js";
import {
  browserCredentialOperationSchema,
  browserOperationSchema,
} from "./tools/browser.js";
import { browserMutationSchema } from "./tools/browser-proposals.js";
import { emojiSearchUrlSchema } from "./tools/emoji-search.js";

const nonempty = z.string().trim().min(1);
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const absolutePath = nonempty.refine(isAbsolute, "Path must be absolute");
const name = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const baseUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ["https:", "http:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}, "Use an HTTP(S) base URL without credentials, query, or fragment");
const decisionModel = z.strictObject({
  protocol: z.enum(["openai", "anthropic"]),
  model: nonempty,
  apiKeyEnv: envName,
  baseUrl: baseUrl.refine((value) => value.startsWith("https:")).optional(),
  maxOutputTokens: z.number().int().min(1).max(32768).default(4096),
  timeoutMs: z.number().int().min(1000).max(300000).default(60000),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
});
const companionModel = z.discriminatedUnion("protocol", [
  z
    .strictObject({
      protocol: z.enum(["openai", "anthropic"]),
      model: nonempty,
      apiKeyEnv: envName,
      baseUrl: baseUrl.optional(),
      maxOutputTokens: z.number().int().min(1).max(32768).optional(),
      timeoutMs: z.number().int().min(1000).max(300000).optional(),
      reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
    })
    .refine(
      (value) => value.protocol === "openai" || !value.reasoningEffort,
      "Reasoning effort is supported only for OpenAI and Codex",
    ),
  z.strictObject({
    protocol: z.literal("codex"),
    model: nonempty,
    home: nonempty.refine(isAbsolute, "Codex home must be absolute"),
    executable: nonempty.optional(),
    timeoutMs: z.number().int().min(1000).max(300000).optional(),
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
    serviceTier: z.enum(["fast", "default"]).optional(),
  }),
]);
const schema = z
  .strictObject({
    host: nonempty.default("127.0.0.1"),
    port: z.number().int().min(1024).max(65535).default(3080),
    operatorTokenEnv: envName.default("JUNE_OPERATOR_TOKEN"),
    ampJobs: ampJobsSchema.optional(),
    continuity: z
      .strictObject({
        idleMs: z
          .number()
          .int()
          .min(1000)
          .max(7 * 24 * 60 * 60 * 1000)
          .default(3 * 60 * 60 * 1000),
        model: decisionModel,
      })
      .optional(),
    debugShare: z
      .strictObject({
        repositoryRoot: absolutePath,
        worktreeRoot: absolutePath,
        timeoutMs: z.number().int().min(1000).max(3_600_000).default(900_000),
      })
      .optional(),
    activitySessions: z
      .strictObject({
        enabled: z.boolean().default(false),
        idleMs: z
          .number()
          .int()
          .min(1000)
          .max(7 * 24 * 60 * 60 * 1000)
          .default(3 * 60 * 60 * 1000),
      })
      .default({ enabled: false, idleMs: 3 * 60 * 60 * 1000 }),
    dynamicApps: z
      .strictObject({
        endpoint: baseUrl.refine(
          (value) =>
            new URL(value).origin === value &&
            (value.startsWith("https://") ||
              ["127.0.0.1", "localhost", "[::1]"].includes(
                new URL(value).hostname,
              )),
          "Use an HTTPS origin or loopback HTTP for the dedicated app host",
        ),
        tokenEnv: envName,
        workspace: name,
      })
      .optional(),
    eventWebhooks: z
      .record(
        z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
        z.strictObject({ secretEnv: envName }),
      )
      .default({}),
    deployment: z
      .strictObject({
        tokenEnv: envName.default("JUNE_DEPLOY_TOKEN"),
        intakeTokenEnv: envName.optional(),
        blueGreen: z.boolean().default(false),
        eventsFile: absolutePath.default(
          "/var/lib/june-deploy/public/events.json",
        ),
      })
      .optional(),
    console: z
      .strictObject({
        origin: z.url().refine((value) => {
          const url = new URL(value);
          return (
            url.origin === value &&
            (url.protocol === "https:" ||
              (url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
          );
        }, "Use a canonical private HTTPS origin, or loopback HTTP for an SSH tunnel"),
      })
      .optional(),
    capabilities: z.strictObject({ directory: absolutePath }).optional(),
    credentials: z
      .strictObject({
        executable: absolutePath,
        appDataDir: absolutePath,
        sessionFile: absolutePath,
        bindings: z
          .array(
            z.strictObject({
              account: name,
              item: name,
              origin: z.url().refine((value) => {
                const url = new URL(value);
                return url.protocol === "https:" && url.origin === value;
              }, "Use an exact canonical HTTPS origin"),
              vaultItemId: z
                .string()
                .regex(
                  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu,
                ),
              field: z.enum(["bearer", "login"]),
            }),
          )
          .min(1)
          .max(64),
      })
      .optional(),
    mcp: z
      .strictObject({
        directory: absolutePath,
        keyEnv: envName.default("JUNE_MCP_KEY"),
        github: z
          .strictObject({
            clientIdEnv: envName.default("JUNE_GITHUB_CLIENT_ID"),
            clientSecretEnv: envName.default("JUNE_GITHUB_CLIENT_SECRET"),
            webhookSecretEnv: envName.default("JUNE_GITHUB_WEBHOOK_SECRET"),
            userId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            appSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
          })
          .optional(),
        slack: z
          .strictObject({
            clientIdEnv: envName.default("JUNE_SLACK_CLIENT_ID"),
            clientSecretEnv: envName.default("JUNE_SLACK_CLIENT_SECRET"),
            teamId: nonempty,
            userId: nonempty,
            scopes: z
              .array(z.string().regex(/^[a-z][a-z0-9:._-]*$/))
              .min(1)
              .max(30),
          })
          .optional(),
      })
      .optional(),
    browserCompanion: z
      .strictObject({
        enabled: z.boolean().default(false),
        directory: absolutePath,
        home: absolutePath,
        tempDirectory: absolutePath,
        codexHome: absolutePath,
        navigationOrigins: z
          .array(
            baseUrl.refine(
              (value) =>
                new URL(value).origin === value && value.startsWith("https:"),
            ),
          )
          .min(1)
          .max(32),
        resourceOrigins: z
          .array(
            baseUrl.refine(
              (value) =>
                new URL(value).origin === value && value.startsWith("https:"),
            ),
          )
          .min(1)
          .max(64),
        processIsolationAcknowledged: z.literal(true),
        networkIsolationAcknowledged: z.literal(true),
        ephemeralStorageAcknowledged: z.literal(true),
        resourceLimitsAcknowledged: z.literal(true),
      })
      .optional(),
    browser: z
      .strictObject({
        enabled: z.boolean().default(false),
        readOperations: z
          .array(
            browserOperationSchema.refine(
              (recipe) =>
                recipe.steps.length === 0 &&
                recipe.requests.every(
                  (request) => request.method === "GET" && !request.credential,
                ),
              "Browser reads must be anonymous GET recipes without interaction steps",
            ),
          )
          .max(64)
          .default([]),
        mutationOperations: z.array(browserMutationSchema).max(16).default([]),
        credentialOperations: z
          .array(browserCredentialOperationSchema)
          .max(64)
          .default([]),
        timeoutMs: z.number().int().min(100).max(60000).default(15000),
        execution: z
          .strictObject({
            kind: z.literal("isolated-host"),
            home: absolutePath,
            tempDirectory: absolutePath,
            processIsolationAcknowledged: z.literal(true),
            networkIsolationAcknowledged: z.literal(true),
            ephemeralStorageAcknowledged: z.literal(true),
            resourceLimitsAcknowledged: z.literal(true),
          })
          .optional(),
      })
      .refine(
        (browser) =>
          !browser.enabled ||
          (!!browser.execution &&
            browser.readOperations.length +
              browser.mutationOperations.length +
              browser.credentialOperations.length >
              0),
        "Enabled browsing requires explicit isolated execution and named recipes",
      )
      .prefault({}),
    setupMode: z.boolean().default(false),
    owner: z.strictObject({
      id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
      identities: z
        .array(
          z.strictObject({
            channel: z.enum(["slack", "whatsapp"]),
            accountId: nonempty,
            senderId: nonempty,
          }),
        )
        .refine(
          (identities) =>
            new Set(
              identities.map((identity) =>
                JSON.stringify([
                  identity.channel,
                  identity.accountId,
                  identity.senderId,
                ]),
              ),
            ).size === identities.length,
          "Duplicate identity",
        ),
    }),
    model: companionModel,
    deepModel: companionModel.optional(),
    executionEnabled: z.boolean().default(true),
    jev: z
      .strictObject({
        endpoint: baseUrl.refine((value) => value.startsWith("https:")),
        model: nonempty.max(256),
        apiKeyEnv: envName,
        timeoutMs: z.number().int().min(1000).max(30000).default(10000),
        question: jevQuestionSchema.refine(
          (question) =>
            Buffer.byteLength(JSON.stringify(question)) <= 1024 &&
            (question.type !== "choice" ||
              Object.keys(question.criteria).length <= 8),
          "Use one bounded observation rubric (1024 bytes, at most 8 choices)",
        ),
      })
      .optional(),
    emojiSearch: z
      .strictObject({
        baseUrl: emojiSearchUrlSchema.default("https://emojis.raygen.dev"),
        readTokenEnv: envName.default("EMOJI_SEARCH_READ_TOKEN"),
        timeoutMs: z.number().int().min(100).max(5000).default(4000),
      })
      .optional(),
    webSearch: z
      .strictObject({
        provider: z.literal("tavily"),
        apiKeyEnv: envName.default("TAVILY_API_KEY"),
        timeoutMs: z.number().int().min(1000).max(15000).default(10000),
      })
      .optional(),
    e2b: z
      .strictObject({ apiKeyEnv: envName.default("E2B_API_KEY") })
      .optional(),
    slack: z
      .strictObject({
        teamId: nonempty,
        botUserId: nonempty,
        signingSecretEnv: envName,
        botTokenEnv: envName,
        webEmbedOrigins: z
          .array(
            webEmbedUrlSchema.refine(
              (value) => URL.parse(value)?.origin === value,
              "Use an exact HTTPS origin without a trailing slash",
            ),
          )
          .max(20)
          .default([]),
        searchEnabled: z.boolean().default(false),
        participateInOwnerChannels: z.boolean().default(false),
        contextEnabled: z.boolean().default(false),
        workspaceUrl: z
          .url()
          .refine((value) => {
            const url = new URL(value);
            return (
              url.protocol === "https:" &&
              /^[a-z0-9-]+\.slack\.com$/.test(url.hostname) &&
              url.href === `${url.origin}/`
            );
          }, "Use the canonical workspace URL returned by Slack auth.test")
          .optional(),
      })
      .optional(),
    whatsapp: z
      .strictObject({
        phoneNumberId: z.string().regex(/^\d+$/),
        apiVersion: z.string().regex(/^v\d+\.\d+$/),
        appSecretEnv: envName,
        verifyTokenEnv: envName,
        accessTokenEnv: envName,
      })
      .optional(),
    memory: z
      .strictObject({
        directory: absolutePath,
        keyEnv: envName,
        importBudget: z
          .strictObject({
            sources: z.number().int().positive().safe().optional(),
            claims: z.number().int().positive().safe().optional(),
            serializedBytes: z.number().int().positive().safe().optional(),
          })
          .optional(),
        restore: z
          .strictObject({
            watermark: z.number().int().nonnegative().safe(),
            tombstonePages: absolutePath,
          })
          .optional(),
        extraction: decisionModel
          .pick({ protocol: true, model: true, apiKeyEnv: true, baseUrl: true })
          .optional(),
        curated: z
          .strictObject({ directory: absolutePath, keyEnv: envName })
          .optional(),
      })
      .optional(),
    imports: z
      .record(
        name,
        z
          .strictObject({
            platform: z.enum(["slack", "gmail"]),
            account: nonempty,
            conversations: z.array(nonempty).min(1).max(1000),
            from: z.number().int().nonnegative().safe(),
            to: z.number().int().nonnegative().safe(),
            accessTokenEnv: envName,
          })
          .refine((value) => value.from < value.to, "Invalid import interval"),
      )
      .default({}),
    reflection: z
      .strictObject({
        model: decisionModel,
        juryEnabled: z.boolean().default(false),
        idleMs: z.number().int().min(1000).max(86400000).default(300000),
        deepMs: z.number().int().min(1000).max(86400000).default(3600000),
        pollMs: z.number().int().min(1000).max(86400000).default(60000),
        timeoutMs: z.number().int().min(1000).max(300000).default(60000),
        policy: z
          .strictObject({
            totalCapacity: z.number().int().min(2).max(8).default(2),
            liveReserve: z.number().int().min(1).max(7).default(1),
            cooldownMs: z
              .number()
              .int()
              .min(1000)
              .max(86400000)
              .default(300000),
            maxNoNewEvidence: z.number().int().min(1).max(10).default(2),
            maxAttempts: z.number().int().min(1).max(10).default(3),
            evidenceMaxAgeMs: z
              .number()
              .int()
              .min(1000)
              .max(31536000000)
              .default(604800000),
            quiet: z
              .strictObject({
                timeZone: nonempty.default("America/Boise"),
                startMinute: z.number().int().min(0).max(1439).default(1320),
                endMinute: z.number().int().min(0).max(1439).default(480),
              })
              .prefault({}),
          })
          .prefault({}),
      })
      .refine(
        (value) =>
          value.deepMs >= value.idleMs &&
          value.policy.liveReserve < value.policy.totalCapacity,
        "Reflection requires idle/deep ordering and reserved live capacity",
      )
      .optional(),
    coding: z
      .strictObject({
        enabled: z.boolean().default(false),
        runtime: z
          .discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("amp") }),
            z.strictObject({
              kind: z.literal("codex"),
              home: absolutePath,
              model: nonempty.optional(),
              executable: absolutePath.optional(),
            }),
            z.strictObject({
              kind: z.literal("claude"),
              apiKeyEnv: envName,
              stateDirectory: absolutePath,
              model: nonempty.optional(),
              allowedTools: z
                .array(
                  z.enum(["Read", "Glob", "Grep", "Edit", "Write", "Bash"]),
                )
                .default([]),
              maxTurns: z.number().int().min(1).max(1000).default(40),
            }),
            z.strictObject({
              kind: z.literal("pi"),
              executable: absolutePath,
              provider: nonempty,
              model: nonempty,
              home: absolutePath,
              path: nonempty,
              agentDir: absolutePath,
              sessionDir: absolutePath,
              hostSandboxAcknowledged: z.literal(true),
            }),
          ])
          .optional(),
        workspaces: z
          .record(
            z.string().regex(/^[a-zA-Z0-9_-]+$/),
            nonempty.refine(isAbsolute, "Workspace must be absolute"),
          )
          .default({}),
        isolation: z
          .record(
            name,
            z.strictObject({
              worktreeRoot: absolutePath,
              verifier: z
                .strictObject({
                  argv: z.tuple([absolutePath], z.string()),
                  timeoutMs: z.number().int().min(1000).max(3600000),
                  env: z.record(envName, z.string()).default({}),
                })
                .optional(),
            }),
          )
          .default({}),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(86_400_000)
          .default(3_600_000),
      })
      .prefault({}),
  })
  .refine(
    (config) =>
      config.setupMode
        ? !config.slack && !config.whatsapp && !config.coding.enabled
        : (config.slack || config.whatsapp) &&
          config.owner.identities.length > 0,
    "Configure a channel and owner identities, or enable channel-free setup mode with coding disabled",
  )
  .refine(
    (config) =>
      (!!config.memory ||
        (!config.reflection && !Object.keys(config.imports).length)) &&
      (!config.memory || !config.slack || !!config.slack.workspaceUrl),
    "Memory is required for reflection/imports; live Slack memory requires its verified workspace URL",
  )
  .refine(
    (config) => !config.continuity || (!!config.memory && !config.setupMode),
    "Continuity requires private memory storage and cannot run in setup mode",
  )
  .refine(
    (config) =>
      !config.activitySessions.enabled ||
      (!config.setupMode &&
        !!config.memory &&
        !!config.slack &&
        config.executionEnabled &&
        !(
          config.whatsapp &&
          config.owner.identities.some(
            (identity) => identity.channel === "whatsapp",
          )
        )),
    "Activity sessions require retained memory, execution workers and Slack-only owner ingress",
  )
  .refine(
    (config) =>
      !config.setupMode ||
      (!config.reflection &&
        !config.memory?.extraction &&
        !Object.keys(config.imports).length),
    "Setup mode cannot run reflection or historical imports",
  )
  .refine(
    (config) => !config.browser.enabled || !!config.capabilities,
    "Enabled browsing requires the generic capability broker",
  )
  .refine(
    (config) =>
      !config.browserCompanion?.enabled || !config.deployment?.blueGreen,
    "Browser PIN input cannot pass through the durable blue-green Slack intake queue",
  )
  .refine(
    (config) =>
      !config.coding.enabled ||
      (!!config.coding.runtime &&
        Object.keys(config.coding.workspaces).length > 0 &&
        Object.keys(config.coding.workspaces).every((key) =>
          Object.hasOwn(config.coding.isolation, key),
        ) &&
        Object.keys(config.coding.isolation).every((key) =>
          Object.hasOwn(config.coding.workspaces, key),
        )),
    "Enabled coding requires an explicit runtime and an isolation root for every workspace",
  )
  .refine(
    (config) =>
      !config.dynamicApps ||
      (config.coding.enabled &&
        !!config.coding.isolation[config.dynamicApps.workspace]?.verifier &&
        config.dynamicApps.tokenEnv !== config.operatorTokenEnv),
    "Dynamic Apps require enabled coding, a verified workspace and a separate app-host credential",
  );

export type Config = z.infer<typeof schema>;

export function parseConfig(input: unknown): Config {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Zod's full errors may contain values supplied in a malformed config.
    throw new Error(
      `Invalid June configuration at ${result.error.issues.map((issue) => issue.path.join(".") || "root").join(", ")}`,
    );
  }
  const config = result.data;
  // June has one Slack owner, explicitly bound by trusted host configuration.
  if (config.slack) {
    const identities = config.owner.identities.filter(
      (identity) => identity.channel === "slack",
    );
    if (
      identities.length !== 1 ||
      identities[0]?.accountId !== config.slack.teamId
    )
      throw new Error(
        "Configure exactly one Slack owner in the configured workspace",
      );
  }
  return config;
}

export function secret(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name];
  if (!value?.trim()) throw new Error(`Missing environment variable ${name}`);
  return value;
}
