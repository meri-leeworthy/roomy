/**
 * SQLite worker — runs in a Bun.Worker thread.
 *
 * Owns the monolithic materialisation DB (`mainDb`), the read-state DB
 * (`readStateDb`, ATTACHed as `readstate`), the event-log DB (`eventsDb`,
 * ATTACHed as `events`), and — for the per-space split (Phase 1 of
 * docs/plans/per-space-dbs.md) — the per-space DBs and the global DB.
 *
 * Per-space DBs (`data/spaces/<spaceDid>.sqlite`) are opened lazily on first
 * request for that space, cached with LRU eviction, and backfilled from the
 * monolithic DB on first open (the monolithic DB is the source of truth
 * during Phase 1 dual-write). The global DB (`data/global.sqlite`) is opened
 * lazily on first request and holds only `joinedSpace`/`leftSpace` edges.
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

let mainDb: Database | null = null;
let readStateDb: Database | null = null;
let eventsDb: Database | null = null;
const preparedStmts = new Map<number, ReturnType<Database["prepare"]>>();
let nextHandle = 1;
let closed = false;

/** Per-space DBs, opened lazily and LRU-evicted. Keyed by spaceDid. */
const spaceDbs = new Map<string, { db: Database; lastUsed: number }>();
/** Global DB (joinedSpace/leftSpace edges), opened lazily. */
let globalDb: Database | null = null;
let spacesDir: string | null = null;
let globalDbPath: string | null = null;
let spaceSchemaVersion: string | null = null;
let globalSchemaVersion: string | null = null;
/** Max concurrently-open space DBs before LRU eviction. */
let maxSpaceDbs = 100;

// ─── Schema paths ─────────────────────────────────────────────────────────

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(THIS_DIR, "schema.sql");
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

