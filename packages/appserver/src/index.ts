/**
 * Appserver boot entry point.
 *
 * Constructs the server via `createAppserver` (see `./appserver.ts`) with
 * env-derived options, then re-materializes all streams from the local
 * events DB. The factory handles all server construction — DBs, routes,
 * CORS, health endpoints, WebSocket — so this file is only the process
 * entry point and the re-materialization driver.
 *
 * Fatal handlers and the boot counter are installed as the first statements,
 * ahead of the top-level `await`s below: a rejection from `createAppserver`
 * or the membership migration is exactly the boot-window crash that must be
 * recorded (see `./fatal.ts`).
 */

import { createAppserver, type AppserverHandle } from "./appserver.ts";
import { log } from "./log.ts";
import { installFatalHandlers, recordProcessStart } from "./fatal.ts";
import {
  reMaterializeFromLocalEvents,
  DEFAULT_REMATERIALIZE_CONCURRENCY,
} from "./streams/reMaterialize.ts";
import { openDb, poolStats } from "./db/db.ts";
import { runPendingReadStateMigrationsWithRetry } from "./db/userSpaceMembershipMigration.ts";
import { BootReadinessTracker } from "./readiness.ts";

// ─── Fatal-exit visibility ─────────────────────────────────────────────────
// Install before anything that can throw or reject: a boot failure must leave
// an error record behind, not just a raw Bun abort that never reaches Loki.
// `recordProcessStart` stamps the boot time into
// `roomy_process_boot_timestamp_seconds`, which is what makes a restart
// visible to a scrape (`changes(...[1h])`) — see ./fatal.ts.
installFatalHandlers();
recordProcessStart();

// ─── Boot readiness ────────────────────────────────────────────────────────
// The socket binds long before the materialised views are current: the sweep
// below walks every stream in the event log, and until it finishes a read can
// be answered from a space that has not caught up. `/health` reports that
// through this tracker (503 `starting` until the first pass completes), which
// is the signal a platform health check holds traffic behind.
const boot = new BootReadinessTracker();

// ─── Server construction ───────────────────────────────────────────────────

const app: AppserverHandle = await createAppserver({
  readiness: () => boot.snapshot(),
});

// Listening is not readiness: this line exists so the boot's progress is
// visible in the log even while `/health` still reports `starting`.
log.info("startup", `appserver listening (DID: ${app.ownDid}, port: ${app.port})`);

// ─── Re-materialize from local events DB ─────────────────────────────────
// Replay un-materialized events from the local events DB to bring the
// materialized views up to date. The `materialization_cursor` table tracks
// how far each stream has been materialized; streams that are already caught
// up are skipped entirely (no event reads, no materialization). A full
// replay only happens after a schema-version wipe (which empties the cursor
// table). On a normal restart the cursors are current, so this is cheap.
//
// Re-materialization runs after the server is listening (requests are answered
// from whatever is already materialized, and a stream is usable the moment it
// is caught up) but the process reports itself ready only when the pass
// returns: `/health` is 503 until then, so a platform health check routes no
// traffic into a pool that is mid-sweep. A pass that throws leaves the process
// not-ready and logs why — the previous instance keeps serving, which is the
// right outcome for a boot whose event log could not be read.
//
// Profile hydration uses the HappyView-first fetcher (HappyView → Bluesky
// fallback, or Bluesky-only when HappyView is not configured).
const db = openDb();

// ─── Durable membership recovery (awaited) ────────────────────────────────
// Recover user-space membership intent from the event log into the read-state
// DB before serving reads. This is a resumable migration: on a fresh deploy it
// scans the full join/leave history (current + deprecated personal events) and
// writes the durable `user_space_membership` rows that getSpaces/hydration/
// activity-feed now read. It must complete before reads serve, otherwise
// getSpaces would return empty during the boot window. Idempotent — on
// subsequent boots the migration is already stamped complete and this is a
// no-op.
//
// We retry a few times (a transient DB hiccup shouldn't take the server down),
// then fail fast: serving with an empty `user_space_membership` would silently
// hide every user's spaces, which is worse than a restart. The migration is
// resumable, so the orchestrator's restart retries it from where it left off.
await runPendingReadStateMigrationsWithRetry(db);

boot.setPhase("sweeping");
const poolSize = (await poolStats())?.size;
const concurrency = poolSize ?? DEFAULT_REMATERIALIZE_CONCURRENCY;
reMaterializeFromLocalEvents(db, concurrency, {
  onProgress: (progress) => boot.update(progress),
})
  .then(() => {
    boot.markReady();
    const { elapsed_ms, streams_total } = boot.snapshot();
    log.info(
      "startup",
      `appserver ready (DID: ${app.ownDid}, port: ${app.port}) after ${elapsed_ms}ms: ${streams_total} streams`,
    );
  })
  .catch((err) => {
    boot.markFailed();
    log.error(
      "startup",
      `re-materialization failed, staying not-ready: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
