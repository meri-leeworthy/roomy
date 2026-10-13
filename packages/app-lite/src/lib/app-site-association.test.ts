/**
 * The Apple App Site Association must describe the claim the app actually
 * makes, and a build that cannot produce it must fail.
 *
 * `src-tauri/tauri.conf.json` declares `applinks:roomy.space` — the deep-link
 * plugin's build script turns that into the app's `associated-domains`
 * entitlement, and macOS/iOS honour it only for a domain whose
 * `/.well-known/apple-app-site-association` names an `appID` that app can
 * claim. So the file is generated from the same config at build time, and the
 * parts that can drift are the ones worth pinning here:
 *
 *   - the claim parsed back out of the real `tauri.conf.json`, not a fixture
 *     (the Android intent filter is generated from that same entry);
 *   - the path prefixes becoming `components` — a prefix the file does not
 *     cover is a link the entitlement opens the app for and the association
 *     refuses;
 *   - the Team ID, which comes from the environment and must be rejected when
 *     absent, so the build fails instead of shipping a file that parses and
 *     associates nothing;
 *   - the build running the generator, and then verifying the artifact.
 *
 * Most assertions are pure; the last spawns the generator with no team id and
 * asserts it wrote nothing, because that failure mode is the whole point of the
 * gate and reads identically to success from the outside.
 *
 * Written against `node:test` + `node:assert` (app-lite's existing convention)
 * so the file runs under `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AASA_PATH,
  buildAppSiteAssociation,
  aasaComponents,
  readAppLinkClaim,
  readBundleId,
} from "./app-site-association.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const tauriConfig = JSON.parse(read("../../src-tauri/tauri.conf.json"));

describe("the app's universal-link claim", () => {
  test("is one https appLink entry, whose host and prefixes the file must cover", () => {
    const claim = readAppLinkClaim(tauriConfig);
    assert.equal(claim.host, "roomy.space");
    // The same list generates the Android intent filter's pathPrefix, so what
    // the association file claims is what Android auto-verifies.
    assert.deepEqual(claim.pathPrefixes, ["/"]);
  });

  test("names the app the served appIDs entry will be built from", () => {
    assert.equal(readBundleId(tauriConfig), "space.roomy");
  });

  test("refuses a second https appLink, which one file could not distinguish", () => {
    const twoClaims = {
      identifier: "space.roomy",
      plugins: {
        "deep-link": {
          mobile: [
            { scheme: ["https"], host: "roomy.space", pathPrefix: ["/"], appLink: true },
            { scheme: ["https"], host: "next.roomy.space", pathPrefix: ["/"], appLink: true },
          ],
        },
      },
    };
    assert.throws(() => readAppLinkClaim(twoClaims), /exactly one https appLink/);
  });

  test("refuses a claim with no pathPrefix, rather than guessing at a scope", () => {
    const noPrefix = {
      identifier: "space.roomy",
      plugins: {
        "deep-link": {
          mobile: [{ scheme: ["https"], host: "roomy.space", appLink: true }],
        },
      },
    };
    assert.throws(() => readAppLinkClaim(noPrefix), /no pathPrefix/);
  });
});

describe("aasaComponents", () => {
  test("covers the whole site for the declared root prefix", () => {
    // Apple matches `/` as a whole-path pattern where `*` is zero or more
    // characters, so the prefix "/" is "/*" — every URL on the host.
    assert.deepEqual(aasaComponents(["/"]), [{ "/": "/*" }]);
  });

  test("extends a narrower prefix so the pattern starts where the claim does", () => {
    assert.deepEqual(aasaComponents(["/join", "/c/"]), [
      { "/": "/join*" },
      { "/": "/c/*" },
    ]);
  });

  test("rejects a prefix that is not rooted, which no URL path could match", () => {
    assert.throws(() => aasaComponents(["join"]), /must start with/);
  });

  test("rejects an empty scope rather than matching nothing", () => {
    assert.throws(() => aasaComponents([]), /at least one path prefix/);
  });
});

describe("buildAppSiteAssociation", () => {
  test("associates the app ID Apple matches against the entitlement", () => {
    const doc = buildAppSiteAssociation({
      teamId: "ABCDE12345",
      bundleId: "space.roomy",
      pathPrefixes: ["/"],
    });
    assert.deepEqual(doc, {
      applinks: {
        details: [
          {
            appIDs: ["ABCDE12345.space.roomy"],
            components: [{ "/": "/*" }],
          },
        ],
      },
    });
  });

  test("rejects an absent or malformed team id instead of writing a dead appID", () => {
    for (const teamId of ["", "  ", "ABCDE1234", "ABCDE123456", "abcde12345", "APPLE_TEAM"]) {
      assert.throws(
        () =>
          buildAppSiteAssociation({ teamId, bundleId: "space.roomy", pathPrefixes: ["/"] }),
        /Apple Developer Team ID/,
        `team id ${JSON.stringify(teamId)} must be rejected`,
      );
    }
  });
});

describe("the production build", () => {
  test("resolves the association file before the frontend build", () => {
    // A deploy that cannot produce the file must fail before `pnpm build`
    // (minutes), not after it.
    const script = read("../../scripts/build-prod.sh");
    const preflight = script.indexOf("--mode preflight --out build-staging");
    const build = script.indexOf("\npnpm build\n");
    assert.ok(preflight !== -1, "build-prod.sh must preflight the association file");
    assert.ok(preflight < build, "the preflight must run before the frontend build");
  });

  test("generates the association file and then verifies the artifact", () => {
    const script = read("../../scripts/build-prod.sh");
    assert.match(script, /gen-aasa\.mjs \\\n  --out build-staging --origin "\$target_url"/);
    assert.match(script, /gen-aasa\.mjs \\\n  --verify --out build-staging --origin "\$target_url"/);
    // Generation and verification must both precede the atomic publish, or a
    // bad file is served from `build/` before anything checks it.
    assert.ok(
      script.indexOf("--verify --out build-staging") <
        script.search(/^mv build-staging build$/m),
      "the verification must run before build-staging is published as build/",
    );
  });

  test("serves the file at the one path Apple fetches", () => {
    assert.equal(AASA_PATH, "/.well-known/apple-app-site-association");
    assert.ok(
      read("../../scripts/gen-aasa.mjs").includes('join(outDir, AASA_PATH)'),
      "the generator must write to AASA_PATH, not a path of its own",
    );
  });

  test("fails, and writes nothing, when the team id is unset", () => {
    const out = mkdtempSync(join(tmpdir(), "aasa-"));
    const script = fileURLToPath(new URL("../../scripts/gen-aasa.mjs", import.meta.url));
    const env = { ...process.env, APPLE_DEVELOPMENT_TEAM: "" };
    // Under Bun the runner's own binary executes the script directly; under
    // Node the TS import needs the strip-types flag.
    const argv = process.versions.bun
      ? [script]
      : ["--experimental-strip-types", script];
    let failure: unknown;
    try {
      execFileSync(
        process.execPath,
        [...argv, "--out", out, "--origin", "https://roomy.space"],
        { env, stdio: "pipe" },
      );
    } catch (e) {
      failure = e;
    }
    if (!(failure instanceof Error)) {
      assert.fail("the generator exited zero with no team id set");
    }
    const stderr = "stderr" in failure ? String(failure.stderr) : "";
    assert.match(stderr, /APPLE_DEVELOPMENT_TEAM/);
    assert.equal(
      existsSync(join(out, AASA_PATH.slice(1))),
      false,
      "a failed build must not leave a partially written association file",
    );
    rmSync(out, { recursive: true, force: true });
  });
});
