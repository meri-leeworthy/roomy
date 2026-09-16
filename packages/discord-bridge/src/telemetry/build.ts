/**
 * Build identity for log records.
 *
 * Resolution chain: `BUILD_ID` (baked by the Dockerfile RUNTIME stage as the
 * 8-char SHA from `RAILWAY_GIT_COMMIT_SHA`) → `RAILWAY_GIT_COMMIT_SHA` (the
 * platform provides this when the deploy came from git) → `"unknown"` (local
 * dev, or a deploy carrying no git metadata).
 *
 * The Dockerfile pair must be declared in the stage that RUNS the bridge
 * (`FROM oven/bun`), not only in the builder stage: Docker does not propagate
 * `ARG`/`ENV` across stages, so a value set only in the builder is invisible to
 * the process reading it here.
 *
 * An empty or whitespace-only value counts as ABSENT, not as an identity. The
 * Dockerfile's `ENV BUILD_ID=${RAILWAY_GIT_COMMIT_SHA%...}` materialises an
 * empty string when the build arg is absent, and `??` does not fall through on
 * `""` — a raw chain would put an empty `build_id` on every log line: present,
 * meaningless, and indistinguishable from a real value downstream.
 *
 * Called once per log record, so the chain is written out inline — no array or
 * iterator allocation on the hot path.
 */
export function resolveBuildId(): string {
	const baked = process.env.BUILD_ID?.trim();
	if (baked) return baked;
	const sha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim();
	if (sha) return sha;
	return "unknown";
}
