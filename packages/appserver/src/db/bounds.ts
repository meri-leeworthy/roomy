/**
 * Memory bounds for the DB worker's caches.
 *
 * Every open SQLite connection owns a native page cache plus connection state
 * the page cache does not cover (the parsed schema, and Bun's statement cache
 * for the SQL that connection has served). `PRAGMA cache_size` bounds only the
 * first term, so the connection cache is bounded here on the byte axis: the
 * number of connections a worker may hold is derived from a per-worker byte
 * budget, not fixed by count. Each bound is env-overridable so an operator can
 * trade cache for headroom without a rebuild.
 *
 * Measured (bun 1.3.14, the per-space schema, 800 resident connections,
 * 8 workers, 1200 spaces under sustained read+write load):
 *
 * | `APPSERVER_MAX_SPACE_DBS` | page cache | resident RSS |
 * |---|---|---|
 * | 100 | 512 KiB | 1068 MiB |
 * | 100 | 64 KiB  | 921 MiB  |
 * | 50  | 64 KiB  | 739 MiB  |
 *
 * Fitting those points gives `RSS ≈ 557 MiB + connections × 0.64 MiB`, of
 * which ~184 KiB/connection is page cache at a 512 KiB cap. The remaining
 * ~466 KiB/connection is not addressed by `cache_size` at all, which is why a
 * count-only bound prices the cache at roughly half of what it costs. The
 * 557 MiB is what the process costs before the pool: the main heap, the worker
 * threads' heaps, and the allocator's retained high-water mark.
 */

/**
 * Resident bytes one open per-space connection holds *beyond* its page cache:
 * SQLite's connection state, the parsed per-space schema, and Bun's
 * per-connection statement cache for the SQL that connection has served.
 *
 * Measured, not estimated: halving the resident connections from 800 to 400
 * with a 64 KiB page cache removed 182 MiB (466 KiB per connection, of which
 * at most 64 KiB is page cache). This is that figure with the page cache term
 * taken out.
 */
export const SPACE_DB_CONNECTION_OVERHEAD_KIB = 436;

/**
 * Default per-worker budget for the per-space connection cache, in KiB. The
 * process's ceiling is this times the pool size (8 by default): 384 MiB of
 * connections, against the ~512 MiB the 800-connection default it replaces
 * cost.
 */
export const DEFAULT_SPACE_DB_CACHE_BUDGET_KIB = 48 * 1024;

/**
 * Default live prepared statements per worker before the least-recently-used
 * one is finalized and dropped. Bounds the worker's statement map against a
 * caller that prepares per invocation and never finalizes: an abandoned handle
 * is the first eviction candidate, while one a caller keeps using survives.
 */
export const DEFAULT_MAX_PREPARED_STMTS = 256;

/**
 * Default page cache per connection, in KiB (`PRAGMA cache_size`; negative
 * means KiB). A quarter of SQLite's 2 MiB default: per-space reads resolve on
 * the room/message index pages they touch, and the open-time and boot-sweep
 * `PRAGMA optimize` keeps the planner off the partition scans that would want
 * more cache (see `docs/per-space-stats.md`). Measured on a 131k-entity space
 * DB: the 23-id lookup `readPositions`/`userActiveThreads` issue takes 331 ms
 * per 20k calls at 512 KiB against 353 ms at the default — the bound is free.
 */
export const DEFAULT_SPACE_DB_CACHE_KIB = 512;

/**
 * Default open per-space DBs per worker before LRU eviction: whatever fits in
 * {@link DEFAULT_SPACE_DB_CACHE_BUDGET_KIB} once each connection is priced at
 * its page cache plus {@link SPACE_DB_CONNECTION_OVERHEAD_KIB}.
 */
export const DEFAULT_MAX_SPACE_DBS = spaceDbConnectionCountForBudget(
  DEFAULT_SPACE_DB_CACHE_BUDGET_KIB,
  DEFAULT_SPACE_DB_CACHE_KIB,
);

