import { z } from "zod";
import type { CompanionReply } from "../core/contracts.js";
import type { CodingState } from "../runtime/coding.js";
import {
  appCodingGoal,
  appIdSchema,
  artifactDigest,
  digestSchema,
} from "./artifact.js";

export const appsRequestSchema = z
  .strictObject({
    action: z.enum(["build", "prepare", "inspect"]),
    appId: appIdSchema,
    jobId: digestSchema.nullable(),
    goal: z.string().trim().max(900).nullable(),
  })
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
  readJob(id: string): Promise<CodingState | undefined>;
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
    return `Dynamic App receipt: ${JSON.stringify(receipt)}. This is the host's last recorded outcome, not a live health check.${receipt.status === "prepared" ? (receipt.expiresAt <= Date.now() ? " This approval has expired. Ask June to prepare the app again for a fresh approval." : ` Reply !deploy-app ${receipt.id} as a fresh plain-text owner Slack DM before ${new Date(receipt.expiresAt).toISOString()} to deploy exactly this source digest. This may install dependencies, execute generated code, and provision Rivet resources. Coding approval did not authorize deployment.`) : receipt.status === "unknown" ? " Do not retry: inspect the dedicated app host and Rivet dashboard to reconcile this uncertain deployment." : ""}`;
  }
  async function artifactFor(jobId: string, appId: string) {
    const job = await options.readJob(jobId);
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
  return {
    async request(
      input: AppsRequest,
      requestId: string,
      isCurrent = () => true,
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
      if (request.action === "inspect")
        return { text: report(await call(`/control/apps/${request.appId}`)) };
      const artifact = await artifactFor(request.jobId ?? "", request.appId);
      if (!isCurrent()) throw new Error("app_context_revoked");
      return {
        text: report(
          await call("/control/prepare", {
            jobId: request.jobId,
            requestId,
            artifact: { appId: artifact.appId, files: artifact.files },
          }),
        ),
      };
    },
    /** Called only for an actual owner-private command, never a model directive. */
    async approve(id: string, isCurrent = () => true) {
      digestSchema.parse(id);
      if (!isCurrent()) throw new Error("app_context_revoked");
      const receipt = await call(`/control/receipts/${id}`);
      if (!receipt || receipt.id !== id) throw new Error("missing_app_receipt");
      const artifact = await artifactFor(receipt.jobId, receipt.appId);
      if (!isCurrent() || artifact.digest !== receipt.digest)
        throw new Error("app_approval_revoked");
      if (receipt.status !== "prepared" || receipt.expiresAt <= Date.now())
        return report(receipt);
      return report(await call(`/control/deploy/${id}`, {}));
    },
  };
}
