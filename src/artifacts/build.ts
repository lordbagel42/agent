import { copyFile, cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Bundle the board/workflow browser client from this release's own source. */
export async function buildArtifactClient(outdir: string) {
  const source = (file: string) =>
    fileURLToPath(new URL(file, import.meta.url));
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: [source("./client.tsx")],
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    conditions: ["production"],
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "file", ".woff": "file" },
    legalComments: "linked",
    logLevel: "silent",
  });
  const excalidraw = dirname(
    createRequire(import.meta.url).resolve("@excalidraw/excalidraw"),
  );
  await cp(join(excalidraw, "fonts"), join(outdir, "fonts"), {
    recursive: true,
  });
  await copyFile(
    source("./EXCALIDRAW-LICENSE.txt"),
    join(outdir, "EXCALIDRAW-LICENSE.txt"),
  );
  return outdir;
}
