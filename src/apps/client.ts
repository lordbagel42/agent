import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { CompanionReply } from "../core/contracts.js";
import type { CodingState } from "../runtime/coding.js";
import type { EffectGuard } from "../sentinel/contracts.js";
import {
  appAccessSchema,
  appCodingGoal,
  appIdSchema,
  artifactDigest,
  artifactSchema,
  digestSchema,
} from "./artifact.js";
import { type AppsKey, signControl } from "./signature.js";

/** The Rivet Dynamic Apps host on mrow, reached through its public apex. */
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
    for (const field of [
      "appId",
      "files",
      "jobId",
      "receiptId",
      "goal",
      "access",
      "title",
    ])
      if (
        set(request[field as keyof typeof request]) &&
        !allowed[request.action].includes(field)
      )
        ctx.addIssue({ code: "custom", message: `${field} must be null` });
    const required =
      request.action === "prepare"
        ? ["appId", "access"]
        : allowed[request.action];
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

/** SDK codes raised while validating or building in its local VM, before
 * anything reaches the engine; the previous release keeps serving. */
export const BUILD_FAILURES = [
  "dynamic_apps_install_failed",
  "dynamic_apps_build_failed",
  "dynamic_apps_invalid_handler",
  "dynamic_apps_pack_failed",
  "dynamic_apps_entrypoint_not_found",
  "dynamic_apps_invalid_package_json",
  "dynamic_apps_native_addon_unsupported",
  "dynamic_apps_dependency_limit",
  "dynamic_apps_build_artifact_size_limit",
  "dynamic_apps_build_artifact_truncated",
] as const;

export const appReceiptSchema = z.strictObject({
  id: digestSchema,
  appId: appIdSchema,
  /** Null when June wrote the source herself rather than a coding job. */
  jobId: digestSchema.nullable(),
  digest: digestSchema,
  // failed: the SDK rejected the source while building, before deployment.
  status: z.enum(["prepared", "deploying", "deployed", "failed", "unknown"]),
  expiresAt: z.number(),
  release: z.string().max(256).nullable(),
  url: z.url(),
  // Missing on legacy/internal-only receipts; never infer public access.
  access: appAccessSchema.optional(),
  title: z.string().max(120).optional(),
  failureCode: z.enum(BUILD_FAILURES).optional(),
});
export type AppReceipt = z.infer<typeof appReceiptSchema>;
const appStateSchema = z.object({
  appId: appIdSchema,
  publication: appReceiptSchema.nullable(),
  latest: appReceiptSchema.nullable(),
  owned: z.boolean(),
});

const HOST_ERRORS: Record<string, string> = {
  unauthorized:
    "The app host did not accept June's signature. Its juneKeys must list June's apps public key (capability-matrix dynamic-apps row); ask Raygen to pin it in mrow-gitops apps/june-apps/host.json.",
  replayed_signature: "The app host rejected a replayed request; nothing ran.",
  receipt_not_found: "No receipt with that ID exists on the app host.",
  receipt_from_other_conversation:
    "That receipt was prepared in another conversation. Prepare it here, or the owner can deploy it from their private DM.",
  app_owned_by_other_conversation:
    "That app ID belongs to another conversation. Choose another app ID, or the owner can change it from their private DM.",
  app_not_found: "No published app with that ID exists.",
  approval_expired: "That receipt expired. Prepare the app again.",
  build_in_progress:
    "Another app is deploying right now; nothing was consumed. Try this deploy again shortly.",
  app_requires_reconciliation:
    "This app has an uncertain earlier deployment. Do not retry; ask Raygen to reconcile it on the app host.",
  viewer_not_configured: "The app host has no public viewer configured.",
  host_draining: "The app host is restarting; nothing ran. Try again shortly.",
  apps_request_failed:
    "The app host rejected the request (invalid source or fields). Check package.json and the Fetch handler export.",
};
const FAILURES: Record<(typeof BUILD_FAILURES)[number], string> = {
  dynamic_apps_install_failed:
    "npm install failed (check package.json dependencies and versions)",
  dynamic_apps_build_failed: "npm run build failed",
  dynamic_apps_invalid_handler:
    "the entrypoint does not default-export a Fetch handler or Hono app",
  dynamic_apps_pack_failed: "the built app exceeded the 4 MiB archive limit",
  dynamic_apps_entrypoint_not_found:
    "package.json main does not point at an existing entrypoint",
  dynamic_apps_invalid_package_json: "package.json is not valid",
  dynamic_apps_native_addon_unsupported:
    "a dependency needs a native addon, which is unsupported",
  dynamic_apps_dependency_limit: "too many dependencies",
  dynamic_apps_build_artifact_size_limit: "the built app is too large",
  dynamic_apps_build_artifact_truncated: "the built app was truncated",
};

