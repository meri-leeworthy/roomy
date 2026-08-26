/**
 * Build identity for log records and health checks.
 *
 * Resolution chain: `BUILD_ID` (baked by Dockerfile.appserver as the 8-char
 * SHA from `RAILWAY_GIT_COMMIT_SHA`) → `RAILWAY_GIT_COMMIT_SHA` (Railway
 * provides this on every deploy) → `"unknown"` (local dev).
 */

export function resolveBuildId(): string {
  return process.env.BUILD_ID ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? "unknown";
}
