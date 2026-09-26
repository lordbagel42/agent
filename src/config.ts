import { isAbsolute } from "node:path";
import { z } from "zod";

const nonempty = z.string().trim().min(1);
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
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
const schema = z
  .strictObject({
    host: nonempty.default("127.0.0.1"),
    port: z.number().int().min(1024).max(65535).default(3080),
    operatorTokenEnv: envName.default("JUNE_OPERATOR_TOKEN"),
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
    coding: z
      .strictObject({
        enabled: z.boolean().default(false),
        workspaces: z
          .record(
            z.string().regex(/^[a-zA-Z0-9_-]+$/),
            nonempty.refine(isAbsolute, "Workspace must be absolute"),
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
