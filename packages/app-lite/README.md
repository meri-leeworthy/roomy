# app-lite

The SvelteKit thin client: Svelte 5 + Tanstack Query over XRPC, no SQLite WASM
and no client-side materialisation. See the root `AGENTS.md` for the package
map and the dev/test commands.

```bash
pnpm dev                 # vite dev on 127.0.0.1:5180
pnpm --filter app-lite check      # svelte-check
pnpm --filter app-lite test       # node --test, src/**/*.test.ts
```

## Build identity, and verifying a deploy

A static SPA has no `/health` and no stdout, so a deploy can "succeed" while
the origin keeps serving the previous bundle. Two pieces make the served build
identifiable and checkable:

- **`/build-id.json`** — a prerendered route
  (`src/routes/build-id.json/+server.ts`) written into the static output by
  every build, so the origin serves it next to `index.html`:

  ```json
  { "commit": "1a2b3c4d", "builtAt": "2026-11-10T09:00:00.000Z", "version": "0.1.0" }
  ```

  `commit` comes from the build environment (`BUILD_ID`, then
  `RAILWAY_GIT_COMMIT_SHA`, then the checkout's git HEAD — see
  `scripts/build-prod.sh` and `src/lib/build-id.ts`). A build with no commit
  available succeeds and reports `"unknown"` rather than failing. The same
  value is inlined into the JS bundle as `__BUILD_ID__`, so the file and the
  running code cannot disagree about which commit they are.

- **`scripts/check-deployed-build.mjs`** — fetches `<origin>/build-id.json`
  and compares it to an expected commit:

  ```bash
  node scripts/check-deployed-build.mjs \
    --origin http://127.0.0.1:8000 \
    --expected-file build/build-id.json
  ```

  Exit codes: `0` the origin serves the expected commit, `1` a different one,
  `2` no build id served at all (the deployed site predates the endpoint, or
  the static host answered with its SPA shell), `3` the origin did not answer,
  `4` unusable arguments. The comparison rules live in
  `scripts/lib/build-id-compare.mjs` so they are unit-tested without a network
  (`src/lib/deployed-build.test.ts`); an abbreviated id matches the full SHA
  it abbreviates.

**Deploys are manual.** The site is published only by dispatching the
`Netlify Deploy` workflow (`.github/workflows/netlify.yml`, `workflow_dispatch`)
with the ref to deploy; nothing deploys on push. After the deploy, the workflow
resolves the deploy's URL and runs the check against it, so a run whose origin
serves a commit other than the one checked out fails.
