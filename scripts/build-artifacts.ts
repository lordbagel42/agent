import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist/artifacts", { recursive: true });
await build({
  entryPoints: ["src/artifacts/client.tsx"],
  outdir: "dist/artifacts",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  conditions: ["production"],
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".woff2": "file", ".woff": "file" },
  legalComments: "linked",
});
await cp(
  "node_modules/@excalidraw/excalidraw/dist/prod/fonts",
  "dist/artifacts/fonts",
  { recursive: true },
);
await cp(
  "docs/licenses/EXCALIDRAW.txt",
  "dist/artifacts/EXCALIDRAW-LICENSE.txt",
);
