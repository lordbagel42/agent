import { isAbsolute } from "node:path";
import { Cause, Exit, Option, Schema, type Types } from "effect";
import { audioConfigSchema } from "./audio/contracts.js";
import { capabilityConfigSchema } from "./capabilities/config.js";
import { ampJobsSchema } from "./coding/remote-amp.js";
import { webEmbedUrlSchema } from "./core/web-embed.js";
import {
  check,
  discriminated,
  Int,
  issuePaths,
  strictWithInputs,
  TrimmedString,
  Url,
  withDefault,
} from "./effect/schema.js";
import { jevQuestionSchema } from "./models/jev.js";
import {
  browserCredentialOperationSchema,
  browserOperationSchema,
} from "./tools/browser.js";
import { browserMutationSchema } from "./tools/browser-proposals.js";
import { emojiSearchUrlSchema } from "./tools/emoji-search.js";

const pattern = (regExp: RegExp) =>
  Schema.String.check(Schema.isPattern(regExp));
const flag = (value: boolean) => Schema.Boolean.pipe(withDefault(value));
const between = (minimum: number, maximum: number, value: number) =>
  Int({ minimum, maximum }).pipe(withDefault(value));
const nonempty = TrimmedString({ min: 1 });
const envName = pattern(/^[A-Z_][A-Z0-9_]*$/);
const absolutePath = nonempty.check(check(isAbsolute, "Path must be absolute"));
const name = pattern(/^[a-zA-Z0-9_-]+$/);
const positiveSafe = Schema.Int.check(Schema.isGreaterThan(0));
const nonnegativeSafe = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const loopback = ["127.0.0.1", "localhost", "[::1]"];
const baseUrl = Url.check(
  check((value) => {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "Use an HTTP(S) base URL without credentials, query, or fragment"),
);
const httpsOrLoopbackOrigin = Url.check(
  check((value) => {
    const url = new URL(value);
    return (
      value === url.origin &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && loopback.includes(url.hostname)))
    );
  }, "Use a canonical HTTPS origin or loopback HTTP for local checks"),
);
const httpsOriginBaseUrl = baseUrl.check(
  check(
    (value) => new URL(value).origin === value && value.startsWith("https:"),
  ),
);
const decisionModelFields = {
  protocol: Schema.Literals(["openai", "anthropic"]),
  model: nonempty,
  apiKeyEnv: envName,
  baseUrl: Schema.optionalKey(
    baseUrl.check(check((value) => value.startsWith("https:"))),
  ),
};
const decisionModel = Schema.Struct({
  ...decisionModelFields,
  maxOutputTokens: between(1, 32768, 4096),
  timeoutMs: between(1000, 300000, 60000),
  reasoningEffort: Schema.optionalKey(
    Schema.Literals(["low", "medium", "high"]),
  ),
});
const companionModel = discriminated("protocol", [
  Schema.Struct({
    protocol: Schema.Literals(["openai", "anthropic"]),
    model: nonempty,
    apiKeyEnv: envName,
    baseUrl: Schema.optionalKey(baseUrl),
    maxOutputTokens: Schema.optionalKey(Int({ minimum: 1, maximum: 32768 })),
    timeoutMs: Schema.optionalKey(Int({ minimum: 1000, maximum: 300000 })),
    reasoningEffort: Schema.optionalKey(
      Schema.Literals(["low", "medium", "high"]),
    ),
  }).check(
    check(
      (value) => value.protocol === "openai" || !value.reasoningEffort,
      "Reasoning effort is supported only for OpenAI and Codex",
    ),
  ),
  Schema.Struct({
    protocol: Schema.Literal("codex"),
    model: nonempty,
    home: nonempty.check(check(isAbsolute, "Codex home must be absolute")),
    executable: Schema.optionalKey(nonempty),
    timeoutMs: Schema.optionalKey(Int({ minimum: 1000, maximum: 300000 })),
    reasoningEffort: Schema.optionalKey(
      Schema.Literals(["low", "medium", "high", "xhigh", "max"]),
    ),
    serviceTier: Schema.optionalKey(Schema.Literals(["fast", "default"])),
  }),
]);
const acknowledged = Schema.Literal(true);
const httpsOrigins = (maximum: number) =>
  Schema.Array(httpsOriginBaseUrl).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximum),
  );
