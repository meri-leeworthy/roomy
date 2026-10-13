#!/usr/bin/env node
/**
 * Generate (or verify) the Apple App Site Association for the deployment being
 * built.
 *
 *   gen-aasa.mjs --out build-staging --origin https://roomy.space
 *   gen-aasa.mjs --verify --out build-staging --origin https://roomy.space
 *
 * The association file is what makes the `associated-domains` entitlement the
 * iOS build carries a claim the system can check: Apple fetches
 * `/.well-known/apple-app-site-association` from the domain and associates the
 * app only if the served `appIDs` entry matches `<Team ID>.<Bundle ID>`. The
 * Team ID is an Apple account property — supplied as APPLE_DEVELOPMENT_TEAM and
 * never committed — so the file is generated at build time, and a build that
 * cannot name the team fails here rather than shipping a file that parses and
 * associates nothing.
 *
 * One file serves one host. The app declares the host it claims in
 * `src-tauri/tauri.conf.json` (`plugins > deep-link > mobile`, the same entry
 * that generates the Android intent filter), so `--origin` decides whether this
 * build is that deployment: a build served from another origin writes nothing
 * and `--verify` asserts nothing was written. The skipped case is printed,
 * never silent — an association file on a host the app does not claim would
 * name the app for links it cannot open.
 *
 * Run: node --experimental-strip-types scripts/gen-aasa.mjs --help
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AASA_PATH,
  TEAM_ID_ENV,
  buildAppSiteAssociation,
  readAppLinkClaim,
  readBundleId,
} from "../src/lib/app-site-association.ts";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(pkgRoot, "src-tauri/tauri.conf.json");

const USAGE = `usage: gen-aasa.mjs --out <dir> [--origin <url>] [--mode preflight|generate|verify]

  --out <dir>      directory the built site is published from (build-prod.sh
                   passes build-staging)
  --origin <url>   origin this build is served from. When its host is not the
                   host the app claims, no association file is written: the
                   deployment is not the one the app's entitlement names.
  --mode <mode>    preflight: assert this build can produce the file (config
                   and APPLE_DEVELOPMENT_TEAM) without writing anything, so a
                   build that cannot fails before the frontend build
                   generate (default): write it
                   verify: read the artifact instead, and fail when it
                   disagrees with tauri.conf.json, the team id, or the origin
  --verify         shorthand for --mode verify
  --help           print this text
`;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { out: undefined, origin: undefined, mode: "generate", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") args.out = argv[++i];
    else if (arg === "--origin") args.origin = argv[++i];
    else if (arg === "--mode") args.mode = argv[++i];
    else if (arg === "--verify") args.mode = "verify";
    else if (arg === "--help" || arg === "-h") args.help = true;
    else fail(`unknown argument ${arg}\n\n${USAGE}`);
  }
  if (!["preflight", "generate", "verify"].includes(args.mode)) {
    fail(`unknown --mode ${args.mode}\n\n${USAGE}`);
  }
  return args;
}

function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return fail(
      `--origin ${JSON.stringify(origin)} is not a URL: it decides whether this ` +
        `build is the deployment the app claims (${CONFIG_PATH})`,
    );
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (!args.out) fail(`--out is required\n\n${USAGE}`);

const outDir = args.out;
const artifact = join(outDir, AASA_PATH);
const origin = args.origin ?? "";

// Every configuration problem here is a build failure, so report it as one:
// `fail` (a message and a non-zero exit) rather than an uncaught throw with a
// stack trace pointing at whichever helper noticed.
let claim;
let bundleId;
let servesClaim;
try {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  claim = readAppLinkClaim(config);
  bundleId = readBundleId(config);
  // An absent --origin means the build is not tied to an origin at all (a local
  // `scripts/build-prod.sh` run); it is then treated as the claimed deployment,
  // since nothing says otherwise and the caller asked for a web build.
  servesClaim = origin === "" || hostOf(origin) === claim.host;
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

try {
  if (args.mode === "preflight") preflight();
  else if (args.mode === "verify") verify();
  else generate();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

/**
 * Assert this build can produce the association file, without writing one.
 *
 * Runs before the frontend build in `scripts/build-prod.sh`: a deploy with no
 * APPLE_DEVELOPMENT_TEAM, or a `tauri.conf.json` whose claim cannot be read, is
 * broken before `vite build` — which is minutes — rather than after it.
 */
