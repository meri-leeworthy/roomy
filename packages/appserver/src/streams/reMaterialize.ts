/**
 * Re-materialize streams from the local events DB, skipping streams that are
 * already fully materialized.
 *
 * Uses the `materialization_cursor` table to determine which streams need
 * replay: for each stream in the log, compares the cursor's `materialized_to`
 * against that stream's latest event idx. Streams that are already caught up
 * are skipped; the rest are replayed from `cursor + 1`.
 *
 * After a schema-version wipe the cursor table is empty (all cursors default
 * to -1), so every stream is fully replayed. After a clean restart the
 * cursors are current and nothing is replayed. After a crash mid-sendEvents
 * only the un-materialized gap is replayed.
 *
 * The pass runs while the process serves reads, so its cost is the boot window
 * every restart pays. Two rules follow from that and shape the code below:
 *
 *   - One round trip per stream, and one read per shared DB. A caught-up boot
 *     asks each space DB four questions at once (`bootProbe`) and takes the
 *     stream inventory from the log's own rollup (`stream_state`) rather than
 *     scanning the event log.
 *   - The work that repairs the global DBs (the `entity_space` index, the
 *     `space_stats` aggregate) is issued only for a stream that owes it. Both
 *     are maintained on the write path, so on a caught-up boot nothing does.
 */

import { decode } from "@atcute/cbor";
import {
  type Event,
  type StreamDid,
  type StreamIndex,
  type UserDid,
} from "@roomy-space/sdk";
import type { DbLike, SpaceBootProbe } from "../db/types.ts";
import { applyBatch } from "../materialization/applyBatch.ts";
import { log } from "../log.ts";
import { runPendingGlobalMigrations } from "../db/globalMigrations.ts";
import { refreshSpaceStats } from "../queries/spaceStats.ts";
import { upgradeSpaceInPlace, carrySpaceHandleToGlobal, carryLinkEmbedsToGlobal } from "../db/spaceMigrations.ts";
import { sweepReadStateWatermarks } from "../db/readStateWatermarks.ts";
import { isTransientDbError } from "../db/transient.ts";
import type { LoggedEvent } from "../materialization/types.ts";

interface RawEvent {
  idx: number;
  user: string;
  payload: Uint8Array;
  received_at: number | null;
  created_at: number | null;
}

/** Default number of streams re-materialized concurrently (matches the pool default). */
export const DEFAULT_REMATERIALIZE_CONCURRENCY = 4;

/**
 * How many times a per-stream boot step is re-issued after a DB request times
 * out, and how long to wait before each re-issue. The worker bound is
 * `REQUEST_TIMEOUT_MS` (30s) per request, so the schedule gives a step up to
 * four of those budgets before it is treated as failed.
 */
const STREAM_STEP_ATTEMPTS = 4;
const STREAM_STEP_BACKOFF_MS = 5_000;

/**
 * Streams per `globalIndexProbe` request. Each one is two index lookups in the
 * global DB, so a chunk is a few milliseconds of one worker's time — small
 * enough that a live request waiting behind it is not delayed, large enough
 * that the pass does not pay a round trip per stream.
 */
const GLOBAL_PROBE_CHUNK = 256;

export interface ReMaterializeOpts {
  /**
   * Retry schedule for a per-stream boot step whose DB request timed out
   * (see `withStreamStepRetry`). Shortening it is for tests only: production
   * needs the budget to outlast a genuinely slow query.
   */
  streamStep?: { attempts?: number; backoffMs?: number };
  /**
   * Called as the pass advances, so a caller can report whether the process is
   * serving current data yet (see `readiness.ts`). Cheap and synchronous; it is
   * invoked from the pass's own loop, never concurrently with itself.
   */
  onProgress?: (progress: ReMaterializeProgress) => void;
}

/** One report from the running sweep, for `/health` and the boot log. */
export interface ReMaterializeProgress {
  phase: "sweeping" | "replaying" | "finishing" | "done";
  /** Streams found in the event log this pass. */
  streamsTotal?: number;
  /** How many of them have had their per-space state read. */
  streamsScanned?: number;
  /** Streams found needing replay, and how far that replay has got. */
  replayTotal?: number;
  replayDone?: number;
  replayFailed?: number;
}

