import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { z } from "zod";

const revision = z.string().regex(/^[0-9a-f]{40}$/);
const deploymentSchema = z.strictObject({
  version: z.literal(1),
  controllerRevision: revision,
  phase: z.enum([
    "ready",
    "building",
    "activating",
    "failed",
    "blocked",
    "disabled",
  ]),
  checkedAt: z.number().int().min(0).max(8.64e15),
  targetRevision: revision,
  activeRevision: revision,
  reason: z
    .enum([
      "interrupted",
      "current_unhealthy",
      "fetch_failed",
      "non_fast_forward",
      "storage_policy_changed",
      "source_unchanged",
      "preflight_failed",
      "binding_changed",
      "rollback_unhealthy",
      "health_failed",
    ])
    .nullable(),
});

export type DebugSiteDeploymentStatus = z.infer<typeof deploymentSchema>;

/** Optional root-owned, content-free receipt. Missing/bad status never fails health. */
export function createDebugSiteDeploymentReader(options: {
  file: string;
  trustedUid?: number;
}): () => Promise<DebugSiteDeploymentStatus | null> {
  return async () => {
    try {
      if ((await realpath(options.file)) !== options.file) return null;
      const file = await open(
        options.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.uid !== (options.trustedUid ?? 0) ||
          stat.nlink !== 1 ||
          (stat.mode & 0o027) !== 0 ||
          stat.size > 4096
        )
          return null;
        const buffer = Buffer.alloc(4097);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 4096) return null;
        return deploymentSchema.parse(
          JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
        );
      } finally {
        await file.close();
      }
    } catch {
      return null;
    }
  };
}

/** Owner-private inspection of one configured origin; no upload/viewer credentials. */
export function createDebugSiteDeploymentInspection(
  origin: string,
): () => Promise<string> {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("Invalid debug-site inspection origin");
  const healthSchema = z.object({
    ready: z.boolean(),
    revision,
    deployment: deploymentSchema.nullable().optional(),
  });
  return async () => {
    const observedAt = new Date().toISOString();
    try {
      const response = await fetch(new URL("/health", origin), {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("health_unavailable");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing_health");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 8192) throw new Error("oversized_health");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const health = healthSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      const status = health.deployment;
      const age = status ? Date.now() - status.checkedAt : null;
      return [
        `Debug website inspection observed ${observedAt}.`,
        `Loaded website revision: ${health.revision}; readiness: ${health.ready}. Reported by the independent website, not June's running revision.`,
        status
          ? `Controller receipt: ${status.phase}${status.reason ? ` (${status.reason})` : ""}; published ${new Date(status.checkedAt).toISOString()}${age !== null && (age < 0 || age > 300000) ? " (stale or clock-skewed; current update progress unknown)" : ""}. Installed controller revision: ${status.controllerRevision}. Target revision: ${status.targetRevision}. Historical controller active revision: ${status.activeRevision}.`
          : "Automatic update status unavailable: no valid controller receipt reported. Installation, enablement and update progress are unknown.",
        "Controller receipts are historical, not proof that the timer is enabled or alive. Publishing main is not activation. The independent updater owns builds, code-only rollback and retries; interrupted effects and storage-policy changes require operator review. This inspection cannot deploy, retry, change policy or restart either service. Never duplicate an update or restore archive data to roll back code.",
      ].join("\n\n");
    } catch {
      return `Debug website deployment inspection unavailable (observed ${observedAt}). Current readiness, loaded revision and automatic-update status are unknown. No deployment action was taken.`;
    }
  };
}
