import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

// One DNS label: the host serves <appId>.<domain> and <appId>--signed-in.<domain>.
export const appIdSchema = z
  .string()
  .max(48)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const appAccessSchema = z.enum(["public", "signed-in"]);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const MAX_ARTIFACT_BYTES = 262_144;
// Must match apps-host/src/index.ts, which is the authority on serving types.
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
        ) &&
      /\.(?:html?|css|m?js|json|webmanifest|svg|txt|md|csv|xml)$/i.test(path),
  );

export const artifactSchema = z
  .strictObject({
    appId: appIdSchema,
    files: z.record(filePath, z.string().max(65_536)),
  })
  .superRefine((value, ctx) => {
    const entries = Object.entries(value.files);
    if (
      !Object.hasOwn(value.files, "index.html") ||
      entries.length > 128 ||
      entries.some(([, text]) => Buffer.byteLength(text) > 65_536) ||
      entries.reduce(
        (total, [path, text]) =>
          total + Buffer.byteLength(path) + Buffer.byteLength(text),
        0,
      ) > MAX_ARTIFACT_BYTES
    )
      ctx.addIssue({
        code: "custom",
        message:
          "App source needs index.html and at most 128 files, 64 KiB each, 256 KiB total",
      });
  });
export type AppArtifact = z.infer<typeof artifactSchema>;

/** Same canonical digest as the host: code-unit sorted paths, UTF-8 JSON. */
export function artifactDigest(artifact: AppArtifact): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        appId: artifact.appId,
        files: Object.fromEntries(
          Object.entries(artifact.files).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
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
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES * 2)
      throw new Error("invalid_app_artifact");
    const bytes = Buffer.alloc(MAX_ARTIFACT_BYTES * 2 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_ARTIFACT_BYTES * 2)
      throw new Error("invalid_app_artifact");
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
  return `${goal}\n\nBuild a June Dynamic App with ID ${appId}: a static browser app (HTML, CSS, JavaScript) served from the root of its own origin. Export it as june-app.json: {"appId":"${appId}","files":{"index.html":"...","app.js":"..."}}. Files are UTF-8 strings with relative paths; allowed extensions: html, css, js, mjs, json, webmanifest, svg, txt, md, csv, xml. index.html is required. No dotfiles, credentials, symlinks, node_modules, binary files or build steps. Limits: 128 files, 64 KiB each, 256 KiB total. No server code runs. Shared state uses the host's same-origin JSON API: GET /_june/storage/<key>, PUT /_june/storage/<key> with a JSON body, POST /_june/storage/<key> with {"increment":n}, DELETE /_june/storage/<key>, GET /_june/storage?prefix=p&limit=n; signed-in apps can GET /_june/me for the viewer's email. Service workers, framing and app cookies are unsupported. Never include private conversation data or assume viewers are the owner. Run the workspace's verifier against these exact exported files. Do not deploy from the coding process; June prepares and deploys the verified export with the apps tool.`;
}
