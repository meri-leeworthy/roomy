import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The SvelteKit plugin is what resolves `$lib`/`$app` and the other aliases a
  // source file imports; without it a spec can only import modules that use
  // relative paths.
  plugins: [sveltekit()],
  test: {
    include: ["src/**/*.spec.ts"],
    exclude: ["node_modules", "dist"],
  },
});
