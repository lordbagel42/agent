import { isAbsolute } from "node:path";
import { z } from "zod";

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
const schema = z
  .strictObject({
    host: nonempty.default("127.0.0.1"),
    port: z.number().int().min(1024).max(65535).default(3080),
    operatorTokenEnv: envName.default("JUNE_OPERATOR_TOKEN"),
    mcp: z
      .strictObject({
        origin: z.url().refine((value) => {
          const url = new URL(value);
          return (
            value === url.origin &&
            (url.protocol === "https:" ||
              (url.protocol === "http:" &&
                ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
          );
        }, "Use a canonical HTTPS origin or loopback HTTP for local checks"),
        directory: absolutePath,
        keyEnv: envName,
        clients: z
          .record(
            name,
            z.strictObject({
              tokenEnv: envName,
              expiresAt: z.number().int().positive().safe(),
            }),
          )
          .refine(
            (clients) =>
              Object.keys(clients).length > 0 &&
              Object.keys(clients).length <= 32 &&
              Object.keys(clients).every((id) => id.length <= 80),
          ),
        destinations: z
          .array(
            z.strictObject({
              origin: z.url().refine((value) => {
                const url = new URL(value);
                return value === url.origin && url.protocol === "https:";
              }),
              pathPrefix: z.string().min(1).max(1000),
            }),
          )
          .max(32)
          .default([]),
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
    model: z.discriminatedUnion("protocol", [
      z.strictObject({
        protocol: z.enum(["openai", "anthropic"]),
        model: nonempty,
        apiKeyEnv: envName,
        baseUrl: baseUrl.optional(),
      }),
      z.strictObject({
        protocol: z.literal("codex"),
        model: nonempty,
        home: nonempty.refine(isAbsolute, "Codex home must be absolute"),
        executable: nonempty.optional(),
      }),
    ]),
    slack: z
      .strictObject({
        teamId: nonempty,
        botUserId: nonempty,
        signingSecretEnv: envName,
        botTokenEnv: envName,
        searchEnabled: z.boolean().default(false),
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
        ? !config.slack &&
          !config.whatsapp &&
          !config.mcp &&
          !config.coding.enabled
        : !!config.mcp ||
          (!!(config.slack || config.whatsapp) &&
            config.owner.identities.length > 0),
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
    (config) =>
      !config.setupMode ||
      (!config.reflection &&
        !config.memory?.extraction &&
        !Object.keys(config.imports).length),
    "Setup mode cannot run reflection or historical imports",
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
  return result.data;
}

export function secret(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name];
  if (!value?.trim()) throw new Error(`Missing environment variable ${name}`);
  return value;
}
