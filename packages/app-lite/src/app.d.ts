import "unplugin-icons/types/svelte";

declare global {
  // Defined in vite.config.ts. `__BUILD_ID__` is the commit the bundle was
  // built from, or the literal "unknown" when the build carried no git
  // metadata — never an empty string. Served as /build.json by
  // src/routes/build.json/+server.ts (see src/lib/build-id.ts).
  declare const __APP_VERSION__: string;
  declare const __BUILD_ID__: string;

  namespace App {}
}

export {};
