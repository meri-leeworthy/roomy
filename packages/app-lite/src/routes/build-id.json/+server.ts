import { json } from "@sveltejs/kit";
import type { BuildManifest } from "$lib/build-id";

/**
 * The deployed bundle's self-description: `/build-id.json`.
 *
 * A static SPA has no `/health` and no stdout, so nothing it served named the
 * commit it was built from. Prerendered, so it is a real file in the static
 * output (`build/build-id.json`) served next to `index.html`, readable with a
 * plain `curl` — no devtools, no JS execution.
 *
 * `__BUILD_ID__` is the same value inlined into the JS bundle (both come from
 * one `resolveBuildId()` call in `vite.config.ts`), so this file and the
 * running code cannot disagree about which commit they are.
 *
 * `scripts/check-deployed-build.mjs` reads this endpoint back from a deployed
 * origin and compares it to the commit that was deployed.
 */
export const prerender = true;

export function GET(): Response {
  const manifest: BuildManifest = {
    commit: __BUILD_ID__,
    builtAt: new Date().toISOString(),
    version: __APP_VERSION__,
  };
  return json(manifest);
}
