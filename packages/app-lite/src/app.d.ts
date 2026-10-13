import "unplugin-icons/types/svelte";

declare global {
  // Defined in vite.config.ts. `__BUILD_ID__` is the commit the bundle was
  // built from, or the literal "unknown" when the build carried no git
  // metadata — never an empty string. Served as /build.json by
  // src/routes/build.json/+server.ts (see src/lib/build-id.ts).
  declare const __APP_VERSION__: string;
  declare const __BUILD_ID__: string;

  // Defined in vite.config.ts from `VITE_IOS_BUILD=1`, which the iOS job in
  // .github/workflows/release-tauri.yml sets. True only in the Apple App
  // Store bundle, where the Roomy Pro subscription page and everything that
  // links to it is left out (see scripts/build-target.mjs). Keep it first in a
  // condition (`!__IOS_BUILD__ && …`) so the bundler folds the whole thing to
  // a literal and drops the branch.
  declare const __IOS_BUILD__: boolean;

  namespace App {}
}

export {};
