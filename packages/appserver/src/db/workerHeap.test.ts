import { afterEach, describe, expect, test } from "bun:test";
import { closeDb, openDb, poolStats } from "./db.ts";
import { DEFAULT_WORKER_GC_HEAP_MIB, workerGcHeapBytesFromEnv } from "./bounds.ts";

/**
 * A worker collects its own heap once it passes its ceiling. Bun's worker
 * threads do not run the collector while they are busy, so without the ceiling
 * the heap grows with the garbage each request allocates and never comes back
 * down: measured on a live appserver, 30 MiB → 265 MiB over 40 minutes with RSS
 * tracking it one-for-one.
 *
 * The test asserts the mechanism — a worker that is over its ceiling collects
 * and reports the collection — because whether the collector would also have
 * run on its own is not something a test can pin down.
 */
const ROWS = 4000;
const QUERIES = 220;

const ENV_KEY = "APPSERVER_WORKER_GC_HEAP_MIB";
const saved = process.env[ENV_KEY];

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
  closeDb();
});

describe("a DB worker bounds its own JS heap", () => {
  test("the heap stays under the collection ceiling under allocating load", async () => {
    // The lowest ceiling the knob accepts, so the check fires on a worker
    // whose heap is a few MiB rather than one the runtime has already grown.
    process.env[ENV_KEY] = "1";
    closeDb();
    const db = openDb({ path: ":memory:" });
    const space = db.forSpace("did:plc:heap-bound");

    for (let start = 0; start < ROWS; start += 100) {
      await space.transaction(
        Array.from({ length: 100 }, (_, i) => ({
          type: "run" as const,
          sql: "insert or ignore into entities (id, stream_id) values (?, ?)",
          params: [`e${start + i}`, "did:plc:heap-bound"],
        })),
      );
    }

    let lastRowCount = 0;
    for (let i = 0; i < QUERIES; i++) {
      const rows = await space.query("select * from entities").all();
      lastRowCount = rows.length;
    }
    expect(lastRowCount).toBeGreaterThanOrEqual(ROWS);

    const stats = (await poolStats())!;
    // The worker ran the check (one per 64 requests) and collected when its
    // heap was over the ceiling. Without the check, `gcCollections` stays 0 —
    // nothing else in the worker asks for a collection.
    const collections = stats.spaceWorkers.reduce((sum, w) => sum + w.gcCollections, 0);
    expect(collections).toBeGreaterThanOrEqual(1);
    expect(stats.spaceWorkers[0]!.heapCeilingBytes).toBe(workerGcHeapBytesFromEnv());

    const heapUsed = stats.spaceWorkers.reduce((sum, w) => sum + w.heapUsed, 0);
    expect(heapUsed).toBeLessThan(64 * 1024 * 1024);
    expect(DEFAULT_WORKER_GC_HEAP_MIB).toBeGreaterThan(1);
  }, 60_000);
});
