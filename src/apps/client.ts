import { z } from "zod";
import type { CompanionReply } from "../core/contracts.js";
import type { CodingState } from "../runtime/coding.js";
import type { EffectGuard } from "../sentinel/contracts.js";
import {
  appAccessSchema,
  appCodingGoal,
  appIdSchema,
  artifactDigest,
  digestSchema,
} from "./artifact.js";

export const appsRequestSchema = z
  .strictObject({
    action: z.enum(["build", "prepare", "inspect", "deploy"]),
    appId: appIdSchema,
    jobId: digestSchema.nullable(),
    receiptId: digestSchema.nullable().optional(),
    goal: z.string().trim().max(900).nullable(),
    access: appAccessSchema.nullable().optional(),
  })
  .refine((request) => request.action === "prepare" || request.access == null)
  .refine((request) =>
    request.action === "deploy"
      ? request.receiptId != null && request.jobId === null
      : request.receiptId == null,
  )
  .refine((request) =>
    request.action === "build"
      ? !!request.goal && request.jobId === null
      : request.goal === null &&
        (request.action !== "prepare" || request.jobId !== null),
  );
export type AppsRequest = z.infer<typeof appsRequestSchema>;

export const appReceiptSchema = z.strictObject({
  id: digestSchema,
  appId: appIdSchema,
  jobId: digestSchema,
  digest: digestSchema,
  status: z.enum(["prepared", "deploying", "deployed", "unknown"]),
  expiresAt: z.number(),
  release: z.string().max(256).nullable(),
  url: z.url(),
  // Missing on legacy/internal-only receipts; never infer public access.
  access: appAccessSchema.optional(),
  failureCode: z
    .enum([
      "dynamic_apps_install_failed",
      "dynamic_apps_build_failed",
      "dynamic_apps_invalid_handler",
      "dynamic_apps_pack_failed",
    ])
    .optional(),
});
export type AppReceipt = z.infer<typeof appReceiptSchema>;

export function createAppsClient(options: {
  endpoint: string;
  token: string;
  workspace: string;
  /** Authorize the saved source and proposal scope against the authenticated
   * caller, never against the job's own scope as if that were caller authority.
   * Only historical proposals may default to the owner's private scope.
   */
  readJob(
    id: string,
    conversationKey: string[],
  ): Promise<CodingState | undefined>;
  fetch?: typeof fetch;
}) {
  async function call(path: string, body?: unknown) {
    const response = await (options.fetch ?? fetch)(
      `${options.endpoint}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error("apps_host_unavailable");
    // Only a bounded metadata receipt can reach June, never provider tokens/logs.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("apps_host_unavailable");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 8192) throw new Error("invalid_apps_receipt");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return appReceiptSchema
      .nullable()
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }
  function report(receipt: AppReceipt | null) {
    if (!receipt)
      return "No deployment receipt exists for that app. This is not proof it has never existed in Rivet.";
    const audience =
      receipt.access === "public"
        ? "Anyone, without signing in. Publishing cannot recall already downloaded content."
        : receipt.access === "signed-in"
          ? "Anyone who signs in; no owner or workspace allowlist."
          : "Internal credential-only viewer; not published.";
    return `Dynamic App receipt: ${JSON.stringify(receipt)}. Audience: ${audience} This is the host's last recorded outcome, not a live health check.${receipt.status === "prepared" ? (receipt.expiresAt <= Date.now() ? " This receipt has expired. Prepare the app again for a fresh receipt before deciding whether to deploy." : ` Preparation has not deployed anything. June may inspect this receipt and choose apps action deploy with appId ${receipt.appId}, receiptId ${receipt.id}, jobId null, goal null and access null before ${new Date(receipt.expiresAt).toISOString()} to deploy exactly this source digest AND audience. No per-task human command is required. Deployment may install dependencies, execute generated code, and provision Rivet resources only on the configured app host; this grants no credential access or authority over other destinations.`) : receipt.status === "unknown" ? " Do not retry: inspect the dedicated app host and Rivet dashboard to reconcile this uncertain deployment." : ""}`;
  }
  async function artifactFor(
    jobId: string,
    appId: string,
    conversationKey: string[],
  ) {
    const job = await options.readJob(jobId, conversationKey);
    if (
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
      throw new Error("verified_app_required");
    return job.appArtifact;
  }
  // Shared by model-selected deployment and the legacy explicit command. The
  // exact receipt binds immutable source AND audience; neither can be replaced.
  // conversationKey is required host context, never a model-selected field.
  async function approve(
    id: string,
    conversationKey: string[],
    isCurrent = () => true,
    appId?: string,
    guard?: EffectGuard,
  ) {
    digestSchema.parse(id);
    if (!isCurrent()) throw new Error("app_context_revoked");
    const receipt = await call(`/control/receipts/${id}`);
    if (!receipt || receipt.id !== id) throw new Error("missing_app_receipt");
    if (appId !== undefined && receipt.appId !== appId)
      throw new Error("app_receipt_mismatch");
    const check = guard?.("app-deploy", {
      id,
      appId: receipt.appId,
      digest: receipt.digest,
      access: receipt.access,
    });
    const artifact = await artifactFor(
      receipt.jobId,
      receipt.appId,
      conversationKey,
    );
    if (!isCurrent() || artifact.digest !== receipt.digest)
      throw new Error("app_approval_revoked");
    if (receipt.status !== "prepared" || receipt.expiresAt <= Date.now())
      return report(receipt);
    const withheld = await check?.commit();
    if (withheld) return withheld;
    if (!isCurrent()) throw new Error("app_approval_revoked");
    const deployed = await call(`/control/deploy/${id}`, {});
    if (!isCurrent()) throw new Error("app_context_revoked");
    return report(deployed);
  }
  return {
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
      if (request.action === "build")
        return {
          text: "",
          coding: {
            workspace: options.workspace,
            appId: request.appId,
            goal: appCodingGoal(request.appId, request.goal ?? ""),
          },
        };
      if (request.action === "inspect") {
        const receipt = await call(`/control/apps/${request.appId}`);
        if (receipt) {
          if (receipt.appId !== request.appId)
            throw new Error("app_receipt_mismatch");
          await artifactFor(receipt.jobId, receipt.appId, conversationKey);
        }
        if (!isCurrent()) throw new Error("app_context_revoked");
        return { text: report(receipt) };
      }
      if (request.action === "deploy")
        return {
          text: await approve(
            request.receiptId ?? "",
            conversationKey,
            isCurrent,
            request.appId,
            guard,
          ),
        };
      const artifact = await artifactFor(
        request.jobId ?? "",
        request.appId,
        conversationKey,
      );
      if (!isCurrent()) throw new Error("app_context_revoked");
      const withheld = await guard?.("app-prepare", {
        request,
        digest: artifact.digest,
        files: artifact.files,
      }).commit();
      if (withheld) return { text: withheld };
      if (!isCurrent()) throw new Error("app_context_revoked");
      const prepared = await call("/control/prepare", {
        jobId: request.jobId,
        requestId,
        ...(request.access ? { access: request.access } : {}),
        artifact: { appId: artifact.appId, files: artifact.files },
      });
      if (!isCurrent()) throw new Error("app_context_revoked");
      return { text: report(prepared) };
    },
    /** Legacy explicit command compatibility; uses the same deployment checks. */
    approve,
  };
}
