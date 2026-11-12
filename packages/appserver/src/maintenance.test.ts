/**
 * Maintenance tick tests.
 *
 * The tick is the one periodic job whose duration is set by how much history
 * the read-state DB holds, so what has to hold is that a tick *reports* — one
 * timed record per step, a total, and a `roomy_maintenance_seconds` sample —
 * and that a failure names its step instead of leaving an unobserved rejected
 * promise behind. The read-state DB is a stub and the clock is a fixed
 * sequence: these tests are about the tick's bookkeeping, not about the
 * deletes it drives or about how long anything really took.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { runMaintenanceTick } from "./maintenance.ts";
import { ACTIVE_WINDOW_MS } from "./queries/userActiveThreads.ts";
import { metrics } from "./metrics.ts";
import { _setLokiSink } from "./log.ts";
import type { DbLike } from "./db/types.ts";

interface StubOptions {
  /** Row count answered per table name. */
  changes?: Record<string, number>;
  /** Table whose delete rejects. */
  failOn?: string;
}

/**
 * Records every `run` and answers with the configured row count. Only `run`
 * is on the tick's path, so the rest of `DbLike` stays absent — the cast is
 * the stub's boundary, not a claim about the real handle.
 */
function stubReadStateDb({ changes = {}, failOn }: StubOptions = {}) {
  const deletes: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    run: async (sql: string, ...params: unknown[]) => {
      deletes.push({ sql, params });
      const table = /from\s+(\w+)/.exec(sql)?.[1] ?? "";
      if (table === failOn) throw new Error(`delete from ${table} failed`);
      return { changes: changes[table] ?? 0 };
    },
  } as unknown as DbLike;
  return { db, deletes };
}

/** A monotonic millisecond source that hands out the given readings in order. */
function clock(...readings: number[]): () => number {
  let i = 0;
  return () => readings[Math.min(i++, readings.length - 1)]!;
}

/** Capture the records the tick emits through the logger's own Loki sink. */
function captureLogs() {
  const lines: string[] = [];
  _setLokiSink({
    push: (r) => lines.push(r.line),
    flush: async () => {},
    stop: () => {},
    stats: () => ({ queued: 0, sent: 0, dropped: 0, failed: 0 }),
  });
  return {
    records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
    restore: () => _setLokiSink(null),
  };
}

/** The observed sample count for one step label, read from the exposition. */
function maintenanceSamples(step: string): number {
  const match = new RegExp(
    `^roomy_maintenance_seconds_count\\{step="${step}"\\} (\\d+)$`,
    "m",
  ).exec(metrics.render());
  return match ? Number(match[1]) : 0;
}

afterEach(() => {
  _setLokiSink(null);
});

describe("maintenance tick", () => {
  test("reports each purge step with its duration and row count", async () => {
    const { db, deletes } = stubReadStateDb({
      changes: { user_thread_activity: 7, user_thread_backfill: 3 },
    });
    const logs = captureLogs();
    const before = {
      activity: maintenanceSamples("purge-thread-activity"),
      backfill: maintenanceSamples("purge-thread-backfill"),
    };
    const now = 1_700_000_000_000;

    await runMaintenanceTick({
      openReadStateDb: () => db,
      now: () => now,
      // tick start, step 1 start/end, step 2 start/end, tick end.
      elapsedMs: clock(0, 0, 500, 500, 2_500, 3_000),
    });

    const records = logs.records();
    const steps = records.filter((r) => r.msg === "step");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      scope: "maintenance",
      step: "purge-thread-activity",
      ms: 500,
      rows: 7,
    });
    expect(steps[1]).toMatchObject({
      scope: "maintenance",
      step: "purge-thread-backfill",
      ms: 2_000,
      rows: 3,
    });

    const totals = records.filter((r) => r.msg === "tick");
    expect(totals).toHaveLength(1);
    expect(totals[0]).toMatchObject({ ms: 3_000, rows: 10 });

    // Both deletes run against the read-state DB with the same window cutoff.
    expect(deletes.map((d) => d.params[0])).toEqual([
      now - ACTIVE_WINDOW_MS,
      now - ACTIVE_WINDOW_MS,
    ]);

    expect(maintenanceSamples("purge-thread-activity")).toBe(before.activity + 1);
    expect(maintenanceSamples("purge-thread-backfill")).toBe(before.backfill + 1);

    logs.restore();
  });

  test("a failing step is logged with its name and does not reject", async () => {
    const { db, deletes } = stubReadStateDb({ failOn: "user_thread_activity" });
    const logs = captureLogs();

    // No rejection: a throw here would land in the interval callback's
    // unobserved promise.
    await runMaintenanceTick({
      openReadStateDb: () => db,
      elapsedMs: clock(0, 0, 300, 900),
    });

    const records = logs.records();
    const failures = records.filter((r) => r.msg === "step failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      scope: "maintenance",
      step: "purge-thread-activity",
      ms: 300,
      error: { message: "delete from user_thread_activity failed" },
    });
    expect(records.filter((r) => r.msg === "step")).toHaveLength(0);
    const totals = records.filter((r) => r.msg === "tick");
    expect(totals).toHaveLength(1);
    expect(totals[0]).toMatchObject({ ms: 900, rows: 0 });
    // The tick stops at the failed step rather than purging past it.
    expect(deletes).toHaveLength(1);

    logs.restore();
  });
});
