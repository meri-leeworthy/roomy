import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Apple App Store build, selected by `VITE_IOS_BUILD=1` (set by the iOS job in
 * `.github/workflows/release-tauri.yml`).
 *
 * One frontend bundle serves web, desktop and iOS, so anything a target must
 * not ship has to be left out while the bundle is built. App Store review
 * guideline 3.1.1 requires in-app purchases to go through StoreKit, and the
 * Roomy Pro subscription page sells a membership through an external (Polar)
 * checkout, so that page cannot ship in the iOS app. Web, desktop and Android
 * keep it — the web build is where a membership can be bought.
 *
 * `vite.config.ts` turns this into the `__IOS_BUILD__` constant (see
 * `src/app.d.ts`); `routesDir()` below uses it to drop the route itself.
 */
export const IOS_BUILD = process.env.VITE_IOS_BUILD === "1";

/** Routes absent from the iOS bundle, as paths relative to `src/routes`. */
const IOS_EXCLUDED_ROUTES = ["user/settings/subscription"];

/**
 * Routes directory for this build, or `null` to stay on SvelteKit's default
 * `src/routes`.
 *
 * SvelteKit builds its route manifest by walking this directory, so a route
 * that is not there cannot reach the client bundle at all. The iOS build reads
 * a freshly generated mirror of `src/routes` without the excluded routes: the
 * page module, its client chunk and its manifest entry are never emitted, and
 * the URL has no route to match.
 */
export function routesDir() {
  if (!IOS_BUILD) return null;

  const from = path.join(appRoot, "src/routes");
  const to = path.join(appRoot, ".routes-ios");
  fs.rmSync(to, { recursive: true, force: true });
  mirrorRoutes(from, to);
  return path.relative(appRoot, to);
}

function mirrorRoutes(from, to, route = "") {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const entryRoute = route ? `${route}/${entry.name}` : entry.name;
    if (IOS_EXCLUDED_ROUTES.includes(entryRoute)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) mirrorRoutes(source, target, entryRoute);
    // Symlinked rather than copied, so a route file keeps resolving its own
    // relative imports — `../app.css`, `../../lib/…` — from `src/routes`.
    else fs.symlinkSync(source, target);
  }
}
