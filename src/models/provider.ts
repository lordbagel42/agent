import { z } from "zod";
import { appsRequestSchema } from "../apps/client.js";
import type {
  CompanionReply,
  ModelProvider,
  ModelRequest,
} from "../core/contracts.js";
import {
  rivetActorNames,
  rivetRequestSchema,
  rivetTargets,
} from "../core/rivet.js";
import { slackHistorySchema } from "../core/slack-history.js";
import { socialActionSchema } from "../core/social.js";
import { globalProposalInputSchema } from "../reflection/global-proposal.js";
import { juryRequestSchema } from "../reflection/jury.js";
import {
  globalStyleSchema,
  personalityPreviewSchema,
} from "../runtime/personality.js";
import { personalityEvaluateSchema } from "../runtime/personality-evaluation-preview.js";
import { wakeupActionSchema } from "../wakeups/state.js";
import { workflowCommandSchema } from "../workflows/contracts.js";
import {
  observeUsage,
  tokenUsage,
  type UsageLedger,
  type UsageStage,
} from "./usage.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;

export class ModelError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(`Model provider request failed (${code})`);
    this.name = "ModelError";
    this.code = code;
    this.retryable = retryable;
  }
}

const searchQuerySchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Array.from(value).length <= 500);

const recallCategorySchema = z.enum([
  "claim",
  "preference",
  "commitment",
  "pattern",
]);
const recallTimestampSchema = z
  .number()
  .int()
  .nonnegative()
  .safe()
  .nullish()
  .transform((value) => value ?? undefined);

