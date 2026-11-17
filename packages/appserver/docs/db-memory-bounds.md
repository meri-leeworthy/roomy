# DB worker memory bounds

The DB workers hold memory the main thread's `process.memoryUsage()` does not
account for. Three terms matter, all of them per open per-space connection or
per worker:

- the connection's SQLite page cache (`PRAGMA cache_size`),
- the connection's **fixed overhead** — SQLite's connection state, the parsed
  per-space schema, and Bun's per-connection statement cache for the SQL that
  connection has served — which `cache_size` does not bound and which is the
  larger of the two, and
- the worker thread's own JS heap, which Bun does not collect while the worker
  is busy.

All three are bounded by `src/db/bounds.ts`, read from the environment once at
pool open and passed to each worker through its init message. `/health/pool`
and `/metrics` report the live values against those bounds.

## The bounds

| Bound | Env var | Default | Term it caps |
|---|---|---|---|
| Connection-cache byte budget, per worker | `APPSERVER_SPACE_DB_CACHE_BUDGET_KIB` | 49152 (48 MiB) | Page cache + fixed overhead of every open per-space connection |
| Open space DBs per worker | `APPSERVER_MAX_SPACE_DBS` | *derived* (51 at the defaults) | Connections held in a worker's LRU cache; overrides the budget when set |
| Page cache per connection | `APPSERVER_SPACE_DB_CACHE_KIB` | 512 | Native page cache of each open connection (KiB) |
| Live prepared statements per worker | `APPSERVER_MAX_PREPARED_STMTS` | 256 | Compiled statements held in the worker's statement map |
| Worker JS heap | `APPSERVER_WORKER_GC_HEAP_MIB` | 32 | The worker's own heap, above which it collects |

Each takes effect when the pool opens, so a change needs a restart. A malformed
or non-positive value falls back to the default rather than producing a zero
bound (which would close every connection, evict every statement, or collect on
every request).

## The connection cache is bounded on the byte axis

The connection count used to be a constant (100 per worker) priced against the
page cache alone. Measured on 2026-11-06 (bun 1.3.14, 8 workers, 1200 spaces,
sustained `getMessages` + `getActivityFeed` + `sendEvents` load, real per-space
schema):

| `maxSpaceDbs` | `cache_size` | resident RSS |
|---|---|---|
| 100 | 512 KiB | 1068 MiB |
| 100 | 64 KiB | 921 MiB |
| 50 | 64 KiB | 739 MiB |
| 0 (11 workers, no space DBs, idle) | — | 115 MiB |

Those points fit `RSS ≈ 557 MiB + connections × 0.64 MiB`: cutting the page
cache from 512 KiB to 64 KiB saved 147 MiB of 1068 (page caches are ~184 KiB
full on average), while halving the connection count saved 182 MiB. The
remaining ~466 KiB per connection is the fixed overhead, which `cache_size`
never addressed: a 100-connection bound priced the cache at 50 MiB per worker
(the page-cache caps) while those connections cost ~64 MiB, and on top of that
the process spends ~557 MiB before the pool opens its first connection.

`spaceDbConnectionCountForBudget` prices a connection at
`cache_size + SPACE_DB_CONNECTION_OVERHEAD_KIB` and derives the count from the
budget, so:

- raising `APPSERVER_SPACE_DB_CACHE_KIB` lowers the number of connections,
- at the defaults the process's connection ceiling is 8 × 48 MiB = 384 MiB, and
- `APPSERVER_MAX_SPACE_DBS` still sets an explicit count, in which case keeping
  the process under its memory ceiling is the operator's arithmetic to do.

Measured at the derived default (51 per worker, 408 connections) under the same
load: RSS settles at 811–860 MiB over 30 minutes, against 1068 MiB at 100 per
worker and 1534 MiB once the worker heaps below were allowed to grow.

## A worker collects its own heap

