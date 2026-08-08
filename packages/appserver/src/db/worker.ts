/**
 * SQLite worker — runs in a Bun.Worker thread.
 *
 * Owns the read-state DB (`readStateDb`), the event-log DB (`eventsDb`),
 * the per-space DBs (`data/spaces/<spaceDid>.sqlite`), and the global DB
 * (`data/global.sqlite`). There is no monolithic materialised DB — the
 * per-space DBs are the source of truth for space data (Phase 3 of
 * docs/plans/per-space-dbs.md).
 *
 * Per-space DBs (`data/spaces/<spaceDid>.sqlite`) are opened lazily on first
 * request for that space, cached with LRU eviction, and created by
 * re-materialising that stream from the event log (not backfilled from a
 * monolithic DB). The global DB (`data/global.sqlite`) is opened lazily on
 * first request and holds `joinedSpace`/`leftSpace` edges, the global
 * `profiles` table, and the `entity_space` entity→space index.
 *
 * All handlers are synchronous (bun:sqlite is synchronous in the worker
 * thread). Errors are caught and returned as structured { error, errorCode }
 * in the response.
 */

import { Database, type Changes } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerRequest, WorkerResponse } from "./types.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Cast unknown[] to SQLQueryBindings[] for bun:sqlite. */
function toBindings(params?: unknown[]): SQLQueryBindings[] {
  return (params ?? []) as SQLQueryBindings[];
}

/** Normalise lastInsertRowid (number | bigint) to number | undefined. */
function normaliseRowid(
  rowid: number | bigint | undefined,
): number | undefined {
  if (rowid === undefined || rowid === null) return undefined;
  return Number(rowid);
}

// ─── State ────────────────────────────────────────────────────────────────

let readStateDb: Database | null = null;
let eventsDb: Database | null = null;
const preparedStmts = new Map<number, ReturnType<Database["prepare"]>>();
let nextHandle = 1;
let closed = false;

/** Per-space DBs, opened lazily and LRU-evicted. Keyed by spaceDid. */
const spaceDbs = new Map<string, { db: Database; lastUsed: number }>();
/** Global DB (joinedSpace/leftSpace edges + profiles + entity index), opened lazily. */
let globalDb: Database | null = null;
let spacesDir: string | null = null;
let globalDbPath: string | null = null;
let spaceSchemaVersion: string | null = null;
let globalSchemaVersion: string | null = null;
/** Max concurrently-open space DBs before LRU eviction. */
let maxSpaceDbs = 100;

// ─── Schema paths ─────────────────────────────────────────────────────────

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SPACE_SCHEMA_PATH = join(THIS_DIR, "schema-space.sql");
const GLOBAL_SCHEMA_PATH = join(THIS_DIR, "schema-global.sql");
const READSTATE_SCHEMA_PATH = join(THIS_DIR, "readStateSchema.sql");
const EVENTS_SCHEMA_PATH = join(THIS_DIR, "eventsSchema.sql");

// ─── Schema helpers (ported from db.ts / readStateDb.ts) ──────────────────

class SchemaVersionMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `Schema version mismatch: expected ${expected}, got ${actual}`,
    );
    this.name = "SchemaVersionMismatchError";
  }
}

/** Schema-version tracking for a DB that keeps its own version table. */
function initializeVersionedSchema(
  db: Database,
  schemaPath: string,
  versionTable: string,
  expectedVersion: string,
): void {
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  const row = db
    .query<{ version: string }, []>(
      `select version from ${versionTable} where id = 1`,
    )
    .get();
  if (!row) {
    db.exec(
      `insert into ${versionTable} (id, version) values (1, '${expectedVersion}')`,
    );
  } else if (row.version !== expectedVersion) {
    throw new SchemaVersionMismatchError(expectedVersion, row.version);
  }
}

