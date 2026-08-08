/**
 * SQLite handles for the appserver.
 *
 * One Bun.Worker owns ALL SQLite I/O process-wide: the read-state DB, the
 * event-log DB, lazily-created per-space DBs (`data/spaces/<spaceDid>.sqlite`)
 * and a global DB (`data/global.sqlite`). There is no monolithic materialised
 * DB — the per-space DBs are the source of truth for space data (Phase 3 of
 * docs/plans/per-space-dbs.md).
 *
 * This module owns the shared WorkerLink and hands out routed handles:
 * `openDb()` → event-log DB, `openSpaceDb(spaceDid)` → per-space DB,
 * `openGlobalDb()` → global DB, `openReadStateDb()` → read-state DB,
 * `openEventsDb()` → event-log DB. All are proxies over the same worker.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncDatabase, WorkerLink } from "./asyncDatabase.ts";
import { READSTATE_SCHEMA_VERSION } from "./readStateDb.ts";

/**
 * Per-space DB schema version (`data/spaces/*.sqlite`). Bump whenever
 * schema-space.sql changes — a bump wipes and re-derives every per-space DB
 * (from the event log via re-materialisation).
 */
export const SPACE_SCHEMA_VERSION = "1";

/**
 * Global DB schema version (`data/global.sqlite`). Bump whenever
 * schema-global.sql changes.
 *
 * `.2`: added the global `profiles` table (authoritative per-user Roomy
 * profile).
 *
 * `.3`: added the global `entity_space` entity→space index (Phase 3),
 * replacing the monolithic DB's `entities.stream_id` lookup for
 * `openSpaceDbForEntity`.
 *
 * `.4`: added the global `pending_links` embed-sweeper index (Phase 3),
 * dual-written during materialization so the sweeper can find pending
 * embed links across all per-space DBs with one query.
 */
export const GLOBAL_SCHEMA_VERSION = "4";

let link: WorkerLink | null = null;
let mainDb: AsyncDatabase | null = null;
let globalDb: AsyncDatabase | null = null;

export interface OpenDbOptions {
  /** Event-log DB path or `:memory:`. Defaults to `EVENTS_DB_PATH` or `data/roomy-events.sqlite`. */
  path?: string;
  /** If true, skip the process-wide singleton (useful for tests). */
  isolated?: boolean;
}

/**
 * Open the process-wide event-log DB handle (the "main" remaining DB).
 * Routes every request to the event-log DB (`data/roomy-events.sqlite`).
 *
 * `opts.path` is accepted for backwards compatibility with tests that pass
 * `:memory:`; it selects the event-log DB path. `opts.isolated` spins up a
 * dedicated worker (tests).
 */
export function openDb(opts: OpenDbOptions = {}): AsyncDatabase {
  if (!opts.isolated && mainDb) return mainDb;

  const path = opts.path ?? process.env.EVENTS_DB_PATH ?? "data/roomy-events.sqlite";
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
    readStateDbPath: process.env.READSTATE_DB_PATH ?? "data/roomy-readstate.sqlite",
    eventsDbPath: path,
    // In-memory event-log DB (tests) ⇒ in-memory derived DBs too, so tests
    // never touch the filesystem. The worker applies the same fallback when
    // these are absent, but db.ts pins them so env vars can't leak files
    // into a :memory: test run.
    spacesDir: isMemory ? ":memory:" : (process.env.SPACES_DIR ?? "data/spaces"),
    globalDbPath: isMemory ? ":memory:" : (process.env.GLOBAL_DB_PATH ?? "data/global.sqlite"),
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
 * The space DB is created lazily on first use in the worker and populated
 * by re-materialising the stream from the event log.
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
 * Resolve the space DID that owns `entityId` (a room or message entity) by
 * reading the global `entity_space` index, then return a handle that routes
 * requests to that space's per-space DB.
 *
 * Phase 3: room/message-scoped handlers need to know which per-space DB to
 * read from, but their XRPC params only carry the room/message id. The
 * global `entity_space` index (populated during materialization) replaces
 * the monolithic DB's `entities.stream_id` lookup. Returns `null` when the
 * entity doesn't exist (the caller decides 404 vs 400).
 */
export async function openSpaceDbForEntity(
  entityId: string,
): Promise<AsyncDatabase | null> {
  const global = openGlobalDb();
  const row = await global
    .query("select space_did from entity_space where entity_id = ?")
    .get<{ space_did: string }>(entityId);
  if (!row) return null;
  return openSpaceDb(row.space_did);
}

/**
 * Return a handle that routes every request to the global DB
 * (`data/global.sqlite`), over the shared worker. The global DB is created
 * lazily on first use and holds `joinedSpace`/`leftSpace` edges, the global
 * `profiles` table, and the `entity_space` entity→space index.
 */
export function openGlobalDb(): AsyncDatabase {
  ensureLink();
  if (!globalDb) {
    globalDb = mainDb!.global();
  }
  return globalDb;
}

/**
 * Return the global DB handle if the worker-backed DBs are initialised, or
 * `null` otherwise. Unlike `openGlobalDb()`, this does NOT lazily initialise
 * the worker — used by code paths that may run against a raw in-memory
 * `Database` in tests (where the global DB isn't set up) and should skip the
 * global write rather than spin up a worker.
 */
export function tryOpenGlobalDb(): AsyncDatabase | null {
  if (!mainDb) return null;
  if (!globalDb) {
    globalDb = mainDb.global();
  }
  return globalDb;
}

/**
 * Return a handle that routes every request to the read-state DB
 * (`data/roomy-readstate.sqlite`), over the shared worker.
 */
export function openReadStateDb(): AsyncDatabase {
  ensureLink();
  return mainDb!.readState();
}

/**
 * Return a handle that routes every request to the event-log DB
 * (`data/roomy-events.sqlite`), over the shared worker.
 */
export function openEventsDb(): AsyncDatabase {
  ensureLink();
  return mainDb!.events();
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