function initializeSchema(
  db: Database,
  schemaPath: string,
  expectedVersion: string,
): void {
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  const row = db
    .query<{ version: string }, []>(
      "select version from roomy_schema_version where id = 1",
    )
    .get();
  if (!row) {
    db.exec(
      `insert into roomy_schema_version (id, version) values (1, '${expectedVersion}')`,
    );
  } else if (row.version !== expectedVersion) {
    throw new SchemaVersionMismatchError(expectedVersion, row.version);
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
 * On first open: create the file, apply the per-space schema, and backfill
 * from the monolithic DB (the Phase 1 source of truth). The backfill is a
 * single transaction copying every per-space table's rows whose stream_id /
 * entity matches the space.
 */
function openSpaceDb(spaceDid: string): Database {
  if (!spacesDir) throw new Error("Per-space DBs not initialized (no init)");
  const cached = spaceDbs.get(spaceDid);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.db;
  }

  const db = openSpaceDbFile(spaceDid);
  try {
    initializeVersionedSchema(
      db,
      SPACE_SCHEMA_PATH,
      "space_schema_version",
      spaceSchemaVersion ?? "",
    );

    if (mainDb) {
      backfillSpaceDb(db, spaceDid);
    }
  } catch (err) {
    // The space DB must never be left half-initialised: a partial file
    // (schema applied but backfill failed, or worse) reads back as
    // "database disk image is malformed" on every subsequent open.
    // Close and delete it so the next open retries from scratch.
    try {
      db.close();
    } catch {
      /* best-effort */
    }
    if (spacesDir !== ":memory:") {
      const path = join(spacesDir, `${spaceDid}.sqlite`);
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
      try {
        unlinkSync(path + "-wal");
      } catch {
        /* already gone */
      }
      try {
        unlinkSync(path + "-shm");
      } catch {
        /* already gone */
      }
    }
    throw err;
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

/**
 * Copy the monolithic DB's rows for `spaceDid` into a freshly-created
 * per-space DB. One transaction; ~100k rows worst case, no round-trips.
 * Idempotent (insert or ignore) so it is safe to re-run.
 */
function backfillSpaceDb(db: Database, spaceDid: string): void {
  const main = mainDb!;
  const copy = (table: string, where: string, params: SQLQueryBindings[]) => {
    // Column list via pragma (the per-space and monolithic tables share
    // identical shapes for the tables that remain).
    const cols = main
      .query<{ name: string }, []>(
        `select name from pragma_table_info('${table}')`,
      )
      .all()
      .map((r) => r.name);
    if (cols.length === 0) return;
    const colList = cols.join(", ");
    const rows = main
      .query(`select ${colList} from ${table} where ${where}`)
      .all(...params) as Record<string, unknown>[];
    if (rows.length === 0) return;
    const placeholders = cols.map(() => "?").join(", ");
    const insert = db.prepare(
      `insert or ignore into ${table} (${colList}) values (${placeholders})`,
    );
    for (const row of rows) {
      insert.run(...cols.map((c) => row[c] as SQLQueryBindings));
    }
  };

  db.transaction(() => {
    copy("entities", "stream_id = ?", [spaceDid]);

    // The monolithic DB is shared across streams, and a space's own entity
    // row can carry a DIFFERENT stream_id than the space DID (it is created
    // by whichever materialiser ran first). Rows we are about to copy carry
    // FK constraints onto entities (comp_space.entity, comp_room.entity,
    // edge endpoints, reaction users, ...), so ensure every entity they
    // reference exists BEFORE copying any FK-carrying table.
    const referencedIds = new Set<string>([spaceDid]);
    for (const r of main
      .query(
        `select head, tail from edges
          where (head in (select id from entities where stream_id = ?)
             or tail in (select id from entities where stream_id = ?))
            and label not in ('joinedSpace', 'leftSpace')`,
      )
      .all(spaceDid, spaceDid) as Array<{ head: string; tail: string }>) {
      referencedIds.add(r.head);
      referencedIds.add(r.tail);
    }
    for (const r of main
      .query(
        `select user from comp_reaction
          where entity in (select id from entities where stream_id = ?)`,
      )
      .all(spaceDid) as Array<{ user: string }>) {
      if (r.user !== null) referencedIds.add(r.user);
    }
    if (referencedIds.size > 0) {
      // A large space can reference > 100k edge endpoints / reaction users.
      // SQLite caps bind parameters per statement, so chunk the IN (...) so
      // each prepared query stays well under the limit.
      const CHUNK = 500;
      const ids = [...referencedIds];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => "?").join(",");
        for (const row of main
          .query(
            `select id, stream_id, room, sort_idx, created_at, updated_at
               from entities where id in (${placeholders})`,
          )
          .all(...chunk) as Record<string, unknown>[]) {
          db.run(
            `insert or ignore into entities (id, stream_id, room, sort_idx, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?)`,
            [
              row.id as SQLQueryBindings,
              row.stream_id as SQLQueryBindings,
              row.room as SQLQueryBindings,
              row.sort_idx as SQLQueryBindings,
              row.created_at as SQLQueryBindings,
              row.updated_at as SQLQueryBindings,
            ],
          );
        }
      }
    }

    // FK-carrying per-space tables (entity/stream-scoped).
    copy("comp_space", "entity = ?", [spaceDid]);
    copy("comp_room", "entity in (select id from entities where stream_id = ?)", [spaceDid]);
    copy("comp_discord_origin", "entity in (select id from entities where stream_id = ?)", [spaceDid]);
    copy("comp_user", "did in (select id from entities where stream_id = ?)", [spaceDid]);
    copy("comp_content", "entity in (select id from entities where stream_id = ?)", [spaceDid]);
    copy("comp_info", "entity in (select id from entities where stream_id = ?)", [spaceDid]);
    copy("comp_page_edits", "entity in (select id from entities where stream_id = ?)", [spaceDid]);
    copy("comp_comment", "entity in (select id from entities where stream_id = ?)", [spaceDid]);
    copy("comp_embed_image", "entity in (select id from entities where stream_id = ?)", [spaceDid]);
    copy("comp_embed_video", "entity in (select id from entities where stream_id = ?)", [spaceDid]);
    copy("comp_embed_file", "entity in (select id from entities where stream_id = ?)", [spaceDid]);
    copy("comp_embed_link", "entity in (select id from entities where stream_id = ?)", [spaceDid]);
    copy("comp_embed_link_data", "entity in (select id from entities where stream_id = ?)", [spaceDid]);
    copy("comp_last_read", "entity in (select id from entities where stream_id = ?)", [spaceDid]);
    copy("comp_reaction", "entity in (select id from entities where stream_id = ?)", [spaceDid]);
    copy("comp_calendar_link", "entity in (select id from entities where stream_id = ?)", [spaceDid]);
    copy("comp_calendar_event", "entity in (select id from entities where stream_id = ?)", [spaceDid]);
    copy("roles", "stream_id = ?", [spaceDid]);
    copy("member_roles", "stream_id = ?", [spaceDid]);
    copy("role_rooms", "stream_id = ?", [spaceDid]);
    copy("comp_bans", "entity = ?", [spaceDid]);
    copy("comp_invite", "entity = ?", [spaceDid]);
    copy("activity_item", "space_id = ?", [spaceDid]);
    // Copy only this space's cursor rows. Rows whose stream_id differs
    // (edge cases) are skipped — each space DB is self-describing.
    copy("materialization_cursor", "stream_id = ?", [spaceDid]);
    // Per-space `edges` exclude joinedSpace/leftSpace (those live in the
    // global DB). Copy all other labels.
    const edgeRows = main
      .query(
        `select head, tail, label, payload, created_at, updated_at
           from edges
          where (head in (select id from entities where stream_id = ?)
             or tail in (select id from entities where stream_id = ?))
            and label not in ('joinedSpace', 'leftSpace')`,
      )
      .all(spaceDid, spaceDid) as Record<string, unknown>[];
    for (const row of edgeRows) {
      db.run(
        `insert or ignore into edges (head, tail, label, payload, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)`,
        [
          row.head as SQLQueryBindings,
          row.tail as SQLQueryBindings,
          row.label as SQLQueryBindings,
          row.payload as SQLQueryBindings,
          row.created_at as SQLQueryBindings,
          row.updated_at as SQLQueryBindings,
        ],
      );
    }
  })();
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
  initializeVersionedSchema(
    globalDb,
    GLOBAL_SCHEMA_PATH,
    "global_schema_version",
    globalSchemaVersion ?? "",
  );

  if (mainDb) {
    backfillGlobalDb(globalDb);
  }
  return globalDb;
}

/**
 * Copy the monolithic DB's `joinedSpace`/`leftSpace` edges into the global
 * DB (plan §1h). Idempotent (insert or ignore). The global DB is derived
 * data: it is deleted by the Phase 1 rollback plan and regenerated here.
 */
function backfillGlobalDb(db: Database): void {
  const main = mainDb!;
  const rows = main
    .query(
      `select head, tail, label, payload, created_at, updated_at
         from edges
        where label in ('joinedSpace', 'leftSpace')`,
    )
    .all() as Record<string, unknown>[];
  db.transaction(() => {
    for (const row of rows) {
      db.run(
        `insert or ignore into edges (head, tail, label, payload, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)`,
        [
          row.head as SQLQueryBindings,
          row.tail as SQLQueryBindings,
          row.label as SQLQueryBindings,
          row.payload as SQLQueryBindings,
          row.created_at as SQLQueryBindings,
          row.updated_at as SQLQueryBindings,
        ],
      );
    }

    // Backfill the global profiles table from the monolithic DB's
    // comp_user + comp_info (the pre-split profile store). Idempotent
    // (insert or ignore) so re-running is safe. The global DB is derived
    // data; profiles are re-populated on the next profile fetch anyway.
    const profileRows = main
      .query(
        `select
           u.did as did,
           u.handle as handle,
           i.name as name,
           i.avatar as avatar,
           i.description as description,
           i.banner as banner,
           i.pronouns as pronouns,
           i.website as website
         from comp_user u
         left join comp_info i on i.entity = u.did`,
      )
      .all() as Record<string, unknown>[];
    for (const row of profileRows) {
      db.run(
        `insert or ignore into profiles (did, handle, name, avatar, description, banner, pronouns, website, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, unixepoch() * 1000)`,
        [
          row.did as SQLQueryBindings,
          row.handle as SQLQueryBindings,
          row.name as SQLQueryBindings,
          row.avatar as SQLQueryBindings,
          row.description as SQLQueryBindings,
          row.banner as SQLQueryBindings,
          row.pronouns as SQLQueryBindings,
          row.website as SQLQueryBindings,
        ],
      );
    }
  })();
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
  if (!mainDb) throw new Error("Main DB not initialized (no init)");
  return mainDb;
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
  mainDbPath: string;
  readStateDbPath: string;
  version: string;
} {
  const opts = req.initOpts!;
  const mainPath = opts.mainDbPath ?? "data/roomy.sqlite";
  const readStatePath =
    opts.readStateDbPath ?? "data/roomy-readstate.sqlite";

  // Per-space split (Phase 1): lazily-created space DBs + global DB.
  // When the main DB is :memory: (tests), keep the derived DBs in-memory
  // too so tests never touch the filesystem.
  spacesDir =
    opts.spacesDir ?? (mainPath === ":memory:" ? ":memory:" : "data/spaces");
  globalDbPath =
    opts.globalDbPath ??
    (mainPath === ":memory:" ? ":memory:" : "data/global.sqlite");
  spaceSchemaVersion = opts.spaceSchemaVersion ?? "";
  globalSchemaVersion = opts.globalSchemaVersion ?? "";
  if (opts.maxSpaceDbs !== undefined) maxSpaceDbs = opts.maxSpaceDbs;

  // Open main DB
  mkdirSync(dirname(mainPath), { recursive: true });
  mainDb = new Database(mainPath, { create: true });
  mainDb.exec("pragma journal_mode = wal");
  mainDb.exec("pragma synchronous = normal");
  mainDb.exec("pragma foreign_keys = on");

  try {
    initializeSchema(mainDb, SCHEMA_PATH, opts.schemaVersion ?? "");
  } catch (err) {
    if (err instanceof SchemaVersionMismatchError) {
      mainDb.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(mainPath + suffix);
        } catch {
          /* already gone */
        }
      }
      mkdirSync(dirname(mainPath), { recursive: true });
      mainDb = new Database(mainPath, { create: true });
      mainDb.exec("pragma journal_mode = wal");
      mainDb.exec("pragma synchronous = normal");
      mainDb.exec("pragma foreign_keys = on");
      initializeSchema(mainDb, SCHEMA_PATH, opts.schemaVersion ?? "");
    } else {
      throw err;
    }
  }

  // Open read-state DB
  if (readStatePath === ":memory:") {
    // For in-memory read-state DB, ATTACH directly and apply schema on mainDb
    mainDb.exec("attach database ':memory:' as readstate");
    const schemaSql = readFileSync(READSTATE_SCHEMA_PATH, "utf-8");
    // Prepend "readstate." to table names in CREATE TABLE statements so they
    // land in the attached schema rather than the main database schema.
    const prefixedSql = schemaSql.replace(
      /create\s+table\s+(if\s+not\s+exists\s+)?(\w+)/gi,
      (_match, ifNotExists: string | undefined, tableName: string) => {
        if (tableName === "readstate_schema_version") {
          return `create table ${ifNotExists ?? ""}${tableName}`;
        }
        return `create table ${ifNotExists ?? ""}readstate.${tableName}`;
      },
    );
    mainDb.exec(prefixedSql);
  } else {
    mkdirSync(dirname(readStatePath), { recursive: true });
    readStateDb = new Database(readStatePath, { create: true });
    readStateDb.exec("pragma journal_mode = wal");
    readStateDb.exec("pragma synchronous = normal");
    readStateDb.exec("pragma foreign_keys = on");
    initializeReadStateSchema(
      readStateDb,
      READSTATE_SCHEMA_PATH,
      opts.readStateSchemaVersion ?? "",
    );

    // ATTACH read-state to main DB
    const row = readStateDb
      .query<{ file: string }, []>("pragma database_list")
      .all()
      .find((r) => r.file !== "");
    if (!row) throw new Error("Cannot resolve read-state DB path");
    mainDb.exec(
      `attach database '${row.file.replace(/'/g, "''")}' as readstate`,
    );
  }

  // Backfill read_positions.space_did now that readstate is ATTACHed to the
  // main DB (the v5 migration can't do this — it runs before the ATTACH).
  // Idempotent: only touches rows still at ''. Best-effort: a row whose
  // room_id is missing from entities keeps '' and is populated lazily on
  // the next write (ensureReadPositions/updateSeen).
  try {
    mainDb.exec(
      `update readstate.read_positions
          set space_did = coalesce(
            (select stream_id from entities where id = read_positions.room_id),
            ''
          )
        where space_did = ''`,
    );
  } catch {
    // Best-effort backfill; lazily populated on later writes.
  }

  // Open events DB (append-only, never wiped — no schema version)
  const eventsPath = opts.eventsDbPath ?? "data/roomy-events.sqlite";
  mkdirSync(dirname(eventsPath), { recursive: true });
  eventsDb = new Database(eventsPath, { create: true });
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
    eventsDb.exec(
      "alter table stream_events add column event_type text",
    );
  }
  if (!existingColumns.has("created_at")) {
    eventsDb.exec(
      "alter table stream_events add column created_at integer",
    );
  }

  // ATTACH events DB to main DB so `events.stream_events` is queryable
  // from the appserver's main DB handle (used by the dashboard handler).
  const eventsRow = eventsDb
    .query<{ file: string }, []>("pragma database_list")
    .all()
    .find((r) => r.file !== "");
  if (!eventsRow) throw new Error("Cannot resolve events DB path");
  mainDb.exec(
    `attach database '${eventsRow.file.replace(/'/g, "''")}' as events`,
  );

  return {
    mainDbPath: mainPath,
    readStateDbPath: readStatePath,
    version: opts.schemaVersion ?? "",
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
  // DETACH events from mainDb before closing either, so no access to eventsDb
  // via the ATTACH after mainDb drops it.
  if (mainDb) {
    mainDb.exec("detach database events");
  }
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
  if (mainDb) {
    mainDb.close();
    mainDb = null;
  }
  if (readStateDb) {
    readStateDb.close();
    readStateDb = null;
  }
}
