/**
 * Hourly maintenance tick: drops activity rows and backfill markers that have
 * left the active window.
 *
 * Both deletes are unindexed scans over the whole read-state table, so a tick's
 * cost tracks how much history the read-state DB holds rather than how much
 * changed since the last run. That makes the tick the one periodic job whose
 * duration is unbounded by traffic, and the read-state worker it runs on is
 * shared with every read-state query.
 *
 * Each step is therefore timed and reported on its own: one `step` line per
 * purge (`ms`, `rows`), a closing `tick` line carrying the whole tick's `ms`
 * and row total, and a `roomy_maintenance_seconds{step}` observation. A slow
 * tick then names the delete that held the worker and how long it held it,
 * instead of leaving the stall to be inferred from the queries queued behind
 * it.
 *
 * A step that throws is logged with its name and stops the tick: the deletes
 * are cumulative housekeeping, and a rejected promise inside `setInterval` is
 * otherwise invisible (nothing awaits it, so the tick simply never runs again
 * for another hour).
 */

import { log } from "./log.ts";
import { metrics } from "./metrics.ts";
import {
  ACTIVE_WINDOW_MS,
  purgeStaleThreadActivity,
  purgeStaleThreadBackfill,
} from "./queries/userActiveThreads.ts";
import type { DbLike } from "./db/types.ts";

/** A purge step: delete rows older than `olderThan`, return the row count. */
type PurgeStep = (db: DbLike, olderThan: number) => Promise<number>;

/**
 * The steps, in order. The `step` value is a metric label, so this list is the
 * bound on the label set — never add a per-row or per-space name here.
 */
const STEPS: ReadonlyArray<{ step: string; purge: PurgeStep }> = [
  { step: "purge-thread-activity", purge: purgeStaleThreadActivity },
  { step: "purge-thread-backfill", purge: purgeStaleThreadBackfill },
];

// Buckets straddle the magnitudes that separate the two stories a slow tick
// tells: a purge proportional to the rows it drops lands in the low
// milliseconds, while one that blocks the read-state worker on a large table
// runs to seconds. The 0.5–30s band resolves that second case rather than
// collapsing it into the last bucket.
const MAINTENANCE_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

const stepSeconds = metrics.histogram(
  "roomy_maintenance_seconds",
  "Wall time of one hourly maintenance step, by step.",
  ["step"],
  MAINTENANCE_BUCKETS,
);

export interface MaintenanceTickOptions {
  openReadStateDb: () => DbLike;
  /** Clock for the purge cutoff. */
  now?: () => number;
  /** Monotonic millisecond source for the durations. */
  elapsedMs?: () => number;
}

/**
 * Run one maintenance tick. Never rejects: a failing step is logged with the
 * step that failed, and the tick reports its total either way.
 */
export async function runMaintenanceTick({
  openReadStateDb,
  now = Date.now,
  elapsedMs = () => performance.now(),
}: MaintenanceTickOptions): Promise<void> {
  const cutoff = now() - ACTIVE_WINDOW_MS;
  const tickStart = elapsedMs();
  let rows = 0;

  for (const { step, purge } of STEPS) {
    const stepStart = elapsedMs();
    let purged: number;
    try {
      purged = await purge(openReadStateDb(), cutoff);
    } catch (err) {
      const ms = Math.round(elapsedMs() - stepStart);
      log.error("[maintenance] step failed", { step, ms }, err);
      log.info("[maintenance] tick", { ms: Math.round(elapsedMs() - tickStart), rows });
      return;
    }
    const ms = Math.round(elapsedMs() - stepStart);
    rows += purged;
    stepSeconds.observe({ step }, ms / 1000);
    log.info("[maintenance] step", { step, ms, rows: purged });
  }

  log.info("[maintenance] tick", { ms: Math.round(elapsedMs() - tickStart), rows });
}
