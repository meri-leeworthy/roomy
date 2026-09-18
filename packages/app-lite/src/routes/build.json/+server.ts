import { json } from "@sveltejs/kit";
import type { BuildManifest } from "$lib/build-id";

/**
 * The deployed bundle's self-description: `/build.json`.
 *
 * A static SPA has no `/health` and no stdout, so nothing it served named the
 * commit it was built from. Prerendered, so it is a real file in the static
 * output (`build/build.json`) served next to `index.html`, readable with a
 * plain `curl` — no devtools, no JS execution.
 *
 * `__BUILD_ID__` is the same value inlined into the JS bundle (both come from
 * one `resolveBuildId()` call in `vite.config.ts`), so this file and the
 * running code cannot disagree about which commit they are.
 */
export const prerender = true;

export function GET(): Response {
  const manifest: BuildManifest = {
    commit: __BUILD_ID__,
    version: __APP_VERSION__,
    built_at: new Date().toISOString(),
  };
  return json(manifest);
}
