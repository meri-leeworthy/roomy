/**
 * TanStack Query implementation of {@link CacheAdapter}.
 *
 * This lives under `browser/` because TanStack Query is a browser-
 * oriented dependency — server consumers (e.g. `appserver`) import
 * `@roomy-space/sdk` directly and never reach into `/browser`, so
 * `@tanstack/query-core` stays out of the server's dependency tree.
 *
 * Uses `@tanstack/query-core` rather than a framework-specific
 * package: the Svelte/React/Vue packages all build on the same
 * framework-agnostic `QueryClient`, so the adapter works regardless
 * of which UI framework the consumer chose.
 */

import type { QueryClient } from "@tanstack/query-core";
import type { CacheAdapter, CachePatcher, QueryKey } from "../cache/adapter";

/**
 * Window (ms) over which duplicate invalidations of the same query key
 * collapse into at most one trailing refetch. Chosen to be shorter than a
 * user-perceptible delay while still spanning the burst a single logical
 * change produces (one `sendEvents` fans out into several frames, and the
 * server can emit further frames for the same key milliseconds later).
 */
export const DEFAULT_INVALIDATE_COALESCE_MS = 100;

export interface TanstackCacheAdapterOptions {
  /**
   * Coalescing window in ms. `0` disables coalescing (every invalidation
   * refetches), which is useful in tests that assert one-to-one behaviour.
   */
  invalidateCoalesceMs?: number;
}

/** One pending coalescing window for a single query key. */
interface CoalesceEntry {
  key: QueryKey;
  /**
   * A duplicate arrived during the window after the leading flush started.
   * The leading refetch may have raced ahead of that change, so one trailing
   * flush is owed at the end of the window — this is what keeps coalescing
   * from ever dropping the LAST invalidation for a key.
   */
  dirty: boolean;
}

/**
 * Wrap a TanStack {@link QueryClient} in the SDK's {@link CacheAdapter}
 * contract.
 *
 * Consumers construct the `QueryClient` themselves (so they retain
 * full control over default options, devtools wiring, etc.) and hand
 * it to the SDK only for cache writes from the sync layer.
 *
 * ## Why invalidate() is more than a pass-through
 *
 * The server fans a single logical change out into several invalidation
 * frames, and `invalidateQueries` defaults to `cancelRefetch: true` — which
 * CANCELS an in-flight refetch and starts over. For an expensive query (the
 * activity feed is p50 13–14s in production) a sustained frame stream means
 * the refetch never completes, so the client spins and the UI never settles.
 * Two things fix that here:
 *
 *   1. `cancelRefetch: false` — an invalidation arriving while a refetch is
 *      in flight joins it instead of restarting it.
 *   2. A short coalescing window per key, with a leading flush plus at most
 *      one trailing flush, so a burst of duplicate invalidations costs two
 *      refetches at most rather than one per frame.
 */
export function createTanstackCacheAdapter(
  queryClient: QueryClient,
  opts: TanstackCacheAdapterOptions = {},
): CacheAdapter {
  const coalesceMs = opts.invalidateCoalesceMs ?? DEFAULT_INVALIDATE_COALESCE_MS;
  const pending = new Map<string, CoalesceEntry>();

  /**
   * Refetch every cached variant matching `key`, without cancelling in-flight
   * work: `cancelRefetch` is an `InvalidateOptions` (the SECOND argument to
   * `invalidateQueries`), and TanStack ignores it if it is folded into the
   * filters object — which silently restores the cancel-and-restart default.
   */
  function flush(key: QueryKey): void {
    void queryClient.invalidateQueries(
      { queryKey: key as unknown[] },
      { cancelRefetch: false },
    );
  }

  return {
    invalidate(key: QueryKey): void {
      // Fire-and-forget by contract: `invalidateQueries` resolves when the
      // triggered refetch settles, and errors surface through TanStack's
      // per-query error state.
      if (coalesceMs <= 0) {
        flush(key);
        return;
      }

      const id = stableKeyId(key);
      const entry = pending.get(id);

      if (!entry) {
        // Leading edge: refetch now so a single genuine invalidation is not
        // delayed, then hold the window open for duplicates.
        flush(key);
        const timer = setTimeout(() => closeWindow(id), coalesceMs);
        // A pending window must not keep a Node process alive (tests).
        (timer as { unref?: () => void }).unref?.();
        pending.set(id, { key, dirty: false });
        return;
      }

      // Inside the window: the leading flush may have raced ahead of this
      // change, so record that a trailing flush is owed. No second refetch
      // starts now.
      entry.dirty = true;
      entry.key = key;
    },

    patch<T>(key: QueryKey, patcher: CachePatcher<T>): void {
      // `setQueryData` accepts an updater function whose return value
      // replaces the cached entry. Crucially, the updater is invoked
      // with `undefined` when no entry exists yet — the patcher
      // signature mirrors this so diff streams that race ahead of
      // the initial fetch can choose how to seed the cache.
      //
      // We coerce the QueryKey because TanStack types its key as
      // `readonly unknown[]` in some places and `unknown[]` in
      // others; the runtime accepts either.
      queryClient.setQueryData<T>(
        key as unknown[],
        (prev: T | undefined) => patcher(prev),
      );
    },

    patchAll<T>(key: QueryKey, patcher: CachePatcher<T>): void {
      // `setQueriesData` finds every query whose key prefix-matches
      // (same rule `invalidateQueries` uses — TanStack's
      // `partialMatchKey`) and applies the updater to each, batched so
      // observers notify once. An updater returning undefined leaves
      // that entry untouched (setQueryData semantics), so this never
      // creates or deletes entries — purely a live patch of what's
      // already cached, exactly like `patch` but for every variant.
      queryClient.setQueriesData<T>(
        { queryKey: key as unknown[] },
        (prev: T | undefined) => patcher(prev),
      );
    },
  };

  /** End a coalescing window: refetch once more if the window saw a duplicate. */
  function closeWindow(id: string): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (!entry.dirty) return;
    // Trailing edge. Re-open a fresh window for this refetch so a continuing
    // burst keeps collapsing instead of refetching per frame.
    flush(entry.key);
    const timer = setTimeout(() => closeWindow(id), coalesceMs);
    (timer as { unref?: () => void }).unref?.();
    pending.set(id, { key: entry.key, dirty: false });
  }
}

/**
 * Canonical identity for a query key, so structurally-equal keys coalesce.
 * Key order inside param objects must not change identity, so object keys are
 * sorted recursively (the `queryKey()` helper already sorts the top level, but
 * a caller may construct a key directly).
 */
export function stableKeyId(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableKeyId).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKeyId(record[k])}`).join(",")}}`;
}
