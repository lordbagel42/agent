import { join } from "node:path";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const output = ".svelte-kit/web";

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    paths: { base: "/app", relative: false },
    prerender: { crawl: false },
    // Only a prerendered shell is needed; Hono owns all authentication and IO.
    // SvelteKit's adapter interface keeps source compilation in the framework.
    adapter: {
      name: "june-hono-shell",
      async adapt(builder) {
        builder.writeClient(join(output, "client"));
        builder.writePrerendered(join(output, "pages"));
      },
    },
  },
};
