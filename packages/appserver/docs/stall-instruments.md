# Stall instruments

Two instruments answer "was the process itself blocked, or was the database
slow?" — a question the log cannot settle. `[db-slow]` marks every worker
request over 50 ms; when a host stall lands it does so on every worker at once
and emits one warn line per statement inside the stall, with nothing tying the
lines together. Both instruments below are on `/metrics` (scraped by Alloy),
and the per-worker totals are also readable on `/health/pool`.

## `roomy_event_loop_delay_seconds` (histogram)

Longest main-thread event-loop delay observed in each sampling window, in
seconds. `node:perf_hooks.monitorEventLoopDelay` at 10 ms resolution, read once
a second; each window contributes exactly ONE observation — the window's
`max` — so a 35 s block is one bucket sample, not a burst.

- Buckets: 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60.
- Enabled unless `APPSERVER_EVENT_LOOP_LAG_ENABLED=false`, and off in any
  process created with `disableBackgroundWorkers` (tests) unless the caller
  passes `eventLoopLag: true`.
- The family is registered on first start; a process that never enables the
  sampler publishes no such series, so absence reads as "instrument off"
  rather than "zero lag".
- Database work runs on worker threads and cannot block this loop. A late loop
  during slow statements on several workers therefore points at the host, not
  at SQL — which is the distinction the coincident warn lines could not make.

## `roomy_db_stalls_total` / `roomy_db_stall_seconds_total` (counters)

Per `worker` (the same `space-N` / `global` / `readstate` / `events` labels the
pool exports). A worker already times its own handler and reports `selfMs` for
anything over 50 ms; when that exceeds the stall threshold:

- `roomy_db_stalls_total{worker}` — one increment per stalled statement.
- `roomy_db_stall_seconds_total{worker}` — the time PAST the threshold, in
  seconds. A 5 s statement against a 0.5 s threshold adds 4.5.

The threshold is `APPSERVER_DB_STALL_MS`, default **500 ms**. It is clamped to
50 ms, the point below which the worker reports nothing to compare against.

`GET /health/pool` carries the same totals as a `stalls` array
(`[{ worker, stalls, seconds }]`), so a single stalled interval reads as the
few named workers it held rather than as a wall of log lines.

## Scope

These are magnitude instruments: how long something blocked, and which worker
held the work. They are not a statement-time distribution — a histogram of
individual statements' service time is a separate surface, and the two
counters here answer none of it. Request-level wait and queueing already have
`roomy_db_wait_seconds` and `roomy_db_queue_depth`.
