/**
 * Build identity for log records and health checks.
 *
 * Resolution chain: `BUILD_ID` (baked by Dockerfile.appserver's RUNTIME stage
 * as the 8-char SHA from `RAILWAY_GIT_COMMIT_SHA`) → `RAILWAY_GIT_COMMIT_SHA`
 * (provided by the platform when the deploy came from git) → `"unknown"`
 * (local dev, or a deploy carrying no git metadata).
 *
 * The Dockerfile must declare the pair in the runtime stage too: Docker does
 * not propagate `ARG`/`ENV` across stages, so a value set only in the build
 * stage is invisible to the process that actually runs.
 *
 * An empty or whitespace-only value counts as ABSENT, not as an identity:
 * `??` does not fall through on `""`, so a raw chain would put an empty
 * `build_id` on the wire — present, meaningless, and indistinguishable from
 * a real value to every consumer downstream.
 *
 * Called once per log record; the chain is written out inline so it allocates
 * nothing (no array, no iterator) on the hot path.
 */
export function resolveBuildId(): string {
  const baked = process.env.BUILD_ID?.trim();
  if (baked) return baked;
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim();
  if (sha) return sha;
  return "unknown";
}