class AppsHostError extends Error {}

export function createAppsClient(options: {
  endpoint: string;
  key: AppsKey;
  owner: string;
  /** Coding workspace for coding-job builds; absent without native coding. */
  workspace?: string;
  /** Authorize the saved source and proposal scope against the authenticated
   * caller, never against the job's own scope as if that were caller authority.
   */
  readJob?(
    id: string,
    conversationKey: string[],
  ): Promise<CodingState | undefined>;
  fetch?: typeof fetch;
  /** Bounded wait for an in-progress deployment to settle. */
  deployWaitMs?: number;
}) {
  async function call(method: "GET" | "POST", path: string, body?: unknown) {
    const text = body === undefined ? "" : JSON.stringify(body);
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(`${options.endpoint}${path}`, {
        method,
        headers: {
          authorization: signControl(options.key, method, path, text),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : text,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AppsHostError(
        `The app host at ${options.endpoint} is unreachable. Nothing was confirmed; inspect before retrying.`,
      );
    }
    // Only bounded metadata can reach June, never provider tokens or logs.
    const raw = await response.text();
    if (raw.length > 262_144) throw new AppsHostError("Invalid host response.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AppsHostError(
        `The app host returned HTTP ${response.status} without a receipt (it may be down or not yet routed).`,
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
  function describe(receipt: AppReceipt) {
    const audience =
      receipt.access === "public"
        ? "anyone with the link, no login"
        : receipt.access === "signed-in"
          ? "anyone who signs in (email code or GitHub); not an owner or workspace allowlist"
          : "internal only, not published";
    const summary = `App ${receipt.appId}${receipt.title ? ` (${receipt.title})` : ""} receipt ${receipt.id}: ${receipt.status}. Audience: ${audience}. URL: ${receipt.url}. Source ${receipt.digest.slice(0, 12)}${receipt.release ? `, Rivet release ${receipt.release.slice(0, 12)}` : ""}.`;
    switch (receipt.status) {
      case "prepared":
        return receipt.expiresAt <= Date.now()
          ? `${summary} Expired unused; prepare again for a fresh receipt.`
          : `${summary} Nothing is deployed yet. To deploy exactly this source and audience, use apps action deploy with appId ${receipt.appId} and receiptId ${receipt.id} before ${new Date(receipt.expiresAt).toISOString()}. Deploying installs dependencies and runs the app in Rivet's sandbox on the app host, then replaces the live version.`;
      case "deploying":
        return `${summary} Rivet is still building it. Inspect this app again in a minute; do not deploy again.`;
      case "deployed":
        return `${summary} Live. Share the URL. This is the host's recorded outcome, not a fresh health check.`;
      case "failed":
        return `${summary} Build failed: ${receipt.failureCode ? FAILURES[receipt.failureCode] : "rejected by the SDK"}. Nothing changed; any previous version keeps serving. Fix the source and prepare a new receipt.`;
      default:
        return `${summary} Deployment outcome is uncertain. Do not retry: the app is blocked until Raygen reconciles it on the app host.`;
    }
  }
  async function jobFiles(
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
    return job.appArtifact;
  }
  // Shared by model-selected deployment and the owner's explicit command. The
  // exact receipt binds immutable source AND audience; neither can be replaced.
  async function deploy(
    id: string,
    conversationKey: string[],
    isCurrent: () => boolean,
    appId?: string,
    guard?: EffectGuard,
  ) {
    digestSchema.parse(id);
    const receipt = appReceiptSchema
      .nullable()
      .parse(await call("GET", `/control/receipts/${id}`));
    if (!receipt) throw new AppsHostError(HOST_ERRORS.receipt_not_found);
    if (appId !== undefined && receipt.appId !== appId)
      throw new AppsHostError("That receipt belongs to a different app ID.");
    const check = guard?.("app-deploy", {
      id,
      appId: receipt.appId,
      digest: receipt.digest,
      access: receipt.access,
    });
    if (receipt.jobId) {
      const artifact = await jobFiles(
        receipt.jobId,
        receipt.appId,
        conversationKey,
      );
      if (artifact.digest !== receipt.digest)
        throw new AppsHostError("The coding job's source changed.");
    }
    if (!isCurrent()) throw new Error("app_context_revoked");
    if (receipt.status === "prepared") {
      const withheld = await check?.commit();
      if (withheld) return withheld;
      if (!isCurrent()) throw new Error("app_approval_revoked");
    }
    let current = appReceiptSchema.parse(
      await call("POST", `/control/deploy/${id}`, {
        scope: scopeOf(conversationKey),
        privileged: privileged(conversationKey),
      }),
    );
    // Wait briefly so June can usually report the final outcome in one step.
    const deadline = Date.now() + (options.deployWaitMs ?? 90_000);
    while (current.status === "deploying" && Date.now() < deadline) {
      await sleep(3000);
      if (!isCurrent()) break;
      current = appReceiptSchema.parse(
        await call("GET", `/control/receipts/${id}`),
      );
    }
    return describe(current);
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
      guard?: EffectGuard,
    ): Promise<CompanionReply> {
      const request = appsRequestSchema.parse(input);
      digestSchema.parse(requestId);
      if (!isCurrent()) throw new Error("app_context_revoked");
      const appId = request.appId ?? "";
      try {
        if (request.action === "build")
          return options.workspace
            ? {
                text: "",
                coding: {
                  workspace: options.workspace,
                  appId,
                  goal: appCodingGoal(appId, request.goal ?? ""),
                },
              }
            : {
                text: "Coding-job builds are unavailable (native coding has no apps workspace). Write the app's files yourself and use apps action prepare with files.",
              };
        if (request.action === "list") {
          const { apps } = z
            .object({ apps: z.array(appStateSchema).max(200) })
            .parse(
              await call("GET", `/control/apps?${reader(conversationKey)}`),
            );
          return {
            text: apps.length
              ? `Dynamic Apps visible to this conversation (${apps.length}):\n${apps
                  .map(
                    (app) =>
                      `- ${app.appId}: ${app.publication?.status === "deployed" ? `live, ${app.publication.access ?? "internal"}, ${app.publication.url}` : "not live"}${app.latest && app.latest.id !== app.publication?.id ? `; latest receipt ${app.latest.status}` : ""}`,
                  )
                  .join("\n")}`
              : "No Dynamic Apps exist for this conversation yet.",
          };
        }
        if (request.action === "inspect") {
          const state = appStateSchema.parse(
            await call(
              "GET",
              `/control/apps/${appId}?${reader(conversationKey)}`,
            ),
          );
          if (!state.publication && !state.latest)
            return { text: `No app ${appId} is visible on the app host.` };
          return {
            text: [
              state.publication
                ? `Published: ${describe(state.publication)}`
                : `App ${appId} is not published.`,
              state.latest && state.latest.id !== state.publication?.id
                ? `Latest receipt: ${describe(state.latest)}`
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
          };
        }
        if (request.action === "unpublish") {
          await call("POST", `/control/unpublish/${appId}`, {
            scope: scopeOf(conversationKey),
            privileged: privileged(conversationKey),
          });
          return {
            text: `App ${appId} is unpublished; its URLs return 404 now. Receipts remain, and deploying a new prepared receipt publishes it again.`,
          };
        }
        if (request.action === "deploy")
          return {
            text: await deploy(
              request.receiptId ?? "",
              conversationKey,
              isCurrent,
              appId,
              guard,
            ),
          };
        const files = request.files
          ? Object.fromEntries(
              request.files.map((file) => [file.path, file.content]),
            )
          : (await jobFiles(request.jobId ?? "", appId, conversationKey)).files;
        const artifact = artifactSchema.safeParse({ appId, files });
        if (
          !artifact.success ||
          (request.files && Object.keys(files).length !== request.files.length)
        )
          return {
            text: `The app source is invalid: ${artifact.error?.issues.map((issue) => issue.message).join("; ") ?? "duplicate file paths"}. Nothing was prepared.`,
          };
        if (!isCurrent()) throw new Error("app_context_revoked");
        const withheld = await guard?.("app-prepare", {
          request,
          digest: artifactDigest(artifact.data),
          files: artifact.data.files,
        }).commit();
        if (withheld) return { text: withheld };
        if (!isCurrent()) throw new Error("app_context_revoked");
        const receipt = appReceiptSchema.parse(
          await call("POST", "/control/prepare", {
            artifact: artifact.data,
            jobId: request.jobId ?? null,
            requestId,
            access: request.access ?? undefined,
            scope: scopeOf(conversationKey),
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
    /** The owner's explicit `!deploy-app <receipt>` command. */
    async approve(
      id: string,
      conversationKey: string[],
      isCurrent = () => true,
    ) {
      try {
        return await deploy(id, conversationKey, isCurrent);
      } catch (error) {
        if (error instanceof AppsHostError) return error.message;
        throw error;
      }
    },
    /** Reachability and key trust, without changing anything. */
    async probe() {
      try {
        await call(
          "GET",
          `/control/apps?${new URLSearchParams({ scope: "0".repeat(64), privileged: "0" })}`,
        );
        return "connected: the app host accepts June's signatures";
      } catch (error) {
        return error instanceof AppsHostError ? error.message : "probe failed";
      }
    },
  };
}
