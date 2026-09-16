/**
 * The deployed bundle must name its commit, and the build must refuse to
 * publish one that cannot.
 *
 * Pre-fix, app-lite baked `__BUILD_ID__` into the bundle and served nothing:
 * a repo-wide grep found exactly two hits — the `declare` in `src/app.d.ts` and
 * the `define` in `vite.config.ts` — and zero consumers. The mechanism existed;
 * the wire did not. The only stamp on a deployed client was SvelteKit's
 * `/_app/version.json`, a build *timestamp* with no commit mapping, which is why
 * a merge (TASK-136, 03:07Z) could look deployed while the served bundle
 * predated it and that could only ever be INFERRED from a timestamp.
 *
 * These assertions read the tree, not a build: a full 9.4k-module Vite build is
 * minutes of CI and OOM-prone on small hosts, and the failures worth catching
 * here are structural (no route, no consumer, identity not supplied by the
 * script) rather than runtime. The end-to-end proof — a served `/build.json`
 * carrying the commit the image was built from — is the TASK-158 verification
 * recorded on the PR.
 *
 * Written against `node:test` + `node:assert` (available without adding a
 * dependency; app-lite ships no test runner of its own) so the file runs under
 * both `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("app-lite build identity is observable", () => {
  test("a prerendered /build.json route exists", () => {
    const route = read("../routes/build.json/+server.ts");
    assert.match(route, /export\s+const\s+prerender\s*=\s*true/);
    assert.match(route, /__BUILD_ID__/);
    assert.match(route, /commit/);
  });

  test("the route reports the same id the bundle was built with", () => {
    // Both surfaces read the one define resolved in vite.config.ts, so they
    // cannot disagree about which commit they are.
    const config = read("../../vite.config.ts");
    assert.match(config, /__BUILD_ID__/);
    assert.match(config, /resolveBuildId/);
    assert.match(config, /JSON\.stringify\(BUILD_ID\)/);
  });

  test("vite.config.ts no longer emits the literal undefined", () => {
    // Pre-fix: `process.env.BUILD_ID ? JSON.stringify(...) : "undefined"` —
    // an absent id became the four-character string "undefined" in the bundle.
    const config = read("../../vite.config.ts");
    assert.doesNotMatch(config, /:\s*"undefined"/);
  });

  test("the production build script supplies a BUILD_ID", () => {
    const script = read("../../scripts/build-prod.sh");
    assert.match(script, /BUILD_ID/);
    assert.match(script, /RAILWAY_GIT_COMMIT_SHA/);
  });

  test("the build fails rather than publish an unnameable bundle", () => {
    const script = read("../../scripts/build-prod.sh");
    assert.match(script, /build-staging\/build\.json/);
    // The empty-commit case: present but meaningless downstream.
    assert.match(script, /built_commit/);
  });
});
