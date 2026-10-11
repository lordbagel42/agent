/**
 * Bundles each host service into one self-contained `.mjs` with no runtime
 * `node_modules`, plus a manifest of SHA-256 digests for installation
 * provenance. Run from a clean checkout of the exact reviewed revision.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const root = import.meta.dirname;
const out = join(root, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out);

const entries = readdirSync(join(root, "src/bin"))
  .filter((name) => name.endsWith(".ts"))
  .map((name) => name.slice(0, -3));

await build({
  entryPoints: Object.fromEntries(
    entries.map((name) => [name, join(root, "src/bin", `${name}.ts`)]),
  ),
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Deterministic, reviewable output: no minification, no source paths.
  legalComments: "none",
  charset: "utf8",
  logLevel: "warning",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});

for (const script of readdirSync(join(root, "scripts"))) {
  copyFileSync(join(root, "scripts", script), join(out, script));
  chmodSync(join(out, script), 0o755);
}

const files = Object.fromEntries(
  readdirSync(out)
    .sort()
    .map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(join(out, name)))
        .digest("hex"),
    ]),
);
writeFileSync(
  join(out, "manifest.json"),
  `${JSON.stringify({ sha256: files }, null, 2)}\n`,
);
