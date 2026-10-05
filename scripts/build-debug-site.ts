import { execFileSync } from "node:child_process";
import { build } from "esbuild";

// The installed updater builds an exact Git archive without a .git directory.
const revision =
  process.env.JUNE_DEBUG_BUILD_REVISION ??
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(revision))
  throw new Error("Debug site build requires an exact revision");

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
    "process.env.JUNE_DEBUG_BUILD_REVISION": JSON.stringify(revision),
  },
});
