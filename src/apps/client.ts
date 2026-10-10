import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign,
} from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { CompanionReply } from "../core/contracts.js";
import type { CodingState } from "../runtime/coding.js";
import {
  appAccessSchema,
  appCodingGoal,
  appIdSchema,
  artifactDigest,
  artifactSchema,
  digestSchema,
} from "./artifact.js";

/** June's Cloudflare-hosted app host (apps-host/). Overridable in config. */
export const DEFAULT_APPS_ENDPOINT = "https://mrrpmraow.com";

const appFileSchema = z.strictObject({
  path: z.string().min(1).max(200),
  content: z.string().max(65_536),
});

export const appsRequestSchema = z
  .strictObject({
    action: z.enum([
      "build",
      "prepare",
      "deploy",
      "inspect",
      "list",
      "unpublish",
    ]),
    appId: appIdSchema.nullable(),
    files: z.array(appFileSchema).max(128).nullable().optional(),
    jobId: digestSchema.nullable(),
    receiptId: digestSchema.nullable().optional(),
    goal: z.string().trim().min(1).max(900).nullable(),
    access: appAccessSchema.nullable().optional(),
    title: z.string().trim().max(120).nullable().optional(),
  })
  .superRefine((request, ctx) => {
    const set = (value: unknown) => value !== null && value !== undefined;
    const allowed: Record<typeof request.action, string[]> = {
      list: [],
      inspect: ["appId"],
      unpublish: ["appId"],
      build: ["appId", "goal"],
      deploy: ["appId", "receiptId"],
      prepare: ["appId", "access", "files", "jobId", "title"],
    };
    const fields = ["appId", "files", "jobId", "receiptId", "goal", "access"];
    for (const field of [...fields, "title"])
      if (
        set(request[field as keyof typeof request]) &&
        !allowed[request.action].includes(field)
      )
        ctx.addIssue({ code: "custom", message: `${field} must be null` });
    const required =
      request.action === "prepare"
        ? ["appId", "access"]
        : allowed[request.action].filter((field) => field !== "title");
    for (const field of required)
      if (!set(request[field as keyof typeof request]))
        ctx.addIssue({ code: "custom", message: `${field} is required` });
    if (
      request.action === "prepare" &&
      set(request.files) === set(request.jobId)
    )
      ctx.addIssue({
        code: "custom",
        message: "prepare takes exactly one of files or jobId",
      });
  });
export type AppsRequest = z.infer<typeof appsRequestSchema>;

const receiptSchema = z.object({
  id: digestSchema,
  appId: appIdSchema,
  digest: digestSchema,
  access: appAccessSchema,
  title: z.string().nullable(),
  status: z.enum([
    "prepared",
    "deployed",
    "superseded",
    "unpublished",
    "expired",
  ]),
  createdAt: z.number(),
  expiresAt: z.number(),
  deployedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  files: z.number(),
  bytes: z.number(),
  url: z.url(),
});
export type AppReceipt = z.infer<typeof receiptSchema>;
const appStateSchema = z.object({
  appId: appIdSchema,
  live: receiptSchema.nullable(),
  latest: receiptSchema.nullable(),
  updatedAt: z.number().nullable(),
});
const listSchema = z.object({
  apps: z
    .array(
      z.object({
        appId: appIdSchema,
        live: z
          .object({
            url: z.url(),
            access: appAccessSchema,
            receiptId: digestSchema,
            title: z.string().nullable(),
            deployedAt: z.number().nullable(),
          })
          .nullable(),
        latestStatus: z.string().nullable(),
        updatedAt: z.number().nullable(),
      }),
    )
    .max(200),
});

export interface AppsKey {
  keyId: string;
  publicKey: string;
  privateKey: KeyObject;
}

/** June's Ed25519 identity for the app host. Only the public key leaves June. */
export async function loadAppsKey(path: string): Promise<AppsKey> {
  let pem = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    },
  );
  if (pem === undefined) {
    // Both deployment slots share this directory. Publish a complete file
    // atomically with link(); a slot that loses the race reads the winner's.
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      generateKeyPairSync("ed25519")
        .privateKey.export({ format: "pem", type: "pkcs8" })
        .toString(),
      { mode: 0o600, flag: "wx" },
    );
    try {
      await link(temporary, path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    } finally {
      await unlink(temporary);
    }
    pem = await readFile(path, "utf8");
  }
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey).export({ format: "jwk" }).x;
  if (!publicKey) throw new Error("invalid_apps_key");
  return {
    privateKey,
    publicKey,
    keyId: createHash("sha256")
      .update(Buffer.from(publicKey, "base64url"))
      .digest("hex")
      .slice(0, 16),
  };
}