/** The DB worker's cache bounds, read from the environment. */
export interface DbMemoryBounds {
  /** Open per-space DBs per worker before LRU eviction. */
  maxSpaceDbs: number;
  /** Live prepared statements per worker before LRU finalize. */
  maxPreparedStmts: number;
  /** Page cache per connection, in KiB (`PRAGMA cache_size`, negative = KiB). */
  spaceDbCacheKib: number;
  /** The worker's own heap ceiling in bytes, above which it collects. */
  workerGcHeapBytes: number;
}

/**
 * How many per-space connections fit in `budgetKib` when each is priced at its
 * page cache plus the connection overhead `cache_size` does not cover. Always
 * at least one: a bound of zero would close every connection.
 */
export function spaceDbConnectionCountForBudget(
  budgetKib: number,
  cacheKib: number,
): number {
  const perConnectionKib = cacheKib + SPACE_DB_CONNECTION_OVERHEAD_KIB;
  return Math.max(1, Math.floor(budgetKib / perConnectionKib));
}

/** Parse a `>= 1` integer env var, falling back when unset or malformed. */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * Read the bounds from the environment: `APPSERVER_SPACE_DB_CACHE_BUDGET_KIB`,
 * `APPSERVER_SPACE_DB_CACHE_KIB`, `APPSERVER_MAX_SPACE_DBS` and
 * `APPSERVER_MAX_PREPARED_STMTS`.
 *
 * The connection count follows the byte budget: raising the per-connection page
 * cache lowers the number of connections, so the two knobs cannot be set to a
 * combination that exceeds the budget by accident.
 * `APPSERVER_MAX_SPACE_DBS` remains an explicit override for an operator who
 * wants a count rather than a budget (it is then the operator's job to keep the
 * process under its memory ceiling).
 *
 * Read once on the main thread and passed to each worker through its init
 * message (see `PoolInitOptions`), so the worker's configuration has one
 * source and a pool can be initialised with explicit bounds in tests.
 */
export function dbMemoryBoundsFromEnv(): DbMemoryBounds {
  const spaceDbCacheKib = positiveIntFromEnv(
    "APPSERVER_SPACE_DB_CACHE_KIB",
    DEFAULT_SPACE_DB_CACHE_KIB,
  );
  const budgetKib = positiveIntFromEnv(
    "APPSERVER_SPACE_DB_CACHE_BUDGET_KIB",
    DEFAULT_SPACE_DB_CACHE_BUDGET_KIB,
  );
  return {
    maxSpaceDbs: positiveIntFromEnv(
      "APPSERVER_MAX_SPACE_DBS",
      spaceDbConnectionCountForBudget(budgetKib, spaceDbCacheKib),
    ),
    maxPreparedStmts: positiveIntFromEnv(
      "APPSERVER_MAX_PREPARED_STMTS",
      DEFAULT_MAX_PREPARED_STMTS,
    ),
    spaceDbCacheKib,
    workerGcHeapBytes: workerGcHeapBytesFromEnv(),
  };
}

/**
 * Default ceiling for a DB worker's own JS heap, in MiB. A worker collects its
 * heap once it passes this (`APPSERVER_WORKER_GC_HEAP_MIB` overrides it).
 *
 * Bun's worker threads do not run the collector while they are busy serving
 * requests: with an 800-connection pool under sustained read+write load a
 * worker's heap grew 30 MiB → 265 MiB over 40 minutes and RSS with it
 * (993 MiB → 1534 MiB, tracking the heap one-for-one), while throughput fell
 * to ~550 request-pairs a minute. Forcing the same collection in the same
 * workload held the heap at ~20 MiB, RSS flat at 1048 MiB, and throughput at
 * ~18,000 request-pairs a minute. The memory is garbage — it is collected — so
 * the bound is a ceiling the worker enforces on its own heap, checked on the
 * request path (see `maybeCollect` in `worker.ts`).
 */
export const DEFAULT_WORKER_GC_HEAP_MIB = 32;

/** The worker heap ceiling in bytes, read from the environment. */
export function workerGcHeapBytesFromEnv(): number {
  return (
    positiveIntFromEnv("APPSERVER_WORKER_GC_HEAP_MIB", DEFAULT_WORKER_GC_HEAP_MIB) *
    1024 *
    1024
  );
}
