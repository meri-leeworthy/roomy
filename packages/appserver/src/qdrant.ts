/**
 * Qdrant message-search service configuration.
 *
 * Qdrant is the global message-search index (Phase 2 of
 * docs/plans/search-endpoints.md). The appserver indexes every message as a
 * sparse BM25 vector in the `messages` collection and serves
 * `space.roomy.search.messages` from it — see `src/search/`.
 *
 * This module is the process-wide config singleton — set once during
 * `createAppserver`, then read by the indexer and the search handler that
 * don't receive it via constructor injection. Mirrors the
 * `src/happyview.ts` config-singleton pattern.
 *
 * When Qdrant is not configured (no `QDRANT_URL`), the appserver runs fine
 * without it: the indexer queues nothing and the search endpoint returns
 * 503. Enabling Qdrant later picks up every message via the boot backfill
 * sweep (see `src/search/indexer.ts`).
 */

/**
 * Configuration for connecting to a Qdrant search service.
 *
 * Env vars:
 * - `QDRANT_URL` — base HTTP origin (required to enable Qdrant)
 * - `QDRANT_API_KEY` — API key for authenticated deployments
 */
export interface QdrantConfig {
  /** Base HTTP origin (no trailing slash), e.g. `https://search-staging.roomy.space`. */
  url: string;
  /** API key for authenticated deployments. */
  apiKey?: string;
}

/**
 * Parse Qdrant configuration from environment variables.
 *
 * Reads `QDRANT_URL` and `QDRANT_API_KEY`. Returns `null` when `QDRANT_URL`
 * is unset — callers fall back to no-op behaviour (no indexing, no search).
 */
export function getQdrantConfig(): QdrantConfig | null {
  const url = process.env.QDRANT_URL;
  if (!url) return null;
  const apiKey = process.env.QDRANT_API_KEY;
  return {
    url: url.replace(/\/+$/, ""),
    ...(apiKey ? { apiKey } : {}),
  };
}

// ─── Process-wide singleton ───────────────────────────────────────────────

let instance: QdrantConfig | null | undefined;

/**
 * Initialize the Qdrant config singleton from env vars.
 * Called once during `createAppserver`.
 */
export function initQdrant(): QdrantConfig | null {
  instance = getQdrantConfig();
  return instance;
}

/**
 * Explicitly set the Qdrant config (tests).
 */
export function setQdrant(config: QdrantConfig | null): void {
  instance = config;
}

/**
 * Get the process-wide Qdrant config, or `null` if not configured.
 * Returns `null` if `initQdrant` hasn't been called yet.
 */
export function getQdrant(): QdrantConfig | null {
  if (instance === undefined) return null;
  return instance;
}
