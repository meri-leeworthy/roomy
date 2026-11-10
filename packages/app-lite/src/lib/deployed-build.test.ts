/**
 * The post-deploy check: does the origin serve the build that was deployed?
 *
 * `scripts/lib/build-id-compare.mjs` holds the rules and takes a fetched
 * sample, so these assertions cover every outcome without a server: the
 * request itself lives in `scripts/check-deployed-build.mjs`.
 *
 * The case that matters most is not the mismatch — it is the deployment that
 * serves no build id at all. A static host answers unknown paths with the SPA
 * shell (`netlify.toml`'s `/*` redirect), so a site published before the
 * endpoint existed answers `200 text/html` rather than `404`, and reporting
 * that as "serves a different build" would send someone looking for a bad
 * deploy that never happened.
 *
 * Written against `node:test` + `node:assert`, like the rest of app-lite's
 * suites.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateDeployment,
  EXIT,
  parseBuildId,
  sameCommit,
} from "../../scripts/lib/build-id-compare.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHORT = SHA.slice(0, 8);
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const ORIGIN = "https://deploy--site.netlify.app";

const served = (commit: string) =>
  JSON.stringify({
    commit,
    builtAt: "2026-11-10T09:00:00.000Z",
    version: "0.1.0",
  });

describe("sameCommit", () => {
  test("identical commits match", () => {
    assert.equal(sameCommit(SHA, SHA), true);
  });

  test("an abbreviated id matches the full sha it abbreviates", () => {
    assert.equal(sameCommit(SHORT, SHA), true);
    assert.equal(sameCommit(SHA, SHORT), true);
  });

  test("hex case does not change the commit", () => {
    assert.equal(sameCommit(SHA.toUpperCase(), SHA), true);
  });

  test("different commits do not match", () => {
    assert.equal(sameCommit("0123456789abcdef", "fedcba9876543210"), false);
  });

  test("unknown never matches, including another unknown", () => {
    assert.equal(sameCommit("unknown", SHA), false);
    assert.equal(sameCommit(SHA, "unknown"), false);
    assert.equal(sameCommit("unknown", "unknown"), false);
  });

  test("an absent id matches nothing", () => {
    assert.equal(sameCommit("", SHA), false);
    assert.equal(sameCommit(undefined, undefined), false);
  });
});

describe("parseBuildId", () => {
  test("reads a served manifest", () => {
    assert.deepEqual(parseBuildId(served(SHA)), {
      commit: SHA,
      builtAt: "2026-11-10T09:00:00.000Z",
      version: "0.1.0",
    });
  });

  test("a body that is not JSON is not a build id", () => {
    assert.equal(parseBuildId("<!doctype html><html></html>"), null);
    assert.equal(parseBuildId(""), null);
  });

  test("JSON without a string commit is not a build id", () => {
    assert.equal(parseBuildId("{}"), null);
    assert.equal(parseBuildId('{"commit": 42}'), null);
    assert.equal(parseBuildId("null"), null);
  });
});

describe("evaluateDeployment", () => {
  test("the origin serving the deployed commit is a match", () => {
    const result = evaluateDeployment({ origin: ORIGIN, status: 200, body: served(SHA) }, SHA);
    assert.equal(result.exitCode, EXIT.MATCH);
    assert.equal(result.verdict, "match");
  });

  test("the abbreviated id a build records matches the full sha deployed", () => {
    const result = evaluateDeployment({ origin: ORIGIN, status: 200, body: served(SHORT) }, SHA);
    assert.equal(result.exitCode, EXIT.MATCH);
  });

  test("a different commit fails and names both ids", () => {
    const result = evaluateDeployment({ origin: ORIGIN, status: 200, body: served(OTHER) }, SHA);
    assert.equal(result.exitCode, EXIT.MISMATCH);
    assert.match(result.message, new RegExp(OTHER));
    assert.match(result.message, new RegExp(SHA));
  });

  test("a build that cannot name its commit fails rather than passing", () => {
    const result = evaluateDeployment({ origin: ORIGIN, status: 200, body: served("unknown") }, SHA);
    assert.equal(result.exitCode, EXIT.MISMATCH);
    assert.match(result.message, /unknown/);
  });

  test("a 404 means the deployed site predates the endpoint", () => {
    const result = evaluateDeployment({ origin: ORIGIN, status: 404, body: "" }, SHA);
    assert.equal(result.exitCode, EXIT.ABSENT);
    assert.equal(result.verdict, "absent");
    assert.match(result.message, /Redeploy/);
  });

  // What the deployed site actually answers today: the SPA shell, 200.
  test("an SPA shell served in place of the file is absent, not a mismatch", () => {
    const shell = '<!doctype html><html><head><title>Roomy</title></head></html>';
    const result = evaluateDeployment({ origin: ORIGIN, status: 200, body: shell }, SHA);
    assert.equal(result.exitCode, EXIT.ABSENT);
    assert.match(result.message, /predates/);
  });

  test("a 200 carrying unparseable JSON is absent, not a mismatch", () => {
    const result = evaluateDeployment({ origin: ORIGIN, status: 200, body: "{oops" }, SHA);
    assert.equal(result.exitCode, EXIT.ABSENT);
  });

  test("a request that never completed is unreachable", () => {
    const result = evaluateDeployment({ origin: ORIGIN, error: "ENOTFOUND" }, SHA);
    assert.equal(result.exitCode, EXIT.UNREACHABLE);
    assert.equal(result.verdict, "unreachable");
    assert.match(result.message, /ENOTFOUND/);
  });

  test("a server error is unreachable, not a verdict about the build", () => {
    const result = evaluateDeployment({ origin: ORIGIN, status: 503, body: "" }, SHA);
    assert.equal(result.exitCode, EXIT.UNREACHABLE);
  });

  test("the four outcomes are distinct exit codes", () => {
    const codes = [
      evaluateDeployment({ origin: ORIGIN, status: 200, body: served(SHA) }, SHA).exitCode,
      evaluateDeployment({ origin: ORIGIN, status: 200, body: served(OTHER) }, SHA).exitCode,
      evaluateDeployment({ origin: ORIGIN, status: 404, body: "" }, SHA).exitCode,
      evaluateDeployment({ origin: ORIGIN, error: "ECONNREFUSED" }, SHA).exitCode,
    ];
    assert.deepEqual(codes, [EXIT.MATCH, EXIT.MISMATCH, EXIT.ABSENT, EXIT.UNREACHABLE]);
    assert.equal(new Set(codes).size, codes.length);
  });
});