const companionReplySchema = z.strictObject({
  text: z.string().refine((text) => Array.from(text).length <= 3_500),
  workflow: workflowCommandSchema.optional(),
  execution: z
    .array(
      z
        .strictObject({
          agent: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
          action: z.enum(["run", "cancel"]),
          task: z.string().trim().max(2000),
        })
        .refine(
          (command) => command.action === "cancel" || command.task.length > 0,
        ),
    )
    .min(1)
    .max(4)
    .refine(
      (commands) =>
        new Set(commands.map((c) => c.agent)).size === commands.length,
    )
    .optional(),
  social: socialActionSchema.optional(),
  wakeup: wakeupActionSchema.optional(),
  coding: z
    .strictObject({
      workspace: z.string(),
      goal: z.string().refine((goal) => goal.trim().length > 0),
    })
    .optional(),
  codingJob: z
    .strictObject({
      action: z.enum(["list", "inspect", "diff", "report", "cancel"]),
      id: z
        .string()
        .regex(/^[a-f0-9]{12,64}$/)
        .nullable(),
    })
    .refine((value) => (value.action === "list") === (value.id === null))
    .optional(),
  reaction: z.string().optional(),
  search: searchQuerySchema.optional(),
  slackHistory: slackHistorySchema.optional(),
  escalate: z.boolean().optional(),
  webSearch: searchQuerySchema.optional(),
  release: z
    .strictObject({
      action: z.literal("inspect"),
      revision: z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .nullable(),
    })
    .optional(),
  mcp: z
    .strictObject({
      connection: z.string().min(1).max(256),
      tool: z.string().min(1).max(256),
      argumentsJson: z.string().max(4000),
    })
    .optional(),
  mcpPermission: z
    .strictObject({
      connection: z.string().min(1).max(256),
      tool: z.string().min(1).max(256),
    })
    .optional(),
  mcpCatalog: z
    .strictObject({
      connection: z.string().min(1).max(256).nullable(),
      tool: z.string().min(1).max(256).nullable(),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .refine((value) => value.tool === null || value.connection !== null)
    .optional(),
  mcpProposal: z
    .strictObject({
      action: z.literal("inspect"),
      id: z.uuid({ version: "v4" }).transform((value) => value.toLowerCase()),
    })
    .optional(),
  latency: z
    .union([
      z.literal("recent"),
      z.literal("logs"),
      z.uuid({ version: "v4" }).transform((value) => value.toLowerCase()),
    ])
    .optional(),
  replyInThread: z.boolean().optional(),
  apps: appsRequestSchema.optional(),
  inspection: z
    .union([
      z.enum([
        "tombstones",
        "capability-matrix",
        "memory",
        "imports",
        "reflection",
        "native-coding",
        "inference",
        "retention",
        "capabilities",
        "credentials",
        "slack-search",
        "snapshot-retention",
        "operations",
        "mcp-connections",
        "personality",
        "backup",
        "mcp-enrollment",
      ]),
      z.strictObject({
        target: z.literal("imports"),
        selection: z.string().min(1).nullable(),
        offset: z.number().int().nonnegative().safe(),
      }),
      z.strictObject({
        target: z.literal("import-approval"),
        selection: z.string().min(1),
      }),
    ])
    .optional(),
  recall: z
    .union([
      searchQuerySchema,
      z.strictObject({
        kind: z.literal("dependents"),
        sourceId: z.string().min(1).max(2048),
      }),
      z
        .strictObject({
          kind: z.literal("search"),
          query: z
            .string()
            .trim()
            .refine((value) => Array.from(value).length <= 500),
          category: recallCategorySchema
            .nullish()
            .transform((value) => value ?? undefined),
          cursor: z
            .string()
            .regex(/^[A-Za-z0-9_-]{43}$/)
            .nullish()
            .transform((value) => value ?? undefined),
          entity: z
            .string()
            .min(1)
            .max(2048)
            .nullish()
            .transform((value) => value ?? undefined),
          observedFrom: recallTimestampSchema,
          observedTo: recallTimestampSchema,
          validAt: recallTimestampSchema,
        })
        .refine(
          (value) =>
            value.observedFrom === undefined ||
            value.observedTo === undefined ||
            value.observedFrom < value.observedTo,
        ),
      z.strictObject({
        kind: z.literal("source"),
        sourceId: z.string().min(1).max(2048),
      }),
      z.strictObject({
        kind: z.literal("contradictions"),
        claimId: z.string().min(1).max(2048),
      }),
      z.strictObject({
        kind: z.literal("supersession"),
        claimId: z.string().min(1).max(2048),
      }),
      z.strictObject({
        kind: z.literal("claim"),
        claimId: z.string().min(1).max(2048),
      }),
    ])
    .optional(),
  pendingMemory: z.literal(true).optional(),
  personalitySuggestion: globalProposalInputSchema.optional(),
  jevObservation: z.boolean().optional(),
  reflectionRequest: z
    .strictObject({
      evidenceIds: z.array(z.string().trim().min(1).max(2048)).min(1).max(20),
      mode: z.enum(["idle", "deep"]),
      kind: z.enum(["reflection", "curiosity"]).optional(),
    })
    .optional(),
  jury: juryRequestSchema.optional(),
  rivet: rivetRequestSchema.optional(),
  browserProposal: z
    .strictObject({ operation: z.string().min(1).max(128).nullable() })
    .optional(),
  personalityPreview: personalityPreviewSchema.optional(),
  forgetPreview: z
    .strictObject({ sourceId: z.string().min(1).max(2048) })
    .optional(),
  personalityEvaluate: personalityEvaluateSchema.optional(),
  importCancel: z.string().min(1).max(2048).optional(),
  analytics: z
    .strictObject({
      days: z.union([z.literal(1), z.literal(7), z.literal(30)]),
    })
    .optional(),
  modelStatus: z.boolean().optional(),
  dashboardLogin: z.boolean().optional(),
});

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ReplyCapabilities = Pick<
  ModelRequest,
  | "codingJobsAvailable"
  | "searchAvailable"
  | "slackHistoryAvailable"
  | "escalationAvailable"
  | "webSearchAvailable"
  | "releaseAvailable"
  | "modelStatusAvailable"
  | "mcpAvailable"
  | "mcpPermissionAvailable"
  | "mcpProposalAvailable"
  | "latencyAvailable"
  | "analyticsAvailable"
  | "inspectionAvailable"
  | "appsAvailable"
  | "recallAvailable"
  | "pendingMemoryAvailable"
  | "personalitySuggestionAvailable"
  | "jevObservationAvailable"
  | "reflectionRequestAvailable"
  | "juryAvailable"
  | "rivetAvailable"
  | "browserProposalAvailable"
  | "personalityPreviewAvailable"
  | "forgetPreviewAvailable"
  | "personalityEvaluateAvailable"
  | "importCancelAvailable"
  | "dashboardLoginAvailable"
  | "wakeupAvailable"
  | "replyPlacementAvailable"
  | "socialAvailable"
  | "executionAvailable"
  | "workflowAvailable"
>;

function replyCapabilities(
  capabilities: ReplyCapabilities | boolean,
): ReplyCapabilities {
  return typeof capabilities === "boolean"
    ? { searchAvailable: capabilities }
    : capabilities;
}

export function replyJsonSchema(
  workspaces: string[],
  capabilities: ReplyCapabilities | boolean = false,
) {
  const {
    codingJobsAvailable,
    searchAvailable,
    slackHistoryAvailable,
    escalationAvailable,
    webSearchAvailable,
    releaseAvailable,
    modelStatusAvailable,
    mcpAvailable,
    mcpPermissionAvailable,
    mcpProposalAvailable,
    latencyAvailable,
    analyticsAvailable,
    inspectionAvailable,
    appsAvailable,
    recallAvailable,
    pendingMemoryAvailable,
    personalitySuggestionAvailable,
    jevObservationAvailable,
    reflectionRequestAvailable,
    juryAvailable,
    rivetAvailable,
    browserProposalAvailable,
    personalityPreviewAvailable,
    forgetPreviewAvailable,
    personalityEvaluateAvailable,
    importCancelAvailable,
    dashboardLoginAvailable,
    wakeupAvailable,
    replyPlacementAvailable,
    socialAvailable,
    executionAvailable,
    workflowAvailable,
  } = replyCapabilities(capabilities);
  const { $schema: _previewSchema, ...previewSchema } = z.toJSONSchema(
    personalityPreviewSchema.nullable(),
    {
      target: "draft-7",
      override({ jsonSchema }) {
        // Raw Anthropic schemas omit numeric constraints; enforce them locally.
        if (jsonSchema.type === "integer") {
          delete jsonSchema.minimum;
          delete jsonSchema.maximum;
          jsonSchema.description = "Current nonnegative safe-integer version.";
        }
      },
    },
  );
  const { $schema: _schema, ...socialSchema } = z.toJSONSchema(
    socialActionSchema.nullable(),
    {
      target: "draft-7",
      override({ jsonSchema }) {
        // Raw Anthropic structured outputs reject these constraints. Keep the
        // strict Zod checks locally and describe the bounds on the wire.
        for (const key of ["minLength", "maxLength", "maxItems"] as const) {
          const limit = jsonSchema[key];
          if (limit !== undefined) {
            jsonSchema.description =
              `${jsonSchema.description ?? ""} ${key}: ${limit}.`.trim();
            delete jsonSchema[key];
          }
        }
      },
    },
  );
  const { $schema: _wakeupSchema, ...wakeupSchema } = z.toJSONSchema(
    wakeupActionSchema.nullable(),
    {
      target: "draft-7",
      override({ jsonSchema }) {
        for (const key of [
          "minLength",
          "maxLength",
          "maxItems",
          "pattern",
          "format",
        ] as const) {
          const limit = jsonSchema[key];
          if (limit !== undefined) {
            jsonSchema.description =
              `${jsonSchema.description ?? ""} ${key}: ${limit}.`.trim();
            delete jsonSchema[key];
          }
        }
      },
    },
  );
  const permittedWorkspaces = [...new Set(workspaces)];
  const coding =
    permittedWorkspaces.length === 0
      ? { type: "null" }
      : {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            workspace: { type: "string", enum: permittedWorkspaces },
            goal: {
              type: "string",
              description:
                "Must contain at least one non-whitespace character.",
            },
          },
          required: ["workspace", "goal"],
        };

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      text: {
        type: "string",
        description: "Must be no more than 3500 Unicode characters.",
      },
      coding,
      reaction: { type: ["string", "null"] },
      ...(codingJobsAvailable
        ? {
            codingJob: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                action: {
                  type: "string",
                  enum: ["list", "inspect", "diff", "report", "cancel"],
                },
                id: {
                  type: ["string", "null"],
                  description:
                    "Null for list; otherwise an existing job ID or unique lowercase hexadecimal prefix, 12–64 characters.",
                },
              },
              required: ["action", "id"],
              description:
                "Owner-private coding availability, durable job metadata, bounded saved report, or cancellation request. report returns worker claims separately from saved verifier evidence; no verifier command runs. Cancel is not proof of stoppage. Never approves, resumes, or launches work. Leave text empty and all other actions unset.",
            },
          }
        : {}),
      ...(workflowAvailable
        ? {
            workflow: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                action: {
                  type: "string",
                  enum: [
                    "help",
                    "define",
                    "start",
                    "list",
                    "inspect",
                    "signal",
                    "cancel",
                  ],
                },
                name: { type: ["string", "null"] },
                source: {
                  type: ["string", "null"],
                  description:
                    "JavaScript function body, at most 24000 bytes, for define or start-and-define.",
                },
                dataJson: {
                  type: ["string", "null"],
                  description:
                    "JSON input for start or signal, at most 16384 bytes.",
                },
                runId: { type: ["string", "null"] },
                offset: {
                  type: "integer",
                  description:
                    "Start at 0; continue at nextOffset for paged reports.",
                },
              },
              required: [
                "action",
                "name",
                "source",
                "dataJson",
                "runId",
                "offset",
              ],
              description:
                "Manage owner-private authored Rivet workflows. Unused fields null, offset 0. Leave text empty and all other actions unset. help describes the API and available tools.",
            },
          }
        : {}),
      ...(executionAvailable
        ? {
            execution: {
              type: ["array", "null"],
              description:
                "One to four distinct persistent workers. Reuse a stable name for follow-ups. run sends a task; cancel stops pending work. Do not combine with other action directives. Text may acknowledge, not claim completion.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  agent: { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$" },
                  action: { type: "string", enum: ["run", "cancel"] },
                  task: {
                    type: "string",
                    description:
                      "Self-contained instructions, 1–2000 characters for run; empty for cancel. Never include secrets.",
                  },
                },
                required: ["agent", "action", "task"],
              },
            },
          }
        : {}),
      ...(appsAvailable
        ? {
            apps: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                action: {
                  type: "string",
                  enum: ["build", "prepare", "inspect"],
                },
                appId: {
                  type: "string",
                  description:
                    "Lowercase app ID, letters/digits/hyphens, starting with a letter, max 48 characters.",
                },
                jobId: {
                  type: ["string", "null"],
                  description:
                    "Exact 64-character coding job ID for prepare; null otherwise.",
                },
                goal: {
                  type: ["string", "null"],
                  description:
                    "Build task (1–900 characters) for build; null otherwise.",
                },
              },
              required: ["action", "appId", "jobId", "goal"],
              description:
                "Request an app coding proposal, prepare verified source for separate owner approval, or inspect recorded deployment status. Never approves or deploys. Empty text, no other directives.",
            },
          }
        : {}),
      ...(modelStatusAvailable
        ? {
            modelStatus: {
              type: ["boolean", "null"],
              description:
                "Read-only model runtime inspection. Set true with empty text and no other actions.",
            },
          }
        : {}),
      ...(wakeupAvailable ? { wakeup: wakeupSchema } : {}),
      ...(releaseAvailable
        ? {
            release: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                action: { type: "string", enum: ["inspect"] },
                revision: {
                  type: ["string", "null"],
                  description:
                    "Exact lowercase 40-character SHA to track, or null to inspect recent events.",
                },
              },
              required: ["action", "revision"],
              description:
                "Inspect deployment progress, blockers, and revision identity using existing controller evidence. Read-only; no activation, approval, push, or retry. Leave text empty and other actions unset.",
            },
          }
        : {}),
      ...(jevObservationAvailable
        ? {
            jevObservation: {
              type: ["boolean", "null"],
              description:
                "Only when explicitly asked: observe the current owner-private message with the configured Jev rubric. Set true with empty text and no other actions. Typed observation/abstention only, never a jury verdict or permission.",
            },
          }
        : {}),
      ...(rivetAvailable
        ? {
            rivet: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                target: { type: "string", enum: [...rivetTargets] },
                actorId: { type: ["string", "null"] },
                name: {
                  type: ["string", "null"],
                  enum: [...rivetActorNames, null],
                },
                table: { type: ["string", "null"] },
                cursor: { type: ["string", "null"] },
                pointer: { type: "string" },
                offset: { type: "integer" },
                page: { type: "integer" },
                format: { type: "string", enum: ["answer", "raw"] },
              },
              required: [
                "target",
                "actorId",
                "name",
                "table",
                "cursor",
                "pointer",
                "offset",
                "page",
                "format",
              ],
              description:
                "Owner DM only. Read June's Rivet data, never mutate. Discover actors with name (null lists actor names), then use actorId. Nullable unused fields must be null; pointer is a JSON Pointer or empty; offset is a table-row offset (0–1000000), page is a JSON-fragment page (0–1000). format raw sends the page directly, answer lets you inspect it. Live inspector reads may wake actors. No SQL or arbitrary URLs. Leave text empty and other actions unset.",
            },
          }
        : {}),
      ...(browserProposalAvailable
        ? {
            browserProposal: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: { operation: { type: ["string", "null"] } },
              required: ["operation"],
              description:
                "List configured browser mutations with operation:null, or propose one exact operation name (1–128 characters). Proposal only; cannot grant, fill, click, submit or execute. Leave text empty and other actions unset.",
            },
          }
        : {}),
      ...(inspectionAvailable
        ? {
            inspection: {
              anyOf: [
                {
                  type: ["string", "null"],
                  enum: [
                    "tombstones",
                    "capability-matrix",
                    "memory",
                    "imports",
                    "reflection",
                    "native-coding",
                    "inference",
                    "retention",
                    "capabilities",
                    "credentials",
                    "slack-search",
                    "snapshot-retention",
                    "operations",
                    "mcp-connections",
                    "personality",
                    "backup",
                    "mcp-enrollment",
                    null,
                  ],
                },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    target: { type: "string", enum: ["imports"] },
                    selection: {
                      type: ["string", "null"],
                      description:
                        "Exact configured selection ID, or null to list IDs.",
                    },
                    offset: {
                      type: "integer",
                      description:
                        "Non-negative safe integer. Start at 0; continue at the returned nextOffset.",
                    },
                  },
                  required: ["target", "selection", "offset"],
                },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    target: { type: "string", enum: ["import-approval"] },
                    selection: {
                      type: "string",
                      description: "Exact configured selection ID.",
                    },
                  },
                  required: ["target", "selection"],
                  description:
                    "Propose a review for exactly the next import page, including the first. No fetch or approval occurs. The human must explicitly confirm the displayed digest and current page count through the authenticated operator API.",
                },
              ],
              description:
                "Read owner-private bounded subsystem metadata, MCP connection inventory (even disconnected) or credential-free enrollment readiness, interrupted inference receipts, capability-route status, native-coding preflight, credential-binding configuration, public Slack search readiness or unresolved durable operation markers, not recalled content or secrets. personality returns pending global suggestions with exact proposalId/expectedVersion, fixed-vocabulary changes and safe provenance fingerprints, never private rationale or evidence bodies. retention explains retained-copy categories and logical deletion versus unverified physical erasure without scanning copies. snapshot-retention separately inspects bounded curated snapshot metadata for an operator-review dry run, never deletion permission. For exact import coverage use {target:imports, selection:null or exact ID, offset:0 or nextOffset}. Concatenate JSON chunks until nextOffset is null. Leave text empty and all other actions unset. No enrollment, deletions, approvals, retries, admission release, searches, credential resolution, native execution, network probes, account reads, imports, reflection triggers or mutations are performed.",
            },
          }
        : {}),
      ...(recallAvailable
        ? {
            recall: {
              anyOf: [
                { type: ["string", "null"] },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    kind: { type: "string", enum: ["search"] },
                    query: {
                      type: "string",
                      description:
                        "At most 500 Unicode characters; empty for filter-only recall.",
                    },
                    category: {
                      type: ["string", "null"],
                      enum: [...recallCategorySchema.options, null],
                      description:
                        "Exact stored claim category; null preserves unfiltered recall. Raw sources have no category.",
                    },
                    cursor: {
                      type: ["string", "null"],
                      pattern: "^[A-Za-z0-9_-]{43}$",
                      description:
                        "Copy nextCursor from the last page with the same query and filters. Null starts a search. Changed matching data invalidates the cursor; restart without it. Never invent offsets or cursors.",
                    },
                    entity: {
                      type: ["string", "null"],
                      description:
                        "Exact existing entity ID (1–2048 characters), not a display name or inferred identity. Extracted IDs are JSON-encoded [platform,account,author] tuples. Null omits this filter.",
                    },
                    observedFrom: {
                      type: ["integer", "null"],
                      description:
                        "Inclusive original-source observation start in epoch milliseconds (0–9007199254740991), not import time. A claim matches any original supporting source, including grounding. Null means no start bound; must precede observedTo when both are set.",
                    },
                    observedTo: {
                      type: ["integer", "null"],
                      description:
                        "Exclusive original-source observation end in epoch milliseconds (0–9007199254740991). Null means no end bound. Observation and validity filters combine with AND.",
                    },
                    validAt: {
                      type: ["integer", "null"],
                      description:
                        "Epoch-millisecond instant (0–9007199254740991) where known claim bounds satisfy validFrom <= validAt < validTo. Excludes raw sources and claims with either validity bound unknown. Null means no validity filter; never infer missing dates.",
                    },
                  },
                  required: [
                    "kind",
                    "query",
                    "category",
                    "cursor",
                    "entity",
                    "observedFrom",
                    "observedTo",
                    "validAt",
                  ],
                },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    kind: { type: "string", enum: ["source"] },
                    sourceId: {
                      type: "string",
                      description: "Exact source ID, 1–2048 characters.",
                    },
                  },
                  required: ["kind", "sourceId"],
                },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    kind: { type: "string", enum: ["contradictions"] },
                    claimId: {
                      type: "string",
                      description:
                        "Exact retained claim ID, 1–2048 characters.",
                    },
                  },
                  required: ["kind", "claimId"],
                },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    kind: { type: "string", enum: ["supersession"] },
                    claimId: {
                      type: "string",
                      description:
                        "Exact retained claim ID, 1–2048 characters.",
                    },
                  },
                  required: ["kind", "claimId"],
                },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    kind: { type: "string", enum: ["dependents"] },
                    sourceId: {
                      type: "string",
                      description:
                        "Exact source ID, 1–2048 characters; preserve verbatim.",
                    },
                  },
                  required: ["kind", "sourceId"],
                },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    kind: { type: "string", enum: ["claim"] },
                    claimId: {
                      type: "string",
                      description:
                        "Exact retained claim ID, 1–2048 characters. Never a keyword or prefix.",
                    },
                  },
                  required: ["kind", "claimId"],
                },
              ],
              description:
                "One owner-private retained-memory query: a 1–500 character keyword string, a search object with optional category, exact entity and time filters, an exact source lookup by ID, exact claim inspection, explicit contradiction-neighbor/supersession inspection by exact claim ID, or {kind:dependents,sourceId} for bounded dependent claim metadata and authorized direct/derived counts. Unknown categories and invalid time windows are rejected, never broadened. Unknown entity IDs return no matches, never name-based alternatives. The host returns bounded evidence with original provenance directly; claims remain hypotheses, not facts. Leave text empty and all other actions unset. No imports, mutations or permission changes.",
            },
          }
        : {}),
      ...(pendingMemoryAvailable
        ? {
            pendingMemory: {
              type: ["boolean", "null"],
              enum: [true, null],
              description:
                "Show bounded owner-private pending memory claims and source IDs awaiting review. Read-only, not acceptance or evidence of truth. Leave text empty and all other actions unset.",
            },
          }
        : {}),
      ...(personalitySuggestionAvailable
        ? {
            personalitySuggestion: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                expectedVersion: {
                  type: "integer",
                  description:
                    "Exact current global profile version, nonnegative.",
                },
                changes: {
                  type: "object",
                  additionalProperties: false,
                  properties: Object.fromEntries(
                    Object.entries(globalStyleSchema.shape).map(
                      ([name, schema]) => [
                        name,
                        {
                          type: ["string", "null"],
                          enum: [...schema.options, null],
                        },
                      ],
                    ),
                  ),
                  required: Object.keys(globalStyleSchema.shape),
                  description:
                    "Set unchanged fields to null; change at least one style field.",
                },
                evidenceIds: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "One to twenty distinct original source IDs supplied by private memory; never invent IDs.",
                },
                explanation: {
                  type: "string",
                  description: "Private rationale, 1–240 characters.",
                },
                confidence: {
                  type: "number",
                  description:
                    "Between zero and one; never approval authority.",
                },
              },
              required: [
                "expectedVersion",
                "changes",
                "evidenceIds",
                "explanation",
                "confidence",
              ],
              description:
                "Stage one private suggestion, never apply it. Leave text empty and all other actions unset.",
            },
          }
        : {}),
      ...(reflectionRequestAvailable
        ? {
            reflectionRequest: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                evidenceIds: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "1–20 existing retained source IDs, each 1–2048 characters; never invent IDs or provide evidence text. Existing evidence-size limits also apply.",
                },
                mode: { type: "string", enum: ["idle", "deep"] },
                kind: { type: "string", enum: ["reflection", "curiosity"] },
              },
              required: ["evidenceIds", "mode", "kind"],
              description:
                "Request owner-private reflection or curiosity over existing evidence through the same scheduler. No search, private account crawling or tools. Leave text empty and all other actions unset. Queuing does not mean evaluation or delivery; idle, quiet-hour and capacity rules still apply.",
            },
          }
        : {}),
      ...(personalityPreviewAvailable
        ? {
            personalityPreview: {
              ...previewSchema,
              description:
                "Preview a global personality revision privately without saving it. Copy unchanged style fields from the current snapshot; expectedVersion must match it. Leave text empty and other actions unset. The owner must separately confirm publication.",
            },
          }
        : {}),
      ...(forgetPreviewAvailable
        ? {
            forgetPreview: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                sourceId: {
                  type: "string",
                  description:
                    "Exact source ID, 1–2048 characters; never a query or claim ID.",
                },
              },
              required: ["sourceId"],
              description:
                "Preview authorized forgetting impact for one exact source. Counts only; no deletion or confirmation. Leave text empty and all other actions unset.",
            },
          }
        : {}),
      ...(personalityEvaluateAvailable
        ? {
            personalityEvaluate: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                candidateId: {
                  type: "string",
                  description: "Exact pending global personality proposal ID.",
                },
                heldOutSourceIds: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "1–4 distinct original interaction source IDs, not proposal support IDs. Never invent IDs.",
                },
                mode: {
                  type: ["string", "null"],
                  enum: ["compare", null],
                  description:
                    "compare judges both current and candidate on identical inputs and returns a host receipt; null previews the candidate alone.",
                },
              },
              required: ["candidateId", "heldOutSourceIds", "mode"],
              description:
                "Owner-private advisory suitability evaluation only. No profile mutation, promotion, tools or simulated message delivery. Leave text empty and all other actions unset.",
            },
          }
        : {}),
      ...(importCancelAvailable
        ? {
            importCancel: {
              type: ["string", "null"],
              description:
                "Permanently cancel one exact configured import selection ID (1–2048 characters) at the owner's private request. Inspect imports first for selection IDs. Leave text empty and other actions unset. Blocks future pages after restart, but cannot undo external reads or erase uncertainty. Cannot start or resume imports.",
            },
          }
        : {}),
      ...(analyticsAvailable
        ? {
            analytics: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: { days: { type: "integer", enum: [1, 7, 30] } },
              required: ["days"],
              description:
                "Read owner-private aggregate token usage for the last 1, 7, or 30 days plus process-local memory retrieval counts and durations when enabled. Memory metrics cover the current store opening, not the selected day window. Leave text empty and other actions unset. No billing or quota data.",
            },
          }
        : {}),
      ...(juryAvailable
        ? {
            jury: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                question: {
                  type: "string",
                  enum: [
                    "relevance",
                    "novelty",
                    "uncertainty",
                    "interruption-cost",
                  ],
                },
                prompt: {
                  type: "string",
                  description:
                    "One nonempty atomic question, at most 2000 characters.",
                },
                evidenceIds: {
                  type: "array",
                  items: {
                    type: "string",
                    description: "An existing source ID, 1–512 characters.",
                  },
                  minItems: 1,
                  description:
                    "1–20 distinct original source IDs from this turn's scoped memory.",
                },
              },
              required: ["question", "prompt", "evidenceIds"],
              description:
                "One explicitly requested owner-private advisory jury over 1–20 existing source IDs. No new evidence or authority. Leave text empty and all other actions unset.",
            },
          }
        : {}),
      ...(dashboardLoginAvailable
        ? {
            dashboardLogin: {
              type: ["boolean", "null"],
              description:
                "Issue a one-time dashboard sign-in link only when the owner asks privately. Leave text empty and other actions unset. Never invent or share a link with another audience.",
            },
          }
        : {}),
      ...(socialAvailable
        ? {
            social: {
              ...socialSchema,
              description:
                "For Raygen's current turn, post sends directly to a chosen Slack destination. request_access and outreach create approval proposals, never grant permission. Leave text empty and other actions unset.",
            },
          }
        : {}),
      ...(mcpAvailable
        ? {
            mcp: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                connection: { type: "string" },
                tool: { type: "string" },
                argumentsJson: {
                  type: "string",
                  description:
                    "JSON object of tool arguments, at most 4000 characters. No credentials.",
                },
              },
              required: ["connection", "tool", "argumentsJson"],
            },
            mcpCatalog: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                connection: { type: ["string", "null"] },
                tool: { type: ["string", "null"] },
                offset: {
                  type: "integer",
                  description:
                    "Non-negative safe integer. Start at 0; continue at the returned nextOffset.",
                },
              },
              required: ["connection", "tool", "offset"],
              description:
                "Inspect the cached owner-approved MCP catalog, not live availability. This contacts no server, grants no permission and runs no tool. Null tool pages summaries; exact connection and tool retrieve JSON contract chunks. Start offset 0, continue at nextOffset. Leave text empty and other actions unset.",
            },
          }
        : {}),
      ...(mcpProposalAvailable
        ? {
            mcpProposal: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                action: { type: "string", enum: ["inspect"] },
                id: { type: "string", description: "Exact proposal UUIDv4." },
              },
              required: ["action", "id"],
              description:
                "Inspect one recorded MCP proposal and receipt privately. Metadata only; never runs, approves or retries a tool. Leave text empty and other actions unset.",
            },
          }
        : {}),
      ...(mcpPermissionAvailable
        ? {
            mcpPermission: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                connection: { type: "string" },
                tool: { type: "string" },
              },
              required: ["connection", "tool"],
              description:
                "Inspect one exact connection ID and tool name's saved permission/trust boundary, including disabled tools. No execution, live probe, approval or permission change. Leave text empty and other actions unset.",
            },
          }
        : {}),
      ...(searchAvailable
        ? {
            search: {
              type: ["string", "null"],
              description:
                "One current-channel search query, 1–500 Unicode characters, not a public web search. When set, leave text empty and other action directives unset. The host performs the lookup.",
            },
          }
        : {}),
      ...(slackHistoryAvailable
        ? {
            slackHistory: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                target: {
                  type: "string",
                  description:
                    "Conversation ID, user ID/@mention, or exact unique user name (1–256 characters). A user selects June's existing DM with them.",
                },
                threadTs: {
                  type: ["string", "null"],
                  description:
                    "Exact thread timestamp, or null for the conversation timeline.",
                },
                cursor: {
                  type: ["string", "null"],
                  description:
                    "Continuation cursor from the prior report (at most 2000 characters), or null for the first page.",
                },
              },
              required: ["target", "threadTs", "cursor"],
              description:
                "Owner-only read of June's own accessible Slack conversations. Contents are sent only to the owner's verified Slack DM, never to this thread or the model. Leave text empty and other actions unset.",
            },
          }
        : {}),
      ...(escalationAvailable
        ? {
            escalate: {
              type: ["boolean", "null"],
              description:
                "Reply directly to casual or straightforward turns. Set true only when this turn needs the configured deeper model. Text may be empty or a brief context-sensitive acknowledgment, not a final answer or claim of completed work. Leave other action directives unset. The host durably sends any acknowledgment and calls the deeper model once; it cannot escalate again. Use false or null for a direct reply.",
            },
          }
        : {}),
      ...(webSearchAvailable
        ? {
            webSearch: {
              type: ["string", "null"],
              description:
                "One public web query, 1–500 Unicode characters, never a private Slack-history search. Do not include private conversation details or secrets in a public query. When set, leave text empty and other action directives unset. The host performs the lookup.",
            },
          }
        : {}),
      ...(latencyAvailable
        ? {
            latency: {
              type: ["string", "null"],
              description:
                "Owner-private read-only diagnostics: logs for persistent lifecycle/Slack ingress logs, recent for the last five retained timing traces (including previous processes), or an exact ping UUIDv4. Leave text empty and other actions unset. The host sends the report directly, without another model call or any new probe. Never share logs with other users or in shared channels.",
            },
          }
        : {}),
      ...(replyPlacementAvailable
        ? {
            replyInThread: {
              type: ["boolean", "null"],
              description:
                "Choose Slack placement: true uses the incoming thread or starts one on the incoming message; false posts in the main DM/channel, even for threaded input; null preserves incoming placement. Prefer unthreaded DM and ongoing channel replies unless a thread helps. May accompany any otherwise valid reply or directive.",
            },
          }
        : {}),
    },
    required: [
      "text",
      "coding",
      "reaction",
      ...(codingJobsAvailable ? ["codingJob"] : []),
      ...(workflowAvailable ? ["workflow"] : []),
      ...(executionAvailable ? ["execution"] : []),
      ...(releaseAvailable ? ["release"] : []),
      ...(modelStatusAvailable ? ["modelStatus"] : []),
      ...(mcpAvailable ? ["mcp", "mcpCatalog"] : []),
      ...(mcpPermissionAvailable ? ["mcpPermission"] : []),
      ...(mcpProposalAvailable ? ["mcpProposal"] : []),
      ...(searchAvailable ? ["search"] : []),
      ...(slackHistoryAvailable ? ["slackHistory"] : []),
      ...(escalationAvailable ? ["escalate"] : []),
      ...(webSearchAvailable ? ["webSearch"] : []),
      ...(latencyAvailable ? ["latency"] : []),
      ...(analyticsAvailable ? ["analytics"] : []),
      ...(inspectionAvailable ? ["inspection"] : []),
      ...(appsAvailable ? ["apps"] : []),
      ...(recallAvailable ? ["recall"] : []),
      ...(pendingMemoryAvailable ? ["pendingMemory"] : []),
      ...(personalitySuggestionAvailable ? ["personalitySuggestion"] : []),
      ...(jevObservationAvailable ? ["jevObservation"] : []),
      ...(reflectionRequestAvailable ? ["reflectionRequest"] : []),
      ...(juryAvailable ? ["jury"] : []),
      ...(rivetAvailable ? ["rivet"] : []),
      ...(browserProposalAvailable ? ["browserProposal"] : []),
      ...(personalityPreviewAvailable ? ["personalityPreview"] : []),
      ...(forgetPreviewAvailable ? ["forgetPreview"] : []),
      ...(personalityEvaluateAvailable ? ["personalityEvaluate"] : []),
      ...(importCancelAvailable ? ["importCancel"] : []),
      ...(dashboardLoginAvailable ? ["dashboardLogin"] : []),
      ...(wakeupAvailable ? ["wakeup"] : []),
      ...(replyPlacementAvailable ? ["replyInThread"] : []),
      ...(socialAvailable ? ["social"] : []),
    ],
  };
}

