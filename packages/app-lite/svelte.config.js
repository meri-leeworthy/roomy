import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  vitePlugin: {
    inspector: true
  },
  kit: {
    serviceWorker: {
      register: true,
    },
    adapter: adapter({
      // Build to a staging dir, then build-prod.sh atomically swaps it into
      // the published `build/`. Keeps the live-served build/ complete during
      // the whole build so a rebuild never exposes half-written assets.
      pages: "build-staging",
      fallback: "index.html",
    }),
  },
};

export default config;
