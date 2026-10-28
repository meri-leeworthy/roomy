/**
 * The version stamped on every telemetry record must be the build the record
 * came from.
 *
 * A record that reports the package version cannot be attributed to a deployed
 * bundle: the version is a constant, so a stale client and the bundle that
 * fixed the error look identical in the log store. Faro's `app` meta is the
 * one place that reaches every record type — the instrumentations raise logs,
 * exceptions, measurements and spans without the app calling anything — so the
 * build id must be handed to `initializeFaro` there.
 *
 * A build with no git metadata resolves to `UNKNOWN_BUILD_ID`; reporting that
 * as a version would be a bucket indistinguishable from an absent field, so
 * the package version stands in. It must never be `undefined`.
 *
 * The last test reads `faro.ts` rather than importing it: the module pulls the
 * Faro SDKs in dynamically, reads `$lib/config` and `$app/environment`, and
 * references build defines that exist only inside a Vite build. The failure
 * worth catching is structural — the define not being the value handed over —
 * not the SDK call itself.
 *
 * Written against `node:test` + `node:assert` so the file runs under both
 * `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UNKNOWN_BUILD_ID } from "../build-id.ts";
import { telemetryAppVersion } from "./app-meta.ts";

const VERSION = "0.2.0";
const BUILD_ID = "abc12345";

describe("telemetryAppVersion", () => {
  test("the build id is the version a record reports", () => {
    assert.equal(telemetryAppVersion(BUILD_ID, VERSION), BUILD_ID);
  });

  test("a build with no git metadata falls back to the package version", () => {
    assert.equal(telemetryAppVersion(UNKNOWN_BUILD_ID, VERSION), VERSION);
  });

  test("an absent or blank build id falls back to the package version", () => {
    assert.equal(telemetryAppVersion(undefined, VERSION), VERSION);
    assert.equal(telemetryAppVersion("", VERSION), VERSION);
    assert.equal(telemetryAppVersion("   ", VERSION), VERSION);
  });

  test("the version is never undefined", () => {
    const version = telemetryAppVersion(undefined, VERSION);
    assert.equal(typeof version, "string");
    assert.notEqual(version, "undefined");
  });

  test("a padded build id reports the id, not the padding", () => {
    assert.equal(telemetryAppVersion(` ${BUILD_ID}\n`, VERSION), BUILD_ID);
  });
});

describe("initializeFaro is given the build id", () => {
  const faro = readFileSync(new URL("./faro.ts", import.meta.url), "utf8");

  test("app.version comes from the build id", () => {
    assert.match(
      faro,
      /version:\s*telemetryAppVersion\(\s*__BUILD_ID__\s*,\s*__APP_VERSION__\s*\)/,
    );
  });
});