/** `bootProbe` for a `DbLike` that is not the pooled router. */
async function probeSpaceSteps(
  db: DbLike,
  streamId: string,
  opts: ReMaterializeOpts,
): Promise<SpaceBootProbe> {
  // Upgrade decision point: is the canonical per-space DB on the current
  // schema? When `checkSpaceSchema` is absent (sync adapters in tests that
  // don't exercise the upgrade), default to current so behavior is unchanged.
  const { current } = await withStreamStepRetry(
    streamId,
    "schema check",
    async () => (await db.checkSpaceSchema?.(streamId)) ?? { current: true },
    opts.streamStep,
  );
  if (!current) {
    return { current, pendingMigrations: true, materializedTo: -1, hasEntities: false };
  }

  // A current DB may still owe a data task from a pass that was interrupted
  // after the version row advanced (the two are committed separately: the
  // version bumps at open, the task runs later in the boot runner).
  const pendingMigrations = await withStreamStepRetry(
    streamId,
    "migration-marker check",
    () => hasPendingSpaceMigrations(db, streamId),
    opts.streamStep,
  );

  const spaceDb = db.forSpace!(streamId as StreamDid);
  // The materialization_cursor lives in the per-space DB (each space DB is
  // self-describing about its own re-materialization state), not the
  // event-log DB. A stream without a cursor row (a schema-version wipe, a
  // first boot) defaults to -1: nothing materialized, replay everything.
  const cursorRow = await withStreamStepRetry(
    streamId,
    "cursor read",
    () =>
      spaceDb
        .query(
          "SELECT materialized_to FROM materialization_cursor WHERE stream_id = ?",
        )
        .get<{ materialized_to: number }>(streamId),
    opts.streamStep,
  );
  const entity = await spaceDb
    .query(
      "select 1 as x from entities where stream_id is not null and stream_id != '' limit 1",
    )
    .get<{ x: number }>();

  return {
    current,
    pendingMigrations,
    materializedTo: cursorRow?.materialized_to ?? -1,
    hasEntities: entity !== null,
  };
}

/**
 * Read every stream's boot facts, one round trip per stream, `cap` streams at
 * a time.
 *
 * The bound is the pool size: each stream's request lands on the worker that
 * owns its space, so `cap` streams in flight can never queue more than one
 * request per worker, and the phase takes a fraction of the wall clock a
 * serial walk of the same requests does. A stream that cannot be read is
 * logged and left for a later boot — its cursor and its migration marker are
 * both unchanged, so nothing is half-applied.
 */
