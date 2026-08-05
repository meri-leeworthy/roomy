/**
 * SQLite handles for the appserver's materialised views.
 *
 * One Bun.Worker owns ALL SQLite I/O process-wide: the monolithic
 * materialised DB (`data/roomy.sqlite`), the read-state DB, the event-log
 * DB, and — for the per-space split (Phase 1 of
 * docs/plans/per-space-dbs.md) — lazily-created per-space DBs
 * (`data/spaces/<spaceDid>.sqlite`) and a global DB (`data/global.sqlite`).
 *
 * The schema in `./schema.sql` mirrors the frontend worker schema so the
 * SDK's pure materializer functions can be reused unchanged.
 *
 * Materialisation is fully deterministic from the local event log, so on a
 * schema-version mismatch the file is automatically deleted and re-created.
 *
 * This module owns the shared WorkerLink and hands out routed handles:
 * `openDb()` → monolithic DB, `openSpaceDb(spaceDid)` → per-space DB,
 * `openGlobalDb()` → global DB. All are proxies over the same worker.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncDatabase, WorkerLink } from "./asyncDatabase.ts";
import { READSTATE_SCHEMA_VERSION } from "./readStateDb.ts";

/**
 * Bump whenever schema.sql OR materialiser logic changes — a bump triggers
 * a wipe + full re-materialisation from the local event log, which is how a
 * materialiser change is rolled out to existing data. Mirrors the frontend's
 * `CONFIG.databaseSchemaVersion`. Strings, not numbers, so we can use
 * suffixes (e.g. `"6-appserver.1"`) once the two diverge.
 *
 * `.7`: getSpaces/hydration now read membership from `joinedSpace` edges
 * instead of `comp_space.hidden`; needs a re-materialise to seed the edges.
 *
 * `.10`: fixed missing ORDER BY in module "events" and "metadata" subscription
 * queries — without it, backfill pagination skips events. The old DB has
 * holes; a wipe forces clean re-materialisation with the fixed module.
 *
 * `.11`: added `comp_embed_link_data` table for caching enriched embed
 * metadata from the external embed service.
 *
 * `.10-appserver.3`: embed retry-with-backoff. `comp_embed_link_data`
 * gains `attempts` (consecutive transient-failure count) and `retry_after`
 * (epoch ms; transient failures re-queue after this backoff). The pending
 * query now also returns retry-eligible rows, so links stuck on a null row
 * from a transient failure (service down / timeout / 5xx) get re-tried
 * with exponential backoff instead of being permanently abandoned.
 * Definitive failures (404 / no-data) settle with no retry. Wipe re-derives
 * embed data from scratch.
 *
 * `.10-appserver.2`: SDK `createRoomLink` materialiser made idempotent
 * (`on conflict do nothing`) — re-applying the same link event no longer
 * flips `canonical_parent` 1 → 0, which corrupted parent-channel links for
 * threads on streams that got re-backfilled. Wipe re-derives correct
 * canonical_parent values from the event log.
 *
 * `.10-appserver.5`: added `banner`, `pronouns`, `website` columns to
 * `comp_info` for the Roomy profile record (`space.roomy.user.profile`).
 * Wipe re-materialises profiles from the new Roomy-first fetcher (PDS
 * record with Bluesky fallback), populating the new columns.
 *
 * `.10-appserver.6`: fix display name regression — the Bluesky fallback
 * path was overwriting `comp_info.name` with the handle when
 * `displayName` was absent, clobbering names set by `SetUserProfile`
 * events (bridged users) and prior fetches. Wipe re-materialises with
 * the fixed insert strategy (Bluesky fallback uses `on conflict do
 * nothing`, never writes handle as name).
 *
 * `.10-appserver.7`: SDK `UpdateSpaceInfo` materialiser now always ensures
 * a `comp_space` row (and the space's own `entities` row) exists, even when
 * the event carries only name/description (no space-level fields). Without
 * this, spaces created via `createDefaultSpaceEvents` (the default path)
 * never got a `comp_space` row from their own stream — they only got one
 * incidentally when a member's `PersonalJoinSpace` materialised. After a
 * schema-version wipe, re-materialization from the event log failed to
 * recreate `comp_space` (FK constraint), so `getMetadata` returned 404 and
 * the frontend couldn't navigate to any space. Wipe re-derives the rows.
 *
 * `.10-appserver.8`: personal stream removal — `joinedSpace`/`leftSpace` edges
 * now use the user DID as `head` (not a personal-stream DID). The
 * `comp_user_personal_stream` table is dropped. Wipe re-materialises edges
 * from the updated `PersonalJoinSpace`/`PersonalLeaveSpace` materialisers
 * (which use `user` from the event context as the edge head).
 *
 * `.10-appserver.9`: re-run of `.8`'s re-materialisation with a corrected
 * SDK build. The `.8` wipe ran against a stale `@roomy-space/sdk` dist that
 * still wrote `joinedSpace` edges with the personal-stream DID as `head`,
 * so `getSpaces` returned nothing for users whose membership was rebuilt
 * from the event log. Rebuild the SDK, then wipe again so edges are written
 * with `head = userDid`.
 *
 * `.10-appserver.10`: forcing rematerialisation on prod due to aborted
 * materialisation error.
 *
 * Note: the per-space split (Phase 1) does NOT bump this version — the
 * monolithic DB's materialisation semantics are unchanged and its data is
 * already correct. Per-space DBs are derived from it via lazy backfill
 * (docs/plans/per-space-dbs.md §1h); a bump here would force an unnecessary
 * full re-materialisation of every space on first deploy.
 */