interface Migration {
  version: number;
  up: (db: Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 2,
    up(db: Database) {
      db.exec(`
        create table if not exists user_thread_activity (
          user_did      text not null,
          thread_id     text not null,
          last_active_at integer not null,
          updated_at    integer not null default (unixepoch() * 1000),
          primary key (user_did, thread_id)
        ) strict
      `);
      db.exec(`
        create index if not exists idx_user_thread_activity_user
          on user_thread_activity(user_did, last_active_at desc)
      `);
    },
  },
  {
    version: 3,
    up(db: Database) {
      // Web push tables. The schema file (readStateSchema.sql) also
      // declares these with `create table if not exists` so a fresh DB
      // gets them at exec time; this migration exists so an existing v2
      // readstate DB advances its version row to 3 (the schema exec alone
      // would create the tables but leave the version stale).
      db.exec(`
        create table if not exists push_subscriptions (
          user_did        text not null,
          endpoint        text not null,
          p256dh          text not null,
          auth            text not null,
          expiration_time integer,
          created_at      integer not null default (unixepoch() * 1000),
          updated_at      integer not null default (unixepoch() * 1000),
          primary key (user_did, endpoint)
        ) strict
      `);
      db.exec(`
        create index if not exists idx_push_subs_user
          on push_subscriptions(user_did)
      `);
      db.exec(`
        create table if not exists push_user_default (
          user_did text primary key,
          level    text not null check(level in ('silent','quiet','engaged','busy')) default 'engaged',
          updated_at integer not null default (unixepoch() * 1000)
        ) strict
      `);
      db.exec(`
        create table if not exists push_preferences (
          user_did  text not null,
          space_id  text not null,
          level     text not null check(level in ('silent','quiet','engaged','busy')),
          updated_at integer not null default (unixepoch() * 1000),
          primary key (user_did, space_id)
        ) strict
      `);
      db.exec(`
        create table if not exists user_room_participation (
          user_did         text not null,
          room_id          text not null,
          last_message_at  integer not null,     -- epoch ms of the user's latest message in the room
          updated_at       integer not null default (unixepoch() * 1000),
          primary key (user_did, room_id)
        ) strict
      `);
      db.exec(`
        create index if not exists idx_user_room_participation_user
          on user_room_participation(user_did, last_message_at desc)
      `);
      db.exec(`
        create table if not exists notification_state (
          user_did            text not null,
          room_id             text not null,
          first_unseen_at     integer,           -- epoch ms of the first unseen message in this batch
          first_unseen_msg_id text,              -- anchor message ULID
          unseen_count        integer not null default 0,
          notified            integer not null default 0 check(notified in (0,1)),
          pushed_at           integer,
          updated_at          integer not null default (unixepoch() * 1000),
          primary key (user_did, room_id)
        ) strict
      `);
      db.exec(`
        create index if not exists idx_notification_state_due
          on notification_state(notified, first_unseen_at)
      `);
    },
  },
  {
    version: 4,
    up(db: Database) {
      // Feature flags. The schema file (readStateSchema.sql) also declares
      // these with `create table if not exists` so a fresh DB gets them at
      // exec time; this migration exists so an existing v3 readstate DB
      // advances its version row to 4.
      db.exec(`
        create table if not exists feature_flags (
          key             text primary key,
          global_enabled  integer not null default 0 check(global_enabled in (0, 1)),
          updated_at      integer not null default (unixepoch() * 1000)
        ) strict
      `);
      db.exec(`
        create table if not exists feature_flag_assignments (
          flag_key   text not null,
          user_did   text not null,
          updated_at integer not null default (unixepoch() * 1000),
          primary key (flag_key, user_did)
        ) strict
      `);
      db.exec(`
        create index if not exists idx_ff_assignments_flag
          on feature_flag_assignments(flag_key)
      `);
    },
  },
  {
    version: 5,
    up(db: Database) {
      // Per-space split (§1f): read_positions gains a denormalized
      // `space_did` column so unread sums can be scoped per space without
      // joining entities (which moves to per-space DBs). Purely additive —
      // no data loss. The row backfill is NOT done here: the read-state DB
      // is not yet ATTACHed to the main DB when migrations run (the ATTACH
      // happens after initializeReadStateSchema in handleInit), so the
      // entities join would fail. handleInit runs the backfill after the
      // ATTACH instead (see backfillReadPositionsSpaceDid).
      const cols = db
        .query<{ name: string }, []>(
          "select name from pragma_table_info('read_positions')",
        )
        .all()
        .map((r) => r.name);
      if (!cols.includes("space_did")) {
        db.exec(
          "alter table read_positions add column space_did text not null default ''",
        );
      }
    },
  },
];

function initializeReadStateSchema(
  db: Database,
  schemaPath: string,
  expectedVersion: string,
): void {
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  const row = db
    .query<{ version: string }, []>(
      "select version from readstate_schema_version where id = 1",
    )
    .get();
  if (!row) {
    db.exec(
      `insert into readstate_schema_version (id, version) values (1, '${expectedVersion}')`,
    );
    return;
  }

  const currentVersion = parseInt(row.version, 10);
  const expectedNum = parseInt(expectedVersion, 10);

  if (currentVersion < expectedNum) {
    const upsertVersion = db.prepare(
      "update readstate_schema_version set version = ? where id = 1",
    );
    for (const migration of MIGRATIONS) {
      if (
        migration.version > currentVersion &&
        migration.version <= expectedNum
      ) {
        db.transaction(() => {
          migration.up(db);
          upsertVersion.run(String(migration.version));
        })();
      }
    }
  }
}