Bun's worker threads do not run the collector while they are busy serving
requests. With an 800-connection pool under sustained load a worker's heap grew
from 30 MiB to 265 MiB over 40 minutes and RSS tracked it one-for-one (993 MiB
→ 1534 MiB, no plateau), while throughput fell to ~550 request-pairs a minute
and `getMessages` p50 reached 320 ms. Forcing a collection in the same workload
held the heap at ~20 MiB, RSS flat, p50 at 16 ms and throughput at ~18,000
request-pairs a minute — so the memory is garbage, and nothing in the worker was
asking for it to be collected.

`maybeCollectWorkerHeap` checks the worker's own heap once every 64 requests and
runs a full collection past `APPSERVER_WORKER_GC_HEAP_MIB`; the full form holds
the heap at 37–50 MiB where the incremental one let it drift to 103 MiB, at no
cost to read latency (p50 18–23 ms, p95 33–44 ms either way). It is deliberately
not on a timer: the heap only grows while requests are arriving, and a busy
worker's event loop is exactly where a timer would not get a slot.

`/health/pool` reports each worker's `heapUsed`, `heapCeilingBytes` and
`gcCollections`, so a ceiling set too low (constant collection) is as visible as
one that never fires.

## Page cache

SQLite's `DEFAULT_CACHE_SIZE` is 2 MiB (`-2000` KiB) per connection. `openDb`
sets `PRAGMA cache_size = -<APPSERVER_SPACE_DB_CACHE_KIB>` on every per-space
connection, so the ceiling is stated rather than inherited from the SQLite
build.

512 KiB is not a read-path regression: a per-space read resolves on the
room/message index pages it touches, and the open-time and boot-sweep
`PRAGMA optimize` keeps the planner off the partition scans that would want a
larger cache (see `per-space-stats.md`). Measured on a 131k-entity space DB,
the 23-id lookup `readPositions`/`userActiveThreads` issues takes 331 ms per 20k
calls at 512 KiB against 353 ms at the 2 MiB default.

`PRAGMA mmap_size = 0` is also set explicitly. This SQLite build already
defaults memory mapping off (`DEFAULT_MMAP_SIZE=0`), but the bound must not
depend on a compile-time default: a build that mapped the file would add
file-backed pages beyond the `cache_size` ceiling, and those would not show up
in the connection counts `poolStats()` reports.

## Prepared statements

The worker keeps a compiled statement per prepared handle until it is
finalized. `handlePrepare` evicts the least-recently-used handle once the map
reaches `APPSERVER_MAX_PREPARED_STMTS`, and every `prepareRun`/`prepareAll`/
`prepareGet` refreshes its handle's recency. A caller that prepares per
invocation and never finalizes therefore evicts its own abandoned statements,
while a handle a caller keeps executing survives.

One-shot writes should use `run`, which compiles through the worker's SQL cache
(keyed by SQL text) instead of holding a handle by call count. The mark-as-read
path and the hourly thread activity purge both go through `run` for this
reason.

## Observability

`/health/pool` reports, per worker, `pending`, `openSpaceDbs`, `preparedStmts`,
`cacheKib`, `maxSpaceDbs`, `maxPreparedStmts`, and the thread's own
`heapUsed`/`heapTotal`/`external`/`arrayBuffers`/`heapCeilingBytes`/
`gcCollections`. Each `Bun.Worker` has a separate JS heap, so those are
invisible to the main thread's `process.memoryUsage()`: they are what makes RSS
growth attributable to a thread. `/metrics` exports
`roomy_db_open_space_dbs{worker}`, `roomy_db_space_cache_kib`,
`roomy_db_max_space_dbs` and `roomy_db_worker_heap_used_bytes{worker}`. A
worker that does not answer the stats round-trip within 250 ms reports zeros
rather than holding the scrape — the health route stays readable exactly when a
wedged worker makes it matter.

`perf/rss-soak.ts` drives the load these numbers came from: it seeds N spaces,
runs concurrent `getMessages`/`getActivityFeed`/`sendEvents` loops, and writes
one CSV row per sample with RSS, the worker heaps, open connections, the query
cache size and read latency.
