import { buildArtifactClient } from "../src/artifacts/build.js";

// Optional prebuild. June builds the same client at startup when
// artifacts.assets is omitted, so releases need no separate build step.
await buildArtifactClient("dist/artifacts");