// ─── Per-space DB management ──────────────────────────────────────────────

/**
 * Open (or return from the LRU cache) the per-space DB for `spaceDid`.
 * On first open: create the file and apply the per-space schema. The DB is
 * populated by re-materialising the stream from the event log (Phase 3 —
 * there is no monolithic DB to backfill from).
 */
function openSpaceDb(spaceDid: string): Database {
  if (!spacesDir) throw new Error("Per-space DBs not initialized (no init)");
  const cached = spaceDbs.get(spaceDid);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.db;
  }

  let db = openSpaceDbFile(spaceDid);
  try {
    initializeVersionedSchema(
      db,
      SPACE_SCHEMA_PATH,
      "space_schema_version",
      spaceSchemaVersion ?? "",
    );

  } catch (err) {
    // The space DB must never be left half-initialised: a partial file
    // (schema applied but init failed, or worse) reads back as
    // "database disk image is malformed" on every subsequent open.
    // Close and delete it so the next open retries from scratch.
    deleteSpaceDbFile(spaceDid, db);
    // A schema-version mismatch means the on-disk schema is stale. Wipe and
    // re-derive transparently so the caller never sees a failed request for
    // a space that merely needs re-initialising (e.g. after a schema change
    // bumps SPACE_SCHEMA_VERSION).
    if (err instanceof SchemaVersionMismatchError) {
      db = openSpaceDbFile(spaceDid);
      initializeVersionedSchema(
        db,
        SPACE_SCHEMA_PATH,
        "space_schema_version",
        spaceSchemaVersion ?? "",
      );
    } else {
      throw err;
    }
  }


  // LRU eviction: close the least-recently-used handle when over capacity.
  if (spaceDbs.size >= maxSpaceDbs) {
    let oldest: string | null = null;
    let oldestTs = Infinity;
    for (const [did, entry] of spaceDbs) {
      if (entry.lastUsed < oldestTs) {
        oldestTs = entry.lastUsed;
        oldest = did;
      }
    }
    if (oldest !== null && oldest !== spaceDid) {
      const entry = spaceDbs.get(oldest);
      spaceDbs.delete(oldest);
      try {
        entry?.db.close();
      } catch {
        /* best-effort */
      }
    }
  }

  spaceDbs.set(spaceDid, { db, lastUsed: Date.now() });
  return db;
}

/** Close and delete a per-space DB file (best-effort). */
function deleteSpaceDbFile(spaceDid: string, db: Database): void {
  try {
    db.close();
  } catch {
    /* best-effort */
  }
  if (spacesDir !== ":memory:" && spacesDir !== null) {
    const path = join(spacesDir, `${spaceDid}.sqlite`);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(path + suffix);
      } catch {
        /* already gone */
      }
    }
  }
}

function openSpaceDbFile(spaceDid: string): Database {
  if (spacesDir === ":memory:") {
    // In-memory per-space DBs (tests): each connection is its own fresh
    // DB, cached per spaceDid in the worker LRU. Recreated on every worker
    // restart, so tests never leak files or cross-test state.
    const db = new Database(":memory:");
    db.exec("pragma journal_mode = wal");
    db.exec("pragma synchronous = normal");
    db.exec("pragma foreign_keys = on");
    return db;
  }
  const path = join(spacesDir!, `${spaceDid}.sqlite`);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  return db;
}


/** Open (or return) the global DB. Created lazily on first request. */
function openGlobalDbInternal(): Database {
  if (globalDb) return globalDb;
  if (!globalDbPath) throw new Error("Global DB not initialized (no init)");
  if (globalDbPath === ":memory:") {
    // In-memory global DB (tests): fresh per worker, no files touched.
    globalDb = new Database(":memory:");
  } else {
    mkdirSync(dirname(globalDbPath), { recursive: true });
    globalDb = new Database(globalDbPath, { create: true });
  }
  globalDb.exec("pragma journal_mode = wal");
  globalDb.exec("pragma synchronous = normal");
  globalDb.exec("pragma foreign_keys = on");
  try {
    initializeVersionedSchema(
      globalDb,
      GLOBAL_SCHEMA_PATH,
      "global_schema_version",
      globalSchemaVersion ?? "",
    );
  } catch (err) {
    // The global DB is derived data (regenerable from the event log), so a
    // schema-version mismatch means the on-disk schema is stale. Wipe and
    // re-derive transparently rather than failing every request — the
    // membership edges / profiles / entity index are rebuilt by
    // re-materialization. Mirrors the per-space DB handling.
    deleteGlobalDbFile(globalDb);
    globalDb = new Database(globalDbPath, { create: true });
    globalDb.exec("pragma journal_mode = wal");
    globalDb.exec("pragma synchronous = normal");
    globalDb.exec("pragma foreign_keys = on");
    initializeVersionedSchema(
      globalDb,
      GLOBAL_SCHEMA_PATH,
      "global_schema_version",
      globalSchemaVersion ?? "",
    );
  }

  return globalDb;
}

