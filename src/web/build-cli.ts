import { makeJuneRuntime } from "../effect/runtime.js";
import { buildWebAssets } from "./build.js";

const runtime = makeJuneRuntime();
try {
  const assets = await runtime.runPromise(buildWebAssets());
  console.info(
    `June web built: ${assets.files.size} assets, ${assets.html.length} HTML bytes.`,
  );
} finally {
  await runtime.dispose();
}
