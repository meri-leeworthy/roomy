#!/usr/bin/env node
/**
 * Verify that a deployed origin serves the build that was just deployed.
 *
 * A deploy that publishes silently from a stale worktree, or publishes nothing
 * at all, looks identical to a good one from the outside: the site answers, and
 * only the code inside the bundle differs. Reading `/build-id.json` back from
 * the origin turns "we deployed" into "the origin serves commit X", which is
 * the thing worth asserting.
 *
 *   node scripts/check-deployed-build.mjs --origin https://x.netlify.app \
 *        --expected <commit>
 *   node scripts/check-deployed-build.mjs --origin http://127.0.0.1:8000 \
 *        --expected-file build/build-id.json
 *
 * Exit codes (see EXIT in ./lib/build-id-compare.mjs): 0 the origin serves the
 * expected commit, 1 a different one, 2 no build id served (site predates the
 * endpoint), 3 the origin did not answer, 4 the arguments were unusable.
 *
 * The exit status is set through `process.exitCode` rather than
 * `process.exit()`: the latter can drop buffered stdout on a pipe, which is
 * exactly how this runs in CI.
 */

import { readFileSync } from "node:fs";
import {
  evaluateDeployment,
  EXIT,
  parseBuildId,
  UNKNOWN_COMMIT,
} from "./lib/build-id-compare.mjs";

const USAGE = "usage: check-deployed-build.mjs --origin <url> (--expected <commit> | --expected-file <path>) [--timeout <seconds>]";

/** Unusable arguments — reported without the stack a plain throw would add. */
class UsageError extends Error {}

function parseArgs(argv) {
  const args = { timeoutSeconds: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--origin":
        args.origin = value;
        i += 1;
        break;
      case "--expected":
        args.expected = value;
        i += 1;
        break;
      case "--expected-file":
        args.expectedFile = value;
        i += 1;
        break;
      case "--timeout":
        args.timeoutSeconds = Number(value);
        i += 1;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new UsageError(`unknown argument "${flag}"`);
    }
  }
  return args;
}

/** The commit an artifact file (`build/build-id.json`) says it carries. */
function commitFromFile(path) {
  let manifest;
  try {
    manifest = parseBuildId(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(`cannot read --expected-file ${path}: ${error.message}`);
  }
  if (!manifest) throw new UsageError(`--expected-file ${path} is not a build id`);
  if (manifest.commit === UNKNOWN_COMMIT) {
    throw new UsageError(
      `--expected-file ${path} reports commit "unknown"; there is nothing to compare`,
    );
  }
  return manifest.commit;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return EXIT.MATCH;
  }
  if (!args.origin) throw new UsageError("--origin is required");

  const expected =
    args.expected?.trim() || (args.expectedFile ? commitFromFile(args.expectedFile) : "");
  if (!expected) throw new UsageError("one of --expected or --expected-file is required");
  if (expected === UNKNOWN_COMMIT) {
    throw new UsageError(`--expected "${UNKNOWN_COMMIT}" names no commit`);
  }

  const origin = args.origin.replace(/\/+$/, "");
  const url = `${origin}/build-id.json`;

  let sample;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(args.timeoutSeconds * 1000),
    });
    sample = { origin, status: response.status, body: await response.text() };
  } catch (error) {
    sample = { origin, error: error.cause?.code ?? error.message };
  }

  const { exitCode, message } = evaluateDeployment(sample, expected);
  if (exitCode === EXIT.MATCH) {
    console.log(message);
  } else {
    console.error(message);
  }
  return exitCode;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(`check-deployed-build: ${error.message}\n${USAGE}`);
  process.exitCode = EXIT.USAGE;
}