/** Close and delete the global DB file (best-effort). */
function deleteGlobalDbFile(db: Database): void {
  try {
    db.close();
  } catch {
    /* best-effort */
  }
  if (globalDbPath !== ":memory:" && globalDbPath !== null) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(globalDbPath + suffix);
      } catch {
        /* already gone */
      }
    }
  }
}


/** Select the DB handle a request targets. */
function dbForRequest(req: WorkerRequest): Database {
  if (req.targetDb === "space") {
    if (!req.spaceDid) throw new Error("spaceDid required for space target");
    return openSpaceDb(req.spaceDid);
  }
  if (req.targetDb === "global") {
    return openGlobalDbInternal();
  }
  if (req.targetDb === "readstate") {
    if (!readStateDb) throw new Error("Read-state DB not initialized (no init)");
    return readStateDb;
  }
  if (!eventsDb) throw new Error("Events DB not initialized (no init)");
  return eventsDb;
}

// ─── Message handler ──────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent) => {
  const req = event.data as WorkerRequest;
  try {
    if (closed) {
      const response: WorkerResponse = {
        id: req.id,
        error: "Worker is closed",
        errorCode: "WORKER_CLOSED",
      };
      self.postMessage(response);
      return;
    }
    const result = handleRequest(req);
    const response: WorkerResponse = { id: req.id, result };
    self.postMessage(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorCode =
      err instanceof SchemaVersionMismatchError
        ? "SCHEMA_MISMATCH"
        : "INTERNAL_ERROR";
    const response: WorkerResponse = {
      id: req.id,
      error: message,
      errorCode,
    };
    self.postMessage(response);
  }
};