const HOST_ERRORS: Record<string, string> = {
  unknown_june_key:
    "The app host does not trust June's signing key yet. Raygen must add June's apps public key (inspection capability-matrix, dynamic-apps row) to the host's JUNE_KEYS.",
  stale_signature:
    "The app host rejected the request clock; June's system clock may be wrong.",
  receipt_not_found: "No receipt with that ID exists on the app host.",
  app_not_found: "No app with that ID exists on the app host.",
  app_receipt_mismatch: "That receipt belongs to a different app ID.",
  receipt_from_other_conversation:
    "That receipt was prepared in another conversation. Prepare it here, or the owner can deploy it from their private DM.",
  app_owned_by_other_conversation:
    "That app ID belongs to another conversation. Choose a different app ID, or the owner can change it from their private DM.",
  index_html_required: "App source must include index.html.",
  invalid_file:
    "A file path or type is not allowed (html, css, js, mjs, json, webmanifest, svg, txt, md, csv, xml; no dotfiles) or a file exceeds 64 KiB.",
  source_too_large: "App source exceeds 256 KiB.",
  too_many_files: "App source needs 1–128 files.",
};

export class AppsHostError extends Error {}

export function createAppsClient(options: {
  endpoint: string;
  key: AppsKey;
  owner: string;
  /** Coding workspace for build; omitted when native coding is unavailable. */
  workspace?: string;
  /** Authorize a coding job's saved source against the authenticated caller. */
  readJob?(
    id: string,
    conversationKey: string[],
  ): Promise<CodingState | undefined>;
  fetch?: typeof fetch;
}) {
  async function call(method: "GET" | "POST", path: string, body?: unknown) {
    const text = body === undefined ? "" : JSON.stringify(body);
    const timestamp = String(Date.now());
    const signed = `june-apps-v1\n${method}\n${path}\n${timestamp}\n${createHash("sha256").update(text).digest("hex")}`;
    const signature = sign(
      null,
      Buffer.from(signed),
      options.key.privateKey,
    ).toString("base64url");
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(`${options.endpoint}${path}`, {
        method,
        headers: {
          authorization: `June-Ed25519 key=${options.key.keyId}, ts=${timestamp}, sig=${signature}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : text,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AppsHostError(
        `The app host at ${options.endpoint} is unreachable. Nothing was confirmed; inspect again before retrying.`,
      );
    }
    const raw = await response.text();
    if (raw.length > 262_144) throw new AppsHostError("Invalid host response.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AppsHostError(
        `The app host returned HTTP ${response.status} without a receipt.`,
      );
    }
    if (!response.ok) {
      const code = z.object({ error: z.string() }).safeParse(parsed);
      const error = code.success ? code.data.error : "unknown";
      throw new AppsHostError(
        HOST_ERRORS[error] ?? `The app host rejected the request: ${error}.`,
      );
    }
    return parsed;
  }
  const scopeOf = (conversationKey: string[]) =>
    createHash("sha256").update(JSON.stringify(conversationKey)).digest("hex");
  const privileged = (conversationKey: string[]) =>
    JSON.stringify(conversationKey) ===
    JSON.stringify(["private", options.owner]);
  const reader = (conversationKey: string[]) =>
    new URLSearchParams({
      scope: scopeOf(conversationKey),
      privileged: privileged(conversationKey) ? "1" : "0",
    }).toString();
  const audience = (access: string) =>
    access === "public"
      ? "anyone with the link, no login"
      : "anyone who signs in (email one-time code or GitHub); not an owner or workspace allowlist";
  function describe(receipt: AppReceipt) {
    const summary = `App ${receipt.appId} receipt ${receipt.id}: ${receipt.status}. Audience: ${audience(receipt.access)}. URL: ${receipt.url}. Source ${receipt.digest.slice(0, 12)}, ${receipt.files} files, ${receipt.bytes} bytes.`;
    if (receipt.status === "prepared")
      return `${summary} Nothing is published yet. To publish exactly this source and audience, use apps action deploy with appId ${receipt.appId} and receiptId ${receipt.id} before ${new Date(receipt.expiresAt).toISOString()}. Deploying replaces any live version of this app.`;
    if (receipt.status === "deployed")
      return `${summary} Live since ${new Date(receipt.deployedAt ?? 0).toISOString()}. Share the URL; it is served from its own origin with no caching, so updates and unpublishing take effect immediately.`;
    if (receipt.status === "expired")
      return `${summary} This preparation expired unused. Prepare again to get a fresh receipt.`;
    return `${summary} No longer live.`;
  }
  async function artifactFor(
    jobId: string,
    appId: string,
    conversationKey: string[],
  ) {
    const job = await options.readJob?.(jobId, conversationKey);
    if (
      !options.workspace ||
      job?.status !== "completed" ||
      job.revoked ||
      job.cancelRequested ||
      job.proposal?.id !== jobId ||
      job.proposal.workspace !== options.workspace ||
      job.proposal.appId !== appId ||
      job.verification?.status !== "passed" ||
      job.verification.replayed ||
      !job.appArtifact ||
      job.appArtifact.appId !== appId ||
      job.appArtifact.digest !== artifactDigest(job.appArtifact)
    )
      throw new AppsHostError(
        "That coding job has no verified app export for this app ID in this conversation.",
      );
    return job.appArtifact.files;
  }
  async function deploy(
    receiptId: string,
    conversationKey: string[],
    appId?: string,
  ) {
    digestSchema.parse(receiptId);
    const resolvedAppId =
      appId ??
      receiptSchema
        .nullable()
        .parse(await call("GET", `/control/receipts/${receiptId}`))?.appId;
    if (!resolvedAppId) throw new AppsHostError(HOST_ERRORS.receipt_not_found);
    const receipt = receiptSchema.parse(
      await call("POST", "/control/deploy", {
        receiptId,
        appId: resolvedAppId,
        scope: scopeOf(conversationKey),
        privileged: privileged(conversationKey),
      }),
    );
    if (receipt.id !== receiptId) throw new AppsHostError("Receipt mismatch.");
    return describe(receipt);
  }
  return {
    endpoint: options.endpoint,
    keyId: options.key.keyId,
    publicKey: options.key.publicKey,
    buildAvailable: !!options.workspace && !!options.readJob,
    /** conversationKey comes from the authenticated host, not AppsRequest. */
    async request(
      input: AppsRequest,
      requestId: string,
      conversationKey: string[],
      isCurrent = () => true,
    ): Promise<CompanionReply> {
      const request = appsRequestSchema.parse(input);
      digestSchema.parse(requestId);
      if (!isCurrent()) throw new Error("app_context_revoked");
      try {
        if (request.action === "build") {
          if (!options.workspace)
            return {
              text: "Coding-job builds are unavailable because native coding has no apps workspace. Write the app's files yourself and use apps action prepare with files.",
            };
          return {
            text: "",
            coding: {
              workspace: options.workspace,
              appId: request.appId ?? "",
              goal: appCodingGoal(request.appId ?? "", request.goal ?? ""),
            },
          };
        }
        if (request.action === "list") {
          const { apps } = listSchema.parse(
            await call("GET", `/control/apps?${reader(conversationKey)}`),
          );
          return {
            text: apps.length
              ? `June's apps (${apps.length}):\n${apps
                  .map(
                    (app) =>
                      `- ${app.appId}: ${app.live ? `live (${app.live.access}) ${app.live.url}${app.live.title ? ` — ${app.live.title}` : ""}` : `not live (latest receipt ${app.latestStatus ?? "none"})`}`,
                  )
                  .join("\n")}`
              : "This conversation has no apps on the app host yet.",
          };
        }
        const appId = request.appId ?? "";
        if (request.action === "inspect") {
          const state = appStateSchema.parse(
            await call(
              "GET",
              `/control/apps/${appId}?${reader(conversationKey)}`,
            ),
          );
          if (!state.live && !state.latest)
            return { text: `No app ${appId} exists on the app host.` };
          return {
            text: [
              state.live
                ? `Live: ${describe(state.live)}`
                : `App ${appId} is not live.`,
              state.latest && state.latest.id !== state.live?.id
                ? `Latest receipt: ${describe(state.latest)}`
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
          };
        }
        if (request.action === "unpublish") {
          await call("POST", "/control/unpublish", {
            appId,
            scope: scopeOf(conversationKey),
            privileged: privileged(conversationKey),
          });
          return {
            text: `App ${appId} is unpublished; its URLs now return 404. Its stored data and receipts remain, and redeploying a prepared receipt brings it back.`,
          };
        }
        if (request.action === "deploy")
          return {
            text: await deploy(request.receiptId ?? "", conversationKey, appId),
          };
        const files = request.files
          ? Object.fromEntries(
              request.files.map((file) => [file.path, file.content]),
            )
          : await artifactFor(request.jobId ?? "", appId, conversationKey);
        const artifact = artifactSchema.safeParse({ appId, files });
        if (
          !artifact.success ||
          (request.files && Object.keys(files).length !== request.files.length)
        )
          return {
            text: `The app source is invalid: ${artifact.error?.issues.map((issue) => issue.message).join("; ") ?? "duplicate file paths"}. Nothing was prepared.`,
          };
        if (!isCurrent()) throw new Error("app_context_revoked");
        const receipt = receiptSchema.parse(
          await call("POST", "/control/prepare", {
            appId,
            files,
            access: request.access,
            scope: scopeOf(conversationKey),
            requestId,
            title: request.title ?? null,
          }),
        );
        if (receipt.digest !== artifactDigest(artifact.data))
          throw new AppsHostError("The host stored different source.");
        return { text: describe(receipt) };
      } catch (error) {
        if (error instanceof AppsHostError) return { text: error.message };
        throw error;
      }
    },
    /** Owner's explicit `!deploy-app <receipt>` command; same host checks. */
    async approve(
      receiptId: string,
      conversationKey: string[],
      isCurrent = () => true,
    ) {
      if (!isCurrent()) throw new Error("app_context_revoked");
      try {
        return await deploy(receiptId, conversationKey);
      } catch (error) {
        if (error instanceof AppsHostError) return error.message;
        throw error;
      }
    },
    /** Host reachability and key trust, without changing anything. */
    async probe() {
      try {
        await call(
          "GET",
          `/control/apps?${new URLSearchParams({ scope: "0".repeat(64), privileged: "0" })}`,
        );
        return "connected: the app host trusts June's key";
      } catch (error) {
        return error instanceof AppsHostError
          ? error.message
          : "probe failed unexpectedly";
      }
    },
  };
}