async function probeSpaces(
  db: DbLike,
  streamIds: readonly string[],
  cap: number,
  opts: ReMaterializeOpts,
  onScanned: (scanned: number) => void,
): Promise<Array<SpaceBootProbe | null>> {
  const probes: Array<SpaceBootProbe | null> = new Array(streamIds.length).fill(null);
  let scanned = 0;
  for (let start = 0; start < streamIds.length; start += cap) {
    const end = Math.min(start + cap, streamIds.length);
    await Promise.all(
      streamIds.slice(start, end).map(async (streamId, offset) => {
        try {
          probes[start + offset] = db.bootProbe
            ? await withStreamStepRetry(
                streamId,
                "stream probe",
                () => db.bootProbe!(streamId),
                opts.streamStep,
              )
            : await probeSpaceSteps(db, streamId, opts);
        } catch (err) {
          // One stream this pass cannot read must not take the pass with it:
          // the per-space upgrades below are what re-key the log, and a stream
          // that keeps timing out would otherwise mean no space is ever
          // upgraded.
          log.error(
            "startup",
            `re-materialize scan failed for ${streamId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
    scanned = end;
    onScanned(scanned);
  }
  return probes;
}

/**
 * Which streams the global DBs already account for: whether `entity_space` has
 * a row for the space, and whether `space_stats` has its aggregate.
 *
 * Both are written on the materialisation path (`applyBatch` inserts the index
 * rows for every entity it applies and refreshes the aggregate for a chunk of
 * membership events), so "no row" is the only state worth a repair, and one
 * batched request answers it for a whole chunk of streams instead of two
 * round trips each. Empty means "could not tell" — a stream missing from the
 * map is not repaired, because a probe that failed says the global DB is
 * unhealthy and issuing thousands of repairs against it makes that worse.
 */
async function readGlobalIndexStatus(
  db: DbLike,
  streamIds: readonly string[],
  opts: ReMaterializeOpts,
): Promise<Map<string, { indexed: boolean; hasStats: boolean }>> {
  const status = new Map<string, { indexed: boolean; hasStats: boolean }>();
  if (!db.globalIndexProbe) return status;
  for (let start = 0; start < streamIds.length; start += GLOBAL_PROBE_CHUNK) {
    const chunk = streamIds.slice(start, start + GLOBAL_PROBE_CHUNK);
    try {
      const rows = await withStreamStepRetry(
        "<global index>",
        "global index probe",
        () => db.globalIndexProbe!(chunk),
        opts.streamStep,
      );
      for (const row of rows) {
        status.set(row.spaceDid, { indexed: row.indexed, hasStats: row.hasStats });
      }
    } catch (err) {
      log.warn(
        "startup",
        `entity_space/space_stats probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return status;
}

/**
 * Every stream in the event log with its latest event idx.
 *
 * `stream_state` is the log's own rollup: one row per stream, upserted in the
 * same transaction as the insert that extends it, so it answers the whole
 * inventory from a few thousand rows. Scanning the log instead (`SELECT
 * DISTINCT stream_id FROM stream_events`) walks the primary-key index of every
 * event ever received — 20s on the production log — on the same worker that
 * records incoming events. A log written before the rollup existed has no
 * rows; then, and only then, the log itself is read.
 */
async function readStreamInventory(
  db: DbLike,
  opts: ReMaterializeOpts,
): Promise<Array<{ streamId: string; latest: number }>> {
  const rollup = await withStreamStepRetry(
    "<stream sweep>",
    "stream sweep",
    () =>
      db
        .query("SELECT stream_id, latest_event FROM stream_state")
        .all<{ stream_id: string; latest_event: number }>(),
    opts.streamStep,
  );
  if (rollup.length > 0) {
    return rollup.map(({ stream_id, latest_event }) => ({
      streamId: stream_id,
      latest: latest_event,
    }));
  }
  const rows = await withStreamStepRetry(
    "<stream sweep>",
    "stream sweep",
    () =>
      db
        .query(
          "SELECT stream_id, coalesce(max(idx), -1) AS latest FROM stream_events GROUP BY stream_id",
        )
        .all<{ stream_id: string; latest: number }>(),
    opts.streamStep,
  );
  return rows.map(({ stream_id, latest }) => ({ streamId: stream_id, latest }));
}

/**
 * Run one per-stream boot step, re-issuing it after a timed-out DB request.
 *
 * The boot pass is a long serial sweep over thousands of streams. A DB request
 * that exceeds its 30s budget rejects, and the sweep's single-threaded
 * partitioning holds thousands of requests in flight — so one slow query, not a
 * broken database, would otherwise abandon the whole pass: the per-space
 * upgrades it had not reached yet never run, and the log they would have
 * re-keyed stays unre-keyed. Retrying the step is what lets the sweep finish
 * while the database is merely slow.
 *
 * A step must therefore be safe to run twice. Everything wrapped here is:
 * partitioning reads `materialization_cursor` and `stream_events` without
 * writing, and `upgradeSpaceInPlace` is guarded by the per-space marker it
 * stamps only on success. Any other error is the step's own failure and is
 * reported to the caller immediately.
 */
async function withStreamStepRetry<T>(
  streamDid: string,
  step: string,
  run: () => Promise<T>,
  opts: ReMaterializeOpts["streamStep"] = {},
): Promise<T> {
  const attempts = opts.attempts ?? STREAM_STEP_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? STREAM_STEP_BACKOFF_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= attempts || !isTransientDbError(err)) throw err;
      log.warn(
        "startup",
        `${step} timed out for ${streamDid} (attempt ${attempt}/${attempts}); retrying in ${backoffMs}ms`,
      );
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, backoffMs);
      await promise;
    }
  }
}

/**
 * Re-materialize streams that have un-materialized events in the local events DB.
 *
 * Streams are processed with bounded concurrency (up to `concurrency` at
 * once) so different spaces' replay lands on different pool workers in
 * parallel. The cap keeps memory bounded — we never load every stream's
 * event batch into memory at once. Within a stream, the un-materialized
 * events are batched — read in one query and materialized in one
 * `applyBatch` call, which is the fastest path for a replay. Streams whose
 * cursor is already at the latest event idx are skipped entirely (no event
 * reads, no materialization).
 *
 * Logs progress at info level. Errors for individual streams are logged but
 * do not abort the overall process — a failed stream will be re-materialized
 * on demand when first accessed.
 */

/**
 * Whether `streamDid`'s space DB owes an in-place data migration.
 *
 * The space DB's own `space_schema_migrations` rows carry the null markers; a
 * sync adapter (`:memory:` tests) has no space handle, so it reports nothing
 * pending. A missing table means the DB has never been opened by this build,
 * which the caller's upgrade pass will handle.
 *
 * A failure to answer the question propagates: a stream that owes a migration
 * and is not upgraded stays on keys no entity carries, so reporting "nothing
 * pending" would serve the regression this pass exists to repair.
 */
async function hasPendingSpaceMigrations(
  db: DbLike,
  streamDid: string,
): Promise<boolean> {
  if (!db.forSpace) return false;
  const row = await db
    .forSpace(streamDid as StreamDid)
    .query(
      "select count(*) as n from space_schema_migrations where completed_at is null",
    )
    .get<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

export async function reMaterializeFromLocalEvents(
  db: DbLike,
  concurrency: number = DEFAULT_REMATERIALIZE_CONCURRENCY,
  opts: ReMaterializeOpts = {},
): Promise<void> {
  // The sweep's own first read. It is the request most likely to be slow — it
  // runs while the rest of boot is still warming the pool — and it is what the
  // pass died on in production, leaving every per-space upgrade untouched. It
  // is a read, so it is safe to issue again.
  const inventory = await readStreamInventory(db, opts);
  const report = (progress: ReMaterializeProgress): void => {
    try {
      opts.onProgress?.(progress);
    } catch {
      // A progress sink that throws must not abandon a pass that is already
      // re-materializing spaces.
    }
  };

  const streamDids = inventory.map(({ streamId }) => streamId as StreamDid);
  const finishStartupMigrations = async (): Promise<void> => {
    try {
      await runPendingGlobalMigrations(db, streamDids);
    } catch (err) {
      // A failed post-migration remains pending and retries next boot. It must
      // not prevent normal per-space catch-up from completing.
      log.error(
        "startup",
        `global post-migration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Re-anchor read-state watermarks that name no ordering key. It runs here,
    // after every per-space upgrade and replay, because both of them rewrite
    // keys: the v3 task re-keys `entities` in place and a rebuild derives a
    // fresh set, so a watermark resolved before them would be resolved against
    // keys that no longer exist. Idempotent — a space whose watermarks all name
    // a key costs one scan of the read-state table and no writes.
    try {
      await sweepReadStateWatermarks(db, streamDids);
    } catch (err) {
      // Best-effort, like the global post-migrations: an unreadable read-state
      // DB must not abandon the pass that has already re-materialized the
      // spaces it reached.
      log.error(
        "startup",
        `read-state watermark sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Remove per-space DB files left behind by reads of ids that are not
    // spaces. It runs here, after the per-stream `entity_space` backfill, so a
    // real space's DB is indexed by the time the sweep asks whether its file
    // belongs to one.
    try {
      const swept = await db.sweepEmptySpaceDbs?.();
      if (swept && swept.deleted > 0) {
        log.info("startup", "empty space DB files swept", swept);
      }
    } catch (err) {
      log.warn(
        "startup",
        `empty space-DB sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  if (inventory.length === 0) {
    await finishStartupMigrations();
    report({ phase: "done", streamsTotal: 0, streamsScanned: 0, replayTotal: 0 });
    log.info("startup", "no streams to re-materialize from local events DB");
    return;
  }

  report({
    phase: "sweeping",
    streamsTotal: inventory.length,
    streamsScanned: 0,
  });

  // Partition streams into in-place upgrades, blue-green rebuilds, and
  // incremental catch-ups.
  //
  // A stream whose canonical per-space DB is on a STALE schema is upgraded in
  // place: the data migrations run against the existing DB, which keeps serving
  // reads throughout and is far cheaper than replaying the whole log. Only when
  // the upgrade cannot be applied (a version this build cannot start from) or
  // fails does the stream fall back to the blue-green rebuild — a full replay
  // into a temp `.sqlite.new` DB, atomically swapped over the canonical file.
  // Reads keep serving the old DB until the swap, so a schema bump never makes
  // a space appear empty. On any failure the temp DB is aborted and the old DB
  // keeps serving.
  //
  // A stream whose canonical DB is on the CURRENT schema uses the existing
  // incremental catch-up path unchanged (skip if caught up, else replay the
  // un-materialized gap from cursor + 1).
  //
  // Each stream's facts arrive in one `bootProbe` round trip, `cap` streams at
  // a time (see `probeSpaces`). The probe reads are read-only, so the pass does
  // not open a writable handle per space to learn them; a space's query-planner
  // statistics are refreshed when a worker opens it (`openSpaceDb`), which is
  // where the sweep's own per-stream `PRAGMA optimize` used to land too.
  let skipped = 0;
  const upgrades: string[] = [];
  const toReplay: Array<{
    streamId: string;
    fromIdx: number;
    /** Rebuild the whole stream into a temp new-schema DB and swap it in. */
    rebuild: boolean;
  }> = [];

  const cap = Math.max(1, Math.min(Math.floor(concurrency), inventory.length));
  const probes = await probeSpaces(db, streamDids, cap, opts, (scanned) =>
    report({ phase: "sweeping", streamsScanned: scanned }),
  );

  // Which streams the global DBs already account for, asked in one request per
  // chunk instead of two per stream.
  const globalStatus = await readGlobalIndexStatus(db, streamDids, opts);

  for (let i = 0; i < inventory.length; i++) {
    const { streamId, latest } = inventory[i]!;
    const probe = probes[i];
    // An unreadable stream was logged by the probe; its cursor and migration
    // marker are unchanged, so a later boot picks it up unchanged.
    if (!probe) continue;

    // A stale DB needs the full upgrade; the upgrade pass below runs it and
    // falls back to a rebuild for this stream if it cannot.
    if (probe.pendingMigrations) {
      upgrades.push(streamId);
      continue;
    }

    // Repair the global DBs only for a stream they do not account for yet.
    // `applyBatch` writes both on the materialisation path — a row in
    // `entity_space` per applied entity, and a `space_stats` row for a chunk
    // carrying membership events — so an absent row is the only state worth a
    // repair: a space materialised before the index existed, or one this build
    // has never swept. A `DbLike` without the batched probe has no global DB to
    // consult, and the calls below are no-ops there.
    const status = globalStatus.get(streamId);
    if (status ? !status.indexed && probe.hasEntities : !db.globalIndexProbe) {
      try {
        await db.backfillEntitySpace?.(streamId);
      } catch (err) {
        log.warn(
          "startup",
          `entity_space backfill failed for ${streamId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (status ? !status.hasStats : !db.globalIndexProbe) {
      try {
        await refreshSpaceStats(db, streamId as StreamDid);
      } catch (err) {
        log.warn(
          "startup",
          `space_stats refresh failed for ${streamId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (probe.materializedTo >= latest) {
      skipped++;
      continue;
    }

    toReplay.push({
      streamId,
      fromIdx: probe.materializedTo + 1,
      rebuild: false,
    });
  }


  // Upgrade stale-schema spaces in place. A stream the migration declines or
  // fails on is queued for a rebuild instead.
  for (const streamId of upgrades) {
    try {
      await withStreamStepRetry(
        streamId,
        "in-place upgrade",
        () => upgradeSpaceInPlace(db, streamId as StreamDid),
        opts.streamStep,
      );
      // The upgrade replayed no events, so the cursor is unchanged; the space
      // is now current-schema and any un-materialized gap is caught up by the
      // incremental pass below.
      const cursorRow = await db.forSpace!(streamId as StreamDid)
        .query(
          "SELECT materialized_to FROM materialization_cursor WHERE stream_id = ?",
        )
        .get<{ materialized_to: number }>(streamId);
      const materializedTo = cursorRow?.materialized_to ?? -1;
      const latestRow = await db
        .query(
          "SELECT coalesce(max(idx), -1) AS latest FROM stream_events WHERE stream_id = ?",
        )
        .get<{ latest: number }>(streamId);
      const latest = latestRow?.latest ?? -1;

      try {
        await db.backfillEntitySpace?.(streamId);
      } catch (err) {
        log.warn(
          "startup",
          `entity_space backfill failed for ${streamId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        await refreshSpaceStats(db, streamId as StreamDid);
      } catch (err) {
        log.warn(
          "startup",
          `space_stats refresh failed for ${streamId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      log.info("startup", `upgraded ${streamId} in place`);
      if (materializedTo >= latest) {
        skipped++;
      } else {
        toReplay.push({
          streamId,
          fromIdx: materializedTo + 1,
          rebuild: false,
        });
      }
    } catch (err) {
      // The in-place upgrade could not run (or failed). Re-derive the space
      // from the log instead: replay the entire stream (idx from 0) into the
      // temp rebuild DB, then commit the swap. `applyBatch` writes entity_space
      // + materialization_cursor into the new DB, so no backfill of the old DB
      // is needed.
      log.warn(
        "startup",
        `in-place migration for ${streamId} fell back to a rebuild: ${err instanceof Error ? err.message : String(err)}`,
      );
      toReplay.push({ streamId, fromIdx: 0, rebuild: true });
    }
  }

  if (toReplay.length === 0) {
    await finishStartupMigrations();
    report({ phase: "done", streamsTotal: inventory.length, streamsScanned: inventory.length, replayTotal: 0 });
    log.info(
      "startup",
      `re-materialization: all ${skipped} streams already up to date, nothing to replay`,
    );
    return;
  }

  log.info(
    "startup",
    `re-materializing ${toReplay.length} streams from local events DB (${skipped} already up to date)`,
  );

  let succeeded = 0;
  let failed = 0;
  const total = toReplay.length;
  const replayCap = Math.max(1, Math.min(cap, total));
  report({
    phase: "replaying",
    streamsTotal: inventory.length,
    streamsScanned: inventory.length,
    replayTotal: total,
    replayDone: 0,
    replayFailed: 0,
  });

  // Bounded-concurrency worker pool: up to `replayCap` streams are replayed at
  // once, each pulling the next pending stream as it finishes. Different
  // streams hash to different pool workers, so their applyBatch
  // runs in parallel. The cap keeps memory bounded (never all streams in
  // flight at once) while still using the pool.
  const nextIndex = { i: 0 };

  const replayWorker = async (): Promise<void> => {
    while (true) {
      const idx = nextIndex.i++;
      if (idx >= total) return;
      const { streamId: streamDid, fromIdx, rebuild } = toReplay[idx]!;
      try {
        // The DNS handle and the enriched link metadata live in the global
        // store, not the per-space DB, so a rebuild must carry them across
        // before the swap drops the old file. The boot sweep already ran their
        // migrations for every other path; this covers a space that reached the
        // rebuild without them (a version this build cannot start from, or a
        // declined migration).
        if (rebuild) {
          await carrySpaceHandleToGlobal(db, streamDid as StreamDid);
          await carryLinkEmbedsToGlobal(db, streamDid as StreamDid);
        }
        // Blue-green rebuild: begin explicitly so the temp `.sqlite.new` DB is
        // created and the space is flagged rebuilding BEFORE replay starts
        // (and before any slow profile hydration holds the window open) —
        // otherwise `isSpaceRebuilding` is still false while we replay and the
        // write gate wouldn't reject during the window. Idempotent, so it
        // is safe alongside the lazy `forSpaceRebuild` auto-begin.
        if (rebuild) {
          await db.spaceRebuildBegin!(streamDid as StreamDid);
        }
        // Blue-green rebuild targets the temp new-schema DB; the canonical
        // (read-serving) DB is untouched until commit. Incremental catch-up
        // targets the canonical DB as before.
        const handle = rebuild
          ? db.forSpaceRebuild!(streamDid as StreamDid)
          : db.forSpace!(streamDid as StreamDid);

        const rawEvents = await db
          .query(
            "SELECT idx, user, payload, received_at, created_at FROM stream_events WHERE stream_id = ? AND idx >= ? ORDER BY idx",
          )
          .all<RawEvent>(streamDid, fromIdx);

        if (rawEvents.length > 0) {
          const decodedEvents: LoggedEvent[] = rawEvents.map(
            (e): LoggedEvent => ({
              idx: e.idx as StreamIndex,
              event: decode(e.payload) as Event,
              user: e.user as UserDid,
              receivedAt: e.received_at ?? undefined,
              createdAt: e.created_at ?? undefined,
            }),
          );

          const globalDb = db.global?.();
          const stats = await applyBatch(
            handle,
            streamDid as StreamDid,
            decodedEvents,
            {
              isBackfill: true,
            },
            globalDb,
          );

          if (stats.materializerErrors > 0 || stats.applyErrors > 0) {
            log.warn("[re-materialize] stream-done", {
              streamId: streamDid,
              applied: stats.applied,
              materializerErrors: stats.materializerErrors,
              applyErrors: stats.applyErrors,
              rebuild,
            });
          } else {
            log.info("[re-materialize] stream-done", {
              streamId: streamDid,
              applied: stats.applied,
              materializerErrors: 0,
              applyErrors: 0,
              rebuild,
            });
          }
        }

        if (rebuild) {
          // Atomic swap: the temp rebuild DB replaces the canonical file and
          // routing flips. The cursor was advanced by applyBatch.
          await db.spaceRebuildCommit!(streamDid as StreamDid);
        }
        succeeded++;
      } catch (err) {
        if (rebuild) {
          // Never swap in a broken/partial DB — abort and keep serving the
          // old DB. The next boot re-runs the rebuild for this stream.
          try {
            await db.spaceRebuildAbort!(streamDid as StreamDid);
          } catch {
            /* best-effort */
          }
        }
        failed++;
        log.error(
          "startup",
          `re-materialize failed for ${streamDid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if ((succeeded + failed) % 25 === 0 || succeeded + failed === total) {
        const pct = Math.round(((succeeded + failed) / total) * 100);
        log.info("[re-materialize] progress", {
          done: succeeded + failed,
          total,
          pct,
          succeeded,
          failed,
        });
        report({
          phase: "replaying",
          replayDone: succeeded + failed,
          replayFailed: failed,
        });
      }
    }
  };

  await Promise.all(Array.from({ length: replayCap }, () => replayWorker()));

  // The shared DBs' statistics get the same treatment as the per-space ones.
  // Their size is event-driven rather than per-space, so the sweep above is
  // the natural place to catch them, and the global `entity_space` index —
  // which every room/message handler resolves an owner through — is the one
  // that grows without bound (`search/backfill.ts`).
  try {
    await db.analyzeShared?.();
  } catch (err) {
    log.warn(
      "startup",
      `shared-database statistics refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  report({ phase: "finishing", replayDone: succeeded + failed, replayFailed: failed });
  await finishStartupMigrations();

  report({ phase: "done", replayDone: succeeded + failed, replayFailed: failed });
  log.info("[re-materialize] complete", { succeeded, failed });
}
