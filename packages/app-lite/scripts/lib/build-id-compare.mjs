/**
 * Comparison of a deployed build identity against the one that was deployed.
 *
 * `scripts/check-deployed-build.mjs` fetches `<origin>/build-id.json` and hands
 * the response here as a plain sample; everything below is pure, so the rules
 * are testable without a network or a server.
 *
 * The four outcomes are distinct because they mean different things to whoever
 * reads the failed run:
 *
 *   match        the origin serves the build that was just deployed
 *   mismatch     the origin serves a build, and it is the wrong one
 *   absent       the origin serves no build id at all — the deployed site
 *                predates the endpoint, so it cannot be wrong about a commit,
 *                it just cannot answer
 *   unreachable  the origin did not answer (network, TLS, 5xx)
 */

/** The value a build reports when it carried no git metadata at all. */
export const UNKNOWN_COMMIT = "unknown";

/** Process exit codes `check-deployed-build.mjs` reports. */
export const EXIT = {
  MATCH: 0,
  MISMATCH: 1,
  ABSENT: 2,
  UNREACHABLE: 3,
  /** The check could not be run: no origin, no expected commit. */
  USAGE: 4,
};

/**
 * Is `a` the same commit as `b`, allowing either to be an abbreviation of the
 * other?
 *
 * The build id is abbreviated to 8 characters wherever an image supplies it
 * (see `src/lib/build-id.ts`), while the commit a CI run knows it deployed is
 * the full 40-character SHA. Comparing them for equality would report every
 * deploy as a mismatch; comparing by prefix is what makes the two comparable
 * without forcing one shape on both.
 *
 * `"unknown"` never matches: it is the absence of an identity, and two
 * unnameable builds are not known to be the same build.
 */
export function sameCommit(a, b) {
  const left = String(a ?? "").trim().toLowerCase();
  const right = String(b ?? "").trim().toLowerCase();
  if (!left || !right) return false;
  if (left === UNKNOWN_COMMIT || right === UNKNOWN_COMMIT) return false;
  return left.startsWith(right) || right.startsWith(left);
}

/**
 * Parse a `/build-id.json` body, or return `null` when it is not one.
 *
 * The static host under test answers unknown paths with the SPA shell (see
 * `netlify.toml`'s `/*` redirect), so a missing build-id file arrives as
 * `200` with HTML in it, not as `404`. A body that does not parse, or parses to
 * something without a string `commit`, is a body with no build id in it.
 */
export function parseBuildId(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  if (typeof parsed.commit !== "string") return null;
  return parsed;
}

/** A short description of a body that is not a build id, for the failure message. */
function describeBody(body) {
  const trimmed = body.trim();
  if (!trimmed) return "an empty body";
  if (trimmed.startsWith("<")) return "an HTML document";
  return `unparseable JSON (${JSON.stringify(trimmed.slice(0, 60))})`;
}

/**
 * Judge one fetched sample.
 *
 * `sample` is `{ origin, status, body }` for a response, or `{ origin, error }`
 * when the request itself failed. Returns the exit code, the verdict, and the
 * message to print — the caller does nothing but report them.
 */
export function evaluateDeployment(sample, expected) {
  const { origin, status = 0, body = "", error } = sample;
  const url = `${origin}/build-id.json`;

  if (error) {
    return {
      exitCode: EXIT.UNREACHABLE,
      verdict: "unreachable",
      message: `could not reach ${url}: ${error}`,
    };
  }
  if (status === 404) {
    return {
      exitCode: EXIT.ABSENT,
      verdict: "absent",
      message:
        `${url} does not exist (HTTP 404).\n` +
        `The deployed site has no build identity: it was published before ${origin} ` +
        `served one, so nothing can say which commit it runs. Redeploy it.`,
    };
  }
  if (status < 200 || status >= 300) {
    return {
      exitCode: EXIT.UNREACHABLE,
      verdict: "unreachable",
      message: `${url} answered HTTP ${status}, not a build id.`,
    };
  }

  const manifest = parseBuildId(body);
  if (!manifest) {
    return {
      exitCode: EXIT.ABSENT,
      verdict: "absent",
      message:
        `${url} answered HTTP ${status} with ${describeBody(body)}, not a build id.\n` +
        `A static host serves its SPA shell for paths it has no file for, so this ` +
        `usually means the deployed site predates the /build-id.json endpoint and ` +
        `nothing can say which commit it runs. Redeploy it.`,
    };
  }

  const deployed = manifest.commit.trim();
  if (deployed === UNKNOWN_COMMIT) {
    return {
      exitCode: EXIT.MISMATCH,
      verdict: "mismatch",
      message:
        `${url} reports commit "${UNKNOWN_COMMIT}" — the deployed build carried no git ` +
        `metadata. Deployed: "${UNKNOWN_COMMIT}", expected: "${expected}".`,
    };
  }
  if (!sameCommit(deployed, expected)) {
    return {
      exitCode: EXIT.MISMATCH,
      verdict: "mismatch",
      message:
        `${url} serves a different build than the one deployed.\n` +
        `Deployed: "${deployed}", expected: "${expected}".`,
    };
  }
  return {
    exitCode: EXIT.MATCH,
    verdict: "match",
    message: `${url} serves commit "${deployed}" (built ${manifest.builtAt ?? "unknown time"}, version ${manifest.version ?? "unknown"}), matching "${expected}".`,
  };
}
