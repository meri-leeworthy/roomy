import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";
import { FileSystemIconLoader } from "unplugin-icons/loaders";
import { defineConfig } from "vite";
import packageJson from "./package.json";
import { resolveBuildId } from "./src/lib/build-id.ts";

// Resolved once, here, so the value inlined into the bundle (`__BUILD_ID__`)
// and the value served as `/build.json` by src/routes/build.json/+server.ts
// cannot diverge — both come from this one call.
const BUILD_ID = resolveBuildId(process.env);

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [
    sveltekit(),
    tailwindcss(),
    Icons({
      compiler: "svelte",
      customCollections: {
        custom: FileSystemIconLoader("../design/static/icons"),
      },
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5180,
    allowedHosts: true,
  },
});