export const SCHEMA_VERSION = "10-appserver.10";

/**
 * Per-space DB schema version (`data/spaces/*.sqlite`). Tracked independently
 * from the monolithic version so per-space schemas can evolve without forcing
 * a global re-materialisation. Bump whenever schema-space.sql changes — a
 * bump wipes and re-derives every per-space DB (from the monolithic DB via
 * lazy backfill, or from the event log via re-materialisation).
 */
export const SPACE_SCHEMA_VERSION = "1";

/**
 * Global DB schema version (`data/global.sqlite`). Bump whenever
 * schema-global.sql changes.
 */
export const GLOBAL_SCHEMA_VERSION = "1";

const DEFAULT_DB_PATH = process.env.APPSERVER_DB_PATH ?? "data/roomy.sqlite";

let link: WorkerLink | null = null;
let mainDb: AsyncDatabase | null = null;
let globalDb: AsyncDatabase | null = null;

export interface OpenDbOptions {
  /** Filesystem path or `:memory:`. Defaults to `APPSERVER_DB_PATH` or `data/roomy.sqlite`. */
  path?: string;
  /** If true, skip the process-wide singleton (useful for tests). */
  isolated?: boolean;
}
export function openDb(opts: OpenDbOptions = {}): AsyncDatabase {
  if (!opts.isolated && mainDb) return mainDb;

  const path = opts.path ?? DEFAULT_DB_PATH;
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), "worker.ts");

  // Isolated mode (tests) gets its own worker link, terminated on close().
  // Non-isolated handles share one process-wide link.
  let owned: WorkerLink | null = null;
  let shared: WorkerLink | null = link;
  if (opts.isolated) {
    owned = new WorkerLink(workerPath);
    shared = null;
  } else if (!link) {
    shared = new WorkerLink(workerPath);
    link = shared;
  }
  const isMemory = path === ":memory:";
  const db = new AsyncDatabase(shared ?? owned!, undefined, opts.isolated);
  void db.init({
    mainDbPath: path,
    readStateDbPath: process.env.READSTATE_DB_PATH ?? "data/roomy-readstate.sqlite",
    eventsDbPath: process.env.EVENTS_DB_PATH ?? "data/roomy-events.sqlite",
    // In-memory main DB (tests) ⇒ in-memory derived DBs too, so tests never
    // touch the filesystem. The worker applies the same fallback when these
    // are absent, but db.ts pins them so env vars can't leak files into a
    // :memory: test run.
    spacesDir: isMemory ? ":memory:" : (process.env.SPACES_DIR ?? "data/spaces"),
    globalDbPath: isMemory ? ":memory:" : (process.env.GLOBAL_DB_PATH ?? "data/global.sqlite"),
    schemaVersion: SCHEMA_VERSION,
    readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
    spaceSchemaVersion: SPACE_SCHEMA_VERSION,
    globalSchemaVersion: GLOBAL_SCHEMA_VERSION,
  }).catch(() => {
    // Error already propagates via the first queued request's response.
  });

  if (!opts.isolated) mainDb = db;
  return db;
}

/** Return the singleton AsyncDatabase, or throw if not yet opened. */
export function getDb(): AsyncDatabase {
  if (!mainDb) throw new Error("Database not opened. Call openDb() first.");
  return mainDb;
}

/**
 * Return a handle that routes every request to the per-space DB for
 * `spaceDid` (`data/spaces/<spaceDid>.sqlite`), over the shared worker.
 * The space DB is created lazily on first use in the worker and backfilled
 * from the monolithic DB (the Phase 1 source of truth).
 *
 * Safe to call before `openDb()`; the routed handle's first request will
 * resolve against whichever worker link is active. Callers that rely on the
 * worker being initialised should call `openDb()` first (the appserver boot
 * path always does).
 */
export function openSpaceDb(spaceDid: string): AsyncDatabase {
  ensureLink();
  return mainDb!.forSpace(spaceDid);
}

/**
 * Return a handle that routes every request to the global DB
 * (`data/global.sqlite`), over the shared worker. The global DB is created
 * lazily on first use and holds only `joinedSpace`/`leftSpace` edges.
 */
export function openGlobalDb(): AsyncDatabase {
  ensureLink();
  if (!globalDb) {
    globalDb = mainDb!.global();
  }
  return globalDb;
}

function ensureLink(): void {
  if (!mainDb) {
    // Initialise the shared worker (with default paths) so routed handles
    // have a link. Mirrors what openDb() does for the main handle.
    openDb();
  }
}

/**
 * Close the process-wide database singleton. Used by tests to reset state.
 * Terminates the worker immediately so in-flight requests fail fast.
 */
export function closeDb(): void {
  if (link) {
    link.terminate();
    link = null;
  }
  mainDb = null;
  globalDb = null;
}
