/**
 * Worker leases: one owner per process-wide background loop across the fleet,
 * and the release that hands ownership on at shutdown.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _resetEmbedSweeper, startEmbedSweeper, stopEmbedSweeper, EMBED_SWEEPER_LEASE } from "../embed/sweeper.ts";
import { closeDb, openDb, openGlobalDb, openReadStateDb } from "../db/db.ts";
import {
  _resetSearchIndexer,
  startSearchIndexer,
  stopSearchIndexer,
  SEARCH_INDEXER_LEASE,
} from "../search/indexer.ts";
import {
  startPushDispatcher,
  stopPushDispatcher,
  PUSH_DISPATCHER_LEASE,
} from "../push/dispatcher.ts";
import {
  acquireWorkerLease,
  releaseWorkerLease,
  WorkerLease,
} from "./lease.ts";

const TTL_MS = 60_000;
/** A claimant that never runs a loop, used to probe a lease's state. */
const PROBE = "probe";

/** The holder of `name`'s live claim, read without taking the claim. */
async function liveHolder(name: string): Promise<string | null> {
  const row = await openGlobalDb()
    .query("select holder, expires_at from worker_leases where name = ?")
    .get<{ holder: string; expires_at: number }>(name);
  if (!row || row.expires_at <= Date.now()) return null;
  return row.holder;
}

/**
 * Wait for `name` to be claimed. Each check is a DB round trip, so the event
 * loop turns between them and the loop under test gets to run.
 */
async function waitForClaim(name: string, attempts = 500): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await liveHolder(name)) return;
  }
  throw new Error(`${name} was never claimed`);
}

describe("a worker lease", () => {
  beforeEach(() => {
    closeDb();
    openDb({ path: ":memory:" });
  });

  afterEach(() => {
    closeDb();
  });

  test("two claimants against the same DB: only one runs the loop body", async () => {
    const first = new WorkerLease({ name: "two_claimants", ttlMs: TTL_MS, holder: "first" });
    const second = new WorkerLease({ name: "two_claimants", ttlMs: TTL_MS, holder: "second" });
    const body = mock(async () => "ran");

    await first.start();
    await second.start();
    try {
      expect(first.held).toBe(true);
      expect(second.held).toBe(false);

      expect(await first.runIfHeld(body)).toBe("ran");
      // The loser defers: no body, no error, nothing written.
      expect(await second.runIfHeld(body)).toBeNull();
      expect(body).toHaveBeenCalledTimes(1);
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  test("an expired claim is taken over", async () => {
    const now = Date.now();
    expect(await acquireWorkerLease("expiring", "first", 1000, now)).toBe(true);
    // Still inside the TTL: the incumbent keeps it.
    expect(await acquireWorkerLease("expiring", "second", 1000, now + 500)).toBe(false);
    // Past it: the claim is free.
    expect(await acquireWorkerLease("expiring", "second", 1000, now + 1001)).toBe(true);
  });

  test("releasing hands the claim to the next claimant", async () => {
    const first = new WorkerLease({ name: "handover", ttlMs: TTL_MS, holder: "first" });
    await first.start();
    try {
      expect(await acquireWorkerLease("handover", "second", TTL_MS)).toBe(false);
    } finally {
      await first.stop();
    }
    expect(await acquireWorkerLease("handover", "second", TTL_MS)).toBe(true);
    await releaseWorkerLease("handover", "second");
  });

  test("a non-holder cannot release the holder's claim", async () => {
    await acquireWorkerLease("owned", "first", TTL_MS);
    await releaseWorkerLease("owned", "second");
    expect(await liveHolder("owned")).toBe("first");
    await releaseWorkerLease("owned", "first");
  });
});

describe("the background loops' leases", () => {
  beforeEach(() => {
    closeDb();
    _resetEmbedSweeper();
    _resetSearchIndexer();
    openDb({ path: ":memory:" });
  });

  afterEach(async () => {
    await stopEmbedSweeper();
    await stopSearchIndexer();
    await stopPushDispatcher();
    closeDb();
  });

  // Each of these starts a real loop against a real worker pool, so they get
  // room for the pool's init on a loaded machine; the assertions still fail if
  // a loop parks instead of noticing the stop.
  test("the embed sweeper claims its own lease and releases it on stop", async () => {
    startEmbedSweeper({ globalDb: openGlobalDb() });
    await waitForClaim(EMBED_SWEEPER_LEASE);
    expect(await acquireWorkerLease(EMBED_SWEEPER_LEASE, PROBE, TTL_MS)).toBe(false);

    await stopEmbedSweeper();
    expect(await acquireWorkerLease(EMBED_SWEEPER_LEASE, PROBE, TTL_MS)).toBe(true);
    await releaseWorkerLease(EMBED_SWEEPER_LEASE, PROBE);
  }, { timeout: 20_000 });

  test("the search indexer claims its own lease and releases it on stop", async () => {
    startSearchIndexer();
    await waitForClaim(SEARCH_INDEXER_LEASE);
    expect(await acquireWorkerLease(SEARCH_INDEXER_LEASE, PROBE, TTL_MS)).toBe(false);

    await stopSearchIndexer();
    expect(await acquireWorkerLease(SEARCH_INDEXER_LEASE, PROBE, TTL_MS)).toBe(true);
    await releaseWorkerLease(SEARCH_INDEXER_LEASE, PROBE);
  }, { timeout: 20_000 });

  test("the push dispatcher claims its own lease and releases it on stop", async () => {
    startPushDispatcher({ db: openReadStateDb() });
    await waitForClaim(PUSH_DISPATCHER_LEASE);
    expect(await acquireWorkerLease(PUSH_DISPATCHER_LEASE, PROBE, TTL_MS)).toBe(false);

    await stopPushDispatcher();
    expect(await acquireWorkerLease(PUSH_DISPATCHER_LEASE, PROBE, TTL_MS)).toBe(true);
    await releaseWorkerLease(PUSH_DISPATCHER_LEASE, PROBE);
  }, { timeout: 20_000 });
});