function preflight() {
  if (!servesClaim) {
    console.log(
      `AASA: ${origin} is not https://${claim.host}, so this build carries no ` +
        `association file (the app claims links only on that host).`,
    );
    return;
  }
  const doc = buildAppSiteAssociation({
    teamId: process.env[TEAM_ID_ENV] ?? "",
    bundleId,
    pathPrefixes: claim.pathPrefixes,
  });
  console.log(
    `AASA: this build will associate ${doc.applinks.details[0].appIDs[0]} with ` +
      `https://${claim.host}${claim.pathPrefixes.join("")}*`,
  );
}

/** Write the association file for this deployment, or explain why it has none. */
function generate() {
  if (!servesClaim) {
    console.log(
      `AASA: not written — this build is served from ${origin} but the app claims ` +
        `https://${claim.host} (src-tauri/tauri.conf.json). An association file ` +
        `on any other host would name the app for links it cannot open.`,
    );
    return;
  }
  const doc = buildAppSiteAssociation({
    teamId: process.env[TEAM_ID_ENV] ?? "",
    bundleId,
    pathPrefixes: claim.pathPrefixes,
  });
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(
    `AASA: wrote ${artifact} for https://${claim.host} ` +
      `(appID ${doc.applinks.details[0].appIDs[0]})`,
  );
}

/**
 * Read the artifact that ships and hold it against the claim.
 *
 * `build-prod.sh` runs this after generating, so what deploys is what was
 * checked — not the intention to write a file. A deployment that is not the
 * claimed host must carry no association file at all, so the absent case is an
 * assertion here rather than an omission.
 */
function verify() {
  const raw = readOrNull(artifact);

  if (!servesClaim) {
    if (raw !== null) {
      fail(
        `${artifact} exists, but this build is served from ${origin} and the app ` +
          `claims https://${claim.host}. The file names <Team ID>.${bundleId} for ` +
          `a host no entitlement covers; delete it (scripts/build-prod.sh ` +
          `generates it only for the claimed host).`,
      );
    }
    console.log(`AASA: verified — none, as this build is not https://${claim.host}`);
    return;
  }

  if (raw === null) {
    fail(
      `${artifact} is missing: https://${claim.host} would serve no association ` +
        `file, so every shared link opens the browser instead of the app. Is ` +
        `${TEAM_ID_ENV} set for this build?`,
    );
  }

  const expected = buildAppSiteAssociation({
    teamId: process.env[TEAM_ID_ENV] ?? "",
    bundleId,
    pathPrefixes: claim.pathPrefixes,
  });

  let served;
  try {
    served = JSON.parse(raw);
  } catch (e) {
    fail(`${artifact} is not JSON (${String(e)}); Apple reports that as SWCERR00401`);
  }
  if (JSON.stringify(served) !== JSON.stringify(expected)) {
    fail(
      `${artifact} does not match src-tauri/tauri.conf.json.\n` +
        `  served:   ${JSON.stringify(served)}\n` +
        `  expected: ${JSON.stringify(expected)}\n` +
        `The appIDs entry must name the app the entitlement claims, and the ` +
        `components must cover every path prefix the claim declares.`,
    );
  }
  console.log(
    `AASA: verified — ${artifact} associates ` +
      `${expected.applinks.details[0].appIDs[0]} with every path under ` +
      `${claim.pathPrefixes.join(", ")} on https://${claim.host}`,
  );
}

function readOrNull(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
