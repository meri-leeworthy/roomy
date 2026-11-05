/**
 * The `app` meta Faro stamps on every record it sends.
 *
 * Every signal the agent ships — console lines, exceptions, web-vitals
 * measurements, spans — carries this meta, and the collector turns it into the
 * record's `app_name` / `app_version` fields. It is the only value that reaches
 * signals the app never raises itself (the instrumentations emit those), which
 * is why the running build is named here rather than attached per record.
 *
 * `version` is the build id, not the package version. The package version
 * changes only at a release, so it cannot tell a stale bundle from the one just
 * deployed — an error that outlives its fix is unattributable without the
 * build. The build id is the same value `/build.json` serves and
 * `__BUILD_ID__` inlines (see ../build-id.ts), so a record and the deployed
 * bundle name the same commit.
 *
 * A build with no git metadata resolves to `UNKNOWN_BUILD_ID`, which is not an
 * identity: reporting it as a version would put every such build in one bucket
 * that reads the same as an absent field. The package version stands in
 * instead, so a dev or metadata-less build reports a version, never
 * `undefined`.
 */
import { UNKNOWN_BUILD_ID } from "../build-id.ts";

/**
 * The version stamped on every telemetry record: the build id when the build
 * carried one, otherwise the package version.
 */
export function telemetryAppVersion(
  buildId: string | undefined,
  packageVersion: string,
): string {
  const id = buildId?.trim();
  return id && id !== UNKNOWN_BUILD_ID ? id : packageVersion;
}