function handleRequest(req: WorkerRequest): unknown {
  switch (req.type) {
    case "init":
      return handleInit(req);
    case "query":
      return handleQuery(req);
    case "run":
      return handleRun(req);
    case "exec":
      return handleExec(req);
    case "prepare":
      return handlePrepare(req);
    case "prepareRun":
      return handlePrepareRun(req);
    case "prepareAll":
      return handlePrepareAll(req);
    case "prepareGet":
      return handlePrepareGet(req);
    case "prepareFinalize":
      return handlePrepareFinalize(req);
    case "transaction":
      return handleTransaction(req);
    case "close":
      return handleClose();
    case "health":
      return { ok: true };
    default:
      throw new Error(`Unknown request type: ${req.type}`);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────

function handleInit(req: WorkerRequest): {
  readStateDbPath: string;
  eventsDbPath: string;
} {
  const opts = req.initOpts!;
  const readStatePath =
    opts.readStateDbPath ?? "data/roomy-readstate.sqlite";
  const eventsPath = opts.eventsDbPath ?? "data/roomy-events.sqlite";

  // Per-space split (Phase 3): lazily-created space DBs + global DB. When
  // the read-state DB is :memory: (tests), keep the derived DBs in-memory
  // too so tests never touch the filesystem.
  const isMemory = readStatePath === ":memory:";
  spacesDir = opts.spacesDir ?? (isMemory ? ":memory:" : "data/spaces");
  globalDbPath =
    opts.globalDbPath ?? (isMemory ? ":memory:" : "data/global.sqlite");
  spaceSchemaVersion = opts.spaceSchemaVersion ?? "";
  globalSchemaVersion = opts.globalSchemaVersion ?? "";
  if (opts.maxSpaceDbs !== undefined) maxSpaceDbs = opts.maxSpaceDbs;

  // Open read-state DB (own file, no ATTACH — Phase 3)
  if (isMemory) {
    readStateDb = new Database(":memory:");
  } else {
    mkdirSync(dirname(readStatePath), { recursive: true });
    readStateDb = new Database(readStatePath, { create: true });
  }
  readStateDb.exec("pragma journal_mode = wal");
  readStateDb.exec("pragma synchronous = normal");
  readStateDb.exec("pragma foreign_keys = on");
  initializeReadStateSchema(
    readStateDb,
    READSTATE_SCHEMA_PATH,
    opts.readStateSchemaVersion ?? "",
  );

  // Open events DB (append-only, never wiped — no schema version)
  if (eventsPath === ":memory:") {
    eventsDb = new Database(":memory:");
  } else {
    mkdirSync(dirname(eventsPath), { recursive: true });
    eventsDb = new Database(eventsPath, { create: true });
  }
  eventsDb.exec("pragma journal_mode = wal");
  eventsDb.exec("pragma synchronous = normal");
  const eventsSchemaSql = readFileSync(EVENTS_SCHEMA_PATH, "utf-8");
  eventsDb.exec(eventsSchemaSql);

  // Add columns that were added after the table was first created.
  // SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we check the
  // table info first.
  const existingColumns = new Set(
    eventsDb
      .query<{ name: string }, []>(
        "select name from pragma_table_info('stream_events')",
      )
      .all()
      .map((r) => r.name),
  );
  if (!existingColumns.has("event_type")) {
    eventsDb.exec("alter table stream_events add column event_type text");
  }
  if (!existingColumns.has("created_at")) {
    eventsDb.exec("alter table stream_events add column created_at integer");
  }

  return {
    readStateDbPath: readStatePath,
    eventsDbPath: eventsPath,
  };
}

// ─── Query handlers ───────────────────────────────────────────────────────

function handleQuery(req: WorkerRequest): unknown {
  const db = dbForRequest(req);
  const stmt = db.query(req.sql!);
  if (req.mode === "get") {
    return stmt.get(...toBindings(req.params)) ?? null;
  }
  return stmt.all(...toBindings(req.params));
}

function handleRun(req: WorkerRequest): {
  changes: number;
  lastInsertRowid?: number;
} {
  const db = dbForRequest(req);
  const result = (db.run as (...args: unknown[]) => Changes)(req.sql!, ...toBindings(req.params));
  return {
    changes: result.changes,
    lastInsertRowid: normaliseRowid(result.lastInsertRowid),
  };
}

function handleExec(req: WorkerRequest): void {
  dbForRequest(req).exec(req.sql!);
}

function handlePrepare(req: WorkerRequest): { handle: number } {
  const db = dbForRequest(req);
  const handle = nextHandle++;
  preparedStmts.set(handle, db.prepare(req.sql!));
  return { handle };
}

function handlePrepareRun(req: WorkerRequest): {
  changes: number;
  lastInsertRowid?: number;
} {
  const stmt = preparedStmts.get(req.handle!);
  if (!stmt)
    throw new Error(`Unknown prepared statement handle: ${req.handle}`);
  const result = stmt.run(...toBindings(req.params));
  return {
    changes: result.changes,
    lastInsertRowid: normaliseRowid(result.lastInsertRowid),
  };
}

function handlePrepareAll(req: WorkerRequest): unknown[] {
  const stmt = preparedStmts.get(req.handle!);
  if (!stmt)
    throw new Error(`Unknown prepared statement handle: ${req.handle}`);
  return stmt.all(...toBindings(req.params));
}

function handlePrepareGet(req: WorkerRequest): unknown {
  const stmt = preparedStmts.get(req.handle!);
  if (!stmt)
    throw new Error(`Unknown prepared statement handle: ${req.handle}`);
  return stmt.get(...toBindings(req.params)) ?? null;
}

function handlePrepareFinalize(req: WorkerRequest): void {
  const stmt = preparedStmts.get(req.handle!);
  if (stmt) {
    stmt.finalize();
    preparedStmts.delete(req.handle!);
  }
}

function handleTransaction(req: WorkerRequest): unknown {
  const db = dbForRequest(req);
  let lastResult: unknown = undefined;
  const run = db.transaction(() => {
    for (const step of req.steps ?? []) {
      switch (step.type) {
        case "query":
          lastResult = db.prepare(step.sql).all(...toBindings(step.params));
          break;
        case "run":
          lastResult = (db.run as (...args: unknown[]) => Changes)(step.sql, ...toBindings(step.params));
          break;
        case "exec":
          db.exec(step.sql);
          lastResult = undefined;
          break;
      }
    }
  });
  run();
  return lastResult;
}

function handleClose(): void {
  closed = true;
  preparedStmts.clear();
  for (const [, entry] of spaceDbs) {
    try {
      entry.db.close();
    } catch {
      /* best-effort */
    }
  }
  spaceDbs.clear();
  if (globalDb) {
    try {
      globalDb.close();
    } catch {
      /* best-effort */
    }
    globalDb = null;
  }
  if (eventsDb) {
    eventsDb.close();
    eventsDb = null;
  }
  if (readStateDb) {
    readStateDb.close();
    readStateDb = null;
  }
}
