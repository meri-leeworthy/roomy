import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type PluginOption } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import Icons from "unplugin-icons/vite";

export default defineConfig({
  plugins: [
    sveltekit(),
    tailwindcss(),
    topLevelAwait(),
    wasm(),
    {
      // Add stricter headers that will allow the browser to enable SharedArrayBuffers in
      // workers, which is used by the SQLite VFS.
      name: "cross-origin-isolation-headers",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          console.log("INCOMING HOST:", req.headers.host, "URL:", req.url);
          // res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
          // res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          // res.setHeader("Permissions-Policy", "cross-origin-isolated=*");
          next();
        });
      },
    },
    Icons({
      compiler: "svelte",
    }),
  ] as PluginOption[],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2048,
    sourcemap: true,
  },
  server: {
    host: "0.0.0.0", //"127.0.0.1",
    port: 5173,
    strictPort: true,
    allowedHosts: ["bs-local.com", "localhost"],
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
});