const schema = Schema.Struct({
  host: nonempty.pipe(withDefault("127.0.0.1")),
  port: between(1024, 65535, 3080),
  operatorTokenEnv: envName.pipe(withDefault("JUNE_OPERATOR_TOKEN")),
  audio: audioConfigSchema.pipe(withDefault({})),
  agentMcp: Schema.optionalKey(
    Schema.Struct({
      origin: httpsOrLoopbackOrigin,
      directory: absolutePath,
      keyEnv: envName,
      clients: Schema.Record(
        name,
        Schema.Struct({
          tokenEnv: envName,
          expiresAt: positiveSafe,
        }),
      ).check(
        check(
          (clients) =>
            Object.keys(clients).length > 0 &&
            Object.keys(clients).length <= 32 &&
            Object.keys(clients).every((id) => id.length <= 80),
        ),
      ),
      destinations: Schema.Array(
        Schema.Struct({
          origin: Url.check(
            check((value) => {
              const url = new URL(value);
              return value === url.origin && url.protocol === "https:";
            }),
          ),
          pathPrefix: Schema.String.check(
            Schema.isMinLength(1),
            Schema.isMaxLength(1000),
          ),
        }),
      )
        .check(Schema.isMaxLength(32))
        .pipe(withDefault([])),
    }),
  ),
  ampJobs: Schema.optionalKey(ampJobsSchema),
  sentinel: Schema.Struct({
    maxWaitMs: between(0, 60_000, 15_000),
    model: Schema.optionalKey(companionModel),
  }).pipe(withDefault({ maxWaitMs: 15_000 })),
  continuity: Schema.optionalKey(
    Schema.Struct({
      idleMs: between(1000, 7 * 24 * 60 * 60 * 1000, 3 * 60 * 60 * 1000),
      model: decisionModel,
    }),
  ),
  debugShare: Schema.optionalKey(
    Schema.Struct({
      directory: absolutePath.pipe(withDefault("/var/lib/june-debugshare")),
      // Accepted during migration only; DEBUGSHARE no longer executes locally.
      repositoryRoot: Schema.optionalKey(absolutePath),
      worktreeRoot: Schema.optionalKey(absolutePath),
      timeoutMs: between(1000, 3_600_000, 900_000),
    }),
  ),
  debugSite: Schema.optionalKey(
    Schema.Struct({
      origin: httpsOrLoopbackOrigin,
      tokenEnv: envName,
      operationsTokenEnv: Schema.optionalKey(envName),
      operationsDatabase: Schema.optionalKey(absolutePath),
    }),
  ),
  activitySessions: Schema.Struct({
    enabled: flag(false),
    idleMs: between(1000, 7 * 24 * 60 * 60 * 1000, 3 * 60 * 60 * 1000),
  }).pipe(withDefault({ enabled: false, idleMs: 3 * 60 * 60 * 1000 })),
  artifacts: Schema.optionalKey(
    Schema.Struct({
      origin: baseUrl.check(
        check(
          (value) =>
            new URL(value).origin === value && value.startsWith("https://"),
          "Use a dedicated HTTPS origin",
        ),
      ),
      port: Int({ minimum: 1024, maximum: 65535 }),
      directory: absolutePath,
      /** Optional prebuilt client; omitted means build from this release at startup. */
      assets: Schema.optionalKey(absolutePath),
      encryptionKeyEnv: envName,
      pepperEnv: envName,
      experimentalSlackEmbed: flag(false),
    }),
  ),
  // On by default: June signs control requests with her own Ed25519 key
  // (kept with her state); the Rivet app host pins only the public key.
  dynamicApps: Schema.Struct({
    enabled: flag(true),
    endpoint: baseUrl
      .check(
        check(
          (value) =>
            new URL(value).origin === value &&
            (value.startsWith("https://") ||
              loopback.includes(new URL(value).hostname)),
          "Use an HTTPS origin or loopback HTTP for the dedicated app host",
        ),
      )
      .pipe(withDefault("https://mrrpmraow.com")),
    /** Optional coding workspace for coding-job builds. */
    workspace: Schema.optionalKey(name),
    /** Ignored legacy bearer setting; control requests are signed. */
    tokenEnv: Schema.optionalKey(envName),
  }).pipe(withDefault({ enabled: true, endpoint: "https://mrrpmraow.com" })),
  eventWebhooks: Schema.Record(
    pattern(/^[a-z][a-z0-9-]{0,47}$/),
    Schema.Struct({ secretEnv: envName }),
  ).pipe(withDefault({})),
  deployment: Schema.optionalKey(
    Schema.Struct({
      tokenEnv: envName.pipe(withDefault("JUNE_DEPLOY_TOKEN")),
      intakeTokenEnv: Schema.optionalKey(envName),
      blueGreen: flag(false),
      eventsFile: absolutePath.pipe(
        withDefault("/var/lib/june-deploy/public/events.json"),
      ),
    }),
  ),
  console: Schema.optionalKey(
    Schema.Struct({
      origin: Url.check(
        check((value) => {
          const url = new URL(value);
          return (
            url.origin === value &&
            (url.protocol === "https:" ||
              (url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
          );
        }, "Use a canonical private HTTPS origin, or loopback HTTP for an SSH tunnel"),
      ),
    }),
  ),
  capabilities: Schema.optionalKey(Schema.Struct({ directory: absolutePath })),
  moduleConfig: Schema.optionalKey(capabilityConfigSchema),
  credentials: Schema.optionalKey(
    Schema.Struct({
      executable: absolutePath,
      appDataDir: absolutePath,
      sessionFile: absolutePath,
      bindings: Schema.Array(
        Schema.Struct({
          account: name,
          item: name,
          origin: Url.check(
            check((value) => {
              const url = new URL(value);
              return url.protocol === "https:" && url.origin === value;
            }, "Use an exact canonical HTTPS origin"),
          ),
          vaultItemId: pattern(
            /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu,
          ),
          field: Schema.Literals(["bearer", "login"]),
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    }),
  ),
  mcp: Schema.optionalKey(
    Schema.Struct({
      directory: absolutePath,
      keyEnv: envName.pipe(withDefault("JUNE_MCP_KEY")),
      github: Schema.optionalKey(
        Schema.Struct({
          clientIdEnv: envName.pipe(withDefault("JUNE_GITHUB_CLIENT_ID")),
          clientSecretEnv: envName.pipe(
            withDefault("JUNE_GITHUB_CLIENT_SECRET"),
          ),
          webhookSecretEnv: envName.pipe(
            withDefault("JUNE_GITHUB_WEBHOOK_SECRET"),
          ),
          userId: Int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          appSlug: pattern(/^[a-z0-9][a-z0-9-]{0,99}$/),
        }),
      ),
      slack: Schema.optionalKey(
        Schema.Struct({
          // Preserve existing installs until the operator coordinates cutover.
          appId: pattern(/^A[A-Z0-9]+$/).pipe(withDefault("A0C4749KM3R")),
          clientIdEnv: envName.pipe(withDefault("JUNE_SLACK_CLIENT_ID")),
          clientSecretEnv: envName.pipe(
            withDefault("JUNE_SLACK_CLIENT_SECRET"),
          ),
          teamId: nonempty,
          userId: nonempty,
          scopes: Schema.Array(pattern(/^[a-z][a-z0-9:._-]*$/)).check(
            Schema.isMinLength(1),
            Schema.isMaxLength(30),
          ),
        }),
      ),
    }),
  ),
  browserCompanion: Schema.optionalKey(
    Schema.Struct({
      enabled: flag(false),
      directory: absolutePath,
      home: absolutePath,
      tempDirectory: absolutePath,
      codexHome: absolutePath,
      navigationOrigins: httpsOrigins(32),
      resourceOrigins: httpsOrigins(64),
      processIsolationAcknowledged: acknowledged,
      networkIsolationAcknowledged: acknowledged,
      ephemeralStorageAcknowledged: acknowledged,
      resourceLimitsAcknowledged: acknowledged,
    }),
  ),
  browser: Schema.Struct({
    enabled: flag(false),
    readOperations: Schema.Array(
      browserOperationSchema.check(
        check(
          (recipe) =>
            recipe.steps.length === 0 &&
            recipe.requests.every(
              (request) => request.method === "GET" && !request.credential,
            ),
          "Browser reads must be anonymous GET recipes without interaction steps",
        ),
      ),
    )
      .check(Schema.isMaxLength(64))
      .pipe(withDefault([])),
    mutationOperations: Schema.Array(browserMutationSchema)
      .check(Schema.isMaxLength(16))
      .pipe(withDefault([])),
    credentialOperations: Schema.Array(browserCredentialOperationSchema)
      .check(Schema.isMaxLength(64))
      .pipe(withDefault([])),
    timeoutMs: between(100, 60000, 15000),
    execution: Schema.optionalKey(
      Schema.Struct({
        kind: Schema.Literal("isolated-host"),
        home: absolutePath,
        tempDirectory: absolutePath,
        processIsolationAcknowledged: acknowledged,
        networkIsolationAcknowledged: acknowledged,
        ephemeralStorageAcknowledged: acknowledged,
        resourceLimitsAcknowledged: acknowledged,
      }),
    ),
  })
    .check(
      check(
        (browser) =>
          !browser.enabled ||
          (!!browser.execution &&
            browser.readOperations.length +
              browser.mutationOperations.length +
              browser.credentialOperations.length >
              0),
        "Enabled browsing requires explicit isolated execution and named recipes",
      ),
    )
    .pipe(withDefault({})),
  setupMode: flag(false),
  owner: Schema.Struct({
    id: pattern(/^[a-zA-Z0-9_-]+$/),
    identities: Schema.Array(
      Schema.Struct({
        channel: Schema.Literals(["slack", "whatsapp", "audio"]),
        accountId: nonempty,
        senderId: nonempty,
      }),
    ).check(
      check(
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
    ),
  }),
  model: companionModel,
  deepModel: Schema.optionalKey(companionModel),
  executionEnabled: flag(true),
  jev: Schema.optionalKey(
    Schema.Struct({
      endpoint: baseUrl.check(check((value) => value.startsWith("https:"))),
      model: nonempty.check(Schema.isMaxLength(256)),
      apiKeyEnv: envName,
      timeoutMs: between(1000, 30000, 10000),
      question: jevQuestionSchema.check(
        check(
          (question) =>
            Buffer.byteLength(JSON.stringify(question)) <= 1024 &&
            (question.type !== "choice" ||
              Object.keys(question.criteria).length <= 8),
          "Use one bounded observation rubric (1024 bytes, at most 8 choices)",
        ),
      ),
    }),
  ),
  emojiSearch: Schema.optionalKey(
    Schema.Struct({
      baseUrl: emojiSearchUrlSchema.pipe(
        withDefault("https://emojis.raygen.dev"),
      ),
      // Deprecated compatibility key; public search ignores credentials.
      readTokenEnv: Schema.optionalKey(envName),
      timeoutMs: between(100, 5000, 1500),
    }),
  ),
  webSearch: Schema.optionalKey(
    discriminated("provider", [
      Schema.Struct({
        provider: Schema.Literal("tavily"),
        apiKeyEnv: envName.pipe(withDefault("TAVILY_API_KEY")),
        timeoutMs: between(1000, 15000, 10000),
      }),
      Schema.Struct({
        provider: Schema.Literal("tinyfish"),
        apiKeyEnv: envName.pipe(withDefault("TINYFISH_API_KEY")),
        timeoutMs: between(1000, 15000, 10000),
      }),
    ]),
  ),
  e2b: Schema.optionalKey(
    Schema.Struct({
      apiKeyEnv: envName.pipe(withDefault("E2B_API_KEY")),
    }),
  ),
  environments: Schema.optionalKey(
    Schema.Struct({
      enabled: flag(false),
      provider: Schema.Literal("boxlite").pipe(withDefault("boxlite")),
      directory: absolutePath,
      image: Schema.optionalKey(
        nonempty.check(Schema.isPattern(/^[^\s@]+@sha256:[a-f0-9]{64}$/)),
      ),
      rootfsPath: Schema.optionalKey(absolutePath),
      allowedHosts: Schema.Array(
        pattern(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/),
      )
        .check(Schema.isMaxLength(32))
        .pipe(withDefault([])),
    }).check(
      check(
        (value) => !!value.image !== !!value.rootfsPath,
        "BoxLite needs exactly one immutable image or OCI layout",
      ),
    ),
  ),
  slack: Schema.optionalKey(
    Schema.Struct({
      teamId: nonempty,
      botUserId: nonempty,
      signingSecretEnv: envName,
      botTokenEnv: envName,
      webEmbedOrigins: Schema.Array(
        webEmbedUrlSchema.check(
          check(
            (value) => URL.parse(value)?.origin === value,
            "Use an exact HTTPS origin without a trailing slash",
          ),
        ),
      )
        .check(Schema.isMaxLength(20))
        .pipe(withDefault([])),
      searchEnabled: flag(true),
      participateInOwnerChannels: flag(false),
      contextEnabled: flag(false),
      workspaceUrl: Schema.optionalKey(
        Url.check(
          check((value) => {
            const url = new URL(value);
            return (
              url.protocol === "https:" &&
              /^[a-z0-9-]+\.slack\.com$/.test(url.hostname) &&
              url.href === `${url.origin}/`
            );
          }, "Use the canonical workspace URL returned by Slack auth.test"),
        ),
      ),
    }),
  ),
  whatsapp: Schema.optionalKey(
    Schema.Struct({
      phoneNumberId: pattern(/^\d+$/),
      apiVersion: pattern(/^v\d+\.\d+$/),
      appSecretEnv: envName,
      verifyTokenEnv: envName,
      accessTokenEnv: envName,
    }),
  ),
  memory: Schema.optionalKey(
    Schema.Struct({
      directory: absolutePath,
      keyEnv: envName,
      importBudget: Schema.optionalKey(
        Schema.Struct({
          sources: Schema.optionalKey(positiveSafe),
          claims: Schema.optionalKey(positiveSafe),
          serializedBytes: Schema.optionalKey(positiveSafe),
        }),
      ),
      restore: Schema.optionalKey(
        Schema.Struct({
          watermark: nonnegativeSafe,
          tombstonePages: absolutePath,
        }),
      ),
      extraction: Schema.optionalKey(Schema.Struct(decisionModelFields)),
      curated: Schema.optionalKey(
        Schema.Struct({ directory: absolutePath, keyEnv: envName }),
      ),
    }),
  ),
  mind: Schema.optionalKey(
    Schema.Struct({
      directory: absolutePath,
      reflectIdleMs: between(60_000, 7 * 24 * 60 * 60 * 1000, 10 * 60 * 1000),
      timezone: nonempty
        .check(
          check((zone) => {
            try {
              new Intl.DateTimeFormat("en-US", { timeZone: zone });
              return true;
            } catch {
              return false;
            }
          }, "Use an IANA time zone"),
        )
        .pipe(withDefault("America/Denver")),
      timeoutMs: between(30_000, 300_000, 300_000),
      dreamHour: between(0, 23, 3),
      remote: Schema.optionalKey(
        Schema.Struct({
          url: Schema.String.check(
            Schema.isPattern(
              /^(?:git@github\.com:[\w.-]+\/[\w.-]+\.git|\/[^\s]+)$/,
              {
                message:
                  "Use git@github.com:owner/repo.git (or an absolute path for local checks)",
              },
            ),
          ),
          sshKey: Schema.optionalKey(absolutePath),
          knownHosts: Schema.optionalKey(absolutePath),
        }).check(
          check(
            (remote) => !remote.sshKey === !remote.knownHosts,
            "sshKey and knownHosts go together",
          ),
        ),
      ),
    }),
  ),
  imports: Schema.Record(
    name,
    Schema.Struct({
      platform: Schema.Literals(["slack", "gmail"]),
      account: nonempty,
      conversations: Schema.Array(nonempty).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(1000),
      ),
      from: nonnegativeSafe,
      to: nonnegativeSafe,
      accessTokenEnv: envName,
    }).check(
      check((value) => value.from < value.to, "Invalid import interval"),
    ),
  ).pipe(withDefault({})),
  reflection: Schema.optionalKey(
    Schema.Struct({
      model: decisionModel,
      juryEnabled: flag(false),
      idleMs: between(1000, 86400000, 300000),
      deepMs: between(1000, 86400000, 3600000),
      pollMs: between(1000, 86400000, 60000),
      timeoutMs: between(1000, 300000, 60000),
      policy: Schema.Struct({
        totalCapacity: between(2, 8, 2),
        liveReserve: between(1, 7, 1),
        cooldownMs: between(1000, 86400000, 300000),
        maxNoNewEvidence: between(1, 10, 2),
        maxAttempts: between(1, 10, 3),
        evidenceMaxAgeMs: between(1000, 31536000000, 604800000),
        quiet: Schema.Struct({
          timeZone: nonempty.pipe(withDefault("America/Boise")),
          startMinute: between(0, 1439, 1320),
          endMinute: between(0, 1439, 480),
        }).pipe(withDefault({})),
      }).pipe(withDefault({})),
    }).check(
      check(
        (value) =>
          value.deepMs >= value.idleMs &&
          value.policy.liveReserve < value.policy.totalCapacity,
        "Reflection requires idle/deep ordering and reserved live capacity",
      ),
    ),
  ),
  coding: Schema.Struct({
    enabled: flag(false),
    runtime: Schema.optionalKey(
      discriminated("kind", [
        Schema.Struct({ kind: Schema.Literal("amp") }),
        Schema.Struct({
          kind: Schema.Literal("codex"),
          home: absolutePath,
          model: Schema.optionalKey(nonempty),
          executable: Schema.optionalKey(absolutePath),
        }),
        Schema.Struct({
          kind: Schema.Literal("claude"),
          apiKeyEnv: envName,
          stateDirectory: absolutePath,
          model: Schema.optionalKey(nonempty),
          allowedTools: Schema.Array(
            Schema.Literals(["Read", "Glob", "Grep", "Edit", "Write", "Bash"]),
          ).pipe(withDefault([])),
          maxTurns: between(1, 1000, 40),
        }),
        Schema.Struct({
          kind: Schema.Literal("pi"),
          executable: absolutePath,
          provider: nonempty,
          model: nonempty,
          home: absolutePath,
          path: nonempty,
          agentDir: absolutePath,
          sessionDir: absolutePath,
          hostSandboxAcknowledged: acknowledged,
        }),
      ]),
    ),
    workspaces: Schema.Record(
      pattern(/^[a-zA-Z0-9_-]+$/),
      nonempty.check(check(isAbsolute, "Workspace must be absolute")),
    ).pipe(withDefault({})),
    isolation: Schema.Record(
      name,
      Schema.Struct({
        worktreeRoot: absolutePath,
        verifier: Schema.optionalKey(
          Schema.Struct({
            argv: Schema.TupleWithRest(Schema.Tuple([absolutePath]), [
              Schema.String,
            ]),
            timeoutMs: Int({ minimum: 1000, maximum: 3600000 }),
            env: Schema.Record(envName, Schema.String).pipe(withDefault({})),
          }),
        ),
      }),
    ).pipe(withDefault({})),
    timeoutMs: between(1000, 86_400_000, 3_600_000),
  }).pipe(withDefault({})),
}).check(
  check(
    (config) =>
      config.setupMode
        ? !config.slack &&
          !config.whatsapp &&
          !config.agentMcp &&
          !(
            config.audio.enabled && Object.keys(config.audio.endpoints).length
          ) &&
          !config.coding.enabled
        : !!config.agentMcp ||
          (config.audio.enabled &&
            Object.keys(config.audio.endpoints).length > 0) ||
          (!!(config.slack || config.whatsapp) &&
            config.owner.identities.length > 0),
    "Configure a channel and owner identities, or enable channel-free setup mode with coding disabled",
  ),
  check(
    (config) =>
      (!!config.memory ||
        (!config.reflection && !Object.keys(config.imports).length)) &&
      (!config.memory || !config.slack || !!config.slack.workspaceUrl),
    "Memory is required for reflection/imports; live Slack memory requires its verified workspace URL",
  ),
  check(
    (config) => !config.continuity || (!!config.memory && !config.setupMode),
    "Continuity requires private memory storage and cannot run in setup mode",
  ),
  check(
    (config) =>
      !config.activitySessions.enabled ||
      (!config.setupMode &&
        !!config.memory &&
        !!(
          config.slack ||
          config.agentMcp ||
          (config.audio.enabled && Object.keys(config.audio.endpoints).length)
        ) &&
        config.executionEnabled &&
        !(
          config.whatsapp &&
          config.owner.identities.some(
            (identity) => identity.channel === "whatsapp",
          )
        )),
    "Activity sessions require retained memory, execution workers and Slack, agent or trusted-device audio ingress",
  ),
  check(
    (config) =>
      !config.setupMode ||
      (!config.reflection &&
        !config.memory?.extraction &&
        !Object.keys(config.imports).length),
    "Setup mode cannot run reflection or historical imports",
  ),
  check(
    (config) => !config.browser.enabled || !!config.capabilities,
    "Enabled browsing requires the generic capability broker",
  ),
  check(
    (config) =>
      !config.browserCompanion?.enabled || !config.deployment?.blueGreen,
    "Browser PIN input cannot pass through the durable blue-green Slack intake queue",
  ),
  check(
    (config) =>
      !config.artifacts ||
      (!config.setupMode &&
        config.artifacts.port !== config.port &&
        !(
          config.deployment?.blueGreen &&
          [3081, 3082, 3083].includes(config.artifacts.port)
        )),
    "Artifacts require active channels and their own listener port, distinct from June and blue-green slot/intake ports",
  ),
  check(
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
  ),
  check(
    (config) =>
      !config.dynamicApps.workspace ||
      (config.coding.enabled &&
        !!config.coding.isolation[config.dynamicApps.workspace]?.verifier),
    "Dynamic Apps coding builds require enabled coding and a verified workspace",
  ),
);

/** Mutable like the Zod output it replaces: startup rebinds the listener. */
export type Config = Types.DeepMutable<typeof schema.Type>;

const decode = Schema.decodeUnknownExit(schema, strictWithInputs);

export function parseConfig(input: unknown): Config {
  const result = decode(input);
  if (Exit.isFailure(result)) {
    const error = Cause.findErrorOption(result.cause);
    // A check that throws (for example on an unparseable URL) still throws.
    if (Option.isNone(error)) throw Cause.squash(result.cause);
    // Schema issues may contain values supplied in a malformed config.
    throw new Error(
      `Invalid June configuration at ${issuePaths(error.value.issue)
        .map((path) => path || "root")
        .join(", ")}`,
    );
  }
  const config = result.value as Config;
  // An explicit audio identity cannot substitute for a trusted-device endpoint.
  if (
    config.owner.identities.some(
      (identity) =>
        identity.channel === "audio" &&
        (identity.accountId !== "audio" ||
          !config.audio.enabled ||
          !Object.hasOwn(config.audio.endpoints, identity.senderId) ||
          config.audio.endpoints[identity.senderId]?.trustedOwnerDevice !==
            true),
    )
  )
    throw new Error(
      "Audio owner identities require configured trusted owner devices",
    );
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
  if (config.whatsapp) {
    const identities = config.owner.identities.filter(
      (identity) => identity.channel === "whatsapp",
    );
    if (
      identities.length !== 1 ||
      identities[0]?.accountId !== config.whatsapp.phoneNumberId ||
      !/^\d+$/.test(identities[0]?.senderId ?? "")
    )
      throw new Error(
        "Configure exactly one WhatsApp owner with an international digits-only sender ID and the configured phone-number ID",
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
