import { execFileSync } from "node:child_process";
import { build } from "esbuild";

// All runtime JS is bundled. Installing this directory needs only Node 24;
// neither the app checkout nor its dependencies or release symlink are needed.
await build({
  entryPoints: ["src/diagnostics/main.ts"],
  outfile: "dist/debug-site/server.mjs",
  platform: "node",
  target: "node24",
  format: "esm",
  bundle: true,
  minify: false,
  legalComments: "linked",
  define: {
    "process.env.JUNE_DEBUG_BUILD_REVISION": JSON.stringify(
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ),
  },
});