function endpoint(baseUrl: string, resource: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${resource}`;
}

function httpError(status: number): ModelError {
  if (status === 401 || status === 403) {
    return new ModelError("authentication_failed", false);
  }
  if (status === 429) {
    return new ModelError("rate_limited", true);
  }
  if (status >= 500 && status <= 599) {
    return new ModelError("provider_unavailable", true);
  }
  if (status === 408) {
    return new ModelError("timeout", true);
  }
  return new ModelError("request_failed", false);
}

async function fetchJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  controller: AbortController,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new ModelError(
      controller.signal.aborted ? "timeout" : "network_error",
      true,
    );
  }

  if (!response.ok) {
    throw httpError(response.status);
  }

  try {
    return (await response.json()) as unknown;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ModelError("timeout", true);
    }
    if (error instanceof SyntaxError) {
      throw new ModelError("malformed_response", false);
    }
    throw new ModelError("network_error", true);
  }
}

function openAIText(payload: unknown): string {
  if (!isJsonObject(payload)) {
    throw new ModelError("malformed_response", false);
  }
  if (payload.status === "incomplete") {
    const details = payload.incomplete_details;
    if (isJsonObject(details) && details.reason === "content_filter") {
      throw new ModelError("refused", false);
    }
    throw new ModelError("truncated", false);
  }
  if (payload.status === "failed") {
    throw new ModelError("request_failed", false);
  }
  if (payload.status !== "completed" || !Array.isArray(payload.output)) {
    throw new ModelError("malformed_response", false);
  }

  let text = "";
  for (const item of payload.output) {
    if (!isJsonObject(item)) {
      throw new ModelError("malformed_response", false);
    }
    if (item.type !== "message") {
      continue;
    }
    if (item.status === "incomplete") {
      throw new ModelError("truncated", false);
    }
    if (
      item.role !== "assistant" ||
      item.status !== "completed" ||
      !Array.isArray(item.content)
    ) {
      throw new ModelError("malformed_response", false);
    }
    for (const block of item.content) {
      if (!isJsonObject(block)) {
        throw new ModelError("malformed_response", false);
      }
      if (block.type === "refusal") {
        throw new ModelError("refused", false);
      }
      if (block.type === "output_text") {
        if (typeof block.text !== "string") {
          throw new ModelError("malformed_response", false);
        }
        text += block.text;
      }
    }
  }
  if (text.length === 0) {
    throw new ModelError("malformed_response", false);
  }
  return text;
}

function anthropicText(payload: unknown): string {
  if (
    !isJsonObject(payload) ||
    payload.type !== "message" ||
    payload.role !== "assistant"
  ) {
    throw new ModelError("malformed_response", false);
  }
  if (payload.stop_reason === "refusal") {
    throw new ModelError("refused", false);
  }
  if (
    payload.stop_reason === "max_tokens" ||
    payload.stop_reason === "model_context_window_exceeded"
  ) {
    throw new ModelError("truncated", false);
  }
  if (
    (payload.stop_reason !== "end_turn" &&
      payload.stop_reason !== "stop_sequence") ||
    !Array.isArray(payload.content)
  ) {
    throw new ModelError("malformed_response", false);
  }

  let text = "";
  for (const block of payload.content) {
    if (!isJsonObject(block)) {
      throw new ModelError("malformed_response", false);
    }
    if (block.type === "text") {
      if (typeof block.text !== "string") {
        throw new ModelError("malformed_response", false);
      }
      text += block.text;
    }
  }
  if (text.length === 0) {
    throw new ModelError("malformed_response", false);
  }
  return text;
}

export function parseReply(
  text: string,
  workspaces: string[],
  capabilities: ReplyCapabilities | boolean = false,
): CompanionReply {
  const {
    codingJobsAvailable,
    searchAvailable,
    slackHistoryAvailable,
    escalationAvailable,
    webSearchAvailable,
    releaseAvailable,
    modelStatusAvailable,
    mcpAvailable,
    mcpPermissionAvailable,
    mcpProposalAvailable,
    latencyAvailable,
    analyticsAvailable,
    inspectionAvailable,
    appsAvailable,
    recallAvailable,
    pendingMemoryAvailable,
    personalitySuggestionAvailable,
    jevObservationAvailable,
    reflectionRequestAvailable,
    juryAvailable,
    rivetAvailable,
    browserProposalAvailable,
    personalityPreviewAvailable,
    forgetPreviewAvailable,
    personalityEvaluateAvailable,
    importCancelAvailable,
    dashboardLoginAvailable,
    wakeupAvailable,
    replyPlacementAvailable,
    socialAvailable,
    executionAvailable,
    workflowAvailable,
  } = replyCapabilities(capabilities);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ModelError("malformed_response", false);
  }
  if (!isJsonObject(value)) {
    throw new ModelError("invalid_response", false);
  }

  const normalized = { ...value };
  for (const key of [
    "workflow",
    "execution",
    "coding",
    "codingJob",
    "reaction",
    "search",
    "slackHistory",
    "escalate",
    "webSearch",
    "release",
    "modelStatus",
    "mcp",
    "mcpPermission",
    "mcpCatalog",
    "mcpProposal",
    "latency",
    "analytics",
    "inspection",
    "apps",
    "recall",
    "pendingMemory",
    "personalitySuggestion",
    "jevObservation",
    "reflectionRequest",
    "jury",
    "rivet",
    "browserProposal",
    "personalityPreview",
    "forgetPreview",
    "personalityEvaluate",
    "importCancel",
    "dashboardLogin",
    "wakeup",
    "replyInThread",
    "social",
  ]) {
    if (normalized[key] === null) delete normalized[key];
  }

  const parsed = companionReplySchema.safeParse(normalized);
  if (!parsed.success) {
    if (
      recallAvailable &&
      isJsonObject(normalized.recall) &&
      normalized.recall.kind === "search" &&
      !recallCategorySchema.nullish().safeParse(normalized.recall.category)
        .success
    )
      throw new ModelError("invalid_recall_category", false);
    throw new ModelError("invalid_response", false);
  }
  const reply = parsed.data;
  if (
    reply.coding !== undefined &&
    !workspaces.includes(reply.coding.workspace)
  ) {
    throw new ModelError("invalid_response", false);
  }
  if (
    (reply.codingJob !== undefined && !codingJobsAvailable) ||
    (reply.search !== undefined && !searchAvailable) ||
    (reply.slackHistory !== undefined && !slackHistoryAvailable) ||
    (reply.escalate !== undefined && !escalationAvailable) ||
    (reply.webSearch !== undefined && !webSearchAvailable) ||
    (reply.release !== undefined && !releaseAvailable) ||
    (reply.modelStatus !== undefined && !modelStatusAvailable) ||
    (reply.social !== undefined && !socialAvailable) ||
    (reply.mcp !== undefined && !mcpAvailable) ||
    (reply.mcpPermission !== undefined && !mcpPermissionAvailable) ||
    (reply.mcpCatalog !== undefined && !mcpAvailable) ||
    (reply.mcpProposal !== undefined && !mcpProposalAvailable) ||
    (reply.latency !== undefined && !latencyAvailable) ||
    (reply.analytics !== undefined && !analyticsAvailable) ||
    (reply.inspection !== undefined && !inspectionAvailable) ||
    (reply.apps !== undefined && !appsAvailable) ||
    (reply.recall !== undefined && !recallAvailable) ||
    (reply.pendingMemory !== undefined && !pendingMemoryAvailable) ||
    (reply.personalitySuggestion !== undefined &&
      !personalitySuggestionAvailable) ||
    (reply.jevObservation !== undefined && !jevObservationAvailable) ||
    (reply.reflectionRequest !== undefined && !reflectionRequestAvailable) ||
    (reply.jury !== undefined && !juryAvailable) ||
    (reply.rivet !== undefined && !rivetAvailable) ||
    (reply.browserProposal !== undefined && !browserProposalAvailable) ||
    (reply.personalityPreview !== undefined && !personalityPreviewAvailable) ||
    (reply.forgetPreview !== undefined && !forgetPreviewAvailable) ||
    (reply.personalityEvaluate !== undefined &&
      !personalityEvaluateAvailable) ||
    (reply.importCancel !== undefined && !importCancelAvailable) ||
    (reply.dashboardLogin !== undefined && !dashboardLoginAvailable) ||
    (reply.execution !== undefined && !executionAvailable) ||
    (reply.wakeup !== undefined && !wakeupAvailable) ||
    (reply.workflow !== undefined && !workflowAvailable) ||
    (reply.replyInThread !== undefined && !replyPlacementAvailable)
  ) {
    throw new ModelError("invalid_response", false);
  }
  const directiveCount =
    Number(reply.codingJob !== undefined) +
    Number(reply.workflow !== undefined) +
    Number(reply.modelStatus === true) +
    Number(reply.mcp !== undefined) +
    Number(reply.mcpPermission !== undefined) +
    Number(reply.mcpCatalog !== undefined) +
    Number(reply.mcpProposal !== undefined) +
    Number(reply.execution !== undefined) +
    Number(reply.search !== undefined) +
    Number(reply.slackHistory !== undefined) +
    Number(reply.webSearch !== undefined) +
    Number(reply.release !== undefined) +
    Number(reply.social !== undefined) +
    Number(reply.latency !== undefined) +
    Number(reply.analytics !== undefined) +
    Number(reply.inspection !== undefined) +
    Number(reply.apps !== undefined) +
    Number(reply.recall !== undefined) +
    Number(reply.pendingMemory === true) +
    Number(reply.personalitySuggestion !== undefined) +
    Number(reply.jevObservation === true) +
    Number(reply.reflectionRequest !== undefined) +
    Number(reply.jury !== undefined) +
    Number(reply.rivet !== undefined) +
    Number(reply.browserProposal !== undefined) +
    Number(reply.personalityPreview !== undefined) +
    Number(reply.forgetPreview !== undefined) +
    Number(reply.personalityEvaluate !== undefined) +
    Number(reply.importCancel !== undefined) +
    Number(reply.dashboardLogin === true) +
    Number(reply.wakeup !== undefined) +
    Number(reply.escalate === true);
  if (
    directiveCount > 1 ||
    (directiveCount > 0 &&
      (reply.coding !== undefined || reply.reaction !== undefined)) ||
    ((reply.codingJob !== undefined ||
      reply.workflow !== undefined ||
      reply.search !== undefined ||
      reply.slackHistory !== undefined ||
      reply.modelStatus === true ||
      reply.webSearch !== undefined ||
      reply.release !== undefined ||
      reply.social !== undefined ||
      reply.mcp !== undefined ||
      reply.mcpPermission !== undefined ||
      reply.mcpCatalog !== undefined ||
      reply.mcpProposal !== undefined ||
      reply.analytics !== undefined ||
      reply.inspection !== undefined ||
      reply.apps !== undefined ||
      reply.recall !== undefined ||
      reply.pendingMemory === true ||
      reply.personalitySuggestion !== undefined ||
      reply.jevObservation === true ||
      reply.reflectionRequest !== undefined ||
      reply.jury !== undefined ||
      reply.rivet !== undefined ||
      reply.browserProposal !== undefined ||
      reply.personalityPreview !== undefined ||
      reply.forgetPreview !== undefined ||
      reply.personalityEvaluate !== undefined ||
      reply.importCancel !== undefined ||
      reply.dashboardLogin === true ||
      reply.wakeup !== undefined ||
      reply.latency !== undefined) &&
      reply.text.trim().length > 0)
  ) {
    throw new ModelError("invalid_response", false);
  }
  return reply;
}

export interface JsonProviderOptions {
  usage?: UsageLedger;
  protocol: "openai" | "anthropic";
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** Responses max_output_tokens or Messages max_tokens; includes reasoning. */
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** OpenAI Responses only; select an effort supported by the configured model. */
  reasoningEffort?: "low" | "medium" | "high";
  fetch?: typeof globalThis.fetch;
}

/** Tool-free operation shared by conversation and source-grounded extraction.
 * Parse inside tracking so completion means a usable result, not just HTTP success. */
export function createJsonProvider({
  usage,
  protocol,
  model,
  apiKey,
  baseUrl,
  maxOutputTokens,
  timeoutMs = REQUEST_TIMEOUT_MS,
  reasoningEffort,
  fetch: fetchImpl = globalThis.fetch,
}: JsonProviderOptions) {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMER_MS ||
    (maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)) ||
    (reasoningEffort !== undefined &&
      (protocol !== "openai" ||
        !["low", "medium", "high"].includes(reasoningEffort)))
  ) {
    throw new ModelError("invalid_configuration", false);
  }
  return async <T>(
    request: {
      system: string;
      messages: ModelRequest["messages"];
      schema: object;
      name: string;
      usageStage?: UsageStage;
      parse: (text: string) => T;
    },
    signal?: AbortSignal,
  ): Promise<T> => {
    signal?.throwIfAborted();
    return observeUsage(
      usage,
      { provider: protocol, model, stage: request.usageStage ?? "fast" },
      async (report) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const isOpenAI = protocol === "openai";
          // Source metadata belongs to the host, not either API's message schema.
          const messages = request.messages.map(({ role, content }) => ({
            role,
            content,
          }));
          const url = endpoint(
            baseUrl ?? (isOpenAI ? OPENAI_BASE_URL : ANTHROPIC_BASE_URL),
            isOpenAI ? "responses" : "messages",
          );
          const init: RequestInit = {
            method: "POST",
            headers: isOpenAI
              ? {
                  authorization: `Bearer ${apiKey}`,
                  "content-type": "application/json",
                }
              : {
                  "anthropic-version": "2023-06-01",
                  "content-type": "application/json",
                  "x-api-key": apiKey,
                },
            body: JSON.stringify(
              isOpenAI
                ? {
                    model,
                    instructions: request.system,
                    input: messages,
                    store: false,
                    ...(maxOutputTokens === undefined
                      ? {}
                      : { max_output_tokens: maxOutputTokens }),
                    ...(reasoningEffort === undefined
                      ? {}
                      : { reasoning: { effort: reasoningEffort } }),
                    text: {
                      format: {
                        type: "json_schema",
                        name: request.name,
                        strict: true,
                        schema: request.schema,
                      },
                    },
                  }
                : {
                    model,
                    max_tokens: maxOutputTokens ?? 4_096,
                    system: request.system,
                    messages,
                    output_config: {
                      format: { type: "json_schema", schema: request.schema },
                    },
                  },
            ),
            redirect: "error",
            signal: signal
              ? AbortSignal.any([signal, controller.signal])
              : controller.signal,
          };
          init.signal?.throwIfAborted();
          const payload = await fetchJson(fetchImpl, url, init, controller);
          report(
            tokenUsage(
              protocol,
              isJsonObject(payload) ? payload.usage : undefined,
            ),
          );
          init.signal?.throwIfAborted();
          return request.parse(
            isOpenAI ? openAIText(payload) : anthropicText(payload),
          );
        } finally {
          clearTimeout(timeout);
        }
      },
    );
  };
}

export function createModelProvider(
  options: JsonProviderOptions,
): ModelProvider {
  const generate = createJsonProvider(options);
  return {
    async reply(request, signal) {
      return generate(
        {
          ...request,
          schema: replyJsonSchema(request.workspaces, request),
          name: "companion_reply",
          parse: (text) => parseReply(text, request.workspaces, request),
        },
        signal,
      );
    },
  };
}
