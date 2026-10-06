# Per-space query-planner statistics

Each per-space DB carries its own `sqlite_stat1`. The boot sweep refreshes it
(`reMaterializeFromLocalEvents` → `analyze()` → `PRAGMA optimize`), and the same
pass refreshes the three shared DBs (`analyzeShared()`).

## Why the boot sweep owns it

Without statistics SQLite costs indexes by fixed defaults, and for an equality
lookup it prices the single-column index it happens to walk
(`idx_entities_stream_room`) below the table's rowid index. Past roughly 50k
entities that mis-cost flips the plan for a point lookup:

```
select id from entities where id in (?, ?, …) and stream_id = ?
```

With statistics: `SEARCH entities USING INDEX sqlite_autoindex_entities_1 (id=?)`
Without: `SEARCH entities USING INDEX idx_entities_stream_room (stream_id=?)`

The second form scans the space's entire `stream_id` partition — every entity
in the space — to answer a lookup for a handful of ids. That is the shape
`readPositions` and `userActiveThreads` issue on every room read, and the shape
`resolveReplyToAuthors` issues on every message send.

A space's DB is served by exactly one pool worker, so one such scan delays every
other request queued behind it on that worker: the tail latency of an unrelated
route, on a space that is only sharing a worker index.

Measured on a 131k-entity, 151 MB space DB, through the real pool and worker:

| query | before | after |
|---|---|---|
| `select id from entities where id in (…) and stream_id = ?` | 34.4 ms | 0.2 ms |
| `select count(*) … where id in (…) and stream_id = ?` | 33.4 ms | 0.1 ms |
| `resolveReplyToAuthors` (single reply id) | 64.3 ms | 0.1 ms |
| room activity (`where e.room in (…) group by e.room`) | 38.4 ms | 39.2 ms |

The last row is the control: it was never mis-planned, and its plan is
unchanged, so statistics are not a blanket re-plan.

## Cost

`PRAGMA optimize` re-analyzes only what its heuristics call stale, so a DB whose
statistics are current pays ~0.1 ms. On the 151 MB space DB above the first
analyze (no statistics present) took 36 ms; the shared DBs took 43 ms (global,
295k `entity_space` rows), 55 ms (events, 436k rows) and 3 ms (read-state).

Statistics live in the DB file, so they persist: a space analyzed on one boot
plans correctly on the next one even before the sweep reaches it again. Both
calls are wrapped so a failure is logged and the boot continues — a DB that
fails to analyze keeps serving with the old statistics rather than failing the
sweep.

## Scope

- Per-space: every stream the sweep visits, including streams already caught up.
- Shared: global, read-state and event log, on their own workers.

The `roomActivity` projections and other tables whose plans are already correct
are unaffected — the pass adds statistics, it does not force a plan.
