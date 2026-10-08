import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const appIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
export const appAccessSchema = z.enum(["public", "signed-in"]);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const MAX_ARTIFACT_BYTES = 262_144;
const filePath = z
  .string()
  .max(200)
  .refine(
    (path) =>
      path
        .split("/")
        .every(
          (part) =>
            /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part) &&
            !["node_modules", "credentials", "secrets"].includes(
              part.toLowerCase(),
            ),
        ) && /\.(?:json|[cm]?[jt]sx?|html|css|svg|txt|md|lock)$/.test(path),
  );

export const artifactSchema = z
  .strictObject({
    appId: appIdSchema,
    files: z.record(filePath, z.string().max(65_536)),
  })
  .superRefine((value, ctx) => {
    const entries = Object.entries(value.files);
    if (
      !Object.hasOwn(value.files, "package.json") ||
      entries.length > 128 ||
      entries.some(([, text]) => Buffer.byteLength(text) > 65_536) ||
      Buffer.byteLength(JSON.stringify(value)) > MAX_ARTIFACT_BYTES
    )
      ctx.addIssue({
        code: "custom",
        message: "App source exceeds limits or lacks package.json",
      });
    try {
      const manifest = JSON.parse(value.files["package.json"] ?? "");
      // Match the SDK's actor detection before retaining or uploading source.
      // Self-hosted actor startup would expose an engine-wide runner credential.
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
        throw new Error("invalid_package");
      if (
        ["dependencies", "devDependencies"].some((section) =>
          Object.hasOwn(manifest[section] ?? {}, "rivetkit"),
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Actor-backed apps are unavailable; export a Fetch-only app",
        });
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid app package.json" });
    }
  });
export type AppArtifact = z.infer<typeof artifactSchema>;

export function artifactDigest(artifact: AppArtifact): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        appId: artifact.appId,
        files: Object.fromEntries(
          Object.entries(artifact.files).sort(([a], [b]) =>
            a.localeCompare(b, "en"),
          ),
        ),
      }),
    )
    .digest("hex");
}

/** Only this bounded, explicitly exported file is read; never upload a worktree. */
export async function readAppArtifact(cwd: string, appId: string) {
  const file = await open(
    join(cwd, "june-app.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES)
      throw new Error("invalid_app_artifact");
    const bytes = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_ARTIFACT_BYTES) throw new Error("invalid_app_artifact");
    const artifact = artifactSchema.parse(
      JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
    );
    if (artifact.appId !== appId) throw new Error("app_identity_changed");
    return { ...artifact, digest: artifactDigest(artifact) };
  } finally {
    await file.close();
  }
}

export function appCodingGoal(appId: string, goal: string) {
  return `${goal}\n\nBuild a Rivet Dynamic App with ID ${appId}. Export the complete app as june-app.json: {"appId":"${appId}","files":{"package.json":"...","index.js":"..."}}. Files are UTF-8 strings, relative paths only, no dotfiles, credentials, symlinks, node_modules or host state. Limits: 128 files, 64 KiB each, 256 KiB total JSON. Include package.json with type:module and main pointing to an entrypoint that default-exports a Fetch handler (or a Hono app). Never call listen(), serve(), or registry.start(). Only Fetch/HTTP apps are supported; do not declare rivetkit or use actors. The host controls public versus sign-in-required viewing through a prepared deployment receipt, not this artifact. Anyone may view a public app; any signed-in person may view a sign-in-required app. Never include private conversation data or assume viewers are the owner. Serve beneath /apps/${appId}/ on the app's own origin. App cookies, identity/auth headers, cross-origin authenticated requests, embedding and service workers are unsupported. Run the workspace's verifier against these exact exported files. Do not deploy from the coding process; June can prepare and deploy the verified export using the apps tool.`;
}
