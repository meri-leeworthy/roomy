import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { routesDir } from "./scripts/build-target.mjs";

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

// The Apple App Store bundle drops the routes that must not ship there (see
// scripts/build-target.mjs): SvelteKit builds its route manifest by walking
// the routes directory, so an absent route is absent from the bundle too.
// SvelteKit marks `kit.files.routes` deprecated and offers no replacement;
// only the iOS build sets it, so every other build stays on the default
// `src/routes`.
const iosRoutes = routesDir();
if (iosRoutes) config.kit.files = { routes: iosRoutes };

export default config;
